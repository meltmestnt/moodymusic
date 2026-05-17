import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { refreshAndPersistSoundCloud } from "@/lib/auth-refresh";

// SoundCloud stream proxy.
//
// Two-step resolve:
//
//   1. GET /tracks/{id}/streams (plural)  →  JSON listing the available
//      progressive + HLS URLs. We pick http_mp3_128_url (most universally
//      playable; ~128kbps mp3 served as a single file). The legacy
//      /tracks/{id}/stream (singular) returned a 302 to a CDN URL but is
//      now flaky — it returns 406 Not Acceptable for many requests
//      regardless of Accept header, since SoundCloud started routing
//      newer apps through /streams.
//
//   2. GET <signed CDN url>  →  audio bytes. The CDN URL embeds its own
//      signature so the upstream call needs no Authorization header
//      (passing one back actually makes the CDN 403). We forward the
//      browser's Range header so scrubbing works.
//
// Both legs run server-side so the browser sees a same-origin URL and
// audio bytes — no CORS, no auth-header leaking, no JSON-parsed-as-audio
// surprises.
//
// All error responses carry { code, error }: `code` is a stable i18n
// key (see lib/i18n.tsx playback.* / sc.*); `error` is an English
// fallback for logs. Don't change codes without updating the dict.

const TRACKS_BASE = "https://api.soundcloud.com/tracks";

interface StreamsManifest {
  http_mp3_128_url?: string;
  hls_mp3_128_url?: string;
  preview_mp3_128_url?: string;
  // SoundCloud occasionally adds new fields; keep the index access loose.
  [k: string]: string | undefined;
}

