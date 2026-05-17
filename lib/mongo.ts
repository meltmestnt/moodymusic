import { MongoClient, type Db, type Collection } from "mongodb";
import type { MusicProvider } from "@/types/next-auth";
import type { SpotifyTrack } from "@/lib/spotify";

// Singleton connection. In dev, Next.js hot-reloads modules and would create
// a fresh MongoClient on every change — eventually exhausting Atlas's
// connection pool. We stash the live promise on `globalThis` so HMR reuses
// it. In prod each instance creates exactly one client.

declare global {
  // eslint-disable-next-line no-var
  var __moodymusic_mongo: Promise<MongoClient> | undefined;
}

const URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB ?? "moodymusic";

function getClientPromise(): Promise<MongoClient> | null {
  if (!URI) return null;
  if (process.env.NODE_ENV === "production") {
    return new MongoClient(URI).connect();
  }
  if (!globalThis.__moodymusic_mongo) {
    globalThis.__moodymusic_mongo = new MongoClient(URI).connect();
  }
  return globalThis.__moodymusic_mongo;
}

// Returns the Db handle, or null if MONGODB_URI isn't configured. All
// callers treat null as "skip persistence" so the app degrades gracefully
// for someone who hasn't set up the database yet.
export async function getDb(): Promise<Db | null> {
  const promise = getClientPromise();
  if (!promise) return null;
  try {
    const client = await promise;
    return client.db(DB_NAME);
  } catch (e) {
    console.warn("[mongo] connection failed:", e);
    return null;
  }
}

// ─── Document shapes ──────────────────────────────────────────────────────

export interface UserDoc {
  _id?: unknown;
  // The provider's stable user id (Spotify uri-id, Deezer numeric id,
  // SoundCloud numeric id, Google `sub`). Field name retained for
  // back-compat with the analytics queries that came from the
  // single-provider era — semantically this is a provider-agnostic
  // "userId on whichever service signed them in." Two users with the
  // same id on different providers are distinct rows; uniqueness is
  // enforced jointly with `provider` (compound index below).
  spotifyUserId: string;
  // Which streaming service signed the user in. Rows that pre-date the
  // multi-provider rollout are backfilled to "spotify" by ensureIndexes.
  provider: MusicProvider;
  displayName: string | null;
  email: string | null;
  // Avatar URL captured from the provider's userinfo / profile() — used
  // for the topbar avatar fallback and any future "users list" view.
  image: string | null;
  // Spotify-only. Other providers don't expose a comparable plan field.
  product: "premium" | "free" | "open" | null;
  createdAt: Date;
  lastSeenAt: Date;
}

export interface SearchDoc {
  _id?: unknown;
  spotifyUserId: string;
  mood: string;
  suggestions: { title: string; artist: string; reason?: string | null }[];
  // Projected shape kept for analytics aggregations (stats top-artists
  // pipeline unwinds resolvedTracks.artists as a string[]). Don't widen
  // this field — extend `fullTracks` instead.
  resolvedTracks: {
    id: string;
    name: string;
    artists: string[];
    uri: string;
  }[];
  // Full SpotifyTrack JSON for each pick, in the same order as
  // resolvedTracks. Used to re-render saved searches without re-calling
  // the streaming provider (no album-art roundtrip on history clicks /
  // page reloads). Optional because old rows pre-date this field; the
  // read API falls back to resolvedTracks when fullTracks is missing.
  fullTracks?: SpotifyTrack[];
  resolvedCount: number;
  model: string;
  durationMs: number;
  createdAt: Date;
}

export interface PlayDoc {
  _id?: unknown;
  spotifyUserId: string;
  trackId: string;
  trackUri: string;
  trackName: string;
  artists: string[];
  // Where the play originated from on our side. "library" / "mood" /
  // "footer" / "external" — external means this row was logged because we
  // observed it via /me/player polling without our own write.
  source: "library" | "mood" | "footer" | "external" | "unknown";
  deviceName: string | null;
  createdAt: Date;
}

export interface FavoriteDoc {
  _id?: unknown;
  spotifyUserId: string;
  trackId: string;
  action: "save" | "unsave";
  createdAt: Date;
}

// Per-login audit row. The `users` collection only carries lastSeenAt, so
// reconstructing "who signed in via which provider, when" needs a separate
// append-only log. One row per successful OAuth callback.
export interface SignInDoc {
  _id?: unknown;
  spotifyUserId: string;
  provider: MusicProvider;
  // Captured at sign-in time so the row stands alone for analytics queries
  // without needing to join against `users` (which gets overwritten on
  // every subsequent login).
  displayName: string | null;
  email: string | null;
  product: "premium" | "free" | "open" | null;
  createdAt: Date;
}

// Bidirectional link between a moodymusic web account and a Telegram
// user. Created when the web user clicks "Connect to Telegram" and the
// bot exchanges the one-time link token (see telegramLinkTokens). Once
// stored, anything the linked Telegram user does inside the bot (or
// future bot-side surfaces) can be attributed to the same web userId.
//
// Uniqueness is enforced jointly on (provider, spotifyUserId) AND on
// telegramUserId — a Telegram account can only be linked to one web
// account, and vice versa. Re-linking an already-linked side replaces
// the existing row.
export interface TelegramLinkDoc {
  _id?: unknown;
  // Web side (matches the same shape used in users/searches/etc.)
  spotifyUserId: string;
  provider: MusicProvider;
  // Telegram side — `id` from initDataUnsafe.user / Telegraf's ctx.from.
  telegramUserId: number;
  telegramUsername: string | null;
  telegramFirstName: string | null;
  telegramLastName: string | null;
  linkedAt: Date;
}

