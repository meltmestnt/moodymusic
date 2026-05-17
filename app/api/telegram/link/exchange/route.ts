import { NextResponse } from "next/server";
import { z } from "zod";
import { exchangeLinkToken, verifyBotSecret } from "@/lib/telegram-link";

// POST /api/telegram/link/exchange
//
// Bot-only endpoint. The bot calls this when it sees `/start link_<token>`
// in a chat — it forwards the token + the Telegram user info, and we
// store the link. Authenticated via the X-Telegram-Bot-Secret header
// matching TELEGRAM_BOT_API_SECRET (constant-time compare).
//
// The bot is the only server-side caller; nothing in the browser ever
// touches this endpoint, so we don't need cookies / NextAuth here.

const bodySchema = z.object({
  token: z.string().min(8).max(128),
  telegramUserId: z.number().int().positive(),
  telegramUsername: z.string().max(64).nullable().optional(),
  telegramFirstName: z.string().max(128).nullable().optional(),
  telegramLastName: z.string().max(128).nullable().optional(),
});

export async function POST(req: Request) {
  const secret = req.headers.get("x-telegram-bot-secret");
  if (!verifyBotSecret(secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const result = await exchangeLinkToken({
      token: parsed.data.token,
      telegramUserId: parsed.data.telegramUserId,
      telegramUsername: parsed.data.telegramUsername ?? null,
      telegramFirstName: parsed.data.telegramFirstName ?? null,
      telegramLastName: parsed.data.telegramLastName ?? null,
    });
    if (!result) {
      return NextResponse.json(
        { error: "invalid_or_expired_token" },
        { status: 400 },
      );
    }
    return NextResponse.json({
      ok: true,
      webProvider: result.webProvider,
      alreadyLinked: result.alreadyLinked,
    });
  } catch (e) {
    console.error("[telegram-link] exchange failed:", e);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
