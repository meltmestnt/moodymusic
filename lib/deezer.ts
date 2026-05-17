// Deezer API client. We model exactly what we need and emit objects in
// the *Spotify* shape (SpotifyTrack, SavedTrack, SpotifyPaging) so the
// rest of the app can stay provider-agnostic. The track URI uses a
// `deezer:track:<id>` form so callers that round-trip through it (e.g.
// Mongo plays log) still have a parseable identifier.
//
// Deezer reference: https://developers.deezer.com/api

import type {
  SavedTrack,
  SpotifyAlbum,
  SpotifyArtist,
  SpotifyImage,
  SpotifyPaging,
  SpotifyTrack,
} from "@/lib/spotify";

const API = "https://api.deezer.com";

// Deezer's raw response shapes — only the fields we use.
interface DzImage {
  cover?: string;
  cover_small?: string;
  cover_medium?: string;
  cover_big?: string;
  cover_xl?: string;
}

interface DzArtist extends DzImage {
  id: number;
  name: string;
  link?: string;
  picture?: string;
}

interface DzAlbum extends DzImage {
  id: number;
  title: string;
  link?: string;
  release_date?: string;
  record_type?: string;
  nb_tracks?: number;
  label?: string;
  genres?: { data: { id: number; name: string }[] };
}

interface DzTrack {
  id: number;
  title: string;
  title_short?: string;
  link: string;
  duration: number;
  preview: string;
  artist: DzArtist;
  album: DzAlbum;
  // Track-list endpoints (album tracks etc.) sometimes flatten these,
  // optional by design.
  track_position?: number;
  disk_number?: number;
}

interface DzPaging<T> {
  data: T[];
  total?: number;
  next?: string;
  prev?: string;
}

interface DzError {
  type?: string;
  message?: string;
  code?: number;
}

export class DeezerApiError extends Error {
  constructor(
    public status: number,
    public deezerMessage: string | null,
    humanMessage: string,
  ) {
    super(humanMessage);
    this.name = "DeezerApiError";
  }
}

function humanizeDeezerError(status: number, message: string | null): string {
  switch (status) {
    case 401:
      return "Your Deezer session expired — please sign in again.";
    case 403:
      return message
        ? `Deezer denied the request: ${message}`
        : "Deezer denied the request.";
    case 404:
      return message
        ? `Deezer couldn't find it: ${message}`
        : "Deezer resource not found.";
    case 429:
      return "Too many requests to Deezer — wait a moment and try again.";
    default:
      if (status >= 500) {
        return "Deezer ran into a problem on its end. Please try again shortly.";
      }
      return message
        ? `Deezer error (${status}): ${message}`
        : `Deezer error (${status}).`;
  }
}

// Deezer signals errors with HTTP 200 + a body of `{ "error": { ... } }`.
// We have to inspect every response, not just trust res.ok.
async function deezerFetch<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${API}${path}${sep}access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
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
      // Non-JSON body
    }
  }
  // Network/HTTP error
  if (!res.ok) {
    const message =
      (parsed as { error?: DzError })?.error?.message ?? res.statusText ?? null;
    throw new DeezerApiError(
      res.status,
      message,
      humanizeDeezerError(res.status, message),
    );
  }
  // 200 OK with an embedded error object
  if (
    parsed &&
    typeof parsed === "object" &&
    "error" in parsed &&
    (parsed as { error?: DzError }).error
  ) {
    const e = (parsed as { error: DzError }).error;
    const status = e.code ?? 500;
    throw new DeezerApiError(
      status,
      e.message ?? null,
      humanizeDeezerError(status, e.message ?? null),
    );
  }
  return parsed as T;
}

// ─── Adapters ───
//
// The whole point of returning Spotify-shaped objects is so the React
// components and API routes don't need a switch on `provider`. We pay
// the adapter cost here, once.

