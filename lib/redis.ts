import Redis from "ioredis";

// Singleton Redis client. In dev, Next.js HMR reloads modules and would
// otherwise leak a fresh connection on every change — eventually getting
// the local redis-server stuck on stale TCP sockets. We pin the client to
// `globalThis` so the same connection is reused across hot reloads.

declare global {
  // eslint-disable-next-line no-var
  var __moodymusic_redis: Redis | undefined;
}

const URL = process.env.REDIS_URL;

function getClient(): Redis | null {
  if (!URL) return null;
  if (process.env.NODE_ENV === "production") {
    if (!globalThis.__moodymusic_redis) {
      globalThis.__moodymusic_redis = makeClient(URL);
    }
    return globalThis.__moodymusic_redis;
  }
  if (!globalThis.__moodymusic_redis) {
    globalThis.__moodymusic_redis = makeClient(URL);
  }
  return globalThis.__moodymusic_redis;
}

function makeClient(url: string): Redis {
  // maxRetriesPerRequest: 1 keeps a Redis-down failure from blocking a
  // user-facing request for ~30s while ioredis retries internally. We'd
  // rather log a warning and serve from the upstream API.
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: false,
  });
  client.on("error", (err) => {
    // ioredis emits 'error' for every reconnect attempt — log once at info
    // level. Without a listener these would crash node in some Next.js
    // server-action contexts.
    if (process.env.NODE_ENV !== "production") {
      console.warn("[redis] error:", err.message);
    }
  });
  return client;
}

// Returns the parsed value, or null on miss / Redis being unavailable.
// Callers treat null as "cache miss, compute fresh".
export async function cacheGet<T>(key: string): Promise<T | null> {
  const c = getClient();
  if (!c) return null;
  try {
    const raw = await c.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[redis] cacheGet failed:", e);
    }
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[redis] cacheSet failed:", e);
    }
  }
}

// Best-effort delete. Used by the discover route to invalidate the cached
// recommendation when the user explicitly clicks "Regenerate", so the
// next fetch re-populates the same key with fresh picks instead of
// leaving the stale entry sitting under a parallel TTL.
export async function cacheDelete(key: string): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.del(key);
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[redis] cacheDelete failed:", e);
    }
  }
}

// Stable cache key for a mood search. Includes the model name + count so
// changing either invalidates old entries automatically. The optional
// avoidHash lets a per-user "tracks already suggested" list participate
// in the key — same user + same recent state still hits the cache, but a
// fresh search after another query changes the hash, busting the cache
// and producing a unique result. v2 bumped because the prompt changed
// substantially.
export function moodCacheKey(
  mood: string,
  count: number,
  model: string,
  avoidHash?: string,
  audience: "auth" | "anon" = "auth",
): string {
  const normalized = mood.toLowerCase().trim().replace(/\s+/g, " ");
  const suffix = avoidHash ? `:${avoidHash}` : "";
  // Anon results are resolved against SoundCloud, not the user's provider —
  // their track ids/uris aren't interchangeable with the signed-in cache,
  // so they live under a separate namespace.
  const ns = audience === "anon" ? "anon:" : "";
  return `mood:v2:${ns}${model}:${count}:${normalized}${suffix}`;
}

// Tiny djb2 string hash. Used to fold the (potentially long) "avoid"
// track list into the mood cache key without bloating it. Returns a
// base36 unsigned int — collisions are fine here, the worst case is a
// stale cache hit for one search, never a privacy or correctness issue.
export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i); // h * 33 ^ char
  }
  return (h >>> 0).toString(36);
}

// Per-user cache key for /api/discover. The librarySig folds the user's
// saved-track ids into a short hash so the cache invalidates naturally
// when their library changes. There is exactly ONE entry per (user,
// library) — a regenerate click in the UI deletes this entry instead of
// stashing a parallel one under a different seed, which means the
// "current cached recommendation" is always whatever was generated most
// recently.
export function discoverCacheKey(
  userId: string,
  librarySig: string,
  model: string,
): string {
  return `discover:v2:${model}:${userId}:${librarySig}`;
}

