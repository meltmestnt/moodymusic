// YouTube Data API v3 client.
//
// Same contract as lib/deezer.ts and lib/soundcloud.ts: every endpoint
// returns objects in the *Spotify* shape (SpotifyTrack, SavedTrack,
// SpotifyPaging) so the rest of the app stays provider-agnostic.
//
// Reference: https://developers.google.com/youtube/v3/docs
//
// Mappings:
//   • "Saved tracks" → user's "Liked videos" auto-playlist (id "LL")
//     fetched via /playlistItems. We filter to the music category by
//     joining each video's snippet.categoryId — but YouTube's category
//     metadata is unreliable, so the effective filter is "anything the
//     user liked" rather than "music only."
//   • "Track" → Video. SpotifyTrack.id holds the videoId; uri is
//     `youtube:track:<videoId>`.
//   • "Album" → fabricated from the channel (uploader). YouTube has no
//     album entity for individual videos; track-info modal shows the
//     channel name where Spotify would show the album.
//   • "Artist" → channel. artists[0].id is the channelId.
//   • "Search" → /search?q=...&type=video&videoCategoryId=10 (Music).
//   • "Save / unsave" → /videos/rate?id=...&rating=like|none.
//   • "Check saved" → /videos/getRating?id=... (returns a per-id rating).
//
// Playback is handled in lib/player-context (mode="yt-widget") via the
// YouTube IFrame Player API. preview_url stays null because the iframe
// player loads videos by id, not by URL.

import type {
  SavedTrack,
  SpotifyAlbum,
  SpotifyArtist,
  SpotifyImage,
  SpotifyPaging,
  SpotifyTrack,
} from "@/lib/spotify";
import { cacheGet, cacheSet } from "@/lib/redis";

const API = "https://www.googleapis.com/youtube/v3";

// ─── Raw response types ───
//
// We model only the fields we actually read; YouTube's full API surface
// is large and most of it is irrelevant to "show this as a track".

interface YtThumbnail {
  url: string;
  width?: number;
  height?: number;
}

interface YtThumbnails {
  default?: YtThumbnail;
  medium?: YtThumbnail;
  high?: YtThumbnail;
  standard?: YtThumbnail;
  maxres?: YtThumbnail;
}

interface YtVideoSnippet {
  publishedAt: string;
  channelId: string;
  channelTitle: string;
  title: string;
  description?: string;
  thumbnails?: YtThumbnails;
  // categoryId is on /videos snippet; absent on /playlistItems snippet.
  categoryId?: string;
}

interface YtVideoContentDetails {
  duration: string; // ISO 8601, e.g. "PT4M13S"
}

interface YtVideo {
  id: string;
  snippet: YtVideoSnippet;
  contentDetails?: YtVideoContentDetails;
}

interface YtPlaylistItem {
  id: string;
  snippet: YtVideoSnippet & {
    resourceId: { kind: string; videoId: string };
  };
}

interface YtPage<T> {
  items: T[];
  nextPageToken?: string;
  prevPageToken?: string;
  pageInfo?: { totalResults: number; resultsPerPage: number };
}

interface YtSearchResultId {
  kind: "youtube#video" | "youtube#channel" | "youtube#playlist";
  videoId?: string;
  channelId?: string;
  playlistId?: string;
}

interface YtSearchResult {
  id: YtSearchResultId;
  snippet: YtVideoSnippet;
}

interface YtError {
  code?: number;
  message?: string;
  errors?: { reason?: string; message?: string }[];
}

export class YouTubeApiError extends Error {
  constructor(
    public status: number,
    public ytMessage: string | null,
    humanMessage: string,
  ) {
    super(humanMessage);
    this.name = "YouTubeApiError";
  }
}

function humanize(status: number, message: string | null): string {
  switch (status) {
    case 401:
      return "Your YouTube session expired — please sign in again.";
    case 403:
      // 403 from YouTube can mean quota exceeded, scope missing, or the
      // resource being private. The message often clarifies; surface it
      // when present.
      return message
        ? `YouTube denied the request: ${message}`
        : "YouTube denied the request.";
    case 404:
      return "YouTube couldn't find that video.";
    case 429:
      return "Hit YouTube's rate limit — wait a moment and try again.";
    default:
      if (status >= 500) {
        return "YouTube ran into a problem on its end. Please try again shortly.";
      }
      return message
        ? `YouTube error (${status}): ${message}`
        : `YouTube error (${status}).`;
  }
}

