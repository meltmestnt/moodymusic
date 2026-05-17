// Thin write-side helpers around the moodymusic event collections. Every
// helper swallows write errors and returns void — persistence is a side
// effect on the user-facing happy path, not a precondition. If Mongo is
// down or unconfigured, the user still gets their search results, plays,
// and favorites; the analytics just don't accumulate.

import { getCollections } from "@/lib/mongo";
import type { SpotifyTrack } from "@/lib/spotify";
import type { MusicProvider } from "@/types/next-auth";

interface UserCtx {
  // The provider's user id. Field name is historical (the app started
  // single-provider) but the value is whatever the current sign-in
  // service hands us — the row is keyed jointly with `provider`.
  spotifyUserId: string;
  provider: MusicProvider;
  displayName?: string | null;
  email?: string | null;
  image?: string | null;
  product?: "premium" | "free" | "open" | null;
}

// Append-only audit row for each successful sign-in. `users` only carries
// lastSeenAt, which is overwritten every login — this collection lets us
// reconstruct the order in which a user attached different providers,
// count logins per day, etc.
export async function logSignIn(user: UserCtx) {
  try {
    const cols = await getCollections();
    if (!cols) return;
    await cols.signIns.insertOne({
      spotifyUserId: user.spotifyUserId,
      provider: user.provider,
      displayName: user.displayName ?? null,
      email: user.email ?? null,
      product: user.product ?? null,
      createdAt: new Date(),
    });
  } catch (e) {
    console.warn("[db] logSignIn failed:", e);
  }
}

// Upserts a row in `users` and bumps lastSeenAt. Called both from
// NextAuth events.signIn (so we capture every login, including the
// kind where the user just browses without taking any action) and
// from each event-logging helper (so a user record exists before we
// insert their first search/play/favorite, even if they signed in
// before this surface existed).
export async function touchUser(user: UserCtx) {
  const cols = await getCollections();
  if (!cols) return;
  const now = new Date();
  await cols.users.updateOne(
    { provider: user.provider, spotifyUserId: user.spotifyUserId },
    {
      $set: {
        displayName: user.displayName ?? null,
        email: user.email ?? null,
        image: user.image ?? null,
        product: user.product ?? null,
        lastSeenAt: now,
      },
      $setOnInsert: {
        spotifyUserId: user.spotifyUserId,
        provider: user.provider,
        createdAt: now,
      },
    },
    { upsert: true },
  );
}

// Returns the inserted row id as a string, or null when Mongo isn't
// configured / the insert failed. Callers use the id to hand back a
// `searchId` to the client so the URL can pin to ?id=<id> and replay
// the saved suggestions on reload.
export async function logSearch(input: {
  user: UserCtx;
  mood: string;
  suggestions: { title: string; artist: string; reason?: string | null }[];
  resolvedTracks: SpotifyTrack[];
  model: string;
  durationMs: number;
}): Promise<string | null> {
  try {
    const cols = await getCollections();
    if (!cols) return null;
    await touchUser(input.user);
    const result = await cols.searches.insertOne({
      spotifyUserId: input.user.spotifyUserId,
      mood: input.mood,
      suggestions: input.suggestions,
      // Projected analytics shape — keep stable for the stats pipeline.
      resolvedTracks: input.resolvedTracks.map((t) => ({
        id: t.id,
        name: t.name,
        artists: t.artists.map((a) => a.name),
        uri: t.uri,
      })),
      // Full per-track JSON for re-render. Stored alongside the projected
      // shape so /api/searches/[id] can rebuild a TrackCard-ready payload
      // without a roundtrip to the streaming provider.
      fullTracks: input.resolvedTracks,
      resolvedCount: input.resolvedTracks.length,
      model: input.model,
      durationMs: input.durationMs,
      createdAt: new Date(),
    });
    return result.insertedId?.toString() ?? null;
  } catch (e) {
    console.warn("[db] logSearch failed:", e);
    return null;
  }
}

export async function logPlay(input: {
  user: UserCtx;
  trackUris: string[];                                         // first uri = the actual track started
  // Caller passes the track snapshot when it has it (the body of /api/playback
  // doesn't, so it falls back to a minimal record keyed by uri only).
  trackInfo?: {
    id: string;
    name: string;
    artists: string[];
  };
  source: "library" | "mood" | "footer" | "external" | "unknown";
  deviceName?: string | null;
}) {
  try {
    const cols = await getCollections();
    if (!cols) return;
    await touchUser(input.user);
    const firstUri = input.trackUris[0];
    if (!firstUri) return;
    // Spotify track URIs are "spotify:track:<id>". Pull the id out as a
    // fallback when caller didn't supply trackInfo.
    const idFromUri = firstUri.split(":").pop() ?? firstUri;
    await cols.plays.insertOne({
      spotifyUserId: input.user.spotifyUserId,
      trackId: input.trackInfo?.id ?? idFromUri,
      trackUri: firstUri,
      trackName: input.trackInfo?.name ?? "(unknown)",
      artists: input.trackInfo?.artists ?? [],
      source: input.source,
      deviceName: input.deviceName ?? null,
      createdAt: new Date(),
    });
  } catch (e) {
    console.warn("[db] logPlay failed:", e);
  }
}

export async function logFavorite(input: {
  user: UserCtx;
  trackIds: string[];
  action: "save" | "unsave";
}) {
  try {
    const cols = await getCollections();
    if (!cols) return;
    await touchUser(input.user);
    const now = new Date();
    if (input.trackIds.length === 0) return;
    await cols.favorites.insertMany(
      input.trackIds.map((id) => ({
        spotifyUserId: input.user.spotifyUserId,
        trackId: id,
        action: input.action,
        createdAt: now,
      })),
    );
  } catch (e) {
    console.warn("[db] logFavorite failed:", e);
  }
}
