import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getCollections } from "@/lib/mongo";

// All aggregations are scoped to the current user's spotifyUserId. We keep
// the per-day window at 30 days because that's the typical "stats over the
// last month" UX; longer windows are easy to add later without touching the
// frontend (the response shape is just an array).

const PER_DAY_WINDOW_DAYS = 30;
const TOP_ARTISTS_LIMIT = 10;
const RECENT_LIMIT = 10;

export interface StatsResponse {
  totals: {
    searches: number;
    cachedHits: number;
    uniqueMoods: number;
    uniqueTracks: number;
    avgDurationMs: number | null;
  };
  perDay: { date: string; count: number }[];
  topArtists: { name: string; count: number }[];
  recent: {
    // Mongo _id stringified — used by the row's delete control to call
    // DELETE /api/searches/:id, and as a stable React key.
    id: string;
    mood: string;
    createdAt: string;
    cached: boolean;
    resolvedCount: number;
    trackPreview: { id: string; name: string; artists: string[] }[];
  }[];
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const cols = await getCollections();
  if (!cols) {
    // Mongo isn't configured — return an empty shape so the UI renders a
    // friendly "no data yet" state instead of erroring.
    const empty: StatsResponse = {
      totals: {
        searches: 0,
        cachedHits: 0,
        uniqueMoods: 0,
        uniqueTracks: 0,
        avgDurationMs: null,
      },
      perDay: [],
      topArtists: [],
      recent: [],
    };
    return NextResponse.json(empty);
  }

  const userId = session.user.id;
  const since = new Date(
    Date.now() - PER_DAY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  try {
    const [
      totalsAgg,
      perDayAgg,
      topArtistsAgg,
      recentDocs,
      uniqueMoodsRes,
      uniqueTracksRes,
    ] = await Promise.all([
      // Aggregate totals + cached hit count + avg duration in one pipeline.
      // Cached searches are tagged with the suffix "(cached)" in the model
      // field by the mood-search route.
      cols.searches
        .aggregate<{
          searches: number;
          cachedHits: number;
          avgDurationMs: number | null;
        }>([
          { $match: { spotifyUserId: userId } },
          {
            $group: {
              _id: null,
              searches: { $sum: 1 },
              cachedHits: {
                $sum: {
                  $cond: [
                    { $regexMatch: { input: "$model", regex: /\(cached\)$/ } },
                    1,
                    0,
                  ],
                },
              },
              avgDurationMs: { $avg: "$durationMs" },
            },
          },
        ])
        .toArray(),

      // Per-day series for the chart. Bucketed by UTC date to keep the
      // pipeline simple — minor TZ skew at midnight is fine for a monthly
      // overview.
      cols.searches
        .aggregate<{ _id: string; count: number }>([
          {
            $match: {
              spotifyUserId: userId,
              createdAt: { $gte: since },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray(),

      // Top recommended artists across every search ever. We unwind the
      // nested resolvedTracks.artists array and group on artist name.
      cols.searches
        .aggregate<{ _id: string; count: number }>([
          { $match: { spotifyUserId: userId } },
          { $unwind: "$resolvedTracks" },
          { $unwind: "$resolvedTracks.artists" },
          { $group: { _id: "$resolvedTracks.artists", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: TOP_ARTISTS_LIMIT },
        ])
        .toArray(),

      cols.searches
        .find({ spotifyUserId: userId })
        .sort({ createdAt: -1 })
        .limit(RECENT_LIMIT)
        .toArray(),

      cols.searches.distinct("mood", { spotifyUserId: userId }),
      cols.searches.distinct("resolvedTracks.id", { spotifyUserId: userId }),
    ]);

    const totals = totalsAgg[0] ?? {
      searches: 0,
      cachedHits: 0,
      avgDurationMs: null,
    };

    // Fill day buckets with zeros so the chart line doesn't have gaps —
    // recharts otherwise interpolates across missing days, which reads as
    // "we searched on these days" instead of "no searches".
    const perDay = fillDayBuckets(since, perDayAgg);

    // Recent: just the bits the page shows.
    const recent = recentDocs.map((doc) => ({
      id: String(doc._id),
      mood: doc.mood,
      createdAt: doc.createdAt.toISOString(),
      cached: /\(cached\)$/.test(doc.model),
      resolvedCount: doc.resolvedCount,
      trackPreview: doc.resolvedTracks.slice(0, 3),
    }));

    const body: StatsResponse = {
      totals: {
        searches: totals.searches,
        cachedHits: totals.cachedHits,
        uniqueMoods: uniqueMoodsRes.length,
        uniqueTracks: uniqueTracksRes.length,
        avgDurationMs: totals.avgDurationMs,
      },
      perDay,
      topArtists: topArtistsAgg.map((a) => ({ name: a._id, count: a.count })),
      recent,
    };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "stats error" },
      { status: 502 },
    );
  }
}

// Mongo's date-string group only emits buckets that actually had documents.
// For a continuous line chart we want every day in the window, with 0 for
// quiet days. This walks `since`..today and merges in the counts.
function fillDayBuckets(
  since: Date,
  rows: { _id: string; count: number }[],
): { date: string; count: number }[] {
  const map = new Map(rows.map((r) => [r._id, r.count]));
  const out: { date: string; count: number }[] = [];
  const d = new Date(
    Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()),
  );
  const today = new Date();
  const todayUTC = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  while (d.getTime() <= todayUTC) {
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, count: map.get(key) ?? 0 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
