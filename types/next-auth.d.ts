import type { DefaultSession } from "next-auth";

export type MusicProvider = "spotify" | "deezer" | "soundcloud" | "youtube";

declare module "next-auth" {
  interface Session {
    accessToken?: string;
    refreshToken?: string;
    error?: "RefreshAccessTokenError";
    provider?: MusicProvider;
    // True when this user's email is in the server-only ADMIN_EMAILS
    // env. Set by the session callback in lib/auth.ts; the email list
    // itself is never sent to the client — only this derived boolean.
    isAdmin?: boolean;
    user: {
      id?: string;
      // Spotify-only. Deezer has no comparable plan field exposed via API,
      // so we leave it undefined for Deezer users — the player-context
      // treats undefined as "free" (preview-only).
      product?: "premium" | "free" | "open";
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpires?: number;
    error?: "RefreshAccessTokenError";
    userId?: string;
    product?: "premium" | "free" | "open";
    provider?: "spotify" | "deezer" | "soundcloud" | "youtube";
  }
}
