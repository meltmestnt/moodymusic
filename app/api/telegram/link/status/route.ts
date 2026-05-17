import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { botPlainUrl, getLinkForWebUser } from "@/lib/telegram-link";

// GET /api/telegram/link/status
//
// Reports whether the current session is linked to a Telegram account.
// Used by the UI both to render the initial state and to poll while the
// user is mid-flow (the deep link opens Telegram in a new tab; we want
// the "Connected" state to surface automatically when they return).
export async function GET() {
  // botUrl + botConfigured are returned to EVERY caller, signed in or
  // not — anonymous visitors use them to deep-link straight to the bot
  // (no account-link flow, just opens @moodymusic_music_bot). Without
  // this, the anon click path in TelegramConnectButton sees an empty
  // botUrl and surfaces the "not configured" error toast.
  const botConfigured = !!process.env.TELEGRAM_BOT_USERNAME;
  const botUrl = botPlainUrl();

  const session = await getServerSession(authOptions);
  if (!session || !session.user?.id || !session.provider) {
    return NextResponse.json({
      signedIn: false,
      linked: false,
      botConfigured,
      botUrl,
    });
  }
  const link = await getLinkForWebUser(session.provider, session.user.id);
  return NextResponse.json({
    signedIn: true,
    linked: !!link,
    botConfigured,
    botUrl,
    telegram: link
      ? {
          telegramUserId: link.telegramUserId,
          telegramUsername: link.telegramUsername,
          telegramFirstName: link.telegramFirstName,
          linkedAt: link.linkedAt,
        }
      : null,
  });
}
