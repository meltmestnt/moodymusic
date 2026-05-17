"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Box, Button, Container, Flex, Heading, Text } from "@radix-ui/themes";
import { readLastProvider, signInWithProvider } from "@/lib/auth-client";
import { useI18n } from "@/lib/i18n";
import type { MusicProvider } from "@/types/next-auth";

// NextAuth points its `pages.error` here. The most common error we see in
// dev is `OAuthCallback` — a transient cookie/state mismatch on Spotify's
// very first sign-in attempt that resolves on retry (the explicit cookie
// config in lib/auth.ts is the root-cause fix; this page is the safety
// net for any residual flakiness).
//
// Provider-aware behavior:
//   - The auto-retry is intentionally Spotify-only. It was built to paper
//     over a Spotify-specific cookie-jar quirk on the first sign-in; for
//     Deezer / SoundCloud, OAuth failures are almost always config errors
//     (missing env vars, app not yet approved) that won't fix themselves
//     on a second click. We surface the manual UI for those instead.
//   - The manual sign-in button retries with whichever provider the user
//     actually clicked, read from sessionStorage via readLastProvider().

const RETRY_FLAG = "moodymusic.oauth.retry";
// How recently a previous retry has to have happened to count as "we've
// already used our budget". Past this window, treat the flag as stale and
// retry again — covers the case where a user signs out + signs back in
// later in the same tab and hits the same first-attempt OAuthCallback.
const RETRY_WINDOW_MS = 30_000;

const RETRYABLE_ERRORS = new Set([
  "OAuthCallback",
  "OAuthSignin",
  "Callback",
  "OAuthCreateAccount",
]);

// Display name for each provider — kept as English brand strings
// because product names don't translate. Used to interpolate into the
// localized title / body copy.
const PROVIDER_LABELS: Record<MusicProvider, string> = {
  spotify: "Spotify",
  deezer: "Deezer",
  soundcloud: "SoundCloud",
  youtube: "YouTube",
};

const PROVIDER_BUTTON_COLORS: Record<
  MusicProvider,
  "grass" | "purple" | "orange" | "red"
> = {
  spotify: "grass",
  deezer: "purple",
  soundcloud: "orange",
  youtube: "red",
};

// Reuse the existing per-provider sign-in copy ("Sign in with Spotify",
// etc.) — they already have proper translations and the wording differs
// per locale (e.g. Ukrainian uses "Увійти через" instead of "Sign in with").
const PROVIDER_SIGNIN_KEYS: Record<MusicProvider, "auth.signInSpotify" | "auth.signInDeezer" | "auth.signInSoundCloud" | "auth.signInYouTube"> = {
  spotify: "auth.signInSpotify",
  deezer: "auth.signInDeezer",
  soundcloud: "auth.signInSoundCloud",
  youtube: "auth.signInYouTube",
};

function ErrorPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { t } = useI18n();
  const error = params.get("error") ?? "";
  // hasRetried flips to true once we've consumed the auto-retry budget so
  // the surface re-renders with the manual sign-in fallback.
  const [hasRetried, setHasRetried] = useState(false);
  const triggeredRef = useRef(false);
  // Provider is read from sessionStorage, which is browser-only — so the
  // value is `null` during SSR and the first client paint. We populate it
  // in useEffect to keep server-rendered HTML and the initial client tree
  // identical (avoids the React hydration mismatch).
  const [provider, setProvider] = useState<MusicProvider | null>(null);

  useEffect(() => {
    setProvider(readLastProvider());
  }, []);

  useEffect(() => {
    if (provider === null) return;
    if (triggeredRef.current) return;
    triggeredRef.current = true;

    // Only auto-retry for Spotify — see header comment for rationale.
    if (provider !== "spotify" || !RETRYABLE_ERRORS.has(error)) {
      setHasRetried(true);
      return;
    }
    // Check the flag's age, not just its presence. A retry that happened
    // ages ago shouldn't count against the current attempt — without this,
    // a user who signs out and tries again in the same tab gets stuck on
    // the manual UI forever because the old flag is still set.
    const stamp = sessionStorage.getItem(RETRY_FLAG);
    const recent =
      stamp && Date.now() - parseInt(stamp, 10) < RETRY_WINDOW_MS;
    if (recent) {
      sessionStorage.removeItem(RETRY_FLAG);
      setHasRetried(true);
      return;
    }
    sessionStorage.setItem(RETRY_FLAG, String(Date.now()));
    // Brief pause so the user sees "retrying" rather than a blank flicker.
    const handle = setTimeout(() => {
      void signInWithProvider("spotify", { callbackUrl: "/library" });
    }, 600);
    return () => clearTimeout(handle);
  }, [error, provider, router]);

  // While provider is still null (SSR + first client render before the
  // effect runs), render nothing. That keeps the SSR and client trees
  // identical — the real UI swaps in once we know which provider was
  // attempted, with no hydration mismatch.
  if (provider === null) {
    return <Container size="2" px={{ initial: "4", sm: "6" }} py="9" />;
  }

  const providerLabel = PROVIDER_LABELS[provider];

  if (!hasRetried && provider === "spotify" && RETRYABLE_ERRORS.has(error)) {
    return (
      <Container size="2" px={{ initial: "4", sm: "6" }} py="9">
        <Flex direction="column" align="center" gap="4">
          <Box className="running-ring" style={{ borderRadius: "50%", padding: 0 }}>
            <Box
              style={{
                width: 96,
                height: 96,
                borderRadius: "50%",
                background: "var(--gray-2)",
              }}
            />
          </Box>
          <Heading size="5">
            {t("authError.reconnecting", { provider: providerLabel })}
          </Heading>
          <Text color="gray" size="2">
            {t("authError.reconnectingNote")}
          </Text>
        </Flex>
      </Container>
    );
  }

  return (
    <Container size="2" px={{ initial: "4", sm: "6" }} py="9">
      <Flex direction="column" gap="4" align="center" style={{ textAlign: "center" }}>
        <Heading size="6">{t("authError.title")}</Heading>
        <Text color="gray" size="2" style={{ maxWidth: 480 }}>
          {t("authError.body", { provider: providerLabel })}
        </Text>
        {error && (
          <Text size="1" color="gray" style={{ fontFamily: "ui-monospace, monospace" }}>
            {t("authError.codeLabel", { code: error })}
          </Text>
        )}
        <Button
          size="3"
          color={PROVIDER_BUTTON_COLORS[provider]}
          onClick={() => {
            sessionStorage.removeItem(RETRY_FLAG);
            void signInWithProvider(provider, { callbackUrl: "/library" });
          }}
        >
          {t(PROVIDER_SIGNIN_KEYS[provider])}
        </Button>
        <Button variant="ghost" color="gray" onClick={() => router.replace("/")}>
          {t("authError.goHome")}
        </Button>
      </Flex>
    </Container>
  );
}

export default function AuthErrorPage() {
  return (
    <Suspense fallback={null}>
      <ErrorPageInner />
    </Suspense>
  );
}
