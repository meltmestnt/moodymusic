import { NextResponse } from "next/server";
import {
  getAppAccessToken,
  searchTracks,
  SoundCloudApiError,
} from "@/lib/soundcloud";
import { bucketCheck } from "@/lib/redis";

// Public, anonymous-friendly SoundCloud search.
//
// Powers the signed-out home page so visitors can search and play public
// SoundCloud tracks without OAuthing into any provider. AI features stay
// gated by /api/discover + /api/mood-search session checks — this route
// is the only "free tier" surface and is IP-rate-limited so a misbehaving
// client can't burn through SoundCloud's quota for our app credentials.

const MAX_LIMIT = 20;
const RATE_LIMIT_PER_MIN = 60;

function clientIp(req: Request): string {
  // Next.js doesn't normalise these for us. We trust the first non-empty
  // value in the conventional precedence order (forwarded > real-ip >
  // peer). All entries get bucketed independently so a single bad client
  // can't spread its budget across multiple headers.
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    // x-forwarded-for can be a comma-separated list (proxy chain). The
    // left-most is the original client.
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

export async function GET(req: Request) {
  const ip = clientIp(req);
  const decision = await bucketCheck("sc-search", ip, RATE_LIMIT_PER_MIN, 60);
  if (!decision.ok) {
    const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    return NextResponse.json(
      {
        code: "rate_limited",
        error: "Too many searches — slow down a moment.",
        retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSeconds) },
      },
    );
  }

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (!q) {
    return NextResponse.json({ tracks: { items: [] } });
  }
  const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(MAX_LIMIT, Math.max(1, limitParam))
    : 12;

  let token: string;
  try {
    token = await getAppAccessToken();
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[sc-search] app token grant failed:", e);
    }
    return NextResponse.json(
      { code: "config_error", error: "SoundCloud search isn't configured." },
      { status: 500 },
    );
  }

  try {
    const result = await searchTracks(token, q, limit);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof SoundCloudApiError) {
      return NextResponse.json(
        { code: "upstream_error", error: e.message },
        { status: e.status >= 500 ? 502 : e.status },
      );
    }
    if (process.env.NODE_ENV !== "production") {
      console.error("[sc-search] search failed:", e);
    }
    return NextResponse.json(
      { code: "upstream_error", error: "SoundCloud search failed." },
      { status: 502 },
    );
  }
}
