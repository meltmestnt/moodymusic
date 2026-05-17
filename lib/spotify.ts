// Lightweight typed Spotify Web API client. We only model the fields we use.
// Reference: https://developer.spotify.com/documentation/web-api

export interface SpotifyArtist {
  id: string;
  name: string;
  uri: string;
}

export interface SpotifyImage {
  url: string;
  width: number | null;
  height: number | null;
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  uri: string;
  images: SpotifyImage[];
  // Optional fields — only populated when Spotify returns full album
  // metadata (e.g. /tracks/{id}, /albums/{id}). The shorter shapes used
  // by /me/tracks omit these, so callers should treat them as nullable.
  release_date?: string;
  album_type?: "album" | "single" | "compilation";
  total_tracks?: number;
  label?: string;
  genres?: string[];
}

export interface SpotifyTrack {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  preview_url: string | null;
  album: SpotifyAlbum;
  artists: SpotifyArtist[];
  external_urls: { spotify: string };
  // Only present on full track responses (/tracks/{id}, /me/player). The
  // shorter shapes returned by /me/tracks omit it.
  track_number?: number;
  disc_number?: number;
}

export interface SpotifyPaging<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  next: string | null;
}

export interface SavedTrack {
  added_at: string;
  track: SpotifyTrack;
}

const API = "https://api.spotify.com/v1";

// Carries the original status + raw Spotify message alongside the
// humanised error text. Callers (e.g. the playback API route) use the
// status to drive recovery flows — most importantly, auto-transferring
// playback to the SDK device on a 404 "Device not found".
export class SpotifyApiError extends Error {
  constructor(
    public status: number,
    public spotifyMessage: string | null,
    humanMessage: string,
  ) {
    super(humanMessage);
    this.name = "SpotifyApiError";
  }
}

// Spotify's error bodies look like `{ "error": { "status": 404, "message":
// "Device not found" } }`. We pull the inner message and turn it into
// something a user can act on instead of dumping the JSON into a toast.
function humanizeSpotifyError(status: number, message: string | null): string {
  const m = (message ?? "").toLowerCase();
  switch (status) {
    case 401:
      return "Your Spotify session expired — please sign in again.";
    case 403:
      if (m.includes("premium")) {
        return "This action requires Spotify Premium.";
      }
      if (m.includes("restriction") || m.includes("restricted")) {
        return "Spotify won't allow this right now — try the action in the Spotify app first.";
      }
      return message
        ? `Spotify denied the request: ${message}`
        : "Spotify denied the request.";
    case 404:
      if (m.includes("device")) {
        return "No active Spotify device. Open Spotify on your phone or computer, then try again.";
      }
      if (m.includes("not found")) {
        return "Spotify couldn't find that track or resource.";
      }
      return message
        ? `Spotify couldn't find it: ${message}`
        : "Spotify resource not found.";
    case 429:
      return "Too many requests to Spotify — wait a moment and try again.";
    case 502:
    case 503:
    case 504:
      return "Spotify is temporarily unavailable. Please try again in a moment.";
    default:
      if (status >= 500) {
        return "Spotify ran into a problem on its end. Please try again shortly.";
      }
      return message
        ? `Spotify error (${status}): ${message}`
        : `Spotify error (${status}).`;
  }
}

async function spotifyFetch<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let message: string | null = null;
    if (body) {
      try {
        const parsed = JSON.parse(body) as {
          error?: { message?: string } | string;
        };
        if (typeof parsed.error === "object" && parsed.error?.message) {
          message = parsed.error.message;
        } else if (typeof parsed.error === "string") {
          message = parsed.error;
        }
      } catch {
        // Non-JSON body — fall through and use statusText.
      }
    }
    message = message || res.statusText || null;
    throw new SpotifyApiError(
      res.status,
      message,
      humanizeSpotifyError(res.status, message),
    );
  }
  if (res.status === 204) return undefined as T;
  // Spotify's write endpoints (PUT/DELETE /me/tracks, /me/player/*) return
  // 200 with an empty body — not 204. Reading text first lets us short-
  // circuit before json-parsing an empty string and getting "Unexpected
  // end of JSON input".
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export function getSavedTracks(
  token: string,
  opts: { limit?: number; offset?: number } = {},
) {
  const params = new URLSearchParams({
    limit: String(opts.limit ?? 50),
    offset: String(opts.offset ?? 0),
  });
  return spotifyFetch<SpotifyPaging<SavedTrack>>(
    token,
    `/me/tracks?${params}`,
  );
}

