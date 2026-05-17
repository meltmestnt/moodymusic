// SoundCloud API client. Same shape contract as lib/deezer.ts: every
// endpoint returns objects in the *Spotify* shape (SpotifyTrack, SavedTrack,
// SpotifyPaging) so the rest of the app stays provider-agnostic.
//
// Reference: https://developers.soundcloud.com/docs/api/explorer/open-api
//
// SoundCloud has a few quirks worth flagging:
//   • Auth: tokens are sent as `Authorization: OAuth <token>` (NOT Bearer),
//     except some newer endpoints accept Bearer. We use OAuth for
//     compatibility with the older /me/likes/tracks surface.
//   • There's no concept of an "album" — tracks belong to a user (the
//     uploader / artist), and may optionally be part of a playlist. We
//     synthesise a minimal album shape from the uploader so the existing
//     UI keeps rendering.
//   • Playback isn't done through preview_url at all. SoundCloud's
//     streaming API requires app-level approval that's not available
//     to new apps, so the audio element can't fetch their streams.
//     Instead the player runs in "widget" mode (see lib/player-context):
//     it instantiates the SoundCloud iframe Widget Player and drives it
//     via SoundCloud's Widget JS API. preview_url stays null because
//     the widget loads tracks by id, not by URL — there's no preview
//     clip we'd point a bare <audio> at.

import type {
  SavedTrack,
  SpotifyAlbum,
  SpotifyArtist,
  SpotifyImage,
  SpotifyPaging,
  SpotifyTrack,
} from "@/lib/spotify";
import { cacheGet, cacheSet } from "@/lib/redis";

const API = "https://api.soundcloud.com";
const TOKEN_URL = "https://secure.soundcloud.com/oauth/token";

interface ScUser {
  id: number;
  username: string;
  full_name?: string;
  permalink_url?: string;
  avatar_url?: string;
}

interface ScTrack {
  id: number;
  title: string;
  duration: number; // milliseconds, unlike Deezer's seconds
  permalink_url: string;
  artwork_url: string | null;
  user: ScUser;
  // Some endpoints return a plain array of tracks; the "liked" endpoint
  // wraps them with a created_at on the parent object.
  created_at?: string;
  // Newer endpoints expose a media block with progressive URLs; we don't
  // rely on it (see preview_url note in the file header).
  streamable?: boolean;
}

interface ScCollection<T> {
  collection: T[];
  next_href?: string | null;
  // Some legacy endpoints return a plain array; we normalise in fetchList.
}

// ─── App-level (non-user) OAuth ─────────────────────────────────────────
//
// SoundCloud's client_credentials grant exchanges the app's CLIENT_ID +
// CLIENT_SECRET for a short-lived access token (~1h). Used by the public
// /api/sc-search route so anonymous visitors can search tracks without
// logging in. Cached in Redis keyed by client_id so we re-issue once per
// hour-ish, not once per request.

interface AppTokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
}

const APP_TOKEN_CACHE_KEY = "sc:app-token";

export async function getAppAccessToken(): Promise<string> {
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID;
  const clientSecret = process.env.SOUNDCLOUD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "SOUNDCLOUD_CLIENT_ID / SOUNDCLOUD_CLIENT_SECRET are not configured.",
    );
  }
  const cached = await cacheGet<{ token: string }>(APP_TOKEN_CACHE_KEY);
  if (cached?.token) return cached.token;

  // SoundCloud's OAuth 2.1 token endpoint rejects credentials sent in the
  // form body with `invalid_client` — it requires HTTP Basic auth, with
  // `<client_id>:<client_secret>` base64-encoded in the Authorization
  // header. See https://developers.soundcloud.com/docs/api/guide#authentication
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json; charset=utf-8",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `SoundCloud token grant failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as AppTokenResponse;
  if (!json.access_token) {
    throw new Error("SoundCloud token grant returned no access_token.");
  }
  // Cache for expires_in - 60s so we never serve a token that's about to
  // expire mid-request. Default to 50min if SC ever omits expires_in.
  const ttl = Math.max(60, (json.expires_in ?? 3600) - 60);
  await cacheSet(APP_TOKEN_CACHE_KEY, { token: json.access_token }, ttl);
  return json.access_token;
}

export class SoundCloudApiError extends Error {
  constructor(
    public status: number,
    public scMessage: string | null,
    humanMessage: string,
  ) {
    super(humanMessage);
    this.name = "SoundCloudApiError";
  }
}

