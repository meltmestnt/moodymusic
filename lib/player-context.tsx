"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSession } from "next-auth/react";
import type { SpotifyPlaybackState, SpotifyTrack } from "@/lib/spotify";
import { showError } from "@/lib/toast";
import { useI18n } from "@/lib/i18n";

// We unify four sources of truth into a single `current/isPlaying/...`:
//
//   1. Spotify Connect state (/me/player polling, ~3s) — authoritative for
//      ANY Spotify device the user is signed into. This is what makes the
//      webapp mirror their Spotify desktop/phone playback.
//
//   2. Spotify Web Playback SDK events (Premium only) — fire instantly when
//      OUR webapp's SDK device changes state. We use them to skip the poll
//      latency for actions originating in this tab.
//
//   3. HTMLAudioElement — plays the preview_url when the user clicks a
//      card. Used by Spotify free (30s preview) and Deezer (30s preview).
//
//   4. SoundCloud Widget Player (iframe) — for SoundCloud sessions only.
//      SoundCloud's streaming API requires app-level approval that's not
//      available to new apps, so we fall back to the public Widget that
//      streams any public track. The audio lives inside the iframe and
//      we drive it via SoundCloud's Widget JS API (postMessage). The
//      AnalyserNode-based visualizer doesn't work in this mode (cross-
//      origin audio), but playback itself does.
//
// Polling source's track wins by default; preview / widget audio takes
// over when it's actively playing.

type Mode = "premium" | "free" | "widget" | "yt-widget";

export interface PlayerContextValue {
  // Whatever's actually playing right now, from any of the three sources.
  current: SpotifyTrack | null;
  isPlaying: boolean;
  // Smoothed, ticking forward locally between polls.
  progressMs: number;
  durationMs: number;
  volumePercent: number;
  deviceName: string | null;
  source: "spotify" | "preview" | "widget" | "yt-widget" | null;

  mode: Mode | null;
  // True when the user has Premium AND there's an active device — the
  // preconditions for any of the write controls to actually take effect.
  canControlSpotify: boolean;
  // Whether the current mode can actually play the given track. Premium →
  // always true (SDK can play any URI). Free → true only if the track has a
  // preview_url.
  isPlayable: (track: SpotifyTrack) => boolean;

  // Actions. play() picks the best strategy: Premium → transfer to our SDK
  // device + start the track; Free → play the 30s preview locally.
  // If `queue` is supplied, the next tracks auto-play when the current one
  // ends. For Premium that's Spotify's own queue (we send the uri list to
  // /me/player/play); for Free we listen for the audio 'ended' event and
  // step to the next preview.
  // `source` is recorded for analytics on the server (library / mood / etc).
  play: (
    track: SpotifyTrack,
    queue?: SpotifyTrack[],
    source?: "library" | "mood" | "footer" | "external" | "unknown",
  ) => Promise<void>;
  toggle: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  seek: (ms: number) => Promise<void>;
  setVolume: (percent: number) => Promise<void>;
  stopPreview: () => void;

  // Retained for back-compat with any caller that imported it; the player
  // now emits errors via lib/toast.showError directly.
  dismissError: () => void;

  analyser: AnalyserNode | null;
}

const Ctx = createContext<PlayerContextValue | null>(null);

const POLL_INTERVAL_MS = 3000;
const TICK_INTERVAL_MS = 250;

