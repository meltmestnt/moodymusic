import type { NextAuthOptions } from "next-auth";
import type { OAuthConfig } from "next-auth/providers/oauth";
import GoogleProvider from "next-auth/providers/google";
import SpotifyProvider from "next-auth/providers/spotify";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { isAdminUser } from "@/lib/auth-admin";
import { logSignIn, touchUser } from "@/lib/db/events";
import type { MusicProvider } from "@/types/next-auth";

// ─── Spotify scopes ───
//
// user-library-read = list saved tracks, user-library-modify = save/unsave
// (heart toggle), user-read-email for the account email, user-read-private
// to learn `product` (free vs premium), streaming + user-modify-playback-state
// so the Web Playback SDK can play full tracks for Premium users,
// user-read-playback-state to read what's currently playing across devices.
const SPOTIFY_SCOPES = [
  "user-read-email",
  "user-read-private",
  "user-library-read",
  "user-library-modify",
  "user-top-read",
  "streaming",
  "user-modify-playback-state",
  "user-read-playback-state",
  "user-read-currently-playing",
].join(" ");

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

// ─── Deezer scopes ("perms") ───
//
// basic_access for /user/me, email for the email field, manage_library for
// add/remove favorites, listening_history for any future "recently played"
// surface, offline_access so the access token is long-lived (Deezer has no
// refresh-token grant — without offline_access the token expires in an hour
// with no way to renew except sending the user back through consent).
const DEEZER_PERMS = [
  "basic_access",
  "email",
  "manage_library",
  "listening_history",
  "offline_access",
].join(",");

async function refreshSpotifyToken(refreshToken: string) {
  const basic = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`,
  ).toString("base64");

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) throw new Error(`spotify refresh failed: ${res.status}`);
  return (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };
}

// ─── Deezer custom OAuth provider ───
//
// NextAuth doesn't ship a Deezer provider, so we wire it up by hand. The two
// gotchas vs. a normal OAuth2 provider:
//
//   1. The token endpoint returns application/x-www-form-urlencoded, not
//      JSON: `access_token=…&expires=…`. NextAuth's default token handler
//      json-parses the body, so we provide a custom `request` function.
//
//   2. There is NO refresh-token grant. With `offline_access` perm the
//      access token is long-lived (~indefinitely until revoked); without
//      it the token expires in an hour and the only way to renew is to
//      send the user back through the authorize screen. We set a
//      far-future accessTokenExpires in the JWT callback so we don't try
//      to refresh, and surface the auth-expired state via 401s flowing
//      through the API routes.
//
// Reference: https://developers.deezer.com/api/oauth
function DeezerProvider(): OAuthConfig<DeezerProfile> {
  return {
    id: "deezer",
    name: "Deezer",
    type: "oauth",
    version: "2.0",
    authorization: {
      url: "https://connect.deezer.com/oauth/auth.php",
      params: {
        // Deezer uses `app_id` instead of the standard `client_id` on the
        // authorize URL (and `perms` instead of `scope`). NextAuth lets us
        // shape the params however the provider expects.
        app_id: process.env.DEEZER_APP_ID ?? "",
        perms: DEEZER_PERMS,
      },
    },
    token: {
      url: "https://connect.deezer.com/oauth/access_token.php",
      async request(context) {
        const params = new URLSearchParams({
          app_id: process.env.DEEZER_APP_ID ?? "",
          secret: process.env.DEEZER_APP_SECRET ?? "",
          code: context.params.code ?? "",
          output: "json",
        });
        // `output=json` makes Deezer return JSON instead of the default
        // x-www-form-urlencoded body. Their server still sometimes ignores
        // this hint depending on app config, so handle both shapes.
        const res = await fetch(
          `https://connect.deezer.com/oauth/access_token.php?${params}`,
          { method: "GET" },
        );
        const body = await res.text();
        let parsed: { access_token?: string; expires?: string | number } = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          // form-encoded fallback: access_token=...&expires=...
          const fp = new URLSearchParams(body);
          parsed = {
            access_token: fp.get("access_token") ?? undefined,
            expires: fp.get("expires") ?? undefined,
          };
        }
        if (!parsed.access_token) {
          throw new Error(`deezer token exchange failed: ${body}`);
        }
        const expiresIn = Number(parsed.expires ?? 0);
        // expires=0 with offline_access means "no expiry" — translate to a
        // large but finite number so downstream code stays well-typed.
        return {
          tokens: {
            access_token: parsed.access_token,
            token_type: "bearer",
            expires_in: expiresIn > 0 ? expiresIn : 60 * 60 * 24 * 365,
          },
        };
      },
    },
    userinfo: {
      url: "https://api.deezer.com/user/me",
      async request({ tokens }) {
        const res = await fetch(
          `https://api.deezer.com/user/me?access_token=${encodeURIComponent(tokens.access_token ?? "")}`,
        );
        if (!res.ok) throw new Error(`deezer userinfo failed: ${res.status}`);
        return (await res.json()) as DeezerProfile;
      },
    },
    profile(profile) {
      return {
        id: String(profile.id),
        name: profile.name,
        email: profile.email ?? null,
        image: profile.picture_medium ?? profile.picture ?? null,
      };
    },
    clientId: process.env.DEEZER_APP_ID ?? "",
    clientSecret: process.env.DEEZER_APP_SECRET ?? "",
    // Deezer doesn't follow OIDC, no PKCE — disable both checks. Without
    // this NextAuth tries to set/read a state cookie and PKCE verifier
    // that the Deezer authorize URL will never echo back.
    checks: ["state"],
  };
}