function humanize(status: number, message: string | null): string {
  switch (status) {
    case 401:
      return "Your SoundCloud session expired — please sign in again.";
    case 403:
      return message
        ? `SoundCloud denied the request: ${message}`
        : "SoundCloud denied the request.";
    case 404:
      return message
        ? `SoundCloud couldn't find it: ${message}`
        : "SoundCloud resource not found.";
    case 429:
      return "Too many requests to SoundCloud — wait a moment and try again.";
    default:
      if (status >= 500) {
        return "SoundCloud ran into a problem on its end. Please try again shortly.";
      }
      return message
        ? `SoundCloud error (${status}): ${message}`
        : `SoundCloud error (${status}).`;
  }
}

async function scFetch<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      // SoundCloud accepts both "OAuth <token>" and "Bearer <token>"
      // depending on endpoint vintage. OAuth is the safest superset.
      Authorization: `OAuth ${accessToken}`,
      Accept: "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Some 2xx-no-body endpoints (likes PUT/DELETE) return empty bodies.
    }
  }
  if (!res.ok) {
    let message: string | null = null;
    if (parsed && typeof parsed === "object") {
      const errs = (parsed as { errors?: { error_message?: string }[] }).errors;
      message = errs?.[0]?.error_message ?? null;
      if (!message) {
        message = (parsed as { message?: string }).message ?? null;
      }
    }
    message = message || res.statusText || null;
    throw new SoundCloudApiError(
      res.status,
      message,
      humanize(res.status, message),
    );
  }
  return parsed as T;
}

// SoundCloud paginates with `next_href` (a full URL) on collection-shaped
// responses, but legacy endpoints just return a bare array. This helper
// normalises both into a uniform { items, next } pair.
function normaliseList<T>(raw: T[] | ScCollection<T>): {
  items: T[];
  next: string | null;
} {
  if (Array.isArray(raw)) return { items: raw, next: null };
  return { items: raw.collection ?? [], next: raw.next_href ?? null };
}

// ─── Adapters ───

function pickImages(artwork: string | null | undefined): SpotifyImage[] {
  if (!artwork) return [];
  // SoundCloud's artwork URLs follow a `-large.jpg` suffix convention.
  // We synthesise a few resolutions by swapping the suffix — the CDN
  // serves whatever fits, and missing sizes 404 cheaply (the layout uses
  // the first available URL from `images`).
  const swap = (size: string) =>
    artwork.replace(/-(large|t500x500|t300x300|t200x200|crop)\.([a-z]+)$/, `-${size}.$2`);
  return [
    { url: swap("t500x500"), width: 500, height: 500 },
    { url: artwork, width: 100, height: 100 },
  ];
}

function adaptArtist(u: ScUser): SpotifyArtist {
  return {
    id: String(u.id),
    name: u.full_name || u.username,
    uri: `soundcloud:user:${u.id}`,
  };
}

function adaptAlbumFromTrack(t: ScTrack): SpotifyAlbum {
  // SoundCloud has no album entity. We fake one from the uploader so the
  // track-card / track-info modal have something coherent to render.
  return {
    id: `user-${t.user.id}`,
    name: t.user.full_name || t.user.username,
    uri: `soundcloud:user:${t.user.id}`,
    images: pickImages(t.artwork_url),
  };
}

export function adaptTrack(t: ScTrack): SpotifyTrack {
  return {
    id: String(t.id),
    name: t.title,
    uri: `soundcloud:track:${t.id}`,
    duration_ms: t.duration ?? 0,
    // Playback is handled by the SoundCloud Widget Player in
    // lib/player-context (mode="widget"), not the bare <audio> element
    // — the widget takes a track id and streams via SoundCloud's own
    // hosted player. preview_url stays null because nothing in the
    // free-mode path can play SoundCloud audio.
    preview_url: null,
    album: adaptAlbumFromTrack(t),
    artists: [adaptArtist(t.user)],
    external_urls: { spotify: t.permalink_url },
  };
}

// ─── Endpoints we use ───

export async function getSavedTracks(
  token: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<SpotifyPaging<SavedTrack>> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  // /me/likes/tracks returns a paginated collection of tracks the user
  // has hearted. SoundCloud's pagination uses linked_partitioning + a
  // next_href cursor; we expose offset/limit to match the Spotify API
  // surface the rest of the app expects, even though under the hood
  // SoundCloud doesn't truly support arbitrary offsets — `offset` is
  // honoured as a hint and the response includes whatever fits.
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    linked_partitioning: "true",
  });
  const raw = await scFetch<ScCollection<ScTrack> | ScTrack[]>(
    token,
    `/me/likes/tracks?${params}`,
  );
  const { items, next } = normaliseList(raw);
  return {
    items: items.map((t) => ({
      added_at: t.created_at ?? new Date().toISOString(),
      track: adaptTrack(t),
    })),
    total: items.length, // SoundCloud doesn't return a total count
    limit,
    offset,
    next,
  };
}