async function postControl(body: object): Promise<Response> {
  return fetch("/api/playback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function fetchState(): Promise<SpotifyPlaybackState | null> {
  const res = await fetch("/api/playback", { cache: "no-store" });
  if (!res.ok) return null;
  const json = (await res.json()) as { state: SpotifyPlaybackState | null };
  return json.state;
}

// Translate a MediaError code / thrown play()-rejection into an i18n
// key the caller can pass to t(). The browser's default messages
// ("Failed to load because no supported source was found") are
// accurate but cryptic. Empty string = "expected interruption, no
// toast" (e.g. AbortError fires when the user skips to the next song).
function classifyPlaybackError(
  e: unknown,
  mediaErr: MediaError | null,
): "" | "playback.autoplayBlocked" | "playback.notSupported" | "playback.network" | "playback.decode" | "playback.cantLoad" | "playback.cantStart" {
  if (e instanceof DOMException) {
    if (e.name === "NotAllowedError") return "playback.autoplayBlocked";
    if (e.name === "NotSupportedError") return "playback.notSupported";
    if (e.name === "AbortError") return ""; // expected on track skip
  }
  if (mediaErr) {
    switch (mediaErr.code) {
      case 1: // MEDIA_ERR_ABORTED
        return "";
      case 2: // MEDIA_ERR_NETWORK
        return "playback.network";
      case 3: // MEDIA_ERR_DECODE
        return "playback.decode";
      case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
        return "playback.cantLoad";
    }
  }
  return "playback.cantStart";
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const { t } = useI18n();
  const accessToken = session?.accessToken;
  const product = session?.user?.product;
  const provider = session?.provider;

  // Show a translated playback error. When the audio src is one of our
  // server-side stream proxies, the browser's generic "no supported
  // source" message hides the real upstream cause — so we hit the proxy
  // directly to read its `code`/`error` body and translate that. Falls
  // back to a humanised browser-error string for non-proxy sources.
  //
  // NOTE: declared inside the provider (not at module scope) so it can
  // close over `t` from useI18n — without that the toast text would
  // always be the English fallback regardless of locale.
  const reportAudioFailure = useCallback(
    async (audio: HTMLAudioElement, e: unknown): Promise<void> => {
      const src = audio.src;
      if (src && src.includes("/api/sc-stream")) {
        try {
          const res = await fetch(src);
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as
              | { code?: string; error?: string }
              | null;
            if (body?.code) {
              // The dictionary lookup t() returns the key itself when the
              // entry is missing — guard against that so we fall back to
              // the server's English `error` string instead of the bare
              // code being shown to the user.
              const translated = t(body.code as Parameters<typeof t>[0]);
              showError(translated !== body.code ? translated : (body.error ?? translated));
              return;
            }
            if (body?.error) {
              showError(body.error);
              return;
            }
          }
          // Proxy itself was OK — the failure is genuinely client-side
          // (codec, CORS). Fall through to the generic mapping.
        } catch {
          // Diagnostic fetch failed — fall through.
        }
      }
      const key = classifyPlaybackError(e, audio.error);
      if (key) showError(t(key));
    },
    [t],
  );
  const mode: Mode | null = useMemo(() => {
    // Anonymous "free tier": signed-out visitors only encounter SC tracks
    // surfaced by /api/sc-search, so widget mode is the only one that
    // makes sense. The SC Widget plays any public track without user
    // OAuth, so this works without a session.
    if (status === "unauthenticated") return "widget";
    if (!session) return null;
    // SoundCloud: streaming API is gated behind app-level approval that
    // isn't available to new apps. Use the public iframe Widget Player
    // instead — it plays any public track without API permission.
    if (provider === "soundcloud") return "widget";
    // YouTube: Google OAuth gives us metadata/likes access via the
    // Data API, but actual playback runs through the YouTube IFrame
    // Player (separate JS API surface from SoundCloud's Widget).
    if (provider === "youtube") return "yt-widget";
    // Deezer: no Web Playback SDK, no Connect API. Use the existing free
    // path which plays the 30s preview clip locally via <audio>.
    if (provider === "deezer") return "free";
    return product === "premium" ? "premium" : "free";
  }, [status, session, product, provider]);

  // ─── Spotify Connect state (polling) ───
  const [spotifyState, setSpotifyState] =
    useState<SpotifyPlaybackState | null>(null);
  // When we issue a write (pause/play/seek/etc) the polled state is briefly
  // stale. We bump this timestamp and skip merging poll results that arrive
  // within ~1.2s of the optimistic update — the next poll after that wins.
  const optimisticUntilRef = useRef<number>(0);
  // Local clock when the last spotifyState update was applied. We use THIS
  // (not Spotify's `timestamp` field) as the base for extrapolating progress
  // forward between polls — Spotify's `timestamp` is "when playback state
  // last CHANGED" (play/pause/seek), which can be many minutes in the past
  // for a steadily playing song. Adding (now - that) on top of progress_ms
  // (which is already the current position at fetch) double-counts elapsed
  // time and pegs the slider to durationMs after a page reload.
  const polledAtRef = useRef<number>(Date.now());

  useEffect(() => {
    if (!session) return;
    // Deezer / SoundCloud / YouTube have no Connect endpoint to poll —
    // skip the loop entirely so we don't burn a request every 3s on a
    // route that always returns `{ state: null }` for these sessions.
    if (
      provider === "deezer" ||
      provider === "soundcloud" ||
      provider === "youtube"
    )
      return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const state = await fetchState();
      const fetchedAt = Date.now();
      if (cancelled) return;
      if (Date.now() < optimisticUntilRef.current) {
        // Trust our last write for one cycle. Schedule another poll.
      } else {
        polledAtRef.current = fetchedAt;
        setSpotifyState(state);
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [session, provider]);

  // ─── Local tick to advance progress between polls ───
  // /me/player only updates progress_ms when we poll. Between polls we
  // advance our own counter so the progress bar moves smoothly.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // ─── Preview mode (free) ───
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [previewTrack, setPreviewTrack] = useState<SpotifyTrack | null>(null);
  const [previewIsPlaying, setPreviewIsPlaying] = useState(false);

  // Queue for auto-advance. Refs (not state) so the 'ended' listener
  // installed once on the audio element always reads the latest value
  // without re-attaching.
  const previewQueueRef = useRef<SpotifyTrack[]>([]);
  const previewIndexRef = useRef<number>(-1);
  const advancePreviewRef = useRef<() => void>(() => {});

  // ─── SoundCloud Widget mode ───
  // The widget runs in an iframe; we drive it via SoundCloud's Widget JS
  // API (postMessage under the hood). We don't render any visible iframe
  // UI — the iframe is fixed off-screen with size 1×1; our own footer
  // renders the controls, which call back into widget.play() / pause()
  // / seekTo(). The audio plays through the iframe regardless of CSS
  // visibility.
  const widgetIframeRef = useRef<HTMLIFrameElement | null>(null);
  const widgetRef = useRef<SC.WidgetPlayer | null>(null);
  const [widgetTrack, setWidgetTrack] = useState<SpotifyTrack | null>(null);
  const [widgetIsPlaying, setWidgetIsPlaying] = useState(false);
  const [widgetProgressMs, setWidgetProgressMs] = useState(0);
  const [widgetDurationMs, setWidgetDurationMs] = useState(0);
  const [widgetVolume, setWidgetVolume] = useState(70);
  const widgetQueueRef = useRef<SpotifyTrack[]>([]);
  const widgetIndexRef = useRef<number>(-1);
  const advanceWidgetRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (mode !== "widget") return;
    let cancelled = false;
    let scriptEl: HTMLScriptElement | null = null;

    const initWidget = () => {
      if (cancelled) return;
      const iframe = widgetIframeRef.current;
      if (!iframe || !window.SC?.Widget) return;
      const widget = window.SC.Widget(iframe);
      const Events = window.SC.Widget.Events;
      widget.bind(Events.READY, () => {
        // Ready handler intentionally a no-op — we don't auto-load
        // anything until the user clicks a track.
      });
      widget.bind(Events.PLAY, () => setWidgetIsPlaying(true));
      widget.bind(Events.PAUSE, () => setWidgetIsPlaying(false));
      widget.bind(Events.PLAY_PROGRESS, (data) => {
        const d = data as SC.PlayProgressEvent | undefined;
        if (typeof d?.currentPosition === "number") {
          setWidgetProgressMs(d.currentPosition);
        }
      });
      widget.bind(Events.FINISH, () => {
        setWidgetIsPlaying(false);
        advanceWidgetRef.current();
      });
      widget.bind(Events.ERROR, () => {
        showError(t("playback.cantLoad"));
      });
      widgetRef.current = widget;
    };

    if (window.SC?.Widget) {
      // Script already loaded by a prior mount — initialise immediately.
      // The iframe ref may not be attached yet on first render; defer
      // one microtask so it lands.
      queueMicrotask(initWidget);
    } else {
      scriptEl = document.createElement("script");
      scriptEl.src = "https://w.soundcloud.com/player/api.js";
      scriptEl.async = true;
      scriptEl.onload = initWidget;
      document.body.appendChild(scriptEl);
    }

    return () => {
      cancelled = true;
      const widget = widgetRef.current;
      if (widget && window.SC?.Widget) {
        try {
          const Events = window.SC.Widget.Events;
          widget.unbind(Events.READY);
          widget.unbind(Events.PLAY);
          widget.unbind(Events.PAUSE);
          widget.unbind(Events.PLAY_PROGRESS);
          widget.unbind(Events.FINISH);
          widget.unbind(Events.ERROR);
          widget.pause();
        } catch {
          // Widget already torn down — ignore.
        }
      }
      widgetRef.current = null;
      setWidgetTrack(null);
      setWidgetIsPlaying(false);
      setWidgetProgressMs(0);
      setWidgetDurationMs(0);
    };
  }, [mode, t]);

  // ─── YouTube IFrame Player mode ───
  // Same shape as the SoundCloud widget block, but driven by the
  // YouTube IFrame Player API. Two key differences:
  //   1. The API doesn't fire a periodic progress event, so we poll
  //      getCurrentTime() ourselves on a 250ms interval while the
  //      player is in the PLAYING state.
  //   2. YT.Player is constructed against a host div which the API
  //      replaces with an iframe. We render the host div with size 1×1
  //      off-screen and let YT.Player swap it for an iframe in place.
  const ytHostRef = useRef<HTMLDivElement | null>(null);
  const ytPlayerRef = useRef<YT.Player | null>(null);
  const [ytTrack, setYtTrack] = useState<SpotifyTrack | null>(null);
  const [ytIsPlaying, setYtIsPlaying] = useState(false);
  const [ytProgressMs, setYtProgressMs] = useState(0);
  const [ytDurationMs, setYtDurationMs] = useState(0);
  const [ytVolume, setYtVolume] = useState(70);
  const ytQueueRef = useRef<SpotifyTrack[]>([]);
  const ytIndexRef = useRef<number>(-1);
  const advanceYtRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (mode !== "yt-widget") return;
    let cancelled = false;
    let scriptEl: HTMLScriptElement | null = null;
    let progressTimer: ReturnType<typeof setInterval> | null = null;

    const initPlayer = () => {
      if (cancelled) return;
      const host = ytHostRef.current;
      if (!host || !window.YT?.Player) return;
      const player = new window.YT.Player(host, {
        height: "1",
        width: "1",
        videoId: "",
        playerVars: {
          autoplay: 0,
          controls: 0,
          modestbranding: 1,
          rel: 0,
          iv_load_policy: 3,
          playsinline: 1,
        },
        events: {
          onReady: () => {
            // Apply our cached volume so the first track plays at the
            // user's last-set level rather than YT's default.
            try {
              player.setVolume(ytVolume);
            } catch {
              // Player not fully ready in some race scenarios — ignore.
            }
          },
          onStateChange: (event) => {
            // YT state codes: -1 unstarted, 0 ended, 1 playing,
            // 2 paused, 3 buffering, 5 cued.
            if (event.data === 1) {
              setYtIsPlaying(true);
              // getDuration is unreliable until PLAYING fires for the
              // first time — pull it now.
              try {
                const seconds = player.getDuration();
                if (seconds > 0) setYtDurationMs(Math.floor(seconds * 1000));
              } catch {
                // ignore
              }
            } else if (event.data === 2) {
              setYtIsPlaying(false);
            } else if (event.data === 0) {
              setYtIsPlaying(false);
              advanceYtRef.current();
            }
          },
          onError: (event) => {
            // YT error codes:
            //   2   invalid parameter (bad video id)
            //   5   HTML5 player error
            //   100 video not found / private / removed
            //   101 owner disabled embedded playback
            //   150 same as 101 (just a different surface)
            //
            // 100/101/150 are per-video and there's nothing the user
            // can do client-side, so we toast a specific reason AND
            // auto-advance to the next queue item — otherwise the
            // player gets permanently stuck on an unplayable track.
            const code = event.data;
            let key:
              | "playback.notEmbeddable"
              | "playback.videoUnavailable"
              | "playback.cantLoad" = "playback.cantLoad";
            if (code === 101 || code === 150) key = "playback.notEmbeddable";
            else if (code === 100) key = "playback.videoUnavailable";
            showError(t(key));
            if (code === 100 || code === 101 || code === 150) {
              // Tiny delay so the toast registers before the next
              // track's onStateChange fires and starts the new track.
              setTimeout(() => advanceYtRef.current(), 200);
            }
          },
        },
      });
      ytPlayerRef.current = player;

      // Polling loop. PLAY_PROGRESS-style updates aren't built in, so
      // we sample getCurrentTime every 250ms while playing. Cheap and
      // synchronous in the iframe API.
      progressTimer = setInterval(() => {
        const p = ytPlayerRef.current;
        if (!p) return;
        try {
          const state = p.getPlayerState();
          if (state === 1) {
            const seconds = p.getCurrentTime();
            setYtProgressMs(Math.floor(seconds * 1000));
          }
        } catch {
          // Transient errors during destruction or unloaded states.
        }
      }, 250);
    };

    if (window.YT?.Player) {
      queueMicrotask(initPlayer);
    } else {
      // Loading the iframe API also installs the global ready callback;
      // chain into our init() once it fires.
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof previous === "function") previous();
        initPlayer();
      };
      scriptEl = document.createElement("script");
      scriptEl.src = "https://www.youtube.com/iframe_api";
      scriptEl.async = true;
      document.body.appendChild(scriptEl);
    }

    return () => {
      cancelled = true;
      if (progressTimer) clearInterval(progressTimer);
      if (ytPlayerRef.current) {
        try {
          ytPlayerRef.current.destroy();
        } catch {
          // Already destroyed — ignore.
        }
        ytPlayerRef.current = null;
      }
      setYtTrack(null);
      setYtIsPlaying(false);
      setYtProgressMs(0);
      setYtDurationMs(0);
    };
    // ytVolume intentionally omitted — re-running this effect every
    // volume change would tear down and recreate the iframe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, t]);

  useEffect(() => {
    if (mode !== "free") return;
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.preload = "none";
    const onPlay = () => {
      setPreviewIsPlaying(true);
      if (!audioCtxRef.current) {
        try {
          const Ctor: typeof AudioContext | undefined =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
          if (!Ctor) return;
          const ctx = new Ctor();
          const source = ctx.createMediaElementSource(audio);
          const a = ctx.createAnalyser();
          a.fftSize = 128;
          a.smoothingTimeConstant = 0.78;
          source.connect(a);
          a.connect(ctx.destination);
          audioCtxRef.current = ctx;
          setAnalyser(a);
        } catch (e) {
          console.warn("[player] WebAudio unavailable:", e);
        }
      }
      void audioCtxRef.current?.resume();
    };
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", () => setPreviewIsPlaying(false));
    audio.addEventListener("ended", () => {
      setPreviewIsPlaying(false);
      // Auto-advance to the next track in the queue if there is one.
      // advancePreviewRef wraps the latest closure so we don't restart this
      // listener on every queue update.
      advancePreviewRef.current();
    });
    audioRef.current = audio;
    return () => {
      audio.pause();
      audio.removeEventListener("play", onPlay);
      audio.src = "";
      audioRef.current = null;
      void audioCtxRef.current?.close();
      audioCtxRef.current = null;
      setAnalyser(null);
    };
  }, [mode]);

  // ─── SDK (premium) ───
  const playerRef = useRef<Spotify.Player | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const accessTokenRef = useRef<string | undefined>(undefined);
  accessTokenRef.current = accessToken;

  useEffect(() => {
    if (mode !== "premium" || !accessToken) return;
    let disposed = false;
    let player: Spotify.Player | null = null;

    function init() {
      if (disposed || !window.Spotify) return;
      player = new window.Spotify.Player({
        name: "moodymusic web",
        getOAuthToken: (cb) => cb(accessTokenRef.current ?? ""),
        volume: 0.7,
      });
      player.addListener("ready", ({ device_id }) => {
        deviceIdRef.current = device_id;
      });
      player.addListener("not_ready", () => {
        deviceIdRef.current = null;
      });
      // SDK fires this fast when our local device's state changes; we don't
      // mirror it directly into spotifyState (the next poll will), but
      // having the listener avoids the SDK warning.
      player.addListener("player_state_changed", () => {});
      player.addListener("authentication_error", (e) =>
        console.warn("[player] SDK auth error:", e.message),
      );
      player.addListener("account_error", (e) =>
        console.warn("[player] SDK account error:", e.message),
      );
      void player.connect();
      playerRef.current = player;
    }

    if (window.Spotify) {
      init();
    } else {
      window.onSpotifyWebPlaybackSDKReady = init;
      const script = document.createElement("script");
      script.src = "https://sdk.scdn.co/spotify-player.js";
      script.async = true;
      document.body.appendChild(script);
    }
    return () => {
      disposed = true;
      if (player) player.disconnect();
      playerRef.current = null;
      deviceIdRef.current = null;
    };
  }, [mode, accessToken]);

  // ─── Merged view ───
  // Widget (SoundCloud) wins as soon as a track is loaded since SoundCloud
  // sessions never have Spotify Connect state at all. Otherwise preview
  // wins while it's actively playing, falling through to Spotify Connect
  // state.
  const merged = useMemo(() => {
    if (mode === "widget" && widgetTrack) {
      return {
        current: widgetTrack,
        isPlaying: widgetIsPlaying,
        // Widget gives us position via PLAY_PROGRESS events; we just
        // surface that directly. progressBaseAt + extrapolation aren't
        // needed because PLAY_PROGRESS fires every ~250ms.
        progressMsBase: widgetProgressMs,
        progressBaseAt: now,
        durationMs: widgetDurationMs || widgetTrack.duration_ms || 0,
        volumePercent: widgetVolume,
        deviceName: "SoundCloud Widget",
        source: "widget" as const,
      };
    }
    if (mode === "yt-widget" && ytTrack) {
      return {
        current: ytTrack,
        isPlaying: ytIsPlaying,
        // YouTube doesn't push progress events; we sample
        // getCurrentTime in the polling loop above. progressBaseAt is
        // set to `now` so the smoothing extrapolation in progressMs
        // doesn't double-count the elapsed time.
        progressMsBase: ytProgressMs,
        progressBaseAt: now,
        durationMs: ytDurationMs || ytTrack.duration_ms || 0,
        volumePercent: ytVolume,
        deviceName: "YouTube Player",
        source: "yt-widget" as const,
      };
    }
    if (previewIsPlaying && previewTrack) {
      return {
        current: previewTrack,
        isPlaying: true,
        progressMsBase: audioRef.current
          ? audioRef.current.currentTime * 1000
          : 0,
        progressBaseAt: now,
        durationMs: 30_000,
        volumePercent: Math.round((audioRef.current?.volume ?? 0.7) * 100),
        deviceName: "This browser (preview)",
        source: "preview" as const,
      };
    }
    if (spotifyState?.item) {
      return {
        current: spotifyState.item,
        isPlaying: spotifyState.is_playing,
        progressMsBase: spotifyState.progress_ms ?? 0,
        // Local clock at the moment we received this state — see
        // polledAtRef comment above for why we don't use Spotify's
        // `timestamp` field here.
        progressBaseAt: polledAtRef.current,
        durationMs: spotifyState.item.duration_ms,
        volumePercent: spotifyState.device?.volume_percent ?? 0,
        deviceName: spotifyState.device?.name ?? null,
        source: "spotify" as const,
      };
    }
    return null;
  }, [
    mode,
    widgetTrack,
    widgetIsPlaying,
    widgetProgressMs,
    widgetDurationMs,
    widgetVolume,
    ytTrack,
    ytIsPlaying,
    ytProgressMs,
    ytDurationMs,
    ytVolume,
    previewIsPlaying,
    previewTrack,
    spotifyState,
    now,
  ]);

  // Smoothed progress: while playing, advance by elapsed wall-clock since
  // the base timestamp. While paused, freeze at the base. Cap at duration.
  const progressMs = useMemo(() => {
    if (!merged) return 0;
    if (!merged.isPlaying) return merged.progressMsBase;
    const elapsed = now - merged.progressBaseAt;
    return Math.min(merged.durationMs, merged.progressMsBase + elapsed);
  }, [merged, now]);

  // ─── Actions ───
  const markOptimistic = () => {
    optimisticUntilRef.current = Date.now() + 1200;
  };

  // Errors fire through the global toast emitter (lib/toast). This used to
  // be a local state + custom toast; the unified system means a Spotify
  // failure looks the same as a Mongo or React Query failure.
  const dismissError = useCallback(() => {
    // Kept on the public surface for callers that previously cleared the
    // player error inline; the toast is auto-dismissed by the renderer
    // now, so this is effectively a no-op.
  }, []);

  const isPlayable = useCallback(
    (track: SpotifyTrack) => {
      if (mode === "premium") return true;
      if (mode === "free") return Boolean(track.preview_url);
      // Widget / yt-widget play anything public — the track only needs
      // to exist. Each widget API gracefully surfaces an ERROR event
      // for takedowns / private content, which we toast.
      if (mode === "widget" || mode === "yt-widget") return true;
      return false;
    },
    [mode],
  );

  const playPreviewByIndex = useCallback(
    async (queue: SpotifyTrack[], index: number) => {
      const audio = audioRef.current;
      if (!audio) {
        showError(t("playback.notReady"));
        return;
      }
      // Skip past tracks with no preview_url (Spotify's API has been
      // returning more nulls under the new dev-mode policy). If no
      // playable track remains, surface a single error instead of
      // silently doing nothing.
      let i = index;
      while (i < queue.length && !queue[i]?.preview_url) i++;
      if (i >= queue.length) {
        showError(t("playback.noPlayable"));
        return;
      }
      const track = queue[i]!;
      previewQueueRef.current = queue;
      previewIndexRef.current = i;
      audio.src = track.preview_url!;
      setPreviewTrack(track);
      try {
        await audio.play();
      } catch (e) {
        await reportAudioFailure(audio, e);
      }
    },
    [t, reportAudioFailure],
  );

  // Wired into the audio 'ended' listener via a ref so the listener never
  // closes over stale state. Called when the current preview ends.
  advancePreviewRef.current = () => {
    const queue = previewQueueRef.current;
    const next = previewIndexRef.current + 1;
    if (queue.length === 0 || next >= queue.length) return;
    void playPreviewByIndex(queue, next);
  };

  const playPreview = useCallback(
    async (track: SpotifyTrack, queue?: SpotifyTrack[]) => {
      const audio = audioRef.current;
      if (!audio) {
        showError(t("playback.notReady"));
        return;
      }
      // Toggle: clicking the currently-playing card pauses it.
      if (previewTrack?.id === track.id && !audio.paused) {
        audio.pause();
        return;
      }
      const list = queue ?? [track];
      const idx = Math.max(
        0,
        list.findIndex((t) => t.id === track.id),
      );
      await playPreviewByIndex(list, idx);
    },
    [previewTrack, playPreviewByIndex, t],
  );

  // ─── Widget actions (SoundCloud) ───
  // Translate our (track, queue) pair into Widget API calls. The widget
  // takes a SoundCloud API track URL like
  // `https://api.soundcloud.com/tracks/<id>`; the query-string
  // parameters control auto-play and styling. We pass auto_play=true so
  // load() also kicks off playback in one round-trip.
  const playWidgetByIndex = useCallback(
    (queue: SpotifyTrack[], index: number) => {
      const widget = widgetRef.current;
      if (!widget) {
        showError(t("playback.notReady"));
        return;
      }
      if (index < 0 || index >= queue.length) return;
      const track = queue[index]!;
      widgetQueueRef.current = queue;
      widgetIndexRef.current = index;
      const trackUrl = `https://api.soundcloud.com/tracks/${encodeURIComponent(track.id)}`;
      widget.load(trackUrl, { auto_play: true, show_artwork: false });
      setWidgetTrack(track);
      // Pull the canonical duration once load() has resolved. The PLAY
      // event arrives ~one tick after load(); waiting for it would race
      // the first PLAY_PROGRESS update. Polling getDuration via the
      // widget API is simpler and idempotent.
      const tryDuration = (attempt = 0) => {
        if (!widgetRef.current) return;
        widgetRef.current.getDuration((ms) => {
          if (ms > 0) setWidgetDurationMs(ms);
          else if (attempt < 5) setTimeout(() => tryDuration(attempt + 1), 200);
        });
      };
      tryDuration();
    },
    [t],
  );

  // Re-bound to the latest closure on every render so the FINISH
  // callback (installed once at widget init) picks up queue updates.
  advanceWidgetRef.current = () => {
    const queue = widgetQueueRef.current;
    const next = widgetIndexRef.current + 1;
    if (next >= queue.length) return;
    playWidgetByIndex(queue, next);
  };

  const playWidget = useCallback(
    (track: SpotifyTrack, queue?: SpotifyTrack[]) => {
      const widget = widgetRef.current;
      if (!widget) {
        showError(t("playback.notReady"));
        return;
      }
      // Toggle: clicking the currently-playing card pauses it.
      if (widgetTrack?.id === track.id && widgetIsPlaying) {
        widget.pause();
        return;
      }
      // Resume: same track but paused → just play.
      if (widgetTrack?.id === track.id && !widgetIsPlaying) {
        widget.play();
        return;
      }
      const list = queue ?? [track];
      const idx = Math.max(
        0,
        list.findIndex((tr) => tr.id === track.id),
      );
      playWidgetByIndex(list, idx);
    },
    [widgetTrack, widgetIsPlaying, playWidgetByIndex, t],
  );

  // ─── YouTube widget actions ───
  const playYtByIndex = useCallback(
    (queue: SpotifyTrack[], index: number) => {
      const player = ytPlayerRef.current;
      if (!player) {
        showError(t("playback.notReady"));
        return;
      }
      if (index < 0 || index >= queue.length) return;
      const track = queue[index]!;
      ytQueueRef.current = queue;
      ytIndexRef.current = index;
      // SpotifyTrack.id holds the YouTube videoId (see lib/youtube.ts
      // adaptVideo).
      try {
        player.loadVideoById(track.id);
      } catch (e) {
        console.warn("[player] yt loadVideoById failed:", e);
        showError(t("playback.cantStart"));
        return;
      }
      setYtTrack(track);
      // Optimistically seed duration from the SpotifyTrack metadata so
      // the slider has a sensible max while we wait for the first
      // PLAYING event to call getDuration() for real.
      if (track.duration_ms > 0) setYtDurationMs(track.duration_ms);
    },
    [t],
  );

  // Re-bound to the latest closure on every render so the ENDED handler
  // (installed once at player init) always picks up queue updates.
  advanceYtRef.current = () => {
    const queue = ytQueueRef.current;
    const next = ytIndexRef.current + 1;
    if (next >= queue.length) return;
    playYtByIndex(queue, next);
  };

  const playYt = useCallback(
    (track: SpotifyTrack, queue?: SpotifyTrack[]) => {
      const player = ytPlayerRef.current;
      if (!player) {
        showError(t("playback.notReady"));
        return;
      }
      // Toggle / resume on same-track click.
      if (ytTrack?.id === track.id && ytIsPlaying) {
        player.pauseVideo();
        return;
      }
      if (ytTrack?.id === track.id && !ytIsPlaying) {
        player.playVideo();
        return;
      }
      const list = queue ?? [track];
      const idx = Math.max(
        0,
        list.findIndex((tr) => tr.id === track.id),
      );
      playYtByIndex(list, idx);
    },
    [ytTrack, ytIsPlaying, playYtByIndex, t],
  );

  // Pick the best Spotify Connect target for a play() call. The order is:
  //   1. Active device (DANNY, phone, desktop) — keep playback where the
  //      user already has it. Avoids hijacking their speakers when they
  //      click a song in this tab.
  //   2. Our own SDK device — if no other device is active, route to the
  //      browser tab so something audible happens.
  // Returns null if the SDK hasn't reported ready AND there's no active
  // device; the caller surfaces a "no device" error.
  const pickPlaybackDevice = useCallback((): string | null => {
    const activeId = spotifyState?.device?.id ?? null;
    if (activeId) return activeId;
    return deviceIdRef.current;
  }, [spotifyState]);

  const play = useCallback(
    async (
      track: SpotifyTrack,
      queue?: SpotifyTrack[],
      source: "library" | "mood" | "footer" | "external" | "unknown" =
        "unknown",
    ) => {
      if (mode === "widget") {
        playWidget(track, queue);
        return;
      }
      if (mode === "yt-widget") {
        playYt(track, queue);
        return;
      }
      if (mode === "free") {
        await playPreview(track, queue);
        return;
      }
      if (mode === null) {
        showError(t("playback.sessionLoading"));
        return;
      }
      // Premium
      markOptimistic();
      // Stop the local preview if it was running from a previous click.
      if (audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause();
        setPreviewTrack(null);
      }
      // Don't bail out if pickPlaybackDevice() returns null — the SDK
      // might not have fired its `ready` event yet on first click. The
      // server route falls back to /me/player/devices in that case so
      // the play still works once the SDK is registered.
      const deviceId = pickPlaybackDevice();
      // Send the rest of the visible list as the play queue. Spotify
      // auto-advances through the uris when each track ends — that's the
      // "play next song when current finishes" behaviour for free without
      // any client-side timer.
      const fullQueue = queue ?? [track];
      const startIdx = Math.max(
        0,
        fullQueue.findIndex((t) => t.id === track.id),
      );
      const uris = fullQueue.slice(startIdx).map((t) => t.uri);
      try {
        const res = await postControl({
          action: "play",
          uris,
          ...(deviceId ? { deviceId } : {}),
          source,
          trackInfo: {
            id: track.id,
            name: track.name,
            artists: track.artists.map((a) => a.name),
          },
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `Play failed (${res.status})`);
        }
      } catch (e) {
        showError(
          e instanceof Error ? e.message : t("playback.notAccepted"),
        );
      }
    },
    [mode, playWidget, playYt, playPreview, pickPlaybackDevice, t],
  );

  const pause = useCallback(async () => {
    if (merged?.source === "widget") {
      widgetRef.current?.pause();
      return;
    }
    if (merged?.source === "yt-widget") {
      ytPlayerRef.current?.pauseVideo();
      return;
    }
    if (merged?.source === "preview") {
      audioRef.current?.pause();
      return;
    }
    markOptimistic();
    setSpotifyState((s) => (s ? { ...s, is_playing: false } : s));
    await postControl({ action: "pause" });
  }, [merged]);

  const resume = useCallback(async () => {
    if (merged?.source === "widget") {
      widgetRef.current?.play();
      return;
    }
    if (merged?.source === "yt-widget") {
      ytPlayerRef.current?.playVideo();
      return;
    }
    if (merged?.source === "preview") {
      try {
        await audioRef.current?.play();
      } catch {
        /* ignore */
      }
      return;
    }
    markOptimistic();
    setSpotifyState((s) => (s ? { ...s, is_playing: true } : s));
    await postControl({ action: "resume" });
  }, [merged]);

  const toggle = useCallback(async () => {
    if (!merged) return;
    if (merged.isPlaying) await pause();
    else await resume();
  }, [merged, pause, resume]);

  const next = useCallback(async () => {
    // Widget mode walks the queue we cached when play() was called.
    if (merged?.source === "widget") {
      const queue = widgetQueueRef.current;
      const i = widgetIndexRef.current + 1;
      if (i >= queue.length) return;
      playWidgetByIndex(queue, i);
      return;
    }
    if (merged?.source === "yt-widget") {
      const queue = ytQueueRef.current;
      const i = ytIndexRef.current + 1;
      if (i >= queue.length) return;
      playYtByIndex(queue, i);
      return;
    }
    // Preview mode walks the local queue. Without this branch the next
    // button would do nothing for free accounts (the postControl call
    // requires Premium + an active device).
    if (merged?.source === "preview") {
      const queue = previewQueueRef.current;
      let i = previewIndexRef.current + 1;
      while (i < queue.length && !queue[i]?.preview_url) i++;
      if (i >= queue.length) return;
      void playPreviewByIndex(queue, i);
      return;
    }
    markOptimistic();
    await postControl({ action: "next" });
  }, [merged, playPreviewByIndex, playWidgetByIndex, playYtByIndex]);

  const previous = useCallback(async () => {
    if (merged?.source === "widget") {
      const queue = widgetQueueRef.current;
      const i = widgetIndexRef.current - 1;
      if (i < 0) return;
      playWidgetByIndex(queue, i);
      return;
    }
    if (merged?.source === "yt-widget") {
      const queue = ytQueueRef.current;
      const i = ytIndexRef.current - 1;
      if (i < 0) return;
      playYtByIndex(queue, i);
      return;
    }
    // Preview mode walks the local queue backward.
    if (merged?.source === "preview") {
      const queue = previewQueueRef.current;
      let i = previewIndexRef.current - 1;
      while (i >= 0 && !queue[i]?.preview_url) i--;
      if (i < 0) return;
      void playPreviewByIndex(queue, i);
      return;
    }
    markOptimistic();
    // Spotify's /me/player/previous restarts the current track if more
    // than ~3s have elapsed; only the second press actually skips back.
    // Send twice in that case so the button matches user expectation:
    // "previous" always means "previous track".
    if (progressMs > 3000) {
      await postControl({ action: "previous" });
      // Tiny delay so Spotify processes the first call (which resets
      // progress to 0) before the second call walks the queue back.
      await new Promise((r) => setTimeout(r, 90));
    }
    await postControl({ action: "previous" });
  }, [merged, playPreviewByIndex, playWidgetByIndex, playYtByIndex, progressMs]);

  const seek = useCallback(
    async (ms: number) => {
      if (merged?.source === "widget") {
        widgetRef.current?.seekTo(Math.max(0, ms));
        // Optimistically reflect the seek so the slider doesn't snap
        // back while waiting for the next PLAY_PROGRESS event.
        setWidgetProgressMs(Math.max(0, ms));
        return;
      }
      if (merged?.source === "yt-widget") {
        // YT.seekTo takes seconds, not ms.
        ytPlayerRef.current?.seekTo(Math.max(0, ms / 1000), true);
        setYtProgressMs(Math.max(0, ms));
        return;
      }
      if (merged?.source === "preview") {
        const audio = audioRef.current;
        if (audio) audio.currentTime = Math.max(0, ms / 1000);
        return;
      }
      markOptimistic();
      // Optimistically reflect the seek.
      setSpotifyState((s) =>
        s ? { ...s, progress_ms: ms, timestamp: Date.now() } : s,
      );
      await postControl({ action: "seek", positionMs: Math.max(0, ms) });
    },
    [merged],
  );

  const setVolumeAction = useCallback(
    async (percent: number) => {
      const clamped = Math.max(0, Math.min(100, Math.round(percent)));
      if (merged?.source === "widget") {
        widgetRef.current?.setVolume(clamped);
        setWidgetVolume(clamped);
        return;
      }
      if (merged?.source === "yt-widget") {
        ytPlayerRef.current?.setVolume(clamped);
        setYtVolume(clamped);
        return;
      }
      if (merged?.source === "preview") {
        if (audioRef.current) audioRef.current.volume = clamped / 100;
        return;
      }
      markOptimistic();
      setSpotifyState((s) =>
        s && s.device
          ? { ...s, device: { ...s.device, volume_percent: clamped } }
          : s,
      );
      await postControl({ action: "volume", percent: clamped });
    },
    [merged],
  );

  const stopPreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setPreviewTrack(null);
    setPreviewIsPlaying(false);
  }, []);

  const value = useMemo<PlayerContextValue>(() => {
    const canControlSpotify =
      mode === "premium" && Boolean(spotifyState?.device?.id);
    return {
      current: merged?.current ?? null,
      isPlaying: merged?.isPlaying ?? false,
      progressMs,
      durationMs: merged?.durationMs ?? 0,
      volumePercent: merged?.volumePercent ?? 0,
      deviceName: merged?.deviceName ?? null,
      source: merged?.source ?? null,
      mode,
      canControlSpotify,
      isPlayable,
      dismissError,
      play,
      toggle,
      pause,
      resume,
      next,
      previous,
      seek,
      setVolume: setVolumeAction,
      stopPreview,
      analyser,
    };
  }, [
    merged,
    progressMs,
    mode,
    spotifyState,
    isPlayable,
    dismissError,
    play,
    toggle,
    pause,
    resume,
    next,
    previous,
    seek,
    setVolumeAction,
    stopPreview,
    analyser,
  ]);

  return (
    <Ctx.Provider value={value}>
      {/* SoundCloud Widget host. Always rendered when the user is in
       * widget mode so the Widget JS API has an iframe to attach to;
       * the iframe is positioned off-screen because we drive playback
       * via the API rather than the widget's own UI. The src is a
       * placeholder track id — playWidget() calls widget.load() with
       * the real URL when the user picks a song. */}
      {mode === "widget" && (
        <iframe
          ref={widgetIframeRef}
          src="https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/0&auto_play=false&visual=false"
          style={{
            position: "fixed",
            left: -9999,
            top: -9999,
            width: 1,
            height: 1,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
          allow="autoplay"
          title="SoundCloud Widget Player"
          aria-hidden
        />
      )}
      {/* YouTube IFrame Player host. YT.Player REPLACES the inner div
       * with an iframe in place — React doesn't know about this swap,
       * so if React ever tries to unmount or re-key the inner div it
       * runs into "removeChild: not a child of this node" because the
       * actual DOM node is now the iframe. We wrap the host in an
       * outer div that React owns; React only ever mutates the wrapper,
       * and the YT-managed inner node is treated as opaque content. */}
      {mode === "yt-widget" && (
        <div
          style={{
            position: "fixed",
            left: -9999,
            top: -9999,
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: "none",
          }}
          aria-hidden
        >
          <div ref={ytHostRef} />
        </div>
      )}
      {children}
    </Ctx.Provider>
  );
}

export function usePlayer() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePlayer must be used inside PlayerProvider");
  return ctx;
}
