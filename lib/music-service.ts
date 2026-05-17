// Provider-agnostic facade over Spotify + Deezer. API routes pull a
// `MusicService` for the current session and call it without caring
// which streaming service backs it. Each method has the same signature
// as the corresponding Spotify helper so the existing route logic only
// changes at the import line.

import type { Session } from "next-auth";
import * as spotify from "@/lib/spotify";
import * as deezer from "@/lib/deezer";
import * as soundcloud from "@/lib/soundcloud";
import * as youtube from "@/lib/youtube";
import type {
  SavedTrack,
  SpotifyAlbum,
  SpotifyPaging,
  SpotifyTrack,
} from "@/lib/spotify";
import type { MusicProvider } from "@/types/next-auth";

export interface MusicService {
  provider: MusicProvider;
  // Read
  getSavedTracks(opts?: {
    limit?: number;
    offset?: number;
  }): Promise<SpotifyPaging<SavedTrack>>;
  getTrack(id: string): Promise<SpotifyTrack>;
  getAlbum(albumId: string): Promise<SpotifyAlbum>;
  getArtistTopTracks(artistId: string): Promise<{ tracks: SpotifyTrack[] }>;
  searchTracks(
    query: string,
    limit?: number,
  ): Promise<{ tracks: SpotifyPaging<SpotifyTrack> }>;
  // Write
  saveTracks(ids: string[]): Promise<void>;
  unsaveTracks(ids: string[]): Promise<void>;
  checkSavedTracks(ids: string[]): Promise<boolean[]>;
}

function spotifyService(token: string): MusicService {
  return {
    provider: "spotify",
    getSavedTracks: (opts) => spotify.getSavedTracks(token, opts),
    getTrack: (id) => spotify.getTrack(token, id),
    getAlbum: (id) => spotify.getAlbum(token, id),
    getArtistTopTracks: (id) => spotify.getArtistTopTracks(token, id),
    searchTracks: (q, l) => spotify.searchTracks(token, q, l),
    saveTracks: (ids) => spotify.saveTracks(token, ids),
    unsaveTracks: (ids) => spotify.unsaveTracks(token, ids),
    checkSavedTracks: (ids) => spotify.checkSavedTracks(token, ids),
  };
}

function deezerService(token: string): MusicService {
  return {
    provider: "deezer",
    getSavedTracks: (opts) => deezer.getSavedTracks(token, opts),
    getTrack: (id) => deezer.getTrack(token, id),
    getAlbum: (id) => deezer.getAlbum(token, id),
    getArtistTopTracks: (id) => deezer.getArtistTopTracks(token, id),
    searchTracks: (q, l) => deezer.searchTracks(token, q, l),
    saveTracks: (ids) => deezer.saveTracks(token, ids),
    unsaveTracks: (ids) => deezer.unsaveTracks(token, ids),
    checkSavedTracks: (ids) => deezer.checkSavedTracks(token, ids),
  };
}

function soundcloudService(token: string): MusicService {
  return {
    provider: "soundcloud",
    getSavedTracks: (opts) => soundcloud.getSavedTracks(token, opts),
    getTrack: (id) => soundcloud.getTrack(token, id),
    getAlbum: (id) => soundcloud.getAlbum(token, id),
    getArtistTopTracks: (id) => soundcloud.getArtistTopTracks(token, id),
    searchTracks: (q, l) => soundcloud.searchTracks(token, q, l),
    saveTracks: (ids) => soundcloud.saveTracks(token, ids),
    unsaveTracks: (ids) => soundcloud.unsaveTracks(token, ids),
    checkSavedTracks: (ids) => soundcloud.checkSavedTracks(token, ids),
  };
}

function youtubeService(token: string): MusicService {
  return {
    provider: "youtube",
    getSavedTracks: (opts) => youtube.getSavedTracks(token, opts),
    getTrack: (id) => youtube.getTrack(token, id),
    getAlbum: (id) => youtube.getAlbum(token, id),
    getArtistTopTracks: (id) => youtube.getArtistTopTracks(token, id),
    searchTracks: (q, l) => youtube.searchTracks(token, q, l),
    saveTracks: (ids) => youtube.saveTracks(token, ids),
    unsaveTracks: (ids) => youtube.unsaveTracks(token, ids),
    checkSavedTracks: (ids) => youtube.checkSavedTracks(token, ids),
  };
}

// Returns null when the session isn't authenticated. Callers should
// 401 in that case — same shape as the previous `if (!session?.accessToken)`
// guard the routes used to do inline.
export function getServiceForSession(
  session: Session | null,
): MusicService | null {
  if (!session?.accessToken) return null;
  if (session.provider === "deezer") {
    return deezerService(session.accessToken);
  }
  if (session.provider === "soundcloud") {
    return soundcloudService(session.accessToken);
  }
  if (session.provider === "youtube") {
    return youtubeService(session.accessToken);
  }
  // Default to Spotify for any session without an explicit provider —
  // covers JWTs minted before we started recording the provider field
  // (existing users on the day of this rollout would otherwise log out).
  return spotifyService(session.accessToken);
}
