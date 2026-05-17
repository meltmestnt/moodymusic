"use client";

import { signIn, type SignInOptions } from "next-auth/react";
import type { MusicProvider } from "@/types/next-auth";

// sessionStorage key holding the most-recently-attempted sign-in provider.
// Read by /auth/error so the retry / manual fallback button targets the
// same provider the user originally clicked, instead of always defaulting
// to Spotify.
export const LAST_PROVIDER_KEY = "moodymusic.lastAuthProvider";

const VALID: MusicProvider[] = ["spotify", "deezer", "soundcloud", "youtube"];

// Map our app-level MusicProvider id → the NextAuth provider id.
// They diverge for YouTube: we surface it as "youtube" everywhere
// in the UI, but NextAuth handles auth via the standard "google"
// provider (with YouTube scopes attached in lib/auth.ts).
function nextAuthProviderId(provider: MusicProvider): string {
  if (provider === "youtube") return "google";
  return provider;
}

// Wrapper around next-auth's signIn that records which provider the user
// just attempted. Use this everywhere instead of calling signIn() directly
// for music providers — without it, /auth/error has no idea what to retry.
export function signInWithProvider(
  provider: MusicProvider,
  options?: SignInOptions,
): Promise<unknown> {
  try {
    sessionStorage.setItem(LAST_PROVIDER_KEY, provider);
  } catch {
    // sessionStorage can throw in private-browsing modes — not fatal.
  }
  return signIn(nextAuthProviderId(provider), options);
}

export function readLastProvider(): MusicProvider {
  try {
    const v = sessionStorage.getItem(LAST_PROVIDER_KEY);
    if (v && (VALID as string[]).includes(v)) return v as MusicProvider;
  } catch {
    // ignore
  }
  return "spotify";
}