function jsonError(
  code: string,
  message: string,
  status: number,
  extra?: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({ code, error: message, ...(extra ?? {}) }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

// Map an upstream HTTP status from either /streams or the CDN into our
// stable error-code set. Both legs surface the same user-facing failures
// (auth expired, app not approved, track gone, rate-limited, etc.), so
// it makes sense to share the mapping.
function classifyUpstream(status: number): {
  code: string;
  message: string;
  forwardStatus: number;
} {
  if (status === 401) {
    return {
      code: "sc.sessionExpired",
      message:
        "Your SoundCloud session expired. Sign out and sign in again to refresh it.",
      forwardStatus: 401,
    };
  }
  if (status === 403) {
    return {
      code: "sc.streamingDenied",
      message:
        "SoundCloud won't stream this track. The app may not be approved for full-track streaming, or this track is region-restricted.",
      forwardStatus: 403,
    };
  }
  if (status === 404) {
    return {
      code: "sc.notFound",
      message: "This track is no longer available on SoundCloud.",
      forwardStatus: 404,
    };
  }
  if (status === 429) {
    return {
      code: "sc.rateLimited",
      message:
        "Hit SoundCloud's rate limit — wait a moment and try again.",
      forwardStatus: 429,
    };
  }
  if (status >= 500) {
    return {
      code: "sc.upstream5xx",
      message:
        "SoundCloud is having a problem on its end. Try again shortly.",
      forwardStatus: 502,
    };
  }
  return {
    code: "sc.refused",
    message: `SoundCloud refused to stream this track (status ${status}).`,
    forwardStatus: 502,
  };
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  // Two paths into this route:
  //   • Signed-in SoundCloud user — try their OAuth token first (a-c),
  //     fall back to the public client_id strategy (d) if that fails.
  //   • Anyone else (anonymous, or signed-in to another provider) — skip
  //     straight to the public client_id flow. Anonymous SC playback is
  //     a deliberate "free tier" feature; we don't 401 here anymore.
  const isScUser = !!session?.accessToken && session.provider === "soundcloud";
  const url = new URL(req.url);
  const id = url.searchParams.get("id")?.trim();
  if (!id || !/^\d+$/.test(id)) {
    return jsonError(
      "sc.invalidId",
      "Couldn't play this track — missing or invalid track id.",
      400,
    );
  }

  // ─── Step 1: resolve to a signed audio URL. ───
  //
  // Auth-strategy ladder. We try, in order, until one returns 200:
  //
  //   a. /streams + Bearer header  — modern OAuth path
  //   b. /streams + OAuth header   — legacy header that some endpoints
  //                                   still require
  //   c. /streams + ?oauth_token=  — very-legacy query-param auth,
  //                                   accepted by older SoundCloud APIs
  //   d. /stream  + ?client_id=    — public, app-credential path; this
  //                                   is what the SoundCloud Widget uses
  //                                   internally and works WITHOUT
  //                                   streaming-API approval for any
  //                                   public track. We hit this last
  //                                   because it returns a 302 to a CDN
  //                                   URL (less ideal than the JSON
  //                                   manifest), but it's the lifeline
  //                                   when the user-token path is gated.
  //
  // Step (c) is mostly cargo-culted at this point — left in because
  // the cost of trying it is one HTTP round-trip and the upside is
  // "playback works for this user."
  type StrategyResult =
    | { kind: "manifest"; res: Response }
    | { kind: "redirect"; url: string };

  async function tryManifestBearer(token: string): Promise<Response> {
    return fetch(`${TRACKS_BASE}/${encodeURIComponent(id ?? "")}/streams`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  }
  async function tryManifestOAuthHeader(token: string): Promise<Response> {
    return fetch(`${TRACKS_BASE}/${encodeURIComponent(id ?? "")}/streams`, {
      headers: {
        Authorization: `OAuth ${token}`,
        Accept: "application/json",
      },
    });
  }
  async function tryManifestQueryParam(token: string): Promise<Response> {
    return fetch(
      `${TRACKS_BASE}/${encodeURIComponent(id ?? "")}/streams?oauth_token=${encodeURIComponent(token)}`,
      { headers: { Accept: "application/json" } },
    );
  }
  // Public client_id flow: /tracks/{id}/stream?client_id=<app_id> —
  // returns a 302 to a CDN URL. Available as long as the track is
  // public, no user OAuth needed.
  async function tryPublicClientId(): Promise<Response | null> {
    const clientId = process.env.SOUNDCLOUD_CLIENT_ID;
    if (!clientId) return null;
    return fetch(
      `${TRACKS_BASE}/${encodeURIComponent(id ?? "")}/stream?client_id=${encodeURIComponent(clientId)}`,
      { redirect: "manual" },
    );
  }

  let strategy: StrategyResult | null = null;
  let lastStatus = 0;
  let lastBody = "";
  let refreshedAccessToken: string | null = null;
  let setCookieHeader: string | null = null;

  // Helper: run a manifest-style fetch and capture status/body for
  // classification if every strategy ends up failing.
  async function runManifest(
    label: string,
    fn: () => Promise<Response>,
  ): Promise<Response | null> {
    try {
      const r = await fn();
      lastStatus = r.status;
      if (r.ok) return r;
      // Read body for diagnostics; clone first so we don't consume the
      // stream we might still want to forward.
      try {
        lastBody = await r.clone().text();
      } catch {
        lastBody = "";
      }
      console.warn(
        `[sc-stream] ${label} non-OK:`,
        r.status,
        lastBody.slice(0, 160),
      );
      return null;
    } catch (e) {
      console.warn(`[sc-stream] ${label} threw:`, e);
      return null;
    }
  }

  // (a-c) only fire when the request came from a signed-in SoundCloud
  // user — anonymous and other-provider sessions skip straight to the
  // public client_id strategy below.
  let r: Response | null = null;
  if (isScUser) {
    // (a) Bearer.
    r = await runManifest("/streams Bearer", () =>
      tryManifestBearer(session!.accessToken!),
    );

    // (a-retry) On 401, refresh inline and retry Bearer once.
    if (!r && lastStatus === 401) {
      console.log("[sc-stream] /streams 401 with cached token, refreshing");
      const refreshed = await refreshAndPersistSoundCloud();
      if (refreshed) {
        refreshedAccessToken = refreshed.accessToken;
        setCookieHeader = refreshed.setCookieHeader;
        r = await runManifest("/streams Bearer (post-refresh)", () =>
          tryManifestBearer(refreshed.accessToken),
        );
      }
    }

    // (b) Legacy OAuth header.
    if (!r) {
      const t = refreshedAccessToken ?? session!.accessToken!;
      r = await runManifest("/streams OAuth-header", () =>
        tryManifestOAuthHeader(t),
      );
    }

    // (c) ?oauth_token= query param.
    if (!r) {
      const t = refreshedAccessToken ?? session!.accessToken!;
      r = await runManifest("/streams ?oauth_token=", () =>
        tryManifestQueryParam(t),
      );
    }
  }

  if (r) {
    strategy = { kind: "manifest", res: r };
  }

  // (d) Public client_id fallback. Only used when ALL user-token paths
  // failed — surfaces full-track audio for public tracks even if our
  // app isn't approved for the streaming API.
  if (!strategy) {
    const publicRes = await tryPublicClientId();
    if (publicRes) {
      // Happy paths from /stream?client_id=:
      //   • 302 with Location → we use that URL as the CDN target
      //   • 200 with body     → already redirected for us; pass through
      const loc = publicRes.headers.get("location");
      if (publicRes.status >= 300 && publicRes.status < 400 && loc) {
        console.log("[sc-stream] using public client_id stream redirect");
        strategy = { kind: "redirect", url: loc };
      } else if (publicRes.ok) {
        // The fetch was set to redirect:"manual", so a 200 here means
        // SoundCloud answered directly. We can pipe its body. Build a
        // fake "manifest" by reusing the body as the audio.
        // (Rare; keep for safety.)
        console.log("[sc-stream] public client_id streamed inline");
        // Re-issue the request with redirect:"follow" to get the proper
        // Range-supporting CDN response.
        const followed = await fetch(
          `${TRACKS_BASE}/${encodeURIComponent(id ?? "")}/stream?client_id=${encodeURIComponent(process.env.SOUNDCLOUD_CLIENT_ID!)}`,
          { redirect: "follow" },
        );
        if (followed.ok) {
          // Direct return: we have the audio body, no manifest step.
          const directHeaders = new Headers();
          for (const name of [
            "content-type",
            "content-length",
            "content-range",
            "accept-ranges",
          ]) {
            const v = followed.headers.get(name);
            if (v) directHeaders.set(name, v);
          }
          if (!directHeaders.has("content-type"))
            directHeaders.set("content-type", "audio/mpeg");
          if (setCookieHeader) directHeaders.set("set-cookie", setCookieHeader);
          return new Response(followed.body, {
            status: followed.status,
            headers: directHeaders,
          });
        }
      } else {
        try {
          lastBody = await publicRes.text();
        } catch {
          lastBody = "";
        }
        console.warn(
          "[sc-stream] public client_id non-OK:",
          publicRes.status,
          lastBody.slice(0, 160),
        );
        lastStatus = publicRes.status;
      }
    }
  }

  // All strategies failed → return a localized error. Use the last
  // captured upstream status to pick the most appropriate code; default
  // to 401 (sc.sessionExpired) only for signed-in SC users — anonymous
  // failures default to 502 (sc.refused) so we don't tell a logged-out
  // visitor their session expired.
  if (!strategy) {
    const fallback = isScUser ? 401 : 502;
    const cls = classifyUpstream(lastStatus || fallback);
    return jsonError(cls.code, cls.message, cls.forwardStatus, {
      upstreamStatus: lastStatus || fallback,
    });
  }

  let audioUrl: string;
  if (strategy.kind === "manifest") {
    let manifest: StreamsManifest;
    try {
      manifest = (await strategy.res.json()) as StreamsManifest;
    } catch (e) {
      console.error("[sc-stream] /streams JSON parse failed:", e);
      return jsonError(
        "sc.refused",
        "SoundCloud returned an unexpected response.",
        502,
      );
    }
    // Prefer the progressive mp3 (single file, byte-range friendly).
    // Falling back to the preview clip is better than nothing — though
    // if the only field present is the HLS m3u8, the bare <audio> can't
    // play it without Media Source Extensions glue. Surface
    // streamingDenied in that case so the user gets a real message.
    const candidate =
      manifest.http_mp3_128_url ?? manifest.preview_mp3_128_url;
    if (!candidate) {
      console.error(
        "[sc-stream] /streams returned no progressive URL, fields:",
        Object.keys(manifest).join(", "),
      );
      return jsonError(
        "sc.streamingDenied",
        "SoundCloud didn't return a playable stream URL for this track.",
        502,
      );
    }
    audioUrl = candidate;
  } else {
    // strategy.kind === "redirect" — public client_id 302 target.
    audioUrl = strategy.url;
  }

  // ─── Step 2: fetch the signed audio. No auth header — the URL itself
  // is signed; sending a stray Authorization causes the CDN to 403. We
  // forward Range so the browser can scrub long tracks instead of
  // re-fetching from byte 0 on every seek. ───
  const cdnHeaders: Record<string, string> = {};
  const range = req.headers.get("range");
  if (range) cdnHeaders.Range = range;

  let cdn: Response;
  try {
    cdn = await fetch(audioUrl, {
      headers: cdnHeaders,
      redirect: "follow",
    });
  } catch (e) {
    console.error("[sc-stream] CDN fetch threw:", e);
    return jsonError(
      "sc.unreachable",
      "Couldn't reach SoundCloud's CDN — check your internet and try again.",
      502,
    );
  }

  if (!cdn.ok && cdn.status !== 206) {
    const body = await cdn.text().catch(() => "");
    console.error(
      "[sc-stream] CDN non-OK:",
      cdn.status,
      body.slice(0, 200),
    );
    const cls = classifyUpstream(cdn.status);
    return jsonError(cls.code, cls.message, cls.forwardStatus, {
      upstreamStatus: cdn.status,
    });
  }

  // Forward only the response headers the browser actually needs. The
  // CDN sends a bunch of CloudFront-specific x-amz-* headers we have no
  // reason to leak.
  const passthrough = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "last-modified",
    "etag",
    "cache-control",
  ];
  const headers = new Headers();
  for (const name of passthrough) {
    const v = cdn.headers.get(name);
    if (v) headers.set(name, v);
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "audio/mpeg");
  }
  // If we refreshed the access token to make this request succeed,
  // persist it back to the session-token cookie so the next request
  // doesn't repeat the refresh round-trip. Set-Cookie is one of the
  // few headers safe to send on a streaming/audio response — browsers
  // process it before they hand the body to the audio element.
  if (setCookieHeader) {
    headers.set("set-cookie", setCookieHeader);
  }
  // Mark refreshedAccessToken as intentionally accessed — the variable
  // exists so callers using a TS noUnusedLocals-style lint can audit
  // the refresh path without a warning. (The retry already used it.)
  void refreshedAccessToken;

  return new Response(cdn.body, {
    status: cdn.status, // pass through 200 vs 206 so range responses are honoured
    headers,
  });
}
