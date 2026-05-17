// Server-only helpers for the moodymusic ↔ Telegram account-link flow.
//
// Linking happens in two hops:
//   1. Web user clicks "Connect" → POST /api/telegram/link/start mints a
//      one-time token (32 random bytes, base64url) and stores it with
//      their (provider, spotifyUserId). Returns the deep-link URL the
//      browser opens: https://t.me/<bot>?start=link_<token>.
//   2. Telegram user taps "Start" → bot reads the link payload, calls
//      POST /api/telegram/link/exchange with the token + their Telegram
//      user info + a shared secret header. Server validates, marks the
//      token consumed, upserts the link.
//
// Links are stored in `telegramLinks`. Tokens are stored in
// `telegramLinkTokens` with a 15-min TTL — both collections + their
// indexes are declared in lib/mongo.ts.

import { randomBytes, timingSafeEqual } from "crypto";

import { getCollections, type TelegramLinkDoc } from "@/lib/mongo";
import type { MusicProvider } from "@/types/next-auth";

export const LINK_TOKEN_TTL_MS = 15 * 60 * 1000;
export const LINK_TOKEN_PREFIX = "link_";

export function generateLinkToken(): string {
  // base64url so it survives the t.me/<bot>?start=… channel without
  // percent-encoding. Telegram caps start_param at 64 chars; 32 random
  // bytes encode to 43 chars, leaving room for the "link_" prefix.
  return randomBytes(32).toString("base64url");
}

// Returns the deep-link URL the browser should open. Resolved from
// TELEGRAM_BOT_USERNAME (e.g. "moodymusic_music_bot") so the link works
// even when a fork uses a different bot.
export function botStartUrl(payload: string): string | null {
  const username = process.env.TELEGRAM_BOT_USERNAME;
  if (!username) return null;
  // Strip the leading "@" if someone pasted it that way in env.
  const clean = username.replace(/^@/, "");
  return `https://t.me/${clean}?start=${encodeURIComponent(payload)}`;
}

// Plain "open the bot" deep link for anonymous users — no token, no
// linking, just a way to launch the bot from the web.
export function botPlainUrl(): string | null {
  const username = process.env.TELEGRAM_BOT_USERNAME;
  if (!username) return null;
  return `https://t.me/${username.replace(/^@/, "")}`;
}

// Constant-time compare for the bot↔server shared secret. The bot sends
// it on every exchange request via the X-Telegram-Bot-Secret header; the
// server side rejects mismatches.
export function verifyBotSecret(provided: string | null): boolean {
  const expected = process.env.TELEGRAM_BOT_API_SECRET;
  if (!expected || !provided) return false;
  // timingSafeEqual requires equal-length inputs — pad both to the same
  // length so attackers can't infer the secret length from response time.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Result of a successful exchange — handed back to the bot so it can
// greet the user by name on the web side.
export interface LinkResult {
  webUserId: string;
  webProvider: MusicProvider;
  alreadyLinked: boolean;
}

export interface ExchangeInput {
  token: string;
  telegramUserId: number;
  telegramUsername: string | null;
  telegramFirstName: string | null;
  telegramLastName: string | null;
}

// Consumes a token + writes the link row. Returns null if the token is
// unknown / expired / already consumed; throws only on Mongo failure
// (which the route surfaces as 500).
export async function exchangeLinkToken(
  input: ExchangeInput,
): Promise<LinkResult | null> {
  const cols = await getCollections();
  if (!cols) return null;
  const now = new Date();

  // Atomic find-and-mark-consumed so a token can't be redeemed twice
  // even under a race (two bot instances, retried updates, etc).
  const token = await cols.telegramLinkTokens.findOneAndUpdate(
    {
      token: input.token,
      consumedAt: null,
      expiresAt: { $gt: now },
    },
    { $set: { consumedAt: now } },
    { returnDocument: "after" },
  );
  if (!token) return null;

  // Upsert the link. If this Telegram user was already linked to a
  // different web account, the unique index on telegramUserId will
  // throw — translate that into "alreadyLinked" instead of a 500 by
  // first checking. Race tolerant enough for the link surface.
  const existingForTelegram = await cols.telegramLinks.findOne({
    telegramUserId: input.telegramUserId,
  });
  if (
    existingForTelegram &&
    !(
      existingForTelegram.provider === token.provider &&
      existingForTelegram.spotifyUserId === token.spotifyUserId
    )
  ) {
    // Replace the prior link — newest mint wins. We could refuse instead
    // but "I changed my mind, link my Telegram to this other account"
    // is the more common case than abuse here.
    await cols.telegramLinks.deleteOne({
      telegramUserId: input.telegramUserId,
    });
  }

  const filter = {
    provider: token.provider,
    spotifyUserId: token.spotifyUserId,
  };
  const setDoc: Partial<TelegramLinkDoc> = {
    telegramUserId: input.telegramUserId,
    telegramUsername: input.telegramUsername,
    telegramFirstName: input.telegramFirstName,
    telegramLastName: input.telegramLastName,
    linkedAt: now,
  };
  const prev = await cols.telegramLinks.findOne(filter);
  await cols.telegramLinks.updateOne(
    filter,
    {
      $set: setDoc,
      $setOnInsert: {
        provider: token.provider,
        spotifyUserId: token.spotifyUserId,
      },
    },
    { upsert: true },
  );
  return {
    webUserId: token.spotifyUserId,
    webProvider: token.provider,
    alreadyLinked:
      !!prev && prev.telegramUserId === input.telegramUserId,
  };
}

export async function getLinkForWebUser(
  provider: MusicProvider,
  spotifyUserId: string,
): Promise<TelegramLinkDoc | null> {
  const cols = await getCollections();
  if (!cols) return null;
  return cols.telegramLinks.findOne({ provider, spotifyUserId });
}

export async function getLinkForTelegramUser(
  telegramUserId: number,
): Promise<TelegramLinkDoc | null> {
  const cols = await getCollections();
  if (!cols) return null;
  return cols.telegramLinks.findOne({ telegramUserId });
}

export async function deleteLinkForWebUser(
  provider: MusicProvider,
  spotifyUserId: string,
): Promise<boolean> {
  const cols = await getCollections();
  if (!cols) return false;
  const res = await cols.telegramLinks.deleteOne({
    provider,
    spotifyUserId,
  });
  return res.deletedCount > 0;
}

export async function createLinkToken(
  provider: MusicProvider,
  spotifyUserId: string,
): Promise<string | null> {
  const cols = await getCollections();
  if (!cols) return null;
  const token = generateLinkToken();
  const now = new Date();
  await cols.telegramLinkTokens.insertOne({
    token,
    provider,
    spotifyUserId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + LINK_TOKEN_TTL_MS),
    consumedAt: null,
  });
  return token;
}