async function ytFetch<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
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
      // Some 2xx-no-body endpoints (rate POST) return empty.
    }
  }
  if (!res.ok) {
    let message: string | null = null;
    if (parsed && typeof parsed === "object") {
      const err = (parsed as { error?: YtError }).error;
      message = err?.message ?? err?.errors?.[0]?.message ?? null;
    }
    message = message || res.statusText || null;
    throw new YouTubeApiError(res.status, message, humanize(res.status, message));
  }
  return parsed as T;
}

// ─── Adapters ───

function pickImages(thumbs: YtThumbnails | undefined): SpotifyImage[] {
  if (!thumbs) return [];
  // Prefer larger thumbnails first so the album-art slot in the UI gets
  // the highest resolution available. Not every video has every size,
  // so we filter out missing entries.
  const order: (keyof YtThumbnails)[] = [
    "maxres",
    "standard",
    "high",
    "medium",
    "default",
  ];
  const out: SpotifyImage[] = [];
  for (const key of order) {
    const t = thumbs[key];
    if (!t) continue;
    out.push({
      url: t.url,
      width: t.width ?? null,
      height: t.height ?? null,
    });
  }
  return out;
}

// Parse YouTube's ISO 8601 duration (e.g. "PT4M13S", "PT1H2M3S") into
// milliseconds. Quick-and-dirty regex — covers the H/M/S forms YouTube
// uses for video duration; doesn't handle days/weeks because no video
// is that long.
function parseIsoDurationMs(iso: string | undefined): number {
  if (!iso) return 0;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return 0;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const s = m[3] ? parseInt(m[3], 10) : 0;
  return ((h * 60 + min) * 60 + s) * 1000;
}

function adaptArtistFromSnippet(s: YtVideoSnippet): SpotifyArtist {
  return {
    id: s.channelId,
    name: s.channelTitle,
    uri: `youtube:channel:${s.channelId}`,
  };
}

function adaptAlbumFromSnippet(s: YtVideoSnippet): SpotifyAlbum {
  // No album entity in YouTube — synthesise from the channel so the
  // track-card / track-info modal have something coherent to render.
  return {
    id: `channel-${s.channelId}`,
    name: s.channelTitle,
    uri: `youtube:channel:${s.channelId}`,
    images: pickImages(s.thumbnails),
  };
}

export function adaptVideo(video: YtVideo): SpotifyTrack {
  return {
    id: video.id,
    name: video.snippet.title,
    uri: `youtube:track:${video.id}`,
    duration_ms: parseIsoDurationMs(video.contentDetails?.duration),
    // Playback is handled by the YouTube IFrame Player in
    // lib/player-context (mode="yt-widget"), not by an <audio> element.
    preview_url: null,
    album: adaptAlbumFromSnippet(video.snippet),
    artists: [adaptArtistFromSnippet(video.snippet)],
    external_urls: { spotify: `https://www.youtube.com/watch?v=${video.id}` },
  };
}

// /playlistItems and /search return snippet-only shapes — we batch a
// follow-up /videos request for duration + categoryId. This helper
// builds a partial track from just the snippet, used when we don't
// want to pay for the second round-trip (search results, etc.).
function adaptVideoFromPlaylistItem(item: YtPlaylistItem): SpotifyTrack {
  const videoId = item.snippet.resourceId.videoId;
  return {
    id: videoId,
    name: item.snippet.title,
    uri: `youtube:track:${videoId}`,
    duration_ms: 0, // hydrated via /videos in getSavedTracks
    preview_url: null,
    album: adaptAlbumFromSnippet(item.snippet),
    artists: [adaptArtistFromSnippet(item.snippet)],
    external_urls: { spotify: `https://www.youtube.com/watch?v=${videoId}` },
  };
}

// ─── Endpoints we use ───