function pickImages(src: DzImage): SpotifyImage[] {
  const list: SpotifyImage[] = [];
  if (src.cover_xl) list.push({ url: src.cover_xl, width: 1000, height: 1000 });
  if (src.cover_big) list.push({ url: src.cover_big, width: 500, height: 500 });
  if (src.cover_medium)
    list.push({ url: src.cover_medium, width: 250, height: 250 });
  if (src.cover_small)
    list.push({ url: src.cover_small, width: 56, height: 56 });
  if (list.length === 0 && src.cover) {
    list.push({ url: src.cover, width: null, height: null });
  }
  return list;
}

export function deezerTrackUri(id: string | number): string {
  return `deezer:track:${id}`;
}

// `deezer:track:123` → "123". Falls through to the input on a non-deezer
// uri so callers can use this defensively.
export function trackIdFromUri(uri: string): string {
  if (uri.startsWith("deezer:track:")) return uri.slice("deezer:track:".length);
  if (uri.startsWith("spotify:track:"))
    return uri.slice("spotify:track:".length);
  return uri;
}

function adaptArtist(a: DzArtist): SpotifyArtist {
  return {
    id: String(a.id),
    name: a.name,
    uri: `deezer:artist:${a.id}`,
  };
}

function adaptAlbum(a: DzAlbum): SpotifyAlbum {
  // Deezer's record_type values are "album"/"single"/"ep"/"compile" —
  // map "compile" to Spotify's "compilation", drop "ep" since the Spotify
  // type union doesn't include it.
  let albumType: SpotifyAlbum["album_type"] | undefined;
  if (a.record_type === "album") albumType = "album";
  else if (a.record_type === "single") albumType = "single";
  else if (a.record_type === "compile") albumType = "compilation";
  return {
    id: String(a.id),
    name: a.title,
    uri: `deezer:album:${a.id}`,
    images: pickImages(a),
    release_date: a.release_date,
    album_type: albumType,
    total_tracks: a.nb_tracks,
    label: a.label,
    genres: a.genres?.data.map((g) => g.name),
  };
}

export function adaptTrack(t: DzTrack): SpotifyTrack {
  return {
    id: String(t.id),
    name: t.title,
    uri: deezerTrackUri(t.id),
    duration_ms: (t.duration ?? 0) * 1000,
    // Deezer always returns a 30-second preview URL for licensed tracks.
    // We store it in `preview_url` so the existing free-mode preview
    // playback path in player-context picks it up unchanged.
    preview_url: t.preview || null,
    album: adaptAlbum(t.album),
    artists: [adaptArtist(t.artist)],
    // The field name says "spotify" but the value is whatever external
    // link the track has — Deezer's `link` (https://www.deezer.com/track/…)
    // slots in here. Renaming the field would touch every consumer; the
    // rename isn't worth the noise.
    external_urls: { spotify: t.link },
    track_number: t.track_position,
    disc_number: t.disk_number,
  };
}

function adaptPaging<T extends { id: number }>(
  page: DzPaging<T>,
  limit: number,
  offset: number,
  adapt: (t: T) => SavedTrack | SpotifyTrack,
): SpotifyPaging<SavedTrack> | SpotifyPaging<SpotifyTrack> {
  return {
    items: page.data.map(adapt as (t: T) => SavedTrack & SpotifyTrack),
    total: page.total ?? page.data.length,
    limit,
    offset,
    next: page.next ?? null,
  } as SpotifyPaging<SavedTrack> | SpotifyPaging<SpotifyTrack>;
}

// ─── Endpoints we use ───

export async function getSavedTracks(
  token: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<SpotifyPaging<SavedTrack>> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const page = await deezerFetch<DzPaging<DzTrack & { time_add?: number }>>(
    token,
    `/user/me/tracks?limit=${limit}&index=${offset}`,
  );
  // Deezer's /user/me/tracks returns a flat list of tracks with a
  // time_add unix timestamp. We wrap each in the Spotify SavedTrack
  // shape so the library page renders unchanged.
  return adaptPaging(
    page,
    limit,
    offset,
    (t) =>
      ({
        added_at: t.time_add
          ? new Date(t.time_add * 1000).toISOString()
          : new Date().toISOString(),
        track: adaptTrack(t),
      }) as SavedTrack,
  ) as SpotifyPaging<SavedTrack>;
}

