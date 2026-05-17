import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { deleteLinkForWebUser } from "@/lib/telegram-link";

// POST /api/telegram/link/unlink
//
// Removes the link row for the current web account. Idempotent — calling
// it without a link still returns 200. The Telegram side will simply
// stop being recognised as a known user; no notification is sent to
// the bot (we'd need to push to the user's chat for that, which is a
// separate surface we don't need yet).
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session || !session.user?.id || !session.provider) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const removed = await deleteLinkForWebUser(
    session.provider,
    session.user.id,
  );
  return NextResponse.json({ ok: true, removed });
}