// YouTube category id for "Music" — the only one we keep in the library.
// Other common values (24 Entertainment, 22 People & Blogs, 20 Gaming,
// etc.) tend to be vlogs / gameplay / tutorials that the user doesn't
// want surfaced as music tracks. The categoryId lives on a video's
// snippet (not on the playlist item), which is why we have to resolve
// each video via /videos before deciding to keep it.
// Categories we treat as "music." YouTube's categoryId is set by the
// uploader and notoriously unreliable: many legitimate music tracks
// get tagged as Entertainment (24) instead of Music (10), especially
// when uploaded by non-music channels (fan re-uploads, DJ mixes,
// random user uploads). Including both means searches like "lil peep"
// pull tracks regardless of which bucket the uploader chose.
//
//   10 — Music (the obvious one)
//   24 — Entertainment (catches the misclassified majority)
//
// Expanding further (e.g. 22 People & Blogs, 1 Film) starts pulling
// in vlogs and movie clips, which is what we wanted to filter out
// in the first place. The 10/24 pair is the empirical sweet spot.
const MUSIC_CATEGORY_IDS = new Set(["10", "24"]);

// `getSavedTracks` is now a thin slicer over the `fetchMusicLibrary`
// cache — that helper does ONE pass over the user's liked playlist
// (with the music-category filter applied), caches the full result,
// and every paginated call slices the cached array. This avoids the
// previous bug where offset-based pagination over the raw playlist
// re-scanned upstream pages already consumed by an earlier call,
// returning duplicate tracks AND keeping `next: "ytcontinue"` set
// indefinitely so the library page's infinite-scroll spinner never
// hid. Now the library is a stable snapshot for the cache TTL,
// pagination is deterministic, and the spinner ends when we slice
// past the cached length.
export async function getSavedTracks(
  token: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<SpotifyPaging<SavedTrack>> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const libraryEntries = await fetchMusicLibrary(token);
  const slice = libraryEntries.slice(offset, offset + limit);

  return {
    items: slice,
    total: libraryEntries.length,
    limit,
    offset,
    // Definitive end-of-list when the slice has consumed the cached
    // library. The infinite-scroll loader on the library page hides
    // the moment this flips to null.
    next: offset + limit < libraryEntries.length ? "ytcontinue" : null,
  };
}

// Fetch snippet (for categoryId, used to filter to Music-only) plus
// contentDetails (for duration) for a list of video ids in batches of
// 50 — the /videos endpoint's per-call cap. Replaces the earlier
// duration-only helper.
async function fetchVideoMetadata(
  token: string,
  ids: string[],
): Promise<Map<string, { duration_ms: number; categoryId: string }>> {
  const out = new Map<string, { duration_ms: number; categoryId: string }>();
  if (ids.length === 0) return out;
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  for (const chunk of chunks) {
    const params = new URLSearchParams({
      part: "snippet,contentDetails",
      id: chunk.join(","),
      maxResults: "50",
    });
    const res = await ytFetch<{
      items: {
        id: string;
        snippet?: { categoryId?: string };
        contentDetails?: YtVideoContentDetails;
      }[];
    }>(token, `/videos?${params}`);
    for (const v of res.items) {
      out.set(v.id, {
        duration_ms: parseIsoDurationMs(v.contentDetails?.duration),
        categoryId: v.snippet?.categoryId ?? "",
      });
    }
  }
  return out;
}

// Process-scoped cache for the user's full liked-music library. Single
// source of truth for getSavedTracks (sliced for pagination), search
// (filtered by query), and getArtistTopTracks (filtered by channel).
//
// Trade-offs encoded by the constants below:
//   • TTL: long enough that a normal session of "open library, click
//     around, scrub through track-info modals" doesn't re-scan; short
//     enough that newly-liked tracks appear on the next page-load.
//   • MAX: high enough that the typical user sees their entire
//     liked-music set (so client-side search isn't blind to tracks
//     past the cap); low enough that a cold-cache fetch finishes in a
//     reasonable time. ~10 upstream pages × ~300ms = 3s cold; warm
//     cache returns instantly.
const LIBRARY_CACHE_TTL_MS = 5 * 60_000;
const MUSIC_LIBRARY_MAX = 500;
const libraryCache = new Map<
  string,
  { entries: SavedTrack[]; expiresAt: number }
