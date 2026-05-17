import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getServiceForSession } from "@/lib/music-service";

// Proxy the user's saved tracks through our server so the access token
// never leaves the httpOnly session cookie. Paginated via ?offset=&limit=.
// Provider-agnostic — Spotify and Deezer both return Spotify-shaped
// SavedTrack pages thanks to the adapter in lib/deezer.ts.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const svc = getServiceForSession(session);
  if (!svc) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  try {
    const data = await svc.getSavedTracks({ limit, offset });
    return NextResponse.json(data);
  } catch (e) {
    // Log the real upstream error to the dev/server console; the client
    // only sees the message. Without this, a 502 from /api/library is
    // a black box — we'd have no way to tell quota-exceeded from
    // token-expired from a transient YouTube outage.
    console.error(
      `[library] upstream failed for ${svc.provider}:`,
      e instanceof Error ? `${e.name}: ${e.message}` : e,
    );
    return NextResponse.json(
      { error: e instanceof Error ? e.message : `${svc.provider} error` },
      { status: 502 },
    );
  }
}