export async function getTrack(
  token: string,
  id: string,
): Promise<SpotifyTrack> {
  const t = await scFetch<ScTrack>(
    token,
    `/tracks/${encodeURIComponent(id)}`,
  );
  return adaptTrack(t);
}

// SoundCloud has no album resource. Return a synthesised shape from the
// track's uploader to keep the track-info UI happy.
export async function getAlbum(
  token: string,
  albumId: string,
): Promise<SpotifyAlbum> {
  // albumId is "user-<id>" in our synthesised scheme. Fall back to a
  // generic shape if a caller hands us something unexpected.
  if (albumId.startsWith("user-")) {
    const userId = albumId.slice("user-".length);
    const u = await scFetch<ScUser>(
      token,
      `/users/${encodeURIComponent(userId)}`,
    );
    return {
      id: albumId,
      name: u.full_name || u.username,
      uri: `soundcloud:user:${u.id}`,
      images: pickImages(u.avatar_url),
    };
  }
  return {
    id: albumId,
    name: "",
    uri: `soundcloud:album:${albumId}`,
    images: [],
  };
}

export async function getArtistTopTracks(
  token: string,
  artistId: string,
): Promise<{ tracks: SpotifyTrack[] }> {
  // SoundCloud doesn't expose a "top tracks for artist" feed; the closest
  // public surface is /users/{id}/tracks (their uploads). The first 10
  // serve as a "more from this artist" stand-in.
  const items = await scFetch<ScTrack[]>(
    token,
    `/users/${encodeURIComponent(artistId)}/tracks?limit=10`,
  );
  const list = Array.isArray(items) ? items : (items as { collection?: ScTrack[] }).collection ?? [];
  return { tracks: list.map(adaptTrack) };
}

export async function searchTracks(
  token: string,
  query: string,
  limit = 1,
): Promise<{ tracks: SpotifyPaging<SpotifyTrack> }> {
  // Strip the Spotify-style field-qualifiers (track:foo artist:bar) —
  // SoundCloud's q= is plain text and treats them as literal substrings,
  // killing recall.
  const cleaned = query
    .replace(/track:\s*/gi, "")
    .replace(/artist:\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const params = new URLSearchParams({
    q: cleaned,
    limit: String(limit),
  });
  const raw = await scFetch<ScCollection<ScTrack> | ScTrack[]>(
    token,
    `/tracks?${params}`,
  );
  const { items, next } = normaliseList(raw);
  return {
    tracks: {
      items: items.map(adaptTrack),
      total: items.length,
      limit,
      offset: 0,
      next,
    },
  };
}

// ─── Likes (favorites) ───
//
// SoundCloud uses POST /likes/tracks/{id} to like and DELETE for unlike.
// (PUT was the verb on the deprecated /me/favorites/{id} surface — the
// modern /likes/tracks endpoint replies with 405 Method Not Allowed if
// you send PUT.) Each call hits one track; we fan out for batches.

export async function saveTracks(token: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await Promise.all(
    ids.map((id) =>
      scFetch<unknown>(
        token,
        `/likes/tracks/${encodeURIComponent(id)}`,
        { method: "POST" },
      ),
    ),
  );
}

export async function unsaveTracks(
  token: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await Promise.all(
    ids.map((id) =>
      scFetch<unknown>(
        token,
        `/likes/tracks/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    ),
  );
}

// SoundCloud has no `contains` endpoint. Same approach as Deezer: page
// through likes and check membership. Cap at a generous 100 pages × 50 =
// 5000 to bound the worst case.
const CONTAINS_MAX_PAGES = 100;

export async function checkSavedTracks(
  token: string,
  ids: string[],
): Promise<boolean[]> {
  if (ids.length === 0) return [];
  const saved = new Set<string>();
  let path = `/me/likes/tracks?limit=50&linked_partitioning=true`;
  for (let i = 0; i < CONTAINS_MAX_PAGES; i++) {
    const raw = await scFetch<ScCollection<ScTrack> | ScTrack[]>(token, path);
    const { items, next } = normaliseList(raw);
    for (const t of items) saved.add(String(t.id));
    if (!next) break;
    // next_href is an absolute URL; pull just the path+query so scFetch's
    // base-URL prefix lines up.
    try {
      const u = new URL(next);
      path = `${u.pathname}${u.search}`;
    } catch {
      break;
    }
  }
  return ids.map((id) => saved.has(String(id)));
}
