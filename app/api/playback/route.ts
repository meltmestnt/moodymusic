import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
  getDevices,
  getPlaybackState,
  pausePlayback,
  playTracks,
  resumePlayback,
  seekToPosition,
  setVolume,
  skipNext,
  skipPrevious,
  SpotifyApiError,
  transferPlayback,
} from "@/lib/spotify";
import { logPlay } from "@/lib/db/events";

// Web Playback SDK device name set in lib/player-context.tsx — kept in sync
// here so the server-side recovery flow can find our own device by name.
const SDK_DEVICE_NAME = "moodymusic web";

// Server-side proxy for Spotify's "Connect" endpoints. We never expose the
// access_token to the browser — every write goes through here. GET returns
// the union of /me/player (currently-playing) and is safe for free accounts;
// every write requires Premium and an active device on Spotify's side.

async function authed() {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) return null;
  return {
    token: session.accessToken,
    provider: session.provider ?? "spotify",
  };
}

export async function GET() {
  const a = await authed();
  if (!a) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Deezer has no equivalent of Spotify Connect — no Web Playback SDK to
  // mirror. Return null state so the player polls fast-no-op and falls
  // back to its preview-URL playback path.
  if (a.provider !== "spotify") {
    return NextResponse.json({ state: null });
  }
  try {
    const state = await getPlaybackState(a.token);
    return NextResponse.json({ state });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "spotify error" },
      { status: 502 },
    );
  }
}

const controlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause"), deviceId: z.string().optional() }),
  z.object({ action: z.literal("resume"), deviceId: z.string().optional() }),
  z.object({ action: z.literal("next"), deviceId: z.string().optional() }),
  z.object({ action: z.literal("previous"), deviceId: z.string().optional() }),
  z.object({
    action: z.literal("seek"),
    positionMs: z.number().int().nonnegative(),
    deviceId: z.string().optional(),
  }),
  z.object({
    action: z.literal("volume"),
    percent: z.number().min(0).max(100),
    deviceId: z.string().optional(),
  }),
  z.object({
    action: z.literal("play"),
    // Either a single uri (kept for compat) OR a list. The handler
    // normalises both to an array so Spotify's queue auto-advance kicks
    // in when callers pass multiple tracks.
    uri: z.string().optional(),
    uris: z.array(z.string()).optional(),
    deviceId: z.string().optional(),
    // Where the click originated, for analytics. Optional — defaults to
    // "unknown" if the client doesn't pass it.
    source: z
      .enum(["library", "mood", "footer", "external", "unknown"])
      .optional(),
    // Snapshot of the started track so logPlay can record name/artists
    // without a round-trip back to Spotify.
    trackInfo: z
      .object({
        id: z.string(),
        name: z.string(),
        artists: z.array(z.string()),
      })
      .optional(),
  }),
  z.object({
    action: z.literal("transfer"),
    deviceId: z.string(),
    play: z.boolean().optional(),
  }),
]);

export async function POST(req: Request) {
  const a = await authed();
  if (!a) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const parsed = controlSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  // Deezer has no Connect-style remote-control surface. The client
  // handles preview playback locally; if it still POSTs here (e.g. on
  // free-mode resume) we 200-no-op rather than burning a 502.
  if (a.provider !== "spotify") {
    return NextResponse.json({ ok: true, noop: true });
  }
  const token = a.token;

  try {
    const c = parsed.data;
    switch (c.action) {
      case "pause":
        await pausePlayback(token, c.deviceId);
        break;
      case "resume":
        await resumePlayback(token, c.deviceId);
        break;
      case "next":
        await skipNext(token, c.deviceId);
        break;
      case "previous":
        await skipPrevious(token, c.deviceId);
        break;
      case "seek":
        await seekToPosition(token, c.positionMs, c.deviceId);
        break;
      case "volume":
        await setVolume(token, c.percent, c.deviceId);
        break;
      case "play": {
        const uris = c.uris ?? (c.uri ? [c.uri] : []);
        if (uris.length === 0) {
          return NextResponse.json(
            { error: "play requires uri or uris" },
            { status: 400 },
          );
        }

        // Resolve a device. If the client passed one, try it first. If it
        // didn't (the SDK hasn't fired `ready` yet, so the client doesn't
        // know its own device id), or if Spotify rejects the requested one
        // with 404 (stale phone, restricted speaker, etc.), fall back to
        // /me/player/devices and pick the moodymusic web player by name —
        // with a generic "any non-restricted device" fallback. After
        // picking, transferPlayback makes that device the active Connect
        // target before we play. The 400ms wait covers Spotify's eventual-
        // consistency on transfer.
        async function pickFallback(): Promise<string | null> {
          const { devices } = await getDevices(token!);
          const sdk = devices.find(
            (d) => d.name === SDK_DEVICE_NAME && !d.is_restricted && d.id,
          );
          if (sdk?.id) return sdk.id;
          const any = devices.find((d) => !d.is_restricted && d.id);
          return any?.id ?? null;
        }

        const tryFallback = async (originalErr: unknown) => {
          const target = await pickFallback();
          if (!target) throw originalErr;
          await transferPlayback(token!, target, false);
          await new Promise((r) => setTimeout(r, 400));
          await playTracks(token!, target, uris);
        };

        if (c.deviceId) {
          try {
            await playTracks(token, c.deviceId, uris);
          } catch (e) {
            if (!(e instanceof SpotifyApiError) || e.status !== 404) throw e;
            await tryFallback(e);
          }
        } else {
          // No client-supplied device — go straight to fallback. If
          // there are no usable devices we want a clean error (the
          // humanised one carries through).
          const target = await pickFallback();
          if (!target) {
            throw new SpotifyApiError(
              404,
              "No device available",
              "No active Spotify device. Open Spotify on your phone or computer, then try again.",
            );
          }
          try {
            await playTracks(token, target, uris);
          } catch (e) {
            if (!(e instanceof SpotifyApiError) || e.status !== 404) throw e;
            await transferPlayback(token, target, false);
            await new Promise((r) => setTimeout(r, 400));
            await playTracks(token, target, uris);
          }
        }
        // Log a play event AFTER Spotify accepted the call. We re-fetch the
        // session here (the `authed()` helper above tossed it after grabbing
        // the token) so we have the user info handy.
        const session = await getServerSession(authOptions);
        if (session?.user?.id) {
          await logPlay({
            user: {
              spotifyUserId: session.user.id,
              provider: session.provider ?? "spotify",
              displayName: session.user.name ?? null,
              email: session.user.email ?? null,
              image: session.user.image ?? null,
              product: session.user.product ?? null,
            },
            trackUris: uris,
            trackInfo: c.trackInfo,
            source: c.source ?? "unknown",
          });
        }
        break;
      }
      case "transfer":
        await transferPlayback(token, c.deviceId, c.play ?? false);
        break;
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "spotify error";
    // Spotify returns 403/404 a lot for "no active device" and "not premium".
    // Surface the message; the client decides how to react.
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
