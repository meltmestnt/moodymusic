import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getServiceForSession } from "@/lib/music-service";
import type { SpotifyTrack } from "@/lib/spotify";

// GET /api/track-info?id=<trackId>
//
// Returns the full track + a list of similar tracks (the primary
// artist's top tracks, excluding the requested track itself). We use
// artist top-tracks as a stand-in for "more like this" since Spotify
// deprecated /recommendations for new apps in late 2024 — Deezer has
// the same shape (/artist/{id}/top) so this works for both providers.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const svc = getServiceForSession(session);
  if (!svc) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id")?.trim();
  if (!id) {
    return NextResponse.json({ error: "missing id" }, { status: 400 });
  }

  try {
    const track = await svc.getTrack(id);
    const primaryArtistId = track.artists[0]?.id;

    // Fire similar-tracks + full-album fetches in parallel — neither is
    // critical; if either fails we still return the base track.
    const [similar, fullAlbum] = await Promise.all([
      primaryArtistId
        ? svc
            .getArtistTopTracks(primaryArtistId)
            .then((r) =>
              r.tracks.filter((t) => t.id !== track.id).slice(0, 8),
            )
            .catch((e: unknown) => {
              console.warn("[track-info] artist top-tracks failed:", e);
              return [] as SpotifyTrack[];
            })
        : Promise.resolve([] as SpotifyTrack[]),
      svc.getAlbum(track.album.id).catch((e: unknown) => {
        console.warn("[track-info] album fetch failed:", e);
        return null;
      }),
    ]);

    // Merge any extra fields from the full album response onto the
    // track's album shape. The /tracks/{id}.album shape lacks label,
    // genres, total_tracks; the /albums/{id} response has them.
    if (fullAlbum) {
      track.album = {
        ...track.album,
        release_date: fullAlbum.release_date ?? track.album.release_date,
        album_type: fullAlbum.album_type ?? track.album.album_type,
        total_tracks: fullAlbum.total_tracks ?? track.album.total_tracks,
        label: fullAlbum.label,
        genres: fullAlbum.genres,
      };
    }

    return NextResponse.json({ track, similar });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : `${svc.provider} error` },
      { status: 502 },
    );
  }
}