// ─── Per-user AI throttle (mood-search + discover share this) ──────────────
//
// Two layers of defense, both enforced server-side:
//
//   1. Spacing schedule — hard minimum gap between consecutive AI calls,
//      escalating with each accepted call. Catches burst clicks and
//      "regenerate every 5 seconds" patterns.
//   2. Daily ceiling — total accepted AI calls per user per UTC day.
//      Catches the patient grinder who paces requests below the spacing
//      threshold.
//
// Both layers fail open if Redis is unavailable (a Redis outage shouldn't
// kill search), and BOTH are skipped entirely in non-production
// environments — local dev would otherwise need a stopwatch to test the
// AI flow. Set MOODYMUSIC_FORCE_AI_THROTTLE=1 in dev to verify the
// throttle code paths without deploying.
function isAiThrottleBypassed(): boolean {
  if (process.env.MOODYMUSIC_FORCE_AI_THROTTLE === "1") return false;
  return process.env.NODE_ENV !== "production";
}

// Long enough that the count doesn't expire DURING a wait — the largest
// throttle in the schedule below is 10 min, so anything shorter would let
// a user "outwait" the counter. Three hours of total inactivity resets.
const THROTTLE_WINDOW_SECONDS = 3 * 60 * 60;

// Spacing schedule. Indexed by `nextCount - 2`:
//   request #1 free, #2 → 30s, #3 → 90s, #4 → 3min, #5 → 5min,
//   #6+ → 10min cap.
// Tighter than the previous "free 2 + 1/2/3 min" schedule because OpenAI
// calls are the dominant cost line and casual clickers were generating
// most of the spend. Power users who actually need new picks every few
// minutes still get them; the schedule punishes BURSTS specifically.
// Mirror in the Lua script below — keep them in sync.
const THROTTLE_SCHEDULE_MS = [
  30_000,    // #2
  90_000,    // #3
  180_000,   // #4
  300_000,   // #5
  600_000,   // #6+
];

// Daily cap — total accepted AI calls per user per UTC day. Default 30.
// Override at deploy time via MOODYMUSIC_AI_DAILY_CAP.
const AI_DAILY_CAP = (() => {
  const raw = process.env.MOODYMUSIC_AI_DAILY_CAP;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 30;
})();

function requiredIntervalMs(count: number): number {
  if (count < 2) return 0;
  const idx = Math.min(count - 2, THROTTLE_SCHEDULE_MS.length - 1);
  return THROTTLE_SCHEDULE_MS[idx]!;
}

export type ThrottleResult =
  | { ok: true }
  | { ok: false; retryAfterMs: number };

// Lua script: atomic check-and-set for both throttle layers. Redis runs
// Lua single-threaded, so two requests that arrive at the same millisecond
// can't both read `count=2` and both decide "no penalty needed" — exactly
// the race that let burst-clicks slip past the JS-side check that did
// GET → compute → SET as separate roundtrips.
//
// Returns 0 when accepted, otherwise either:
//   - a positive number = the required wait in milliseconds (spacing)
//   - -1                = daily cap reached (a magic sentinel; the caller
//                         translates it back into a retry-after-tomorrow
//                         response).
// The schedule + cap must stay in sync with the JS constants above.
const THROTTLE_LUA = `
local count_key = KEYS[1]
local last_key = KEYS[2]
local day_key = KEYS[3]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local day_cap = tonumber(ARGV[3])
local day_ttl = tonumber(ARGV[4])

local count = tonumber(redis.call('GET', count_key) or '0')
local last = tonumber(redis.call('GET', last_key) or '0')
local day_count = tonumber(redis.call('GET', day_key) or '0')
local next_count = count + 1

-- Daily cap check first: if you've burned the day's budget, no spacing
-- math will save you.
if day_cap > 0 and day_count >= day_cap then
  return -1
end

local schedule = { 30000, 90000, 180000, 300000, 600000 }
local required = 0
if next_count >= 2 then
  local idx = next_count - 1
  if idx > #schedule then idx = #schedule end
  required = schedule[idx]
end

if required > 0 and last > 0 and (now - last) < required then
  return required - (now - last)
end

redis.call('SET', count_key, next_count, 'EX', window)
redis.call('SET', last_key, now, 'EX', window)
redis.call('INCR', day_key)
redis.call('EXPIRE', day_key, day_ttl)
return 0
`;

