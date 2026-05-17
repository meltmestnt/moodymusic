import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import OpenAI from "openai";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import type { SpotifyTrack } from "@/lib/spotify";
import { getServiceForSession } from "@/lib/music-service";
import { logSearch } from "@/lib/db/events";
import {
  cacheDelete,
  cacheGet,
  cacheSet,
  discoverCacheKey,
  shortHash,
  throttleMoodSearch,
} from "@/lib/redis";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

// 10-min cache for discover. The cached entry lives until either the TTL
// expires OR the user explicitly regenerates (which deletes the entry
// and writes a fresh one under the same key). The page also polls on a
// 10-min cadence, so right around each tick the cached entry has just
// expired and we pull fresh OpenAI picks naturally.
const CACHE_TTL_SECONDS = 10 * 60;

// We pull a larger pool then randomly sample down for the prompt — this
// way a "Regenerate" click can shuffle to a different subset of the same
// library and elicit different recommendations, while normal page loads
// stay cache-friendly (same library + no seed → same shuffle → cache hit).
const LIBRARY_POOL_SIZE = 50;
const LIBRARY_SAMPLE_SIZE = 20;
// How many results we ultimately ship to the client (two desktop rows).
const RESULT_COUNT = 8;
// Over-ask buffer: some suggestions won't resolve via Spotify search,
// some will collide with the user's library and get filtered.
const ASK_FOR = 14;