// One-time tokens minted when a web user starts the link flow. The bot
// receives the token in /start payload, calls /api/telegram/link/exchange
// with it, and the row is consumed (consumedAt set). Unconsumed rows
// expire after 15 min via a TTL index on expiresAt.
export interface TelegramLinkTokenDoc {
  _id?: unknown;
  token: string;
  spotifyUserId: string;
  provider: MusicProvider;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

// Server-side feature toggles. One row per flag, keyed by `key`. When a
// flag is missing from the collection, callers default it to OFF — so a
// fresh DB hides every gated feature until someone explicitly turns it on
// (insert `{ key, enabled: true }`). To enable Deezer, e.g.:
//   db.featureFlags.updateOne(
//     { key: "deezer" },
//     { $set: { enabled: true, updatedAt: new Date() } },
//     { upsert: true },
//   );
export interface FeatureFlagDoc {
  _id?: unknown;
  key: string;
  enabled: boolean;
  description?: string | null;
  updatedAt: Date;
}

// ─── Collections + indexes ────────────────────────────────────────────────
// We index per spotifyUserId + createdAt for the typical "what did this
// user do" query, plus a couple of secondary indexes for analytics. The
// ensure call runs once per connection; Mongo treats createIndex as a
// no-op if the index already exists.

let indexesEnsured = false;

async function ensureIndexes(db: Db) {
  if (indexesEnsured) return;

  // ─── User-collection migration: single-provider → multi-provider ───
  //
  // Pre-migration rows have only `spotifyUserId` (no provider field).
  // Backfill them to provider="spotify" so the new compound unique
  // index can be built without dup-key violations. The updateMany is
  // a no-op once the migration has run; cheap to keep on every boot
  // as a safety net for fresh deploys.
  await db.collection<UserDoc>("users").updateMany(
    { provider: { $exists: false } },
    { $set: { provider: "spotify" } },
  );
  // Drop the old single-field unique index — it would now reject any
  // non-Spotify user whose provider id happened to collide with an
  // existing Spotify id (rare but possible). Mongo names auto-built
  // indexes from the spec, so the legacy index is "spotifyUserId_1".
  // Drop is idempotent because we swallow the "ns not found" error.
  try {
    await db.collection("users").dropIndex("spotifyUserId_1");
  } catch {
    /* index didn't exist — first deploy of this migration, fine */
  }

  await Promise.all([
    db.collection<UserDoc>("users").createIndex(
      { provider: 1, spotifyUserId: 1 },
      { unique: true },
    ),
    db
      .collection<SearchDoc>("searches")
      .createIndex({ spotifyUserId: 1, createdAt: -1 }),
    db
      .collection<PlayDoc>("plays")
      .createIndex({ spotifyUserId: 1, createdAt: -1 }),
    db.collection<PlayDoc>("plays").createIndex({ trackId: 1 }),
    db
      .collection<FavoriteDoc>("favorites")
      .createIndex({ spotifyUserId: 1, createdAt: -1 }),
    db
      .collection<FavoriteDoc>("favorites")
      .createIndex({ spotifyUserId: 1, trackId: 1 }),
    db
      .collection<SignInDoc>("signIns")
      .createIndex({ provider: 1, spotifyUserId: 1, createdAt: -1 }),
    db
      .collection<SignInDoc>("signIns")
      .createIndex({ createdAt: -1 }),
    db
      .collection<FeatureFlagDoc>("featureFlags")
      .createIndex({ key: 1 }, { unique: true }),
    // A given web account can be linked to at most one Telegram account
    // and vice versa — both directions get a unique index.
    db
      .collection<TelegramLinkDoc>("telegramLinks")
      .createIndex(
        { provider: 1, spotifyUserId: 1 },
        { unique: true },
      ),
    db
      .collection<TelegramLinkDoc>("telegramLinks")
      .createIndex({ telegramUserId: 1 }, { unique: true }),
    db
      .collection<TelegramLinkTokenDoc>("telegramLinkTokens")
      .createIndex({ token: 1 }, { unique: true }),
    // TTL: Mongo deletes rows whose expiresAt is in the past on the next
    // sweep (~60s cadence). 15-min link windows clean themselves up so
    // the collection stays small.
    db
      .collection<TelegramLinkTokenDoc>("telegramLinkTokens")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
  indexesEnsured = true;
}

interface Collections {
  users: Collection<UserDoc>;
  searches: Collection<SearchDoc>;
  plays: Collection<PlayDoc>;
  favorites: Collection<FavoriteDoc>;
  signIns: Collection<SignInDoc>;
  featureFlags: Collection<FeatureFlagDoc>;
  telegramLinks: Collection<TelegramLinkDoc>;
  telegramLinkTokens: Collection<TelegramLinkTokenDoc>;
}

export async function getCollections(): Promise<Collections | null> {
  const db = await getDb();
  if (!db) return null;
  await ensureIndexes(db);
  return {
    users: db.collection<UserDoc>("users"),
    searches: db.collection<SearchDoc>("searches"),
    plays: db.collection<PlayDoc>("plays"),
    favorites: db.collection<FavoriteDoc>("favorites"),
    signIns: db.collection<SignInDoc>("signIns"),
    featureFlags: db.collection<FeatureFlagDoc>("featureFlags"),
    telegramLinks: db.collection<TelegramLinkDoc>("telegramLinks"),
    telegramLinkTokens: db.collection<TelegramLinkTokenDoc>(
      "telegramLinkTokens",
    ),
  };
}