export async function getTrack(
  token: string,
  id: string,
): Promise<SpotifyTrack> {
  const t = await deezerFetch<DzTrack>(token, `/track/${encodeURIComponent(id)}`);
  return adaptTrack(t);
}

export async function getAlbum(
  token: string,
  albumId: string,
): Promise<SpotifyAlbum> {
  const a = await deezerFetch<DzAlbum>(
    token,
    `/album/${encodeURIComponent(albumId)}`,
  );
  return adaptAlbum(a);
}

export async function getArtistTopTracks(
  token: string,
  artistId: string,
): Promise<{ tracks: SpotifyTrack[] }> {
  const page = await deezerFetch<DzPaging<DzTrack>>(
    token,
    `/artist/${encodeURIComponent(artistId)}/top?limit=10`,
  );
  return { tracks: page.data.map(adaptTrack) };
}

export async function searchTracks(
  token: string,
  query: string,
  limit = 1,
): Promise<{ tracks: SpotifyPaging<SpotifyTrack> }> {
  // Strip the Spotify field-qualifiers Spotify search supports
  // (`track:foo artist:bar`) — Deezer's q= is plain text and treats
  // "track:" / "artist:" as literal tokens, which kills the recall
  // rate. Convert to a freeform "title artist" query.
  const cleaned = query
    .replace(/track:\s*/gi, "")
    .replace(/artist:\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const params = new URLSearchParams({
    q: cleaned,
    limit: String(limit),
  });
  const page = await deezerFetch<DzPaging<DzTrack>>(
    token,
    `/search/track?${params}`,
  );
  return {
    tracks: {
      items: page.data.map(adaptTrack),
      total: page.total ?? page.data.length,
      limit,
      offset: 0,
      next: page.next ?? null,
    },
  };
}

// ─── Favorites ───
//
// Deezer's add/remove endpoints take a single track_id per call. There's
// no batch shortcut, so we fan out and await all. (Deezer does enforce
// rate limits — 50 req/5s per IP — but 50 concurrent toggles from one
// user is well below that budget.)

export async function saveTracks(token: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await Promise.all(
    ids.map((id) =>
      deezerFetch<unknown>(
        token,
        `/user/me/tracks?track_id=${encodeURIComponent(id)}`,
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
      deezerFetch<unknown>(
        token,
        `/user/me/tracks?track_id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    ),
  );
}

// Deezer has no `/user/me/tracks/contains` analogue. We page through the
// user's favorites to build a Set, then test membership locally. The
// favorites list is paginated 50 at a time; capping at 5000 entries is
// generous (Spotify caps the saved-tracks UI at 10k) and avoids an
// unbounded scan if the API is unhappy.
const CONTAINS_MAX_PAGES = 100; // 100 × 50 = 5000

export async function checkSavedTracks(
  token: string,
  ids: string[],
): Promise<boolean[]> {
  if (ids.length === 0) return [];
  const saved = new Set<string>();
  let url = `/user/me/tracks?limit=50&index=0`;
  for (let i = 0; i < CONTAINS_MAX_PAGES; i++) {
    const page = await deezerFetch<DzPaging<DzTrack>>(token, url);
    for (const t of page.data) saved.add(String(t.id));
    if (!page.next) break;
    // page.next is an absolute URL with access_token already in it; pull
    // the path+query after the host so deezerFetch can re-attach the
    // token (it'd otherwise duplicate it).
    try {
      const u = new URL(page.next);
      u.searchParams.delete("access_token");
      url = `${u.pathname}${u.search}`;
    } catch {
      break;
    }
  }
  return ids.map((id) => saved.has(String(id)));
}
