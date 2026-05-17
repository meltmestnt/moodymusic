import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { ObjectId } from "mongodb";
import { authOptions } from "@/lib/auth";
import { getCollections } from "@/lib/mongo";
import type { SpotifyTrack } from "@/lib/spotify";

// GET /api/searches/:id — load a single saved search for the current
// user. Used by the /mood page when arriving via ?id=<id> (recent-
// searches click, or browser reload after the page replaced the URL
// post-search). Returns the same tracks shape as /api/mood-search so
// the client can drop it straight into MoodSearchContext.
//
// Pinned to the caller's spotifyUserId so a crafted id can't reveal
// another user's history.

export interface SavedSearchResponse {
  id: string;
  mood: string;
  createdAt: string;
  tracks: { track: SpotifyTrack; reason: string | null }[];
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const cols = await getCollections();
  if (!cols) {
    return NextResponse.json(
      { error: "database not configured" },
      { status: 503 },
    );
  }
  try {
    const doc = await cols.searches.findOne({
      _id: new ObjectId(id),
      spotifyUserId: session.user.id,
    });
    if (!doc) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    // Pair each track with its `reason` from suggestions (order-aligned —
    // resolvedTracks is built by Promise.all over suggestions, so position
    // matches). Old rows pre-date `fullTracks`: fall back to projecting a
    // minimal SpotifyTrack from `resolvedTracks` so the cards still render
    // (no album art for those, but the play CTA still works).
    const fullTracks = doc.fullTracks ?? [];
    const tracks = doc.resolvedTracks.map((projected, i) => {
      const full: SpotifyTrack | undefined = fullTracks[i];
      const track: SpotifyTrack = full ?? {
        id: projected.id,
        name: projected.name,
        uri: projected.uri,
        duration_ms: 0,
        preview_url: null,
        album: { id: "", name: "", uri: "", images: [] },
        artists: projected.artists.map((name) => ({
          id: "",
          name,
          uri: "",
        })),
        external_urls: { spotify: "" },
      };
      const reason = doc.suggestions[i]?.reason ?? null;
      return { track, reason };
    });

    const body: SavedSearchResponse = {
      id: String(doc._id),
      mood: doc.mood,
      createdAt: doc.createdAt.toISOString(),
      tracks,
    };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "fetch failed" },
      { status: 502 },
    );
  }
}

// DELETE /api/searches/:id — remove a single search row from the user's
// history. We pin the deleteOne filter to the caller's spotifyUserId so a
// crafted id can never wipe someone else's row.

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const cols = await getCollections();
  if (!cols) {
    return NextResponse.json(
      { error: "database not configured" },
      { status: 503 },
    );
  }
  try {
    const result = await cols.searches.deleteOne({
      _id: new ObjectId(id),
      spotifyUserId: session.user.id,
    });
    if (result.deletedCount === 0) {
      // Either the id doesn't exist, or it belongs to another user. Either
      // way, treat as 404 — never confirm cross-user existence.
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "delete failed" },
      { status: 502 },
    );
  }
}
