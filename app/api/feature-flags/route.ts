import { NextResponse } from "next/server";
import { getAllFeatureFlags } from "@/lib/feature-flags";

// Public read of every flag listed in FEATURE_FLAG_KEYS. The set is
// curated, not arbitrary — components can only read flags that have been
// added to the constant — so this can't leak unknown keys even if
// someone inserts random docs into the collection.
//
// no-store: the in-memory TTL cache in lib/feature-flags already
// rate-limits Mongo; we want the *response* to be uncached so flipping
// a flag propagates to clients on their next page load instead of
// living in a CDN cache for hours.
export const dynamic = "force-dynamic";

export async function GET() {
  const flags = await getAllFeatureFlags();
  return NextResponse.json(
    { flags },
    { headers: { "Cache-Control": "no-store" } },
  );
}
