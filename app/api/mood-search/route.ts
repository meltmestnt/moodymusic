import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import OpenAI from "openai";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import type { SpotifyTrack } from "@/lib/spotify";
import { getServiceForSession } from "@/lib/music-service";
import { logSearch } from "@/lib/db/events";
import { getCollections } from "@/lib/mongo";
import {
  getAppAccessToken as getSoundCloudAppToken,
  searchTracks as searchSoundCloudTracks,
} from "@/lib/soundcloud";
import {
  anonMoodDailyCap,
  cacheGet,
  cacheSet,
  moodCacheKey,
  shortHash,
  throttleAnonMoodSearch,
  throttleMoodSearch,
} from "@/lib/redis";

// How many of the user's most recent searches to scan for already-shown
// tracks. Bumped from 5 → 15 so a user repeatedly regenerating against
// the same mood doesn't see picks recycle once their avoid-list saturates.
// 15 × ~8 = ~120 unique entries on average, which we cap below.
const AVOID_RECENT_SEARCHES = 15;
// Hard cap on the avoid-list we feed to OpenAI. Bumped from 30 → 80:
// at gpt-4o-mini's pricing the extra prompt tokens are negligible
// (~$0.00003 per search), and a richer avoid-list is the lever that
// most directly fixes the "I keep seeing the same songs" complaint.
const AVOID_TRACKS_MAX = 80;

async function getRecentlyShownTracks(userId: string): Promise<string[]> {
  const cols = await getCollections();
  if (!cols) return [];
  try {
    const rows = await cols.searches
      .find({ spotifyUserId: userId })
      .sort({ createdAt: -1 })
      .limit(AVOID_RECENT_SEARCHES)
      .project<{
        resolvedTracks: { name: string; artists: string[] }[];
      }>({ resolvedTracks: 1 })
      .toArray();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of rows) {
      for (const tr of row.resolvedTracks ?? []) {
        const artist = tr.artists?.[0] ?? "?";
        const label = `${tr.name} — ${artist}`;
        const key = label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(label);
        if (out.length >= AVOID_TRACKS_MAX) return out;
      }
    }
    return out;
  } catch {
    return [];
  }
}

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

// Mood-search cache TTL: 15 minutes. Long enough that "calm rainy" still
// hits cache when the user closes and re-opens the page; short enough
// that a curated playlist stays fresh as we tweak the prompt or model.
const CACHE_TTL_SECONDS = 15 * 60;

// Shape of what we send back to the client (and what we cache in Redis).
// searchId is the Mongo _id of the row written by logSearch — the client
// uses it to pin the URL to ?id=<id> so refresh + back/forward replay
// the saved suggestions instead of burning another OpenAI call. Null
// when persistence skipped (anon visitors, Mongo down).
type MoodResponseBody = {
  tracks: { track: SpotifyTrack; reason: string | null }[];
  searchId?: string | null;
};

const requestSchema = z.object({
  mood: z.string().min(2).max(500),
  // How many songs the AI should return. Clamped to a sane window — the UI
  // sizes the grid for "two rows" depending on viewport (8 on desktop, 6
  // below), so anything outside [1, 20] is almost certainly junk input.
  count: z.number().int().min(1).max(20).optional(),
});