// Seedable PRNG for deterministic Fisher-Yates. Same seed → same sample
// every time, which is what makes the cache key meaningful — pure
// Math.random() would never produce a cache hit.
function seededShuffle<T>(arr: readonly T[], seed: number): T[] {
  let state = seed >>> 0 || 1;
  const rand = () => {
    // Linear congruential — Numerical Recipes constants. Plenty for
    // shuffling 50 items in a non-cryptographic context.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

type DiscoverResponseBody = {
  tracks: { track: SpotifyTrack; reason: string | null }[];
};

const suggestionSchema = z.object({
  songs: z
    .array(
      z.object({
        title: z.string(),
        artist: z.string(),
        reason: z.string().optional(),
      }),
    )
    .min(1)
    .max(20),
});

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const svc = getServiceForSession(session);
  if (!svc || !session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { code: "config_error", error: "OPENAI_API_KEY is not configured." },
      { status: 500 },
    );
  }

  const url = new URL(req.url);
  const seed = url.searchParams.get("seed") ?? undefined;
  // "Similar to one track" mode — driven by the wand button on a TrackCard.
  // When `similar` is set we swap the prompt to seed-from-one-track and
  // bypass the library shuffle entirely (library is still fetched, but
  // only to filter tracks the user already owns out of the results).
  const similarTrackId = url.searchParams.get("similar") ?? undefined;
  const similarTitle = url.searchParams.get("title") ?? undefined;
  const similarArtist = url.searchParams.get("artist") ?? undefined;
  const isSimilarMode = !!(similarTrackId && similarTitle && similarArtist);
  const startedAt = Date.now();

  // Share the mood-search throttle so the OpenAI rate limiter is one
  // user-facing surface, not two surfaces with separate budgets.
  if (session.user?.id) {
    const decision = await throttleMoodSearch(session.user.id);
    if (!decision.ok) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(decision.retryAfterMs / 1000),
      );
      return NextResponse.json(
        {
          code: "throttled",
          error: "Slow down — too many searches.",
          retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfterSeconds) },
        },
      );
    }
  }

  // Pull a POOL of recent saves (50), then randomly subsample down to 20
  // for the prompt. /me/tracks returns newest-first; the pool captures the
  // user's current-taste window, the shuffle gives variety per regenerate.
  let pool: SpotifyTrack[];
  try {
    const saved = await svc.getSavedTracks({
      limit: LIBRARY_POOL_SIZE,
      offset: 0,
    });
    pool = saved.items.map((i) => i.track);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : `${svc.provider} error` },
      { status: 502 },
    );
  }

  if (pool.length === 0 && !isSimilarMode) {
    return NextResponse.json({
      code: "empty_library",
      error:
        "Save a few tracks first — Discover learns from your library.",
      tracks: [],
    });
  }

  // librarySig = hash of the FULL pool. This is the cache key dimension
  // that captures "the user's library state" — it changes when they save
  // or unsave anything in the pool window.
  const poolIdSet = new Set(pool.map((t) => t.id));
  const librarySig = shortHash([...poolIdSet].sort().join(","));

  // Deterministic shuffle: same library + same seed → same sample → same
  // OpenAI request → cache hit. New seed (regenerate click) → different
  // shuffle → different sample → different prompt → fresh recommendations.
  // We hash librarySig (already a base36 number) + the optional regen seed
  // into a 32-bit integer to feed the PRNG.
  const shuffleSeed =
    parseInt(librarySig, 36) ^ (seed ? parseInt(shortHash(seed), 36) : 0);
  const shuffled = seededShuffle(pool, shuffleSeed);
  const library = shuffled.slice(0, LIBRARY_SAMPLE_SIZE);

  // The Spotify-side filter still uses the FULL pool ids, not just the 20
  // we sampled — we don't want the AI to suggest a track that happens to
  // be in the pool but didn't make this particular shuffle.
  const libraryIdSet = poolIdSet;

  // One cache key per (user, mode). In library mode the dimension is
  // librarySig; in similar mode it's a hash of the seed track id so each
  // "similar to X" request gets its own cache entry. Regenerate clicks
  // send `?seed=…` and DELETE the entry first so the fresh fetch
  // overwrites under the same key.
  const cacheSig = isSimilarMode
    ? shortHash(`similar:${similarTrackId}`)
    : librarySig;
  const cacheKey = session.user?.id
    ? discoverCacheKey(session.user.id, cacheSig, MODEL)
    : null;

  if (cacheKey) {
    if (seed) {
      await cacheDelete(cacheKey);
    } else {
      const cached = await cacheGet<DiscoverResponseBody>(cacheKey);
      if (cached) return NextResponse.json(cached);
    }
  }

  // Sample is just "Title — FirstArtist" — full artist arrays don't help
  // the LLM identify patterns and just add tokens. 20 lines × ~40 chars
  // ≈ 200 tokens for the sample block.
  const sample = library
    .map((t) => `- ${t.name} — ${t.artists[0]?.name ?? "?"}`)
    .join("\n");

  // Compressed prompt — same intent as the long version, ~60% fewer
  // tokens. The bullet list is short imperatives because GPT-4-class
  // models follow terse rules better than verbose explanations.
  const systemPrompt = isSimilarMode
    ? `You're a music curator. The listener wants ${ASK_FOR} songs that are very similar to this one track:
"${similarTitle}" — ${similarArtist}

Output ONLY a JSON object of the form: {"songs":[{"title":"","artist":"","reason":""}]}

Rules:
- The "songs" array must contain ${ASK_FOR} entries
- Match the seed track's genre, era, mood, tempo, and sonic palette
- Don't include the seed track itself; at most 1 other track by ${similarArtist}
- Mid-catalog picks welcome, not just the most-streamed hits
- Max 1 track per artist
- Canonical song + artist names (Spotify-searchable)
- reason: one short clause naming WHY this track is similar to the seed`
    : `You're a music curator. From the listener's saved tracks below, recommend EXACTLY ${ASK_FOR} NEW songs they'll love.

Output ONLY a JSON object of the form: {"songs":[{"title":"","artist":"","reason":""}]}

Rules:
- The "songs" array must contain ${ASK_FOR} entries
- None already in the sample
- Match dominant genre/era/mood patterns, plus 1-2 adjacent picks
- Mid-catalog deep cuts, not the obvious hits
- Max 1 track per artist; vary eras/tempos
- Canonical song + artist names (Spotify-searchable)
- reason: one short clause naming WHY this track fits

Library sample:
${sample}`;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Helper so we can retry the OpenAI call once with a more deterministic
  // configuration if the first attempt returns malformed JSON. JSON-mode
  // does most of the work but at temperature 0.9 the model occasionally
  // emits an empty `{}` or wraps the array — a low-temperature retry
  // recovers without surfacing an error to the user.
  async function callOpenAI(
    temperature: number,
  ): Promise<z.infer<typeof suggestionSchema>> {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      temperature,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: isSimilarMode
            ? `Recommend ${ASK_FOR} tracks very similar to "${similarTitle}" by ${similarArtist}.`
            : `Recommend ${ASK_FOR} new tracks I'll love based on my library above.`,
        },
      ],
    });
    const raw = completion.choices[0]?.message.content ?? "{}";
    return suggestionSchema.parse(JSON.parse(raw));
  }

  let suggestions: z.infer<typeof suggestionSchema>;
  try {
    try {
      suggestions = await callOpenAI(0.9);
    } catch (firstErr) {
      // Only retry on schema/parse failures — not on network or auth errors,
      // those don't get better with a second try.
      const isSchemaIssue =
        firstErr instanceof SyntaxError ||
        (firstErr as { name?: string })?.name === "ZodError";
      if (!isSchemaIssue) throw firstErr;
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          "[discover] first OpenAI attempt produced malformed JSON, retrying at lower temperature:",
          firstErr,
        );
      }
      suggestions = await callOpenAI(0.5);
    }
  } catch (e) {
    let code = "upstream_error";
    let status = 502;
    let detail: string | undefined;
    if (e instanceof OpenAI.APIError) {
      if (e.status === 429) {
        code = e.code === "insufficient_quota" ? "quota_exceeded" : "rate_limited";
        status = 429;
      } else if (e.status === 401) {
        code = "config_error";
        status = 500;
      }
      detail = `${e.status ?? "?"} ${e.code ?? ""} ${e.message}`.trim();
    } else if (e instanceof SyntaxError) {
      code = "bad_response";
      detail = `OpenAI returned non-JSON: ${e.message}`;
    } else if ((e as { name?: string })?.name === "ZodError") {
      code = "bad_response";
      detail = `OpenAI JSON didn't match expected shape`;
    } else if (e instanceof Error) {
      detail = `${e.name}: ${e.message}`;
    }
    if (process.env.NODE_ENV !== "production") {
      console.error("discover openai error:", e, "detail:", detail);
    }
    // In dev we hand the detail back so the page can surface it (the
    // generic toast was hiding the actual cause). Production stays opaque
    // so we never leak provider error strings.
    return NextResponse.json(
      process.env.NODE_ENV !== "production"
        ? { code, error: code, detail }
        : { code, error: code },
      { status },
    );
  }

  // Resolve to real provider tracks. Drop any that come back as null OR
  // collide with the user's library (the prompt forbids it but LLMs slip;
  // we belt-and-suspenders here). In similar mode we also drop the seed
  // track itself so the user never sees the song they clicked from in
  // the results list.
  //
  // Two-pass search per suggestion:
  //   1. strict — `track:title artist:artist` — hits canonical mainstream
  //      tracks; this is the high-precision path.
  //   2. loose — title only — catches tracks where the AI's suggested
  //      artist string didn't match the provider's record exactly, or
  //      where the user is on a smaller-catalog provider (SoundCloud
  //      especially — niche/remix seeds hit empty in pass 1 even when
  //      the same recordings exist under slightly different artist
  //      attributions).
  const resolved = await Promise.all(
    suggestions.songs.map(async (s) => {
      try {
        let track =
          (
            await svc.searchTracks(
              `track:${s.title} artist:${s.artist}`,
              1,
            )
          ).tracks.items[0] ?? null;
        if (!track) {
          track =
            (await svc.searchTracks(s.title, 1)).tracks.items[0] ?? null;
        }
        if (!track) return null;
        if (libraryIdSet.has(track.id)) return null;
        if (isSimilarMode && track.id === similarTrackId) return null;
        return { track, reason: s.reason ?? null };
      } catch {
        return null;
      }
    }),
  );

  // First pass: drop search misses + anything that collides with the 40-track
  // sample (cheap local check). Then ask Spotify which of the remaining IDs
  // are actually in the user's full library — that's the authoritative
  // exclusion the user noticed was missing (their library has more than the
  // 40 most recent saves, and the AI was suggesting older saved tracks).
  const candidates = resolved.filter(
    (r): r is { track: SpotifyTrack; reason: string | null } => r !== null,
  );

  let savedFlags: boolean[] = candidates.map(() => false);
  if (candidates.length > 0) {
    try {
      savedFlags = await svc.checkSavedTracks(
        candidates.map((c) => c.track.id),
      );
    } catch (e) {
      // Fall back to the small-sample filter (already applied above) and
      // log — the upstream being briefly unreachable shouldn't return ALL
      // saved tracks if we treat the failure as "nothing is saved".
      if (process.env.NODE_ENV !== "production") {
        console.warn("[discover] checkSavedTracks failed, returning unfiltered:", e);
      }
    }
  }

  const tracks = candidates
    .filter((_, i) => !savedFlags[i])
    .slice(0, RESULT_COUNT);

  const responseBody: DiscoverResponseBody = { tracks };

  if (session.user?.id) {
    // cacheKey was computed up top (when we did the lookup / regenerate
    // delete). Reusing it here keeps the read + write paths on the same
    // single key per (user, library) — exactly what makes "regenerate
    // replaces the cached entry" hold.
    if (cacheKey) {
      await cacheSet(cacheKey, responseBody, CACHE_TTL_SECONDS);
    }

    // Log to the same searches collection so /stats picks it up. We tag
    // the mood string with a recognisable prefix so analytics can split
    // discover-driven plays from mood-driven ones later.
    await logSearch({
      user: {
        spotifyUserId: session.user.id,
        provider: session.provider ?? "spotify",
        displayName: session.user.name ?? null,
        email: session.user.email ?? null,
        image: session.user.image ?? null,
        product: session.user.product ?? null,
      },
      mood: isSimilarMode
        ? `[discover] similar to ${similarTitle} — ${similarArtist}`
        : "[discover] from library",
      suggestions: suggestions.songs,
      resolvedTracks: tracks.map((t) => t.track),
      model: MODEL,
      durationMs: Date.now() - startedAt,
    });
  }

  return NextResponse.json(responseBody);
}
