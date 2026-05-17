// Server-only admin gate.
//
// Consumes the `ADMIN_EMAILS` environment variable (NOT `NEXT_PUBLIC_*`)
// — comma-separated list of email addresses that should see the admin
// surfaces. Read on every check (no caching) so flipping the env in
// production is picked up after a redeploy without further fuss.
//
// CRITICAL: this module must never be imported into a client-side
// bundle. Doing so would inline `process.env.ADMIN_EMAILS` into the
// JS shipped to browsers, leaking the allowlist. Only import from
// server contexts: lib/auth.ts (session callback), server components,
// and route handlers under app/api/.
//
// The browser-visible representation is `session.isAdmin: boolean` —
// the session callback in lib/auth.ts derives that from this helper
// and stores only the derived flag in the JWT, so the email list
// itself never leaves the server.
//
// ─── Provider restriction ────────────────────────────────────────────
// Admin status is granted ONLY when the session was issued via the
// "youtube" provider (Google OAuth). Rationale:
//
//   • Google verifies email addresses before issuing tokens — the
//     "email" scope only resolves for accounts where email ownership
//     was confirmed. Spotify, Deezer, and SoundCloud either don't
//     expose an email-verified flag or accept arbitrary emails at
//     signup, which would let an attacker claim admin by registering
//     a Spotify account with `<your-email>` they don't actually own.
//   • Pinning the provider closes that cross-provider spoofing path:
//     to claim admin you need to control the actual Gmail inbox.
//
// If you ever need to admit Spotify-signed admins later, add a
// per-provider verified-email check (or move to a DB role) — don't
// just relax this guard.

import type { MusicProvider } from "@/types/next-auth";

const ADMIN_EMAIL_ENV = "ADMIN_EMAILS";

function parseAdminList(): Set<string> {
  const raw = process.env[ADMIN_EMAIL_ENV] ?? "";
  const out = new Set<string>();
  for (const entry of raw.split(",")) {
    const email = entry.trim().toLowerCase();
    if (email) out.add(email);
  }
  return out;
}

/**
 * True if this user qualifies for admin access. Two conditions, both
 * required:
 *
 *   1. `provider === "youtube"` — the only provider in our stack with
 *      verified-email guarantees.
 *   2. `email` is present in the `ADMIN_EMAILS` env (case-insensitive).
 *
 * Any other combination returns false.
 */
export function isAdminUser(input: {
  email: string | null | undefined;
  provider: MusicProvider | undefined;
}): boolean {
  if (input.provider !== "youtube") return false;
  if (!input.email) return false;
  const list = parseAdminList();
  return list.has(input.email.toLowerCase());
}