// Empty arrays happen in practice when the model refuses (NSFW prompt) or
// can't satisfy a hard era filter — we treat that as "no results" downstream
// instead of throwing a generic upstream_error.
const suggestionSchema = z.object({
  songs: z
    .array(
      z.object({
        title: z.string(),
        artist: z.string(),
        reason: z.string().optional(),
      }),
    )
    .max(20),
});

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const svc = getServiceForSession(session);
  // Anonymous fallback: when there's no signed-in provider we fall back to
  // SoundCloud's public catalogue for track resolution and apply a stricter
  // per-IP throttle (15s spacing, daily cap). The OpenAI call itself runs
  // either way — anon users still get AI-curated picks, just streamed via
  // the SoundCloud Widget rather than Spotify Connect.
  const isAnon = !svc || !session;

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { code: "config_error", error: "OPENAI_API_KEY is not configured." },
      { status: 500 },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const startedAt = Date.now();
  const count = parsed.data.count ?? 8;

  // Anon path needs a SoundCloud app token to resolve picks; reject early
  // if the deploy hasn't configured one rather than burning the OpenAI
  // call only to fail at resolution time.
  let anonScToken: string | null = null;
  if (isAnon) {
    try {
      anonScToken = await getSoundCloudAppToken();
    } catch (e) {
      if (process.env.NODE_ENV !== "production") {
        console.error("[mood-search] anon SC token grant failed:", e);
      }
      return NextResponse.json(
        { code: "config_error", error: "Free mood search isn't configured." },
        { status: 500 },
      );
    }
  }

  // Throttle BEFORE cache lookup so a client can't pound the same cached
  // mood as a denial-of-service against our backend. Two regimes:
  //   • Signed in: escalating per-user schedule + UTC-day cap.
  //   • Anon:      flat 15s spacing + 20/day cap, keyed by IP.
  let anonRemaining = anonMoodDailyCap();
  if (isAnon) {
    const ip = clientIp(req);
    const decision = await throttleAnonMoodSearch(ip);
    if (!decision.ok) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(decision.retryAfterMs / 1000),
      );
      return NextResponse.json(
        {
          code: decision.reason === "daily_cap" ? "anon_daily_cap" : "throttled",
          error:
            decision.reason === "daily_cap"
              ? "Free daily limit reached — sign in to keep searching."
              : "Slow down — wait a moment between searches.",
          retryAfterMs: decision.retryAfterMs,
          retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfterSeconds) },
        },
      );
    }
    anonRemaining = decision.remaining;
  } else if (session?.user?.id) {
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
          retryAfterMs: decision.retryAfterMs,
          retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfterSeconds) },
        },
      );
    }
  }

  // Pull the user's recently-shown tracks BEFORE the cache check, so the
  // cache key includes a hash of that list. Same user + same recent state
  // → cache hit; after they search a different mood, recent state changes,
  // cache key changes, fresh AI call → fresh tracks. This is the
  // "make them unique in every search" mechanism. Anon visitors don't have
  // search history, so we skip the avoid-list entirely for them — repeats
  // are fine on the free tier.
  const avoidTracks = !isAnon && session?.user?.id
    ? await getRecentlyShownTracks(session.user.id)
    : [];
  const avoidHash = avoidTracks.length
    ? shortHash(avoidTracks.join("|"))
    : undefined;

  // Cache lookup before any upstream calls. Key includes model + count +
  // avoidHash so changing OPENAI_MODEL, row-count, or recent-history all
  // drop old entries automatically. Cache hits skip BOTH the OpenAI call
  // (~$0.0003) AND the Spotify-resolution roundtrip. Anon hits live under
  // a separate namespace — their tracks are SoundCloud-shaped and can't
  // be served to a Spotify-signed-in user.
  const cacheKey = moodCacheKey(
    parsed.data.mood,
    count,
    MODEL,
    avoidHash,
    isAnon ? "anon" : "auth",
  );
  const cached = await cacheGet<MoodResponseBody>(cacheKey);
  if (cached) {
    // Still log the search to Mongo so a user's "search history" reflects
    // what they actually queried. Mark it cached so we can measure hit
    // rate later. Anon visitors don't have an account to attach the log
    // to, so we skip persistence for them.
    let cachedSearchId: string | null = null;
    if (!isAnon && session?.user?.id) {
      cachedSearchId = await logSearch({
        user: {
          spotifyUserId: session.user.id,
          provider: session.provider ?? "spotify",
          displayName: session.user.name ?? null,
          email: session.user.email ?? null,
          image: session.user.image ?? null,
          product: session.user.product ?? null,
        },
        mood: parsed.data.mood,
        suggestions: [],
        resolvedTracks: cached.tracks.map((t) => t.track),
        model: `${MODEL} (cached)`,
        durationMs: Date.now() - startedAt,
      });
    }
    // searchId is the fresh row for THIS request, not whatever was in the
    // Redis blob — each cache hit still creates its own history row so
    // refreshing the page replays this specific occurrence.
    return NextResponse.json(
      isAnon
        ? { ...cached, anon: { remaining: anonRemaining, cap: anonMoodDailyCap() } }
        : { ...cached, searchId: cachedSearchId },
    );
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  // Default 8 = a full row on desktop. Smaller viewports pass 6 so the UI
  // still shows two filled rows. We over-ask OpenAI by a comfortable
  // buffer — many suggestions don't survive the Spotify-search resolution
  // step (mixtape-only tracks, slight name variants, regional licensing
  // gaps), and a +2 buffer regularly left users with 6 cards when they
  // wanted 8. +4 covers the common shortfall.
  const askFor = Math.min(20, count + 4);

  // System prompt. Four jobs:
  //   1. Parse the mood prompt for SIGNALS, not just keywords — time of
  //      day, weather, activity, energy level, mental state, lyric
  //      preference, era hint. Then match songs against those exact
  //      signals.
  //   2. Push past the obvious "every-playlist" picks. Default-trained
  //      LLMs gravitate to whatever's most-cited online — Marvin Gaye
  //      for "intimate", Bon Iver for "rainy", Eminem for "gym" — which
  //      kills discovery.
  //   3. Vary genre, era, region, and tempo across the list.
  //   4. Treat the avoid-list as a HARD ban on consecutive regenerates —
  //      this is the lever that fixes "I keep seeing the same songs".
  const avoidBlock = avoidTracks.length
    ? [
        "",
        "",
        "HARD EXCLUSION LIST (the user has already been shown these in",
        "recent searches — do NOT pick any of them, do NOT pick alternate",
        "versions / live cuts / remixes of them, do NOT pick the same",
        "artist twice in a row across these). Treat this as a banned set:",
        ...avoidTracks.map((t) => `  - ${t}`),
      ].join("\n")
    : "";

  const systemPrompt = [
    "You are an expert music curator with deep, specific knowledge of",
    "global catalogs across decades, genres, regions, and scenes. Your",
    "job is to match a user's described moment to songs that actually",
    "fit THAT moment — not the genre the moment loosely resembles.",
    "",
    "Respond with ONLY a JSON object of the form",
    '{"songs":[{"title":"...","artist":"...","reason":"..."}]}.',
    "",
    `Pick EXACTLY ${askFor} real songs available on Spotify (use canonical`,
    "song + artist names so they look up cleanly).",
    isAnon
      ? "AUDIENCE NOTE: this visitor isn't signed in — resolution falls back to SoundCloud's public catalog. Prefer well-known popular tracks (Top-40, viral, classic radio singles) over obscure deep cuts; uploads of major-label deep cuts may be missing on SoundCloud."
      : "",
    "",
    "═══ STEP 1: PARSE THE PROMPT ═══",
    "Before picking a single song, internally extract these signals from",
    "the user's prompt (don't write them in your output, just use them):",
    "  • NAMED MEDIA: any specific game, film, TV show, anime, book,",
    "    band, album, artist, fictional character, real event, or place",
    '    the user name-checks. Examples: "Doom", "Cyberpunk 2077",',
    '    "Drive", "Twin Peaks", "Berserk", "Hotline Miami", "Evangelion",',
    '    "Witcher 3", "Stranger Things". THIS IS PRIMARY — see Step 1b.',
    "  • TEMPO/ENERGY: still / slow / mid / driving / frantic",
    "  • VALENCE: dark / melancholic / bittersweet / warm / euphoric",
    "  • SETTING: time of day, weather, location, activity",
    "  • INTENSITY: background / focused / immersive / overwhelming",
    "  • VOCAL STANCE: instrumental, sparse vocals, full vocals,",
    "    spoken / rap, choral",
    "  • ERA: explicit year/decade, OR generation slang, OR retro/current",
    "    cue. THIS IS A HARD FILTER — see Step 1a.",
    "  • LANGUAGE/REGION: any cultural cue (a city, a language, a scene)",
    "  • LYRICAL CONTENT: themes the user implied (heartbreak, defiance,",
    "    longing, pride, drift, anger) — pick songs whose lyrics align",
    "Every pick must satisfy MULTIPLE signals, not just one.",
    "",
    "═══ STEP 1a: HARD ERA FILTER ═══",
    "If the prompt names a generation, decade, or year — including in",
    'parentheses or as a tag (e.g. "(zoomer edition)", "90s vibe",',
    '"y2k", "very 2014", "early 2020s") — that constrains the ENTIRE',
    "pick set to that era. No exceptions, no 'classics that fit anyway'.",
    "Mapping (use the modern usage of each term, not the literal birth-",
    "year cohort):",
    "  • zoomer / gen z / tiktok / 'very online'  →  2018 to present,",
    "    skewing 2020+. Hyperpop, bedroom pop, alt-R&B, drill,",
    "    Afrobeats, K-pop B-sides, viral TikTok cuts, plugg, jersey",
    "    club, rage. Artists like PinkPantheress, d4vd, The Marías,",
    "    Faye Webster, Dijon, Steve Lacy, Tyla, Ice Spice, RAYE,",
    "    Yeat, Jane Remover, Dazey & The Scouts, mk.gee, Geese, etc.",
    "  • millennial / 2000s / y2k / emo  →  2000 – 2014 squarely.",
    "  • gen x / 90s  →  1988 – 1999.",
    "  • boomer / classic / oldies  →  1960 – 1985.",
    "  • dadrock / yacht  →  1970s – early 80s soft rock.",
    "When the era is set, do NOT include any song from outside it,",
    "even if it 'fits the vibe perfectly'. Pick a different song from",
    "inside the era that hits the same vibe instead.",
    "Tied to this: VARY-by-decade rule below RELAXES under a hard era —",
    "all picks can be from the SAME decade if that's what the user",
    "asked for. Don't smuggle in older 'staples' to satisfy variety.",
    "",
    "═══ STEP 1b: NAMED-MEDIA RULE ═══",
    "If the prompt name-checks a specific game, film, TV show, anime,",
    "book, real event, or fictional setting (in ANY language — Cyrillic,",
    'Latin, etc), treat that as a PRIMARY signal, not just flavor text.',
    'Examples: "playing doom", "грає в doom", "Cyberpunk vibes",',
    '"like Drive (2011)", "Twin Peaks mood", "Berserk OST", "Hotline',
    'Miami soundtrack feel", "Witcher 3 tavern".',
    "When named media is detected, target ~50% of the picks for that",
    "media's ACTUAL soundtrack / score / companion tracks (canonical",
    "artist + track name as released on streaming). The REMAINING picks",
    "must be tracks that share the named work's musical DNA — same",
    "composer's other work, contemporaries with the same sound, tracks",
    "the original soundtrack was clearly influenced by, or other works",
    "in the same scene/genre that the original drew from.",
    "",
    `OUTPUT COUNT IS NON-NEGOTIABLE: you MUST return ${askFor} picks even`,
    "when named media is in play. If the named work has a small OST and",
    "you can only confidently name 3-4 tracks from it, USE THOSE 3-4 +",
    `FILL the rest (${askFor} − N) with the adjacent / influenced /`,
    'genre-sibling tracks defined above. Never short the list. For',
    '"playing Doom" specifically: 3-4 Mick Gordon Doom tracks, then',
    "fill out with Meshuggah, Author & Punisher, Perturbator, GosT,",
    "Bring Me The Horizon (heavy era), Breaking Benjamin, Linkin Park",
    "(Hybrid Theory), Killswitch Engage, Skillet, Trivium, Machine Head,",
    "Dream Theater — i.e. the heavy/industrial gaming-adjacent canon.",
    "Concrete examples (do not memorise these as the answers — use",
    "them as the SHAPE of how to think):",
    '  • "playing Doom" → Mick Gordon "BFG Division", "Rip & Tear",',
    '    "The Only Thing They Fear Is You"; then Meshuggah, Author &',
    "    Punisher, Perturbator, GosT, industrial-metal contemporaries.",
    '  • "Cyberpunk 2077 night drive" → P. T. Adamczyk "Phantom Liberty",',
    '    SAMURAI "Chippin\' In", Health "Delicious Ape"; then',
    "    Carpenter Brut, Perturbator, dark synthwave.",
    '  • "Stranger Things mood" → Kyle Dixon & Michael Stein themes,',
    '    then era-correct 80s (Tangerine Dream, Vangelis, New Order).',
    '  • "Berserk 1997 vibe" → Susumu Hirasawa "Forces", "Sign",',
    '    then his solo work + dark prog.',
    "If the prompt also adds a vibe modifier (e.g. \"calm doom\",",
    '"sad Cyberpunk"), bias the picks toward the SLOWER / QUIETER',
    "tracks within that media's actual soundtrack first.",
    "Named media also relaxes the ≤1-track-per-artist rule for the",
    "core composer(s) — Mick Gordon can appear 3-4 times across a",
    '"playing Doom" set.',
    "Named media RESPECTS the era filter only when the user combined",
    'both (e.g. "Doom 1993 OST"). Otherwise, use whichever release of',
    "the named media's music best fits the prompt — Doom 2016/2020",
    "for an unspecified Doom prompt, not the 1993 MIDI tracks.",
    "",
    "═══ STEP 1c: SIMILAR-TO RULE (sonic anchor) ═══",
    "When the user frames the request as \"songs LIKE / SIMILAR TO / in",
    "the vein of / in the style of / sounds like / reminds me of [ARTIST]",
    "(optionally — [TRACK])\" — INCLUDING the Slavic phrasings",
    '"схоже на / схожі на / в стилі / у стилі / як / как / похоже на /',
    'похож на / напоминает / в духе" — treat the named artist+track as',
    "a SONIC ANCHOR, not a genre tag. This rule takes precedence over",
    "Step 2's generic anti-obvious advice (the user is explicitly asking",
    "for adjacent picks, not lateral mood matches).",
    "",
    "1. Internally decompose the anchor's musical DNA across multiple",
    "   axes: genre + sub-scene, tempo curve, production texture (lo-fi",
    "   vs polished, dry vs reverbed, organic vs digital), vocal approach",
    "   (clean / scream / spoken / falsetto / harmonized), instrumentation",
    "   (guitar tones, synth palette, drum programming, bass weight),",
    "   lyrical/emotional register, and the era/scene the track lives in.",
    "2. Surface ~80% of picks from SIBLING ARTISTS — different artists",
    "   who share the anchor on AT LEAST 3 of those axes. 'Same genre",
    "   tag' is NOT enough; production aesthetic + emotional register",
    "   are the strong signals. Concrete examples (use as the SHAPE of",
    "   how to think, do not memorise as canonical answers):",
    "     • Deftones \"Rosemary\" / \"Knife Party\" / \"Tempest\"  →",
    "       Bring Me The Horizon (Sempiternal / amo era), Loathe,",
    "       Spiritbox, Sleep Token, Holding Absence, Narrow Head,",
    "       Greet Death, Hum, Cult of Luna, Quicksand. NOT Korn /",
    "       Limp Bizkit — wrong production texture, wrong era.",
    "     • Radiohead \"Pyramid Song\"  →  Talk Talk (Spirit of Eden),",
    "       Bark Psychosis, Bohren & der Club of Gore, Mount Eerie,",
    "       Grouper, Tim Hecker.",
    "     • Tame Impala \"Let It Happen\"  →  Pond, MGMT (Congratulations),",
    "       Unknown Mortal Orchestra, Connan Mockasin, Khruangbin.",
    "     • Frank Ocean \"Pyramids\"  →  Blood Orange, Steve Lacy, James",
    "       Blake (Overgrown), Sampha, Solange.",
    "     • Phoebe Bridgers \"Motion Sickness\"  →  Lucy Dacus, Julien",
    "       Baker, Soccer Mommy, Snail Mail, Indigo De Souza.",
    "3. Reserve EXACTLY ONE pick from the SAME named artist — a deeper-",
    "   catalog track that COMPLEMENTS the named one (different album,",
    "   adjacent mood). Do NOT include the named track itself; the user",
    "   already knows it. Banned set effectively grows by one.",
    "4. AVOID karaoke-style imitators and tribute acts. The goal is",
    "   'artists this fan would discover next', not 'soundalikes'.",
    "   Cross scenes when the DNA matches — a shoegaze listener can",
    "   love post-metal, an R&B listener can love alt-soul.",
    "5. The ≤ 1-track-per-artist rule still applies to siblings; the",
    "   one exception is the anchor artist (allowed exactly one slot).",
    "6. If the user names ONLY an artist (no track), pick the artist's",
    "   single most representative track for axis #1 of the DNA decomp,",
    "   then apply rules 2–5 normally.",
    "",
    "═══ STEP 2: PICK SPECIFIC SONGS ═══",
    "• AVOID the top-of-Google picks for the vibe. If the prompt is",
    '  "songs for sex", do NOT default to "Let\'s Get It On" /',
    '  "Sexual Healing" / "Earned It". If "rainy day", do NOT lead with',
    "  Bon Iver / Cigarettes After Sex / Mazzy Star. These are the lazy",
    "  picks every model defaults to. Reach for one or two layers deeper:",
    "  cult classics, B-sides, contemporary equivalents, regional scenes,",
    "  artists with <500k monthly listeners that fit perfectly.",
    "• Each pick must read as a DELIBERATE match for THIS prompt's",
    "  specifics. A song that fits 'rainy day' generically is NOT enough",
    "  if the user said 'rainy Sunday morning, slow start, quietly",
    "  hopeful' — that calls for a different curve than 'late rainy",
    "  Tuesday, missing someone'. Honor the difference.",
    "• VARY across the list: ≤ 1 track per artist; ≤ 2 picks from any",
    "  single decade UNLESS Step 1a's hard era filter pinned the era,",
    "  in which case all picks stay in-era; mix at least one non-",
    "  English-language pick if the vibe permits; span at least 3",
    "  distinct sub-genres or scenes within the allowed era.",
    "• Each `reason` is ONE short clause (≤ 14 words) naming the SPECIFIC",
    "  signal-match (e.g. 'glassy synth pad + half-time drums fit the",
    "  3am-coding stillness' — not 'great chill electronic song').",
    "",
    "═══ STEP 3: RESPECT THE EXCLUSION LIST ═══",
    "If a hard exclusion list is given below, the listed tracks are",
    "FORBIDDEN. The user has already seen them. Picking them — or live",
    "versions / remixes / acoustics of them — wastes the slot. Pick a",
    "different song that hits the same signals.",
    "",
    "Output JSON only, no preface, no trailing prose, no markdown.",
    avoidBlock,
  ].join("\n");

  let suggestions: z.infer<typeof suggestionSchema>;
  try {
    const completion = await openai.chat.completions.create({
      // Configurable via OPENAI_MODEL env. Default gpt-4o-mini gives strong
      // music knowledge for ~$0.0003/search; JSON mode keeps parsing reliable.
      model: MODEL,
      response_format: { type: "json_object" },
      // Higher temperature for more variety — at the default ~0.7 the
      // model still anchors on the same handful of canonical tracks for a
      // given vibe. 0.9 + the avoid-list produces noticeably fresher
      // picks while staying coherent.
      temperature: 0.9,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: parsed.data.mood },
      ],
    });
    const raw = completion.choices[0]?.message.content ?? "{}";
    suggestions = suggestionSchema.parse(JSON.parse(raw));
  } catch (e) {
    // Classify upstream OpenAI failures into a small stable set of codes.
    // The frontend renders a localized, user-friendly message per code —
    // we intentionally don't surface raw provider strings (billing /
    // quota messages with internal URLs leaked to end users).
    let code = "upstream_error";
    let status = 502;
    if (e instanceof OpenAI.APIError) {
      if (e.status === 429) {
        code = e.code === "insufficient_quota" ? "quota_exceeded" : "rate_limited";
        status = 429;
      } else if (e.status === 401) {
        code = "config_error";
        status = 500;
      }
    }
    if (process.env.NODE_ENV !== "production") {
      console.error("mood-search openai error:", e);
    }
    return NextResponse.json({ code, error: code }, { status });
  }

  // Resolve every suggestion to a real track. We fire the searches in
  // parallel; misses (track not found) silently drop out of the result set
  // rather than failing the whole request. Authed sessions resolve against
  // the user's provider (Spotify / Deezer / SoundCloud / YouTube); anon
  // sessions resolve against SoundCloud's public catalogue using the
  // app-credentials token so the visitor can play the picks via the
  // SoundCloud Widget without signing in.
  //
  // SoundCloud's catalog is much narrower than Spotify's: a precise
  // `title artist` query frequently returns nothing because the upload is
  // by a remixer or compilation channel. We try progressively looser
  // queries before giving up — title+artist → "artist title" → title only.
  // For authed providers the existing single-shot query is plenty.
  const resolved = await Promise.all(
    suggestions.songs.map(async (s) => {
      const tryQueries: string[] = isAnon
        ? [`${s.title} ${s.artist}`, `${s.artist} ${s.title}`, s.title]
        : [`track:${s.title} artist:${s.artist}`];
      for (const q of tryQueries) {
        try {
          const result = isAnon
            ? await searchSoundCloudTracks(anonScToken!, q, 1)
            : await svc!.searchTracks(q, 1);
          const track = result.tracks.items[0];
          if (track) return { track, reason: s.reason ?? null };
        } catch (err) {
          if (process.env.NODE_ENV !== "production") {
            console.warn(
              `[mood-search] resolve failed for "${q}":`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      }
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          `[mood-search] no match for "${s.title}" by "${s.artist}" (isAnon=${isAnon})`,
        );
      }
      return null;
    }),
  );

  let tracks: { track: SpotifyTrack; reason: string | null }[] = resolved
    .filter(
      (r): r is { track: SpotifyTrack; reason: string | null } => r !== null,
    );

  // ─── Backfill pass ──────────────────────────────────────────────────
  //
  // If the first pass under-delivers (most often when a named-media
  // prompt resolves to a small OST + the AI didn't pad with enough
  // adjacent picks, or when many suggestions fail provider lookup),
  // fire a second OpenAI call WITHOUT the named-media rule. The
  // backfill prompt is a pure vibe-matcher, and the already-resolved
  // tracks join the avoid-list so we don't re-pick them.
  //
  // Skipped on anon (cost discipline — anon path is gated by per-IP
  // throttles and a tiny daily cap; doubling AI spend per request
  // would invert the economics), and skipped when we already have
  // ≥ count (no shortfall to fill).
  if (tracks.length < count && !isAnon) {
    const shortfall = count - tracks.length;
    const fillerAskFor = Math.min(20, shortfall + 4);
    const alreadyShown = tracks.map(
      (t) => `${t.track.name} — ${t.track.artists[0]?.name ?? "?"}`,
    );
    const fillerExclusion = [...avoidTracks, ...alreadyShown];
    const fillerExclusionBlock = fillerExclusion.length
      ? [
          "",
          "HARD EXCLUSION LIST (already shown — do NOT pick any of these,",
          "do NOT pick alternate versions / live cuts / remixes of them):",
          ...fillerExclusion.map((t) => `  - ${t}`),
        ].join("\n")
      : "";
    // Stripped-down prompt: same parsing/picking discipline as the main
    // prompt but the named-media rule is OFF — we want pure vibe match
    // to backfill thematically (e.g. "playing Doom" → heavy/industrial
    // adjacent: Bring Me The Horizon, Breaking Benjamin, Linkin Park,
    // Killswitch Engage). Era filter still applies.
    const fillerSystemPrompt = [
      "You are an expert music curator. Pick songs that match the vibe",
      "of the user's prompt — pure mood matching, no named-media bias.",
      "",
      "Respond with ONLY a JSON object of the form",
      '{"songs":[{"title":"...","artist":"...","reason":"..."}]}.',
      "",
      `Pick EXACTLY ${fillerAskFor} real songs available on Spotify (use`,
      "canonical song + artist names so they look up cleanly).",
      "",
      "Read the prompt for: tempo/energy, valence, setting, intensity,",
      "vocal stance, era hints, language/region, lyrical themes. Every",
      "pick must match MULTIPLE signals.",
      "",
      "Honor any era hints the user gave (a decade, generation slang,",
      "y2k / 90s / 2000s tags) as a HARD filter — no out-of-era picks.",
      "",
      "Vary across the list: ≤ 1 track per artist; span at least 3",
      "distinct sub-genres or scenes if the era allows. Reach a layer",
      "deeper than the top-of-Google picks for the vibe.",
      "",
      "Each `reason` is ONE short clause (≤ 14 words) naming the",
      "specific signal-match.",
      "",
      "Output JSON only.",
      fillerExclusionBlock,
    ].join("\n");

    try {
      const fillerCompletion = await openai.chat.completions.create({
        model: MODEL,
        response_format: { type: "json_object" },
        temperature: 0.9,
        messages: [
          { role: "system", content: fillerSystemPrompt },
          { role: "user", content: parsed.data.mood },
        ],
      });
      const fillerRaw =
        fillerCompletion.choices[0]?.message.content ?? "{}";
      const fillerSuggestions = suggestionSchema.parse(
        JSON.parse(fillerRaw),
      );
      const fillerResolved = await Promise.all(
        fillerSuggestions.songs.map(async (s) => {
          const tryQueries: string[] = [
            `track:${s.title} artist:${s.artist}`,
          ];
          for (const q of tryQueries) {
            try {
              const result = await svc!.searchTracks(q, 1);
              const track = result.tracks.items[0];
              if (track) return { track, reason: s.reason ?? null };
            } catch {
              /* fall through to next query / null */
            }
          }
          return null;
        }),
      );
      // Drop dupes by track id — the AI was told to avoid them but
      // double-check on the off chance a different naming variant
      // resolved to the same Spotify track.
      const haveIds = new Set(tracks.map((t) => t.track.id));
      for (const r of fillerResolved) {
        if (!r) continue;
        if (haveIds.has(r.track.id)) continue;
        haveIds.add(r.track.id);
        tracks.push(r);
        if (tracks.length >= count) break;
      }
    } catch (e) {
      // Backfill is best-effort — if it errors we still return the
      // first-pass tracks rather than failing the whole request.
      if (process.env.NODE_ENV !== "production") {
        console.warn("[mood-search] backfill failed:", e);
      }
    }
  }

  // Trim back to the count the client asked for. We over-asked OpenAI to
  // hedge against unresolvable suggestions; if everything resolved we
  // still hand back exactly two rows worth.
  tracks = tracks.slice(0, count);

  const responseBody: MoodResponseBody = { tracks };

  // Cache before responding. Best-effort: cacheSet swallows Redis errors,
  // so a Redis blip never fails the user-facing request. Empty results
  // are intentionally NOT cached — they're usually transient (model
  // refusal, all suggestions failed to resolve), and we'd rather a retry
  // succeed than pin the user to a blank grid for 15 minutes.
  if (tracks.length > 0) {
    await cacheSet(cacheKey, responseBody, CACHE_TTL_SECONDS);
  }

  // Persist the search + AI suggestions + resolved tracks for analytics.
  // Best-effort: errors are swallowed inside logSearch so a Mongo blip
  // never fails the user-facing request. Anon visitors have no account
  // to attach to, so we skip persistence — the per-IP throttle counter
  // is the only state we keep for them.
  let searchId: string | null = null;
  if (!isAnon && session?.user?.id) {
    searchId = await logSearch({
      user: {
        spotifyUserId: session.user.id,
        provider: session.provider ?? "spotify",
        displayName: session.user.name ?? null,
        email: session.user.email ?? null,
        image: session.user.image ?? null,
        product: session.user.product ?? null,
      },
      mood: parsed.data.mood,
      suggestions: suggestions.songs,
      resolvedTracks: tracks.map((t) => t.track),
      model: MODEL,
      durationMs: Date.now() - startedAt,
    });
  }

  return NextResponse.json(
    isAnon
      ? { ...responseBody, anon: { remaining: anonRemaining, cap: anonMoodDailyCap() } }
      : { ...responseBody, searchId },
  );
}