export function getTracksByIds(token: string, ids: string[]) {
  if (ids.length === 0) return Promise.resolve({ tracks: [] });
  // Spotify caps at 50 ids per call. Chunk and merge if you need more.
  const params = new URLSearchParams({ ids: ids.slice(0, 50).join(",") });
  return spotifyFetch<{ tracks: (SpotifyTrack | null)[] }>(
    token,
    `/tracks?${params}`,
  );
}

export function getTrack(token: string, id: string) {
  return spotifyFetch<SpotifyTrack>(token, `/tracks/${encodeURIComponent(id)}`);
}

// Full album metadata — /tracks/{id}.album returns a SHORT shape that
// omits label, genres, total_tracks; for the track-info modal we need
// the full album so the description line can show label + track count.
export function getAlbum(token: string, albumId: string) {
  return spotifyFetch<SpotifyAlbum>(
    token,
    `/albums/${encodeURIComponent(albumId)}`,
  );
}

// /artists/{id}/top-tracks — Spotify's recommendations endpoint was
// deprecated for new apps in late 2024, so we use this as a stand-in
// "more like this": same artist's top 10 tracks. Good signal for "songs
// in the same vein" without needing a recommendations grant.
export function getArtistTopTracks(
  token: string,
  artistId: string,
  market = "from_token",
) {
  const params = new URLSearchParams({ market });
  return spotifyFetch<{ tracks: SpotifyTrack[] }>(
    token,
    `/artists/${encodeURIComponent(artistId)}/top-tracks?${params}`,
  );
}

export function searchTracks(token: string, query: string, limit = 1) {
  const params = new URLSearchParams({
    q: query,
    type: "track",
    limit: String(limit),
  });
  return spotifyFetch<{ tracks: SpotifyPaging<SpotifyTrack> }>(
    token,
    `/search?${params}`,
  );
}

export function playTrack(
  token: string,
  deviceId: string,
  trackUri: string,
) {
  return playTracks(token, deviceId, [trackUri]);
}