>();

async function fetchMusicLibrary(token: string): Promise<SavedTrack[]> {
  const now = Date.now();
  const cached = libraryCache.get(token);
  if (cached && cached.expiresAt > now) return cached.entries;

  const collected: SavedTrack[] = [];
  let pageToken: string | undefined;
  let pagesScanned = 0;
  const MAX_PAGES = Math.ceil(MUSIC_LIBRARY_MAX / 50);
  while (collected.length < MUSIC_LIBRARY_MAX && pagesScanned < MAX_PAGES) {
    const params = new URLSearchParams({
      part: "snippet",
      playlistId: "LL",
      maxResults: "50",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await ytFetch<YtPage<YtPlaylistItem>>(
      token,
      `/playlistItems?${params}`,
    );
    pagesScanned++;

    const ids = page.items.map((i) => i.snippet.resourceId.videoId);
    const metadata = await fetchVideoMetadata(token, ids);

    for (const item of page.items) {
      const meta = metadata.get(item.snippet.resourceId.videoId);
      if (!meta || !MUSIC_CATEGORY_IDS.has(meta.categoryId)) continue;
      const track = adaptVideoFromPlaylistItem(item);
      track.duration_ms = meta.duration_ms;
      collected.push({
        added_at: item.snippet.publishedAt ?? new Date().toISOString(),
        track,
      });
    }

    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }

  libraryCache.set(token, {
    entries: collected,
    expiresAt: now + LIBRARY_CACHE_TTL_MS,
  });
  return collected;
}

export async function getTrack(
  token: string,
  id: string,
): Promise<SpotifyTrack> {
  const params = new URLSearchParams({
    part: "snippet,contentDetails",
    id,
  });
  const res = await ytFetch<{ items: YtVideo[] }>(token, `/videos?${params}`);
  const video = res.items[0];
  if (!video) {
    throw new YouTubeApiError(404, null, humanize(404, null));
  }
  return adaptVideo(video);
}

export async function getAlbum(
  token: string,
  albumId: string,
): Promise<SpotifyAlbum> {
  // We synthesise channel-id → album, so deserialise back here. If the
  // caller hands us a non-prefixed id (legacy data, etc.) we just pass
  // it through to the channels endpoint as-is.
  const channelId = albumId.startsWith("channel-")
    ? albumId.slice("channel-".length)
    : albumId;
  const params = new URLSearchParams({
    part: "snippet",
    id: channelId,
  });
  const res = await ytFetch<{
    items: { id: string; snippet: { title: string; thumbnails?: YtThumbnails } }[];
  }>(token, `/channels?${params}`);
  const ch = res.items[0];
  if (!ch) {
    return {
      id: albumId,
      name: "",
      uri: `youtube:channel:${channelId}`,
      images: [],
    };
  }
  return {
    id: albumId,
    name: ch.snippet.title,
    uri: `youtube:channel:${ch.id}`,
    images: pickImages(ch.snippet.thumbnails),
  };
}

export async function getArtistTopTracks(
  token: string,
  artistId: string,
): Promise<{ tracks: SpotifyTrack[] }> {
  // Hybrid strategy for the "Similar songs" surface in the track-info
  // modal:
  //
  //   1. Pull tracks from the same channel out of the user's liked-
  //      music library. These are guaranteed embeddable, cost zero
  //      additional quota, and — when the user has multiple — give the
  //      strongest "this is what you actually like from this artist"
  //      signal.
  //   2. If we have fewer than 3 from the library — typical case,
  //      since most channels appear exactly once in a normal Liked
  //      Videos playlist — augment with a channel-scoped global
  //      search. /search costs 100 quota units, but the modal fires
  //      this on demand (user opens track-info), so the bill is
  //      bounded. order=relevance surfaces the channel's best videos.
  //   3. Dedupe + cap at 10. Library hits keep their position at the
  //      top, search results fill in below.
  //
  // This is intentionally different from searchTracks (the user-facing
  // text search), which stays library-only. Goal here is "always have
  // something to recommend," not "respect what the user typed."
  const library = await fetchMusicLibrary(token);
  const fromLibrary = library
    .map((entry) => entry.track)
    .filter((t) => t.artists[0]?.id === artistId)
    .slice(0, 10);
  // Fast path: if the library has ANY match for this channel, return
  // those and skip the global /search fallback. The fallback costs
  // 100 quota units AND adds ~1-2s to the modal load — only worth
  // paying when the library has nothing to show. Previous threshold
  // of 3 was making most modal opens slow even though the library
  // typically has the artist already.
  if (fromLibrary.length >= 1) return { tracks: fromLibrary };

  try {
    const params = new URLSearchParams({
      part: "snippet",
      channelId: artistId,
      type: "video",
      maxResults: "10",
      order: "relevance",
    });
    const res = await ytFetch<YtPage<YtSearchResult>>(
      token,
      `/search?${params}`,
    );
    const ids = res.items
      .map((r) => r.id.videoId)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) return { tracks: fromLibrary };

    const metadata = await fetchVideoMetadata(token, ids);
    const fromSearch: SpotifyTrack[] = res.items
      .filter((r) => r.id.videoId)
      .map((r) => {
        const id = r.id.videoId!;
        const meta = metadata.get(id);
        return {
          id,
          name: r.snippet.title,
          uri: `youtube:track:${id}`,
          duration_ms: meta?.duration_ms ?? 0,
          preview_url: null,
          album: adaptAlbumFromSnippet(r.snippet),
          artists: [adaptArtistFromSnippet(r.snippet)],
          external_urls: {
            spotify: `https://www.youtube.com/watch?v=${id}`,
          },
        };
      });

    const libraryIds = new Set(fromLibrary.map((t) => t.id));
    const merged = [
      ...fromLibrary,
      ...fromSearch.filter((t) => !libraryIds.has(t.id)),
    ];
    return { tracks: merged.slice(0, 10) };
  } catch (e) {
    // Search fallback failed (quota exceeded, transient outage). Don't
    // bubble — the track-info modal gracefully hides the Similar
    // section when the array is empty.
    console.warn(
      "[youtube] getArtistTopTracks search fallback failed:",
      e instanceof Error ? e.message : e,
    );
    return { tracks: fromLibrary };
  }
}

// Hot picks like "Massive Attack — Teardrop" repeat across thousands of
// AI suggestions, so we cache the (query → top-N tracks) mapping in Redis
// for 30 days. The Data API /search endpoint costs 100 quota units per
// call vs. ~1 unit for /videos, and the app's daily quota is 10k by
// default — without this cache the discover/mood resolve flow would burn
// through the budget after ~6 cold requests.
const SEARCH_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const SEARCH_FETCH_RESULTS = 5;

interface YtSearchResultItem {
  id: { videoId?: string; kind?: string };
  snippet: YtVideoSnippet;
}

export async function searchTracks(
  token: string,
  query: string,
  limit = 1,
): Promise<{ tracks: SpotifyPaging<SpotifyTrack> }> {
  // Strip the Spotify-style field-qualifiers (`track:foo artist:bar`)
  // — they're literal tokens to YouTube's relevance ranker and would
  // tank recall.
  const cleaned = query
    .replace(/track:\s*/gi, "")
    .replace(/artist:\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return {
      tracks: { items: [], total: 0, limit, offset: 0, next: null },
    };
  }

  // Cache key is query-only (lowercased), so the same suggestion across
  // different users / sessions hits the same entry. Negative results
  // ({ tracks: [] }) are cached too — if /search returned nothing once,
  // a retry tomorrow probably won't help and isn't worth the quota.
  const cacheKey = `yt:search:v1:${cleaned.toLowerCase()}`;
  const cached = await cacheGet<{ tracks: SpotifyTrack[] }>(cacheKey);
  if (cached) {
    return {
      tracks: {
        items: cached.tracks.slice(0, limit),
        total: cached.tracks.length,
        limit,
        offset: 0,
        next: null,
      },
    };
  }

  // Cache miss → real /search. We deliberately omit videoCategoryId:
  // YouTube's /search endpoint doesn't reliably honour category +
  // q= together (the combination often returns zero results, and
  // many legitimate music videos are misclassified as Entertainment
  // anyway — see MUSIC_CATEGORY_IDS for context). The relevance
  // ranker on q= is a good-enough music filter for AI-suggested
  // queries like "title:foo artist:bar" because the title/artist
  // text already constrains the result set.
  //
  // We always pull a small pool (SEARCH_FETCH_RESULTS) regardless of
  // limit so the cache entry is reusable for callers asking for
  // different limits.
  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    q: cleaned,
    maxResults: String(SEARCH_FETCH_RESULTS),
  });
  let searchRes: { items: YtSearchResultItem[] };
  try {
    searchRes = await ytFetch<{ items: YtSearchResultItem[] }>(
      token,
      `/search?${params}`,
    );
  } catch (e) {
    // Most likely a 403 quotaExceeded once a day's budget is gone.
    // Surface as empty so the discover route's outer logic just shows
    // fewer cards rather than 502ing the whole request.
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[youtube] /search failed:",
        e instanceof Error ? e.message : e,
      );
    }
    return {
      tracks: { items: [], total: 0, limit, offset: 0, next: null },
    };
  }

  const videoIds = searchRes.items
    .map((i) => i.id.videoId)
    .filter((id): id is string => !!id);
  if (videoIds.length === 0) {
    await cacheSet(cacheKey, { tracks: [] }, SEARCH_CACHE_TTL_SECONDS);
    return {
      tracks: { items: [], total: 0, limit, offset: 0, next: null },
    };
  }

  // Hydrate duration; categoryId is already constrained by the search
  // filter so we don't filter on it again.
  let metadata: Awaited<ReturnType<typeof fetchVideoMetadata>>;
  try {
    metadata = await fetchVideoMetadata(token, videoIds);
  } catch {
    metadata = new Map();
  }

  const tracks: SpotifyTrack[] = [];
  for (const item of searchRes.items) {
    const id = item.id.videoId;
    if (!id) continue;
    const meta = metadata.get(id);
    tracks.push({
      id,
      name: item.snippet.title,
      uri: `youtube:track:${id}`,
      duration_ms: meta?.duration_ms ?? 0,
      preview_url: null,
      album: adaptAlbumFromSnippet(item.snippet),
      artists: [adaptArtistFromSnippet(item.snippet)],
      external_urls: { spotify: `https://www.youtube.com/watch?v=${id}` },
    });
  }

  await cacheSet(cacheKey, { tracks }, SEARCH_CACHE_TTL_SECONDS);
  return {
    tracks: {
      items: tracks.slice(0, limit),
      total: tracks.length,
      limit,
      offset: 0,
      next: null,
    },
  };
}