interface DeezerProfile {
  id: number;
  name: string;
  email?: string;
  picture?: string;
  picture_small?: string;
  picture_medium?: string;
  picture_big?: string;
  picture_xl?: string;
}

// ─── SoundCloud scopes ───
//
// SoundCloud's OAuth 2.1 model only exposes a single user-facing scope —
// `non-expiring` — which exists to control whether refresh tokens are
// rotated. We just request none and rely on the access_token + refresh
// token rotation that the spec mandates. (Their API docs are sparse;
// the OAuth flow follows the standard Authorization Code + PKCE shape.)
const SOUNDCLOUD_TOKEN_URL = "https://secure.soundcloud.com/oauth/token";

// Exported so route handlers can refresh inline when SoundCloud rejects
// a still-cached-as-fresh access token (server-side revocation, etc.)
// outside the JWT-callback's expiry-driven refresh path.
export async function refreshSoundCloudToken(refreshToken: string) {
  const res = await fetch(SOUNDCLOUD_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: process.env.SOUNDCLOUD_CLIENT_ID ?? "",
      client_secret: process.env.SOUNDCLOUD_CLIENT_SECRET ?? "",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`soundcloud refresh failed: ${res.status} ${body}`);
  }
  return (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };
}

// SoundCloud OAuth provider. Uses the modern secure.soundcloud.com endpoints
// (the older api.soundcloud.com/connect path was deprecated in 2021).
// Authorization Code with PKCE is mandatory since the same migration —
// NextAuth handles PKCE for us by listing it in `checks`.
function SoundCloudProvider(): OAuthConfig<SoundCloudProfile> {
  return {
    id: "soundcloud",
    name: "SoundCloud",
    type: "oauth",
    version: "2.0",
    authorization: {
      url: "https://secure.soundcloud.com/authorize",
      params: {
        response_type: "code",
        // SoundCloud doesn't use OAuth scopes the way Spotify does — the
        // permissions are inferred from what API endpoints the issued
        // token can reach. We omit `scope` entirely.
      },
    },
    token: {
      url: SOUNDCLOUD_TOKEN_URL,
      // Custom token request because openid-client's defaults trip on
      // SoundCloud in two ways:
      //   1. It defaults to `client_secret_basic` (HTTP Basic auth) for
      //      the token endpoint. SoundCloud's docs use `client_secret_post`
      //      (params in the form body). When the auth method is wrong,
      //      SoundCloud returns 401 and NextAuth bubbles it up as a
      //      generic `OAuthCallback` error.
      //   2. The default handler doesn't surface SoundCloud's response
      //      body when the call fails — making the actual cause invisible.
      //      We log it here instead.
      async request(context) {
        const params = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: process.env.SOUNDCLOUD_CLIENT_ID ?? "",
          client_secret: process.env.SOUNDCLOUD_CLIENT_SECRET ?? "",
          redirect_uri: context.provider.callbackUrl,
          code: context.params.code ?? "",
        });
        // PKCE: the verifier was stashed in the cookie at /authorize time;
        // openid-client puts it on `context.checks.code_verifier` for us
        // to forward in the token exchange.
        const verifier = (context.checks as { code_verifier?: string })
          ?.code_verifier;
        if (verifier) params.set("code_verifier", verifier);

        const res = await fetch(SOUNDCLOUD_TOKEN_URL, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params,
        });
        const body = await res.text();
        if (!res.ok) {
          console.error("[soundcloud] token exchange failed", res.status, body);
          throw new Error(
            `soundcloud token exchange failed: ${res.status} ${body}`,
          );
        }
        let parsed: {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          token_type?: string;
          scope?: string;
        };
        try {
          parsed = JSON.parse(body);
        } catch {
          throw new Error(
            `soundcloud token endpoint returned non-JSON: ${body.slice(0, 200)}`,
          );
        }
        if (!parsed.access_token) {
          throw new Error(`soundcloud token response missing access_token: ${body}`);
        }
        return {
          tokens: {
            access_token: parsed.access_token,
            refresh_token: parsed.refresh_token,
            expires_in: parsed.expires_in,
            token_type: parsed.token_type ?? "bearer",
            scope: parsed.scope,
          },
        };
      },
    },
    userinfo: {
      url: "https://api.soundcloud.com/me",
      async request({ tokens }) {
        // OAuth 2.1 standard is `Bearer`. The legacy SoundCloud API
        // accepted `OAuth <token>`; the modern api.soundcloud.com surface
        // expects `Bearer`. Using the wrong one returns 401 and bubbles
        // up as `OAuthCallback`.
        const res = await fetch("https://api.soundcloud.com/me", {
          headers: {
            Authorization: `Bearer ${tokens.access_token ?? ""}`,
            Accept: "application/json",
          },
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.error(
            "[soundcloud] userinfo failed",
            res.status,
            body.slice(0, 200),
          );
          throw new Error(`soundcloud userinfo failed: ${res.status}`);
        }
        return (await res.json()) as SoundCloudProfile;
      },
    },
    profile(profile) {
      return {
        id: String(profile.id),
        name: profile.full_name || profile.username,
        // SoundCloud's `/me` doesn't always return an email field —
        // depends on what the user authorised. Default to null so
        // NextAuth doesn't choke.
        email: null,
        image: profile.avatar_url ?? null,
      };
    },
    clientId: process.env.SOUNDCLOUD_CLIENT_ID ?? "",
    clientSecret: process.env.SOUNDCLOUD_CLIENT_SECRET ?? "",
    // Pin the token-endpoint auth method to client_secret_post so
    // openid-client doesn't fall back to Basic auth (see token.request).
    client: {
      token_endpoint_auth_method: "client_secret_post",
    },
    // PKCE + state — the standard pair for confidential clients. Without
    // PKCE, secure.soundcloud.com rejects the authorize step with
    // `invalid_request` since 2021.
    checks: ["pkce", "state"],
  };
}