// Seconds remaining in the current UTC day. The daily-cap key uses this
// as its TTL so it auto-resets at midnight UTC instead of "24h from
// first call" (which would punish a user who happened to peak at 3pm).
function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    ),
  );
  return Math.max(60, Math.floor((next.getTime() - now.getTime()) / 1000));
}

function utcDayKey(userId: string): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `throttle:ai:${userId}:day:${yyyy}-${mm}-${dd}`;
}

export async function throttleMoodSearch(
  userId: string,
): Promise<ThrottleResult> {
  // Local dev (and any non-production env unless force-enabled) skips
  // throttling entirely. The whole point of dev is rapid iteration.
  if (isAiThrottleBypassed()) return { ok: true };

  const c = getClient();
  // No Redis = fail open. Throttling is a quality-of-service guard, not
  // a security boundary; a Redis outage shouldn't break search.
  if (!c) return { ok: true };

  const countKey = `throttle:mood:${userId}:count`;
  const lastKey = `throttle:mood:${userId}:last`;
  const dayKey = utcDayKey(userId);

  try {
    const result = (await c.eval(
      THROTTLE_LUA,
      3,
      countKey,
      lastKey,
      dayKey,
      String(Date.now()),
      String(THROTTLE_WINDOW_SECONDS),
      String(AI_DAILY_CAP),
      String(secondsUntilUtcMidnight()),
    )) as number | string;
    const code =
      typeof result === "number" ? result : parseInt(result, 10);
    if (code === 0) return { ok: true };
    if (code === -1) {
      // Daily cap exhausted — retry-after = seconds until UTC midnight.
      return {
        ok: false,
        retryAfterMs: secondsUntilUtcMidnight() * 1000,
      };
    }
    return { ok: false, retryAfterMs: code };
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[throttle] redis error, failing open:", e);
    }
    return { ok: true };
  }
}

// ─── Anonymous mood-search throttle (per IP) ─────────────────────────────
//
// Signed-out visitors get a flat free tier: 15s between searches, hard cap
// of MOODYMUSIC_ANON_MOOD_DAILY_CAP (default 20) per IP per UTC day. Unlike
// the logged-in throttle there's no escalation curve — the daily cap is
// the brake on abuse, the 15s spacing just prevents accidental hammering.
// Fails open on Redis errors. Bypassed in non-prod (same flag as the
// authenticated throttle) so local iteration isn't blocked.

const ANON_MOOD_SPACING_MS = 15_000;

const ANON_MOOD_DAILY_CAP = (() => {
  const raw = process.env.MOODYMUSIC_ANON_MOOD_DAILY_CAP;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 20;
})();

// Two keys: last-hit timestamp (for spacing) and a UTC-day counter (for
// cap). Single Lua call so concurrent requests can't both observe
// count=N-1 and both write count=N+1 → past the cap.
const ANON_MOOD_LUA = `
local last_key = KEYS[1]
local day_key = KEYS[2]
local now = tonumber(ARGV[1])
local spacing = tonumber(ARGV[2])
local day_cap = tonumber(ARGV[3])
local day_ttl = tonumber(ARGV[4])
local spacing_ttl = tonumber(ARGV[5])

local last = tonumber(redis.call('GET', last_key) or '0')
local day_count = tonumber(redis.call('GET', day_key) or '0')

if day_cap > 0 and day_count >= day_cap then
  return -1
end

if spacing > 0 and last > 0 and (now - last) < spacing then
  return spacing - (now - last)
end

redis.call('SET', last_key, now, 'EX', spacing_ttl)
redis.call('INCR', day_key)
redis.call('EXPIRE', day_key, day_ttl)
return 0
`;