// ─── Likes (favorites) ───
//
// /videos/rate is a single endpoint that accepts rating=like|none|dislike
// and a single id per call. We fan out for batches; YouTube's quota is
// in "units" (rate=50 units per call), so a 10-track batch costs 500
// units — fine for typical user behaviour.

export async function saveTracks(token: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await Promise.all(
    ids.map((id) =>
      ytFetch<unknown>(
        token,
        `/videos/rate?id=${encodeURIComponent(id)}&rating=like`,
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
      ytFetch<unknown>(
        token,
        `/videos/rate?id=${encodeURIComponent(id)}&rating=none`,
        { method: "POST" },
      ),
    ),
  );
}

export async function checkSavedTracks(
  token: string,
  ids: string[],
): Promise<boolean[]> {
  if (ids.length === 0) return [];
  // /videos/getRating accepts a comma-separated list of ids and
  // returns each rating ("like" | "dislike" | "none" | "unspecified")
  // in the same order. Up to 50 ids per call.
  const out: boolean[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const params = new URLSearchParams({ id: chunk.join(",") });
    const res = await ytFetch<{
      items: { videoId: string; rating: string }[];
    }>(token, `/videos/getRating?${params}`);
    const byId = new Map(res.items.map((r) => [r.videoId, r.rating]));
    for (const id of chunk) out.push(byId.get(id) === "like");
  }
  return out;
}
