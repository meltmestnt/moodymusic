// Server-side feature-flag reader. Backed by the `featureFlags` Mongo
// collection (see lib/mongo.ts).
//
// Defaults: a flag missing from the collection — or read while Mongo is
// unconfigured / unreachable — resolves to `false`. This is intentional
// for in-development integrations like Deezer: the gated code stays in
// the repo but is invisible to users until someone explicitly inserts
// the flag doc with `enabled: true`.
//
// We cache reads in-process for a short TTL so a hot path (every API
// request, every page load) doesn't hammer Mongo.

import { getCollections } from "@/lib/mongo";

// All flags the app reads. Listing them centrally is what lets us expose
// only the public-safe ones to the client (see /api/feature-flags) without
// leaking arbitrary keys.
export const FEATURE_FLAG_KEYS = ["deezer", "soundcloud", "youtube"] as const;
export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

// Per-flag default value — used when no row exists in the collection AND
// (for safety) when Mongo is unreachable. Set per flag so different
// integrations can fail open or closed depending on operational risk.
//
//   - deezer:     OFF by default. Their developer portal isn't accepting
//                 new app registrations, so the integration can't be
//                 used; keep it invisible until that changes.
//   - soundcloud: ON by default. Default-on means an admin has to insert
//                 `{ key: "soundcloud", enabled: false }` to hide it.
const FLAG_DEFAULTS: Record<FeatureFlagKey, boolean> = {
  deezer: false,
  soundcloud: true,
  // YouTube uses Google OAuth — straightforward to set up, no
  // streaming-API approval gate, so default-on like SoundCloud.
  youtube: true,
};

// 30s in-memory cache. Long enough that bursty API traffic skips Mongo,
// short enough that flipping a flag in Mongo propagates within ~half a
// minute without restart. Per-process — so on a multi-instance deploy
// each worker picks up the change independently.
const CACHE_TTL_MS = 30_000;

interface CachedValue {
  value: boolean;
  expiresAt: number;
}

const cache = new Map<FeatureFlagKey, CachedValue>();

export async function isFeatureEnabled(key: FeatureFlagKey): Promise<boolean> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  const fallback = FLAG_DEFAULTS[key];
  let enabled = fallback;
  try {
    const cols = await getCollections();
    if (cols) {
      const doc = await cols.featureFlags.findOne({ key });
      // Doc present → it's authoritative (admin-set value wins). Doc
      // absent → fall back to FLAG_DEFAULTS for this key.
      enabled = doc ? Boolean(doc.enabled) : fallback;
    }
  } catch (e) {
    console.warn(`[feature-flags] read failed for "${key}":`, e);
    // DB hiccup: stay on whatever the per-flag default says. For Deezer
    // that means hidden; for SoundCloud that means visible.
    enabled = fallback;
  }

  cache.set(key, { value: enabled, expiresAt: now + CACHE_TTL_MS });
  return enabled;
}

// Bulk read for endpoints that surface multiple flags at once. Hits the
// per-key cache, then a single Mongo query for the misses.
export async function getAllFeatureFlags(): Promise<
  Record<FeatureFlagKey, boolean>
> {
  const out = {} as Record<FeatureFlagKey, boolean>;
  const now = Date.now();
  const misses: FeatureFlagKey[] = [];
  for (const key of FEATURE_FLAG_KEYS) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) {
      out[key] = hit.value;
    } else {
      misses.push(key);
    }
  }
  if (misses.length === 0) return out;

  try {
    const cols = await getCollections();
    if (cols) {
      const docs = await cols.featureFlags
        .find({ key: { $in: misses as string[] } })
        .toArray();
      const byKey = new Map(docs.map((d) => [d.key, Boolean(d.enabled)]));
      for (const key of misses) {
        // Same semantics as the single-key read: doc wins if present,
        // otherwise per-flag default.
        const value = byKey.has(key)
          ? (byKey.get(key) as boolean)
          : FLAG_DEFAULTS[key];
        out[key] = value;
        cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
      }
    } else {
      for (const key of misses) {
        const value = FLAG_DEFAULTS[key];
        out[key] = value;
        cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
      }
    }
  } catch (e) {
    console.warn("[feature-flags] bulk read failed:", e);
    for (const key of misses) out[key] = out[key] ?? FLAG_DEFAULTS[key];
  }
  return out;
}

// Test/dev helper: drops the cache so the next read re-queries Mongo.
// Not exported on the public route — only used when something explicitly
// wants to invalidate.
export function clearFeatureFlagCache() {
  cache.clear();
}