// ─── YouTube (Google OAuth) ───
//
// We sign in with Google and request the YouTube scopes — there's no
// distinct "YouTube login" endpoint. NextAuth's built-in GoogleProvider
// handles the OAuth dance; we only customise scope + access type
// (offline access so we get a refresh_token on first consent).
//
// Two scopes:
//   - youtube.readonly: list the user's "Liked videos" playlist (LL),
//     fetch video metadata, search.
//   - youtube: write rating (POST /videos/rate?rating=like|none) so the
//     heart button toggles a YouTube "Like" on the video. The user
//     consents once; subsequent sign-ins reuse the grant.
const YOUTUBE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube",
].join(" ");

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

async function refreshGoogleToken(refreshToken: string) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`google refresh failed: ${res.status} ${body}`);
  }
  return (await res.json()) as {
    access_token: string;
    expires_in: number;
    // Google rotates refresh_tokens only on consent — most refreshes
    // omit the field, so callers should fall back to the existing one.
    refresh_token?: string;
  };
}

interface SoundCloudProfile {
  id: number;
  username: string;
  full_name?: string;
  avatar_url?: string;
  permalink_url?: string;
  // The standard next-auth Profile expects at least one of these fields
  // structurally; declaring optionals here lets SoundCloudProfile satisfy
  // `Awaitable<Profile>`. SoundCloud never populates them at runtime; they
  // exist purely to give the structural-typing check an overlap.
  name?: string;
  email?: string;
  image?: string;
}