export type AnonThrottleResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterMs: number; reason: "spacing" | "daily_cap" };

export async function throttleAnonMoodSearch(
  ipKey: string,
): Promise<AnonThrottleResult> {
  if (isAiThrottleBypassed()) {
    return { ok: true, remaining: ANON_MOOD_DAILY_CAP };
  }
  const c = getClient();
  if (!c) return { ok: true, remaining: ANON_MOOD_DAILY_CAP };

  const lastKey = `throttle:anon-mood:${ipKey}:last`;
  const dayKey = `throttle:anon-mood:${ipKey}:day:${utcDayStamp()}`;

  try {
    const result = (await c.eval(
      ANON_MOOD_LUA,
      2,
      lastKey,
      dayKey,
      String(Date.now()),
      String(ANON_MOOD_SPACING_MS),
      String(ANON_MOOD_DAILY_CAP),
      String(secondsUntilUtcMidnight()),
      // Last-hit key only needs to outlive the spacing window. Cap at 10x
      // spacing so a stale key can't accidentally lock out an IP if Lua
      // ever stops updating it.
      String(Math.max(60, Math.ceil(ANON_MOOD_SPACING_MS / 100))),
    )) as number | string;
    const code =
      typeof result === "number" ? result : parseInt(result, 10);
    if (code === 0) {
      // Read the post-increment day count so callers can surface
      // "N searches left" to the visitor.
      let used = 0;
      try {
        const raw = await c.get(dayKey);
        used = raw ? parseInt(raw, 10) : 0;
      } catch {
        used = 0;
      }
      const remaining = Math.max(0, ANON_MOOD_DAILY_CAP - used);
      return { ok: true, remaining };
    }
    if (code === -1) {
      return {
        ok: false,
        retryAfterMs: secondsUntilUtcMidnight() * 1000,
        reason: "daily_cap",
      };
    }
    return { ok: false, retryAfterMs: code, reason: "spacing" };
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[anon-throttle] redis error, failing open:", e);
    }
    return { ok: true, remaining: ANON_MOOD_DAILY_CAP };
  }
}

export function anonMoodDailyCap(): number {
  return ANON_MOOD_DAILY_CAP;
}

function utcDayStamp(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ─── Generic IP / key bucket throttle ────────────────────────────────────
//
// Fixed-window counter. INCR a per-(scope, key, current-window) entry and
// reject once it crosses `limit`. The window is wall-clock-bucketed so a
// burst at the boundary can briefly let through up to 2x the limit — fine
// for our use case (anonymous SC search), where the goal is to bound
// abuse, not enforce a hard SLA. Fail-open on Redis errors.

export type BucketResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterMs: number };

export async function bucketCheck(
  scope: string,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<BucketResult> {
  const c = getClient();
  if (!c) return { ok: true, remaining: limit };
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);
  const cacheKey = `bucket:${scope}:${key}:${windowStart}`;
  try {
    const count = await c.incr(cacheKey);
    if (count === 1) {
      // First hit in this window — pin the TTL to the window length.
      await c.expire(cacheKey, windowSeconds);
    }
    if (count > limit) {
      const retryAfterMs = (windowStart + windowSeconds - now) * 1000;
      return { ok: false, retryAfterMs };
    }
    return { ok: true, remaining: Math.max(0, limit - count) };
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[bucket] redis error, failing open:", e);
    }
    return { ok: true, remaining: limit };
  }
}
