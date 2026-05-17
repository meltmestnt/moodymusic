// Inline session refresh for SoundCloud.
//
// Background: NextAuth's JWT callback only refreshes a token when its
// cached `accessTokenExpires` has passed. SoundCloud occasionally
// revokes access tokens server-side before the cached expiry — once
// that happens, the API responds 401 and the user is stuck because the
// JWT callback never decides "this needs refreshing." We work around
// that by refreshing inline from the API route on 401, retrying the
// upstream call once, and rewriting the session cookie so subsequent
// requests pick up the new token without paying for another refresh.
//
// This is intentionally separate from lib/auth.ts so it can pull in
// `next-auth/jwt`'s server-only encode/decode without bloating the
// client-bundled half of the auth surface.

import { cookies } from "next/headers";
import { decode, encode } from "next-auth/jwt";
import {
  IS_HTTPS,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  refreshSoundCloudToken,
} from "@/lib/auth";

interface RefreshResult {
  accessToken: string;
  setCookieHeader: string;
}

// Build a Set-Cookie header that mirrors NextAuth's session-token cookie
// shape. We don't rely on Next.js's cookies() helper because we want
// to attach the header to a streaming Response (the proxied audio
// bytes), and cookies().set() only works on Server Actions / Route
// Handler initial responses.
function buildSessionCookieHeader(value: string, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${value}`,
    `Path=${SESSION_COOKIE_OPTIONS.path}`,
    `HttpOnly`,
    `SameSite=${SESSION_COOKIE_OPTIONS.sameSite[0].toUpperCase()}${SESSION_COOKIE_OPTIONS.sameSite.slice(1)}`,
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (IS_HTTPS) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Refresh the SoundCloud access token using the refresh_token currently
 * stored in the session JWT, persist the new token by re-encoding the
 * JWT and returning a Set-Cookie header for the caller to attach to its
 * response, and return the fresh access token for an inline retry.
 *
 * Returns null in several no-op scenarios: NEXTAUTH_SECRET unset, no
 * session cookie present, decode failure, JWT not from a SoundCloud
 * sign-in, no refresh_token stored, or the refresh request itself
 * failing. In every null path we log a warning so a session that
 * silently fails to refresh is debuggable from the server console.
 */
export async function refreshAndPersistSoundCloud(): Promise<RefreshResult | null> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    console.warn(
      "[auth-refresh] NEXTAUTH_SECRET not set; can't read or rewrite the session JWT",
    );
    return null;
  }

  // App Router: cookies() from next/headers is the supported way to
  // read request cookies inside a route handler. getToken() with a
  // bare Web Request doesn't reliably parse the Cookie header in v4,
  // which is why our previous attempt always returned null and the
  // refresh-and-retry never fired.
  const cookieStore = await cookies();
  const sessionTokenCookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (!sessionTokenCookie?.value) {
    console.warn(
      `[auth-refresh] no ${SESSION_COOKIE_NAME} cookie on request — can't refresh`,
    );
    return null;
  }

  let token: Awaited<ReturnType<typeof decode>> = null;
  try {
    token = await decode({ token: sessionTokenCookie.value, secret });
  } catch (e) {
    console.warn("[auth-refresh] decode failed:", e);
    return null;
  }
  if (!token) {
    console.warn("[auth-refresh] decoded token was empty");
    return null;
  }
  if (token.provider !== "soundcloud") {
    console.warn(
      `[auth-refresh] session provider is "${String(token.provider)}", not soundcloud — skipping refresh`,
    );
    return null;
  }
  if (!token.refreshToken) {
    console.warn(
      "[auth-refresh] no refresh_token stored on the JWT — user must re-auth",
    );
    return null;
  }

  let refreshed: Awaited<ReturnType<typeof refreshSoundCloudToken>>;
  try {
    refreshed = await refreshSoundCloudToken(token.refreshToken);
  } catch (e) {
    console.warn("[auth-refresh] soundcloud refresh failed:", e);
    return null;
  }

  console.log(
    "[auth-refresh] soundcloud token refreshed; new expiry in",
    refreshed.expires_in,
    "s",
  );

  const newAccessTokenExpires = Date.now() + refreshed.expires_in * 1000;
  const newToken = {
    ...token,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? token.refreshToken,
    accessTokenExpires: newAccessTokenExpires,
    error: undefined,
  };

  // 30 days mirrors NextAuth's default session maxAge — keeps the cookie
  // alive across normal use without going stale.
  const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
  const encoded = await encode({
    token: newToken,
    secret,
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });

  return {
    accessToken: refreshed.access_token,
    setCookieHeader: buildSessionCookieHeader(encoded, COOKIE_MAX_AGE_SECONDS),
  };
}