// We're "secure" only when serving on https. Local dev hits this app over
// http (Spotify forces 127.0.0.1, not localhost, and that origin is plain
// http). NextAuth's auto-detect of `useSecureCookies` is based on
// NEXTAUTH_URL, but historically it has set Secure=true in dev anyway when
// the request happens to come in over a forwarded https header — chunking
// the cookie names and stripping the OAuth state/PKCE cookies that the
// callback then can't read. Pin it explicitly to whatever NEXTAUTH_URL
// says, and pin the actual cookies to Lax + Secure=false on http so the
// pkce_verifier and state cookies survive the round-trip through Spotify's
// consent screen on the first sign-in.
export const IS_HTTPS = (process.env.NEXTAUTH_URL ?? "").startsWith("https://");

// Exported so route handlers writing a refreshed JWT cookie can match
// the same name + options NextAuth itself uses, without duplicating
// the IS_HTTPS-vs-prefix logic.
export const SESSION_COOKIE_NAME = IS_HTTPS
  ? "__Secure-next-auth.session-token"
  : "next-auth.session-token";

const cookieOpts = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: IS_HTTPS,
} as const;

export const SESSION_COOKIE_OPTIONS = cookieOpts;

export const authOptions: NextAuthOptions = {
  providers: [
    SpotifyProvider({
      clientId: process.env.SPOTIFY_CLIENT_ID ?? "",
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET ?? "",
      authorization: {
        // No `show_dialog: "true"` here — forcing the consent screen on
        // every sign-in extends the OAuth round-trip enough to occasionally
        // lose the state cookie on cookie-jar-strict browsers, which is
        // exactly the "first sign-in fails, second succeeds" pattern. If
        // we add new scopes later, users only need to revoke at
        // https://www.spotify.com/account/apps once.
        params: { scope: SPOTIFY_SCOPES },
      },
    }),
    DeezerProvider(),
    SoundCloudProvider(),
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      // We rebrand this provider as "youtube" inside the app — the
      // sign-in UI says "Sign in with YouTube" and the session.provider
      // ends up as "youtube" — but the underlying OAuth happens against
      // Google. NextAuth uses the provider id "google" in its callback
      // URL, so leave the provider id at default; the rename happens
      // in the JWT callback (account.provider → "youtube").
      authorization: {
        params: {
          scope: YOUTUBE_SCOPES,
          // access_type=offline + prompt=consent guarantees Google
          // returns a refresh_token on the first sign-in. Without
          // prompt=consent, a user who has previously authorised the
          // app gets a new access_token but no refresh_token, which
          // breaks token rotation.
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  session: { strategy: "jwt" },
  useSecureCookies: IS_HTTPS,
  // Explicit names + options so the prefix/secure heuristics can't drop
  // the OAuth-flow cookies on http://127.0.0.1 dev.
  cookies: {
    sessionToken: {
      name: IS_HTTPS
        ? "__Secure-next-auth.session-token"
        : "next-auth.session-token",
      options: cookieOpts,
    },
    callbackUrl: {
      name: IS_HTTPS
        ? "__Secure-next-auth.callback-url"
        : "next-auth.callback-url",
      options: { sameSite: "lax", path: "/", secure: IS_HTTPS },
    },
    csrfToken: {
      name: IS_HTTPS
        ? "__Host-next-auth.csrf-token"
        : "next-auth.csrf-token",
      options: cookieOpts,
    },
    pkceCodeVerifier: {
      name: IS_HTTPS
        ? "__Secure-next-auth.pkce.code_verifier"
        : "next-auth.pkce.code_verifier",
      // Short TTL — only needs to survive the round-trip through Spotify.
      // 15 minutes is generous; if it expires the user is hung up on the
      // consent screen, which is its own problem.
      options: { ...cookieOpts, maxAge: 60 * 15 },
    },
    state: {
      name: IS_HTTPS
        ? "__Secure-next-auth.state"
        : "next-auth.state",
      options: { ...cookieOpts, maxAge: 60 * 15 },
    },
    nonce: {
      name: IS_HTTPS ? "__Secure-next-auth.nonce" : "next-auth.nonce",
      options: cookieOpts,
    },
  },
  pages: {
    // Custom error page so a first-time OAuthCallback failure auto-retries
    // sign-in instead of stranding the user on NextAuth's default screen.
    //
    // BOTH pages.signIn AND pages.error need to point here:
    //   - pages.error covers Configuration-type errors NextAuth surfaces
    //     itself.
    //   - pages.signIn is what NextAuth v4 actually redirects to for
    //     OAuth-callback errors (state/PKCE mismatch, profile fetch
    //     failure, etc.). Without this override, a failed first
    //     sign-in lands the user on NextAuth's built-in
    //     /api/auth/signin?error=OAuthCallback screen with a "Try a
    //     different account" button — exactly the bug the auto-retry
    //     page was meant to absorb. Calling signIn(provider) elsewhere
    //     in the app still bypasses this page and goes straight to the
    //     provider's authorize endpoint, so this doesn't add a hop to
    //     normal sign-in clicks.
    signIn: "/auth/error",
    error: "/auth/error",
  },
  events: {
    // Persist a row in the `users` collection on every sign-in. Runs
    // fire-and-forget — NextAuth doesn't await events, so a slow Mongo
    // write doesn't delay the user's redirect to the app. touchUser
    // already swallows DB errors via getCollections returning null
    // when MONGODB_URI isn't set, so this is safe in dev environments
    // without Mongo.
    //
    // We also touchUser from logSearch / logPlay / logFavorite, but
    // those only fire when the user takes an action — a user who signs
    // in and immediately closes the tab would otherwise never appear
    // in the users collection. Capturing on signIn closes that gap.
    async signIn({ user, account, profile }) {
      if (!account || !user.id) return;
      // Rebrand google → youtube to match the rest of the app's
      // session.provider convention.
      const provider: MusicProvider =
        account.provider === "google"
          ? "youtube"
          : (account.provider as MusicProvider);
      // Spotify is the only provider that returns a `product` field
      // (premium / free / open). Everyone else stays null.
      let product: "premium" | "free" | "open" | null = null;
      if (account.provider === "spotify" && profile) {
        const p = profile as { product?: "premium" | "free" | "open" };
        product = p.product ?? null;
      }
      const userCtx = {
        spotifyUserId: user.id,
        provider,
        displayName: user.name ?? null,
        email: user.email ?? null,
        image: user.image ?? null,
        product,
      };
      try {
        // touchUser keeps the per-user "last seen" surface fresh.
        // logSignIn appends a row to the per-login audit collection so
        // we retain history (when each provider was attached, etc.)
        // rather than just the latest snapshot. Both are best-effort.
        await Promise.all([touchUser(userCtx), logSignIn(userCtx)]);
      } catch (e) {
        // Persistence is a side effect — never break sign-in over a
        // DB hiccup. The helpers already log internally on their own
        // catch paths; this outer try is just belt-and-suspenders.
        console.warn("[auth] sign-in persistence failed:", e);
      }
    },
  },
  callbacks: {
    // Block Deezer sign-in attempts when the feature flag is off. The
    // provider stays registered so the route table doesn't have to be
    // rebuilt at flag-flip time, but the actual sign-in is refused at
    // the callback step. Returning false here lands the user back on
    // /auth/error with `error=AccessDenied`. Spotify is unconditional.
    async signIn({ account }) {
      if (account?.provider === "deezer") {
        return await isFeatureEnabled("deezer");
      }
      if (account?.provider === "soundcloud") {
        return await isFeatureEnabled("soundcloud");
      }
      // The "google" provider is rebranded as YouTube in our app.
      // We gate the sign-in on the youtube flag rather than a hypothetical
      // google flag, since Google OAuth here is a means to an end.
      if (account?.provider === "google") {
        return await isFeatureEnabled("youtube");
      }
      return true;
    },
    async jwt({ token, account, profile }) {
      if (account && profile) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.accessTokenExpires = account.expires_at
          ? account.expires_at * 1000
          : Date.now() + 3500 * 1000;
        // Rebrand "google" as "youtube" everywhere in our session
        // surface — the rest of the app keys behaviour off
        // session.provider, and Google is purely a transport here.
        token.provider =
          account.provider === "google"
            ? "youtube"
            : (account.provider as "spotify" | "deezer" | "soundcloud");
        if (account.provider === "spotify") {
          const p = profile as {
            id?: string;
            product?: "premium" | "free" | "open";
          };
          token.userId = p.id;
          token.product = p.product;
        } else if (account.provider === "google") {
          // Google's OIDC profile uses `sub` as the stable user id.
          // Email and name flow through NextAuth's standard fields.
          const p = profile as { sub?: string; id?: string };
          token.userId = p.sub ?? p.id;
          token.product = undefined;
        } else {
          // Deezer / SoundCloud profile ids are numeric; we stringify
          // in each provider's profile() callback. Neither has a `product`
          // field analogous to Spotify's free/premium, so we leave it
          // undefined — the player treats undefined as "free" (preview-
          // only), which is the only playback mode we support for them.
          const p = profile as { id?: string };
          token.userId = p.id;
          token.product = undefined;
        }
        return token;
      }
      // Token still valid — return as is.
      if (
        token.accessTokenExpires &&
        Date.now() < token.accessTokenExpires - 60_000
      ) {
        return token;
      }
      // Refresh — Spotify, SoundCloud, and YouTube all expose refresh
      // tokens. Deezer has no refresh-token grant, so an expired Deezer
      // token requires re-auth; return the token unchanged and let
      // downstream API calls 401, which the UI already handles.
      if (token.provider === "deezer") return token;
      try {
        if (!token.refreshToken) throw new Error("missing refresh_token");
        let refreshed: {
          access_token: string;
          expires_in: number;
          refresh_token?: string;
        };
        if (token.provider === "soundcloud") {
          refreshed = await refreshSoundCloudToken(token.refreshToken);
        } else if (token.provider === "youtube") {
          refreshed = await refreshGoogleToken(token.refreshToken);
        } else {
          refreshed = await refreshSpotifyToken(token.refreshToken);
        }
        return {
          ...token,
          accessToken: refreshed.access_token,
          accessTokenExpires: Date.now() + refreshed.expires_in * 1000,
          refreshToken: refreshed.refresh_token ?? token.refreshToken,
          error: undefined,
        };
      } catch {
        return { ...token, error: "RefreshAccessTokenError" };
      }
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken;
      session.refreshToken = token.refreshToken;
      session.error = token.error;
      session.provider = token.provider;
      // Derive admin status from email + provider on every session
      // read. Both inputs are server-side only at this point — the
      // ADMIN_EMAILS env never leaves this process. Only the boolean
      // flows out to the client via session.isAdmin.
      session.isAdmin = isAdminUser({
        email: session.user?.email ?? null,
        provider: token.provider,
      });
      session.user = {
        ...session.user,
        id: token.userId,
        product: token.product,
      };
      return session;
    },
  },
};
