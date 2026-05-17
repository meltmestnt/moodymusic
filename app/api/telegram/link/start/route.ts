import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  LINK_TOKEN_PREFIX,
  botPlainUrl,
  botStartUrl,
  createLinkToken,
} from "@/lib/telegram-link";

// POST /api/telegram/link/start
//
// Mints a one-time link token tied to the current web session and
// returns the t.me deep link the browser should open. The token lands
// in the bot's /start payload as `link_<token>`; the bot calls
// /api/telegram/link/exchange to consume it (see telegram-link.ts).
//
// Anonymous users hit GET / a different surface — this endpoint is
// strictly for the linking flow and requires a web session.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session || !session.user?.id || !session.provider) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const fallback = botPlainUrl();
  if (!process.env.TELEGRAM_BOT_USERNAME) {
    return NextResponse.json(
      { error: "telegram_not_configured" },
      { status: 503 },
    );
  }

  const token = await createLinkToken(session.provider, session.user.id);
  if (!token) {
    // Mongo not configured — without persistence we can't track the
    // token, so the link wouldn't survive the round-trip to the bot.
    return NextResponse.json(
      { error: "storage_unavailable", botUrl: fallback },
      { status: 503 },
    );
  }
  const url = botStartUrl(`${LINK_TOKEN_PREFIX}${token}`);
  if (!url) {
    return NextResponse.json(
      { error: "telegram_not_configured" },
      { status: 503 },
    );
  }
  return NextResponse.json({ url, botUrl: fallback });
}
