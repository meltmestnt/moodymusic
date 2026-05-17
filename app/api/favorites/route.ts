import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { getServiceForSession } from "@/lib/music-service";
import { logFavorite } from "@/lib/db/events";

// GET /api/favorites?ids=a,b,c → { saved: boolean[] } in the same order.
// We split the comma-separated ids ourselves so callers can use either a
// single ?ids=a,b,c or repeated ?ids=a&ids=b — both arrive at the same
// shape after URLSearchParams flattens them.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const svc = getServiceForSession(session);
  if (!svc) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const raw = url.searchParams.getAll("ids").flatMap((s) => s.split(","));
  const ids = raw.map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    return NextResponse.json({ saved: [] });
  }
  try {
    const saved = await svc.checkSavedTracks(ids);
    return NextResponse.json({ saved, ids });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : `${svc.provider} error` },
      { status: 502 },
    );
  }
}

const bodySchema = z.object({
  action: z.enum(["save", "unsave"]),
  ids: z.array(z.string().min(1)).min(1).max(200),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const svc = getServiceForSession(session);
  if (!svc || !session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    if (parsed.data.action === "save") {
      await svc.saveTracks(parsed.data.ids);
    } else {
      await svc.unsaveTracks(parsed.data.ids);
    }
    // Log the favourite action server-side AFTER the upstream confirmed it.
    if (session.user?.id) {
      await logFavorite({
        user: {
          spotifyUserId: session.user.id,
          provider: session.provider ?? "spotify",
          displayName: session.user.name ?? null,
          email: session.user.email ?? null,
          image: session.user.image ?? null,
          product: session.user.product ?? null,
        },
        trackIds: parsed.data.ids,
        action: parsed.data.action,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : `${svc.provider} error`;
    // Spotify's spotifyFetch helper throws "spotify <status>: <body>".
    // Detect the common scope/auth failures so the client can render a
    // useful message instead of a generic toast. Deezer surfaces 401/403
    // with our humanised messages from lib/deezer.ts; same logic applies.
    let code = "upstream_error";
    let status = 502;
    if (/spotify 401\b/.test(message) || /session expired/i.test(message)) {
      code = "auth_expired";
      status = 401;
    } else if (/spotify 403\b/.test(message) || /denied the request/i.test(message)) {
      // 403 on Spotify means the access token was issued without
      // `user-library-modify`. Tell the client so it can prompt for
      // re-auth instead of silently rolling back.
      code = "scope_missing";
      status = 403;
    }
    console.error("[favorites] toggle failed:", message);
    return NextResponse.json({ error: message, code }, { status });
  }
}
