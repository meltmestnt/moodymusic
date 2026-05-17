"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSession } from "next-auth/react";
import { IconButton, Slider, Text, Theme } from "@radix-ui/themes";
import {
  Cross1Icon,
  PauseIcon,
  PlayIcon,
  SpeakerLoudIcon,
  TrackNextIcon,
  TrackPreviousIcon,
} from "@radix-ui/react-icons";
import { usePlayer } from "@/lib/player-context";
import { useI18n } from "@/lib/i18n";
import { originFromClick, useTrackInfo } from "@/lib/track-info-context";
import { FavoriteButton } from "./FavoriteButton";

function formatMs(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function NowPlayingBar() {
  const player = usePlayer();
  const { t } = useI18n();
  const trackInfo = useTrackInfo();
  const { data: session } = useSession();
  const {
    current,
    isPlaying,
    progressMs,
    durationMs,
    volumePercent,
    deviceName,
    source,
    canControlSpotify,
    toggle,
    next,
    previous,
    seek,
    setVolume,
    stopPreview,
  } = player;

  // Local seek state that takes over the slider's `value` while the user
  // is interacting. Without this, progressMs ticks every 250ms and clobbers
  // the drag — the thumb snaps back to the playhead and clicks-on-track
  // appear to do nothing. We keep the drag value briefly after release so
  // the slider doesn't flash back to the pre-seek position before the
  // optimistic state in player-context catches up.
  const [seekMs, setSeekMs] = useState<number | null>(null);
  const seekResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The bar is rendered into a Portal at document.body so its z-index
  // isn't trapped by the Radix Themes wrapper's stacking context. Without
  // this, dialog overlays (track-info, similar-search) cover the bar even
  // at z-index 9999 because they portal directly to body and beat the
  // theme container's stacking context.
  const [portalReady, setPortalReady] = useState(false);
  useEffect(() => setPortalReady(true), []);

  if (!current) return null;
  if (!portalReady) return null;

  const art = current.album.images[0]?.url;
  const artistNames = current.artists.map((a) => a.name).join(", ");

  // Three local-control modes can drive the controls without going
  // through Spotify Connect:
  //   • previewMode: HTMLAudioElement (Spotify free preview, Deezer)
  //   • widgetMode:  SoundCloud iframe Widget — play/pause/seek/volume
  //                  all flow through the Widget API, which works
  //                  whether or not the user has any subscription.
  // Spotify Premium with Connect is the third path; everything else is
  // disabled (read-only mirror of someone else's device).
  const previewMode = source === "preview";
  const widgetMode = source === "widget" || source === "yt-widget";
  const localMode = previewMode || widgetMode;
  const controlEnabled = localMode || canControlSpotify;
  const seekEnabled = controlEnabled && durationMs > 0;
  const volumeEnabled = localMode || canControlSpotify;
  // Show the close (×) button only when we own playback locally — for
  // remote Spotify Connect playback there's nothing to "close" from here.
  // Widget mode is excluded because there's no equivalent of "stop and
  // discard" — the user can just pause via the play/pause button.
  const showClose = previewMode;

  const subline: string[] = [artistNames];
  if (deviceName) {
    subline.push(
      previewMode
        ? t("nowPlaying.preview")
        : t("nowPlaying.on", { device: deviceName }),
    );
  }

  // Stop pointer-down from bubbling to Radix's DismissableLayer, which
  // closes any open dialog when the user clicks "outside" of it. Without
  // this guard, clicking play/pause/seek while a track-info modal is
  // open would dismiss the modal because the bar is portaled to body —
  // and therefore not a DOM descendant of the dialog content from
  // Radix's perspective.
  //
  // BUBBLE phase, not capture: capture-phase stopPropagation here would
  // also block inner controls (Slider, IconButton) from receiving the
  // event in the first place — that was the original "everything except
  // play/pause is dead" bug. With bubble, inner controls handle the
  // event normally, and we only stop it from reaching the document-
  // level dismiss listener.
  const stopOutsideDismiss = (e: React.PointerEvent | React.MouseEvent) => {
    e.stopPropagation();
  };

  return createPortal(
    <Theme
      appearance="dark"
      accentColor="crimson"
      radius="large"
      scaling="100%"
      hasBackground={false}
      className="now-playing-portal-shell"
    >
      <div
        className="now-playing-bar"
        role="region"
        aria-label={t("nowPlaying.region")}
        onPointerDown={stopOutsideDismiss}
        onMouseDown={stopOutsideDismiss}
      >
        {(() => {
        const inModal = trackInfo.selected?.id === current.id;
        const isOriginArt =
          trackInfo.originatingId === current.id &&
          trackInfo.originatingSource === "footer-art";
        const isOriginText =
          trackInfo.originatingId === current.id &&
          trackInfo.originatingSource === "footer-text";
        const artVtName =
          isOriginArt && !inModal ? `track-card-${current.id}` : undefined;
        const textVtName =
          isOriginText && !inModal ? `track-card-${current.id}` : undefined;
        return (
          <>
            <button
              type="button"
              className="now-playing-art now-playing-art-btn"
              data-playing={isPlaying}
              data-vt-active={isOriginArt || undefined}
              style={{ viewTransitionName: artVtName }}
              onClick={(e) =>
                trackInfo.open(current, "footer-art", originFromClick(e))
              }
              aria-label={t("trackInfo.open", { name: current.name })}
            >
              {art ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={art} alt="" />
              ) : null}
            </button>
            <button
              type="button"
              className="now-playing-text now-playing-text-btn"
              data-vt-active={isOriginText || undefined}
              style={{ viewTransitionName: textVtName }}
              onClick={(e) =>
                trackInfo.open(current, "footer-text", originFromClick(e))
              }
              aria-label={t("trackInfo.open", { name: current.name })}
            >
              <Text size="2" weight="bold" as="div" truncate>
                {current.name}
              </Text>
              <Text size="1" color="gray" as="div" truncate>
                {subline.join(" · ")}
              </Text>
            </button>
          </>
        );
      })()}

      {/* Two FavoriteButton renders, one shown per viewport. The component
        * reads its on/off state from the favorites context, so both
        * instances stay in sync with the underlying Spotify save state.
        * Desktop/laptop position: between the title and the seek bar
        * (matches Spotify's own layout). Mobile position: tucked into the
        * controls block so the heart sits next to play/pause once the
        * seek + volume sliders disappear. Hidden for anon users — favorites
        * require an account to persist against. */}
      {session && (
        <div className="now-playing-favorite now-playing-favorite-wide">
          <FavoriteButton
            trackId={current.id}
            trackName={current.name}
            size="2"
            variant="ghost"
          />
        </div>
      )}

      <div className="now-playing-seek">
        <Text size="1" color="gray" className="now-playing-time">
          {formatMs(progressMs)}
        </Text>
        <Slider
          size="1"
          radius="full"
          min={0}
          max={Math.max(1, durationMs)}
          value={[Math.min(seekMs ?? progressMs, durationMs)]}
          onValueChange={(v) => {
            const ms = v[0];
            if (typeof ms === "number") setSeekMs(ms);
          }}
          onValueCommit={(v) => {
            const ms = v[0];
            if (typeof ms === "number") void seek(ms);
            if (seekResetRef.current) clearTimeout(seekResetRef.current);
            // Hold the seek value briefly so the slider doesn't snap back
            // to the pre-seek progress while the optimistic state ripples
            // through the tick cycle.
            seekResetRef.current = setTimeout(() => setSeekMs(null), 300);
          }}
          disabled={!seekEnabled}
          style={{ flex: 1 }}
        />
        <Text size="1" color="gray" className="now-playing-time">
          {formatMs(durationMs)}
        </Text>
      </div>

      <div className="now-playing-controls">
        {session && (
          <div className="now-playing-favorite now-playing-favorite-narrow">
            <FavoriteButton
              trackId={current.id}
              trackName={current.name}
              size="2"
              variant="ghost"
            />
          </div>
        )}
        <IconButton
          size="2"
          variant="ghost"
          color="gray"
          onClick={() => void previous()}
          disabled={!controlEnabled}
          aria-label={t("nowPlaying.previous")}
        >
          <TrackPreviousIcon />
        </IconButton>
        <IconButton
          size="3"
          onClick={() => void toggle()}
          disabled={!controlEnabled}
          aria-label={isPlaying ? t("nowPlaying.pause") : t("nowPlaying.play")}
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </IconButton>
        <IconButton
          size="2"
          variant="ghost"
          color="gray"
          onClick={() => void next()}
          disabled={!controlEnabled}
          aria-label={t("nowPlaying.next")}
        >
          <TrackNextIcon />
        </IconButton>
      </div>

      <div className="now-playing-volume">
        <SpeakerLoudIcon
          style={{ color: "var(--gray-10)", flexShrink: 0 }}
          aria-hidden
        />
        <Slider
          size="1"
          radius="full"
          min={0}
          max={100}
          value={[volumePercent]}
          onValueChange={(v) => {
            const p = v[0];
            if (typeof p === "number") void setVolume(p);
          }}
          disabled={!volumeEnabled}
          style={{ width: 100 }}
          aria-label={t("nowPlaying.volume")}
        />
      </div>

        {showClose && (
          <IconButton
            size="2"
            variant="soft"
            color="gray"
            onClick={stopPreview}
            aria-label={t("nowPlaying.stop")}
          >
            <Cross1Icon />
          </IconButton>
        )}
      </div>
    </Theme>,
    document.body,
  );
}