// Spotify accepts up to ~700 uris per call but rejects empty arrays. When
// you pass multiple uris it queues them and auto-advances — that's how we
// get "next song plays when current ends" without any client-side loop.
export function playTracks(
  token: string,
  deviceId: string,
  trackUris: string[],
) {
  if (trackUris.length === 0) return Promise.resolve();
  return spotifyFetch<void>(
    token,
    `/me/player/play?device_id=${encodeURIComponent(deviceId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ uris: trackUris.slice(0, 100) }),
    },
  );
}

export function transferPlayback(
  token: string,
  deviceId: string,
  play = false,
) {
  return spotifyFetch<void>(token, `/me/player`, {
    method: "PUT",
    body: JSON.stringify({ device_ids: [deviceId], play }),
  });
}

// ─── /me/player state + control ───
//
// Spotify's "Connect" endpoints. The GET works for free accounts, but every
// write (play/pause/next/seek/volume) requires Premium and an active device.
// Calls without an active device return 404 — the player-context handles
// that by transferring playback to the SDK device first.

export interface SpotifyDevice {
  id: string | null;
  is_active: boolean;
  is_restricted: boolean;
  is_private_session: boolean;
  name: string;
  type: string;
  volume_percent: number | null;
  supports_volume: boolean;
}

export interface SpotifyPlaybackState {
  device: SpotifyDevice | null;
  shuffle_state: boolean;
  repeat_state: "off" | "track" | "context";
  timestamp: number;
  context: { type: string; uri: string } | null;
  progress_ms: number | null;
  is_playing: boolean;
  item: SpotifyTrack | null;
  currently_playing_type: "track" | "episode" | "ad" | "unknown";
}

// /me/player returns 204 (no content) when the user has no active session
// — i.e., Spotify isn't open anywhere. spotifyFetch turns that into
// `undefined`, which we surface as `null` to the caller.
export async function getPlaybackState(
  token: string,
): Promise<SpotifyPlaybackState | null> {
  const data = await spotifyFetch<SpotifyPlaybackState | undefined>(
    token,
    `/me/player`,
  );
  return data ?? null;
}

export function getDevices(token: string) {
  return spotifyFetch<{ devices: SpotifyDevice[] }>(token, `/me/player/devices`);
}

export function pausePlayback(token: string, deviceId?: string) {
  const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  return spotifyFetch<void>(token, `/me/player/pause${q}`, { method: "PUT" });
}

export function resumePlayback(token: string, deviceId?: string) {
  const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  return spotifyFetch<void>(token, `/me/player/play${q}`, { method: "PUT" });
}

export function skipNext(token: string, deviceId?: string) {
  const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  return spotifyFetch<void>(token, `/me/player/next${q}`, { method: "POST" });
}

export function skipPrevious(token: string, deviceId?: string) {
  const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  return spotifyFetch<void>(token, `/me/player/previous${q}`, {
    method: "POST",
  });
}

export function seekToPosition(
  token: string,
  positionMs: number,
  deviceId?: string,
) {
  const params = new URLSearchParams({
    position_ms: String(Math.max(0, Math.floor(positionMs))),
  });
  if (deviceId) params.set("device_id", deviceId);
  return spotifyFetch<void>(token, `/me/player/seek?${params}`, {
    method: "PUT",
  });
}

export function setVolume(
  token: string,
  percent: number,
  deviceId?: string,
) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const params = new URLSearchParams({ volume_percent: String(clamped) });
  if (deviceId) params.set("device_id", deviceId);
  return spotifyFetch<void>(token, `/me/player/volume?${params}`, {
    method: "PUT",
  });
}

// ─── Favorites (saved tracks) ───
//
// Spotify caps each call at 50 ids; we chunk transparently. Endpoints accept
// the ids either as a query param or in a JSON body — we use the body for
// PUT/DELETE so we don't risk URL-length limits with batches of 50.

const FAVORITES_CHUNK = 50;

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function saveTracks(token: string, ids: string[]) {
  if (ids.length === 0) return;
  for (const batch of chunked(ids, FAVORITES_CHUNK)) {
    await spotifyFetch<void>(token, `/me/tracks`, {
      method: "PUT",
      body: JSON.stringify({ ids: batch }),
    });
  }
}

export async function unsaveTracks(token: string, ids: string[]) {
  if (ids.length === 0) return;
  for (const batch of chunked(ids, FAVORITES_CHUNK)) {
    await spotifyFetch<void>(token, `/me/tracks`, {
      method: "DELETE",
      body: JSON.stringify({ ids: batch }),
    });
  }
}

// Returns one boolean per requested id, in the same order. Spotify caps the
// response at 50 too, so we chunk and concatenate.
export async function checkSavedTracks(
  token: string,
  ids: string[],
): Promise<boolean[]> {
  if (ids.length === 0) return [];
  const out: boolean[] = [];
  for (const batch of chunked(ids, FAVORITES_CHUNK)) {
    const params = new URLSearchParams({ ids: batch.join(",") });
    const result = await spotifyFetch<boolean[]>(
      token,
      `/me/tracks/contains?${params}`,
    );
    out.push(...result);
  }
  return out;
}
