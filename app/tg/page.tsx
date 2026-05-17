"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Box,
  Button,
  Callout,
  Flex,
  Grid,
  Heading,
  Text,
} from "@radix-ui/themes";
import {
  ExclamationTriangleIcon,
  MagicWandIcon,
  ReloadIcon,
} from "@radix-ui/react-icons";
import { TrackCard } from "@/components/TrackCard";
import { LanguagePicker } from "@/components/LanguagePicker";
import { useFavorites } from "@/lib/favorites-context";
import { LOCALE_STORAGE_KEY, useI18n } from "@/lib/i18n";
import {
  MoodSearchError,
  useMoodSearch,
} from "@/lib/mood-search-context";
import { signInWithProvider } from "@/lib/auth-client";
import { useTelegramWebApp } from "./telegram";

// Mini-App layout is a 2-column grid at every width — even narrow phone
// viewports render two cards per row. Ask the AI for 12 picks so the user
// gets six full rows of variety; the route caps askFor at 20 and trims to
// this count after resolution.
const TG_PICK_COUNT = 12;

export default function TelegramMiniAppPage() {
  // useSearchParams() inside the inner component forces Next 15 to bail
  // out of static prerender unless we hand it a Suspense boundary at
  // build time. The page is client-rendered anyway, so the fallback is
  // never user-visible — it only satisfies the build-time contract.
  return (
    <Suspense fallback={null}>
      <TelegramMiniApp />
    </Suspense>
  );
}

function TelegramMiniApp() {
  const tg = useTelegramWebApp();
  const { data: session, status } = useSession();
  const { t, setLocale } = useI18n();
  const searchParams = useSearchParams();
  const {
    mood,
    setMood,
    activeQuery,
    data,
    error,
    isLoading,
    isError,
    search,
    regenerate,
  } = useMoodSearch();

  const isSignedIn = status === "authenticated";

  // Telegram supplies its own theme (light or dark) through CSS variables
  // it injects on the document. We don't override Radix's accent — the
  // existing dark theme reads fine against Telegram's dark scheme, and
  // forcing the light scheme would clash with moodymusic's brand. We do
  // pin the header chrome so the seam against the Mini App body is clean.
  useEffect(() => {
    if (!tg) return;
    tg.setHeaderColor?.("bg_color");
    tg.setBackgroundColor?.("#0a0a0a");
  }, [tg]);

  // First-open locale auto-pick. If the user hasn't chosen a language
  // manually yet (no localStorage entry) and Telegram reports the client
  // is set to Ukrainian, default the Mini App to UK. Once the user picks
  // anything via LanguagePicker, that choice writes localStorage and this
  // effect short-circuits on every subsequent open. Ref guard prevents a
  // re-fire if `tg` reference changes during the session.
  const tgLocaleAppliedRef = useRef(false);
  useEffect(() => {
    if (tgLocaleAppliedRef.current) return;
    if (!tg) return;
    tgLocaleAppliedRef.current = true;
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === "en" || saved === "uk") return;
    const lang = tg.initDataUnsafe?.user?.language_code;
    if (lang === "uk") setLocale("uk");
  }, [tg, setLocale]);

  // Deep-link support. The bot opens this app with `?q=<mood>` and we
  // immediately kick off the search so the user lands on a result page
  // rather than a blank input. Telegram's `start_param` is the other
  // supported channel (for t.me/bot/app?startapp=…); read both.
  //
  // Consumed exactly once per mount: a ref guard prevents this effect
  // from re-firing after the user's own subsequent search lands. Without
  // the guard, `activeQuery` in the deps changed on every search and
  // the effect would re-apply the URL's original mood, clobbering what
  // the user just typed and re-running the deep-link search.
  const deepLinkConsumedRef = useRef(false);
  useEffect(() => {
    if (deepLinkConsumedRef.current) return;
    const fromQuery = (searchParams.get("q") ?? "").trim();
    const fromStartParam = (tg?.initDataUnsafe?.start_param ?? "").trim();
    const initial = fromQuery || fromStartParam;
    if (!initial) return;
    deepLinkConsumedRef.current = true;
    if (initial === activeQuery) return;
    setMood(initial);
    search(initial, TG_PICK_COUNT);
  }, [searchParams, tg, activeQuery, setMood, search]);

  // Keep the previous result visible across re-fetches so the grid
  // doesn't flash empty between regenerates.
  const lastDataRef = useRef(data);
  if (data) lastDataRef.current = data;
  const renderData = data ?? lastDataRef.current;

  // Pre-hydrate favorite-state for the heart icons once we have ids.
  // Signed-out users have no favorites, so this is cheap and a no-op
  // for the anon path.
  const favorites = useFavorites();
  useEffect(() => {
    const tracks = renderData?.tracks;
    if (!tracks?.length) return;
    if (!isSignedIn) return;
    favorites.hydrate(tracks.map(({ track }) => track.id));
  }, [renderData, favorites, isSignedIn]);

  // Throttle countdown — server returns retryAfterSeconds for 429s. We
  // surface a small warning callout instead of the discover/mood
  // ring-countdown, which is too tall for the Mini App viewport.
  const [throttledUntil, setThrottledUntil] = useState<number | null>(null);
  useEffect(() => {
    if (
      isError &&
      error instanceof MoodSearchError &&
      (error.code === "throttled" || error.code === "anon_daily_cap")
    ) {
      const sec = error.retryAfterSeconds ?? 5;
      setThrottledUntil(Date.now() + sec * 1000);
    }
  }, [isError, error]);

  const [throttleRemainingSec, setThrottleRemainingSec] = useState(0);
  useEffect(() => {
    if (throttledUntil === null) {
      setThrottleRemainingSec(0);
      return;
    }
    const tick = () => {
      const remaining = Math.max(
        0,
        Math.ceil((throttledUntil - Date.now()) / 1000),
      );
      setThrottleRemainingSec(remaining);
      if (remaining === 0) setThrottledUntil(null);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => clearInterval(id);
  }, [throttledUntil]);

  const isThrottled = throttleRemainingSec > 0;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = mood.trim();
    if (trimmed.length < 2) return;
    tg?.HapticFeedback?.impactOccurred("light");
    search(trimmed, TG_PICK_COUNT);
  };

  const onRegenerate = () => {
    tg?.HapticFeedback?.impactOccurred("light");
    regenerate(TG_PICK_COUNT);
  };

  const onSignIn = () => {
    // Inside Telegram, NextAuth's redirect flow lands in the in-app
    // browser. `tg.openLink` would force the external browser and
    // break the cookie loop. Default browser nav is the right thing.
    signInWithProvider("spotify", { callbackUrl: "/tg" });
  };

  return (
    <Box px="4" py="4" pb="9" className="tg-app page-fade-in">
      <Flex direction="column" gap="4">
        <Flex justify="between" align="start" gap="3">
          <Box minWidth="0">
            <Heading size="6" weight="bold">
              {t("mood.title")}
            </Heading>
            <Text size="2" color="gray">
              {t("mood.subtitle")}
            </Text>
          </Box>
          {/* Mini-App lives without the global TopBar, so the language
            * picker is mounted here. Telegram users land in their Telegram
            * client language; the picker lets them switch in-place — the
            * choice persists via localStorage just like the desktop app. */}
          <LanguagePicker />
        </Flex>

        {/* Sign-in nudge for anon users — optional, dismissible. We don't
         * block search behind it because the anon SoundCloud path
         * works fine for the default case. */}
        {!isSignedIn && (
          <Box
            style={{
              background: "var(--gray-2)",
              border: "1px solid var(--gray-6)",
              borderRadius: "var(--radius-3)",
              padding: "var(--space-3)",
              color: "var(--gray-11)",
            }}
          >
            <Flex direction="column" align="stretch" gap="2">
              <Text size="2">{t("tg.guestBanner")}</Text>
              <Button
                size="2"
                variant="soft"
                onClick={onSignIn}
                style={{ width: "100%" }}
              >
                {t("tg.signIn")}
              </Button>
            </Flex>
          </Box>
        )}

        <form onSubmit={onSubmit} aria-busy={isLoading || undefined}>
          <Flex direction="column" gap="3">
            <div className="mood-input-stage">
              <Box
                className="running-ring mood-input-wrap"
                data-loading={isLoading ? "true" : undefined}
                role={isLoading ? "status" : undefined}
                aria-live="polite"
                aria-label={isLoading ? t("mood.finding") : undefined}
              >
                <textarea
                  className="mood-input"
                  placeholder={t("mood.placeholder")}
                  value={mood}
                  onChange={(e) => setMood(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      onSubmit(e);
                    }
                  }}
                  disabled={isLoading}
                  aria-hidden={isLoading || undefined}
                />
                <div className="mood-loader-eq" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              </Box>
            </div>
            <Button
              size="3"
              type="submit"
              disabled={isLoading || mood.trim().length < 2 || isThrottled}
            >
              <MagicWandIcon />
              {isLoading ? t("mood.finding") : t("mood.find")}
            </Button>
          </Flex>
        </form>

        {isThrottled && (
          <Callout.Root size="1" variant="surface" color="amber">
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>
              {error instanceof MoodSearchError && error.code === "anon_daily_cap"
                ? `Free daily limit reached. Sign in to keep searching, or try again in ${throttleRemainingSec}s.`
                : `Slow down — try again in ${throttleRemainingSec}s.`}
            </Callout.Text>
          </Callout.Root>
        )}

        {isError && !isThrottled && (
          <Callout.Root size="1" variant="surface" color="red">
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>
              {(() => {
                const code =
                  error instanceof MoodSearchError
                    ? error.code
                    : "upstream_error";
                if (code === "quota_exceeded") return t("mood.errorQuota");
                if (code === "rate_limited") return t("mood.errorRateLimited");
                if (code === "config_error") return t("mood.errorConfig");
                return t("mood.error");
              })()}
            </Callout.Text>
          </Callout.Root>
        )}

        {renderData && renderData.tracks.length === 0 && (
          <Text color="gray">{t("mood.noResults")}</Text>
        )}

        {renderData && renderData.tracks.length > 0 && (
          <Flex direction="column" gap="3">
            <Heading size="4">{t("mood.picks")}</Heading>
            <Grid columns="2" gap="3">
              {(() => {
                const tracks = renderData.tracks.map((p) => p.track);
                return tracks.map((track, i) => (
                  <TrackCard
                    key={`tg-result-${i}`}
                    track={track}
                    index={i}
                    queue={tracks}
                    source="mood"
                  />
                ));
              })()}
            </Grid>
            <Flex justify="center" mt="2">
              <Button
                size="2"
                variant="soft"
                onClick={onRegenerate}
                disabled={isLoading || isThrottled}
              >
                <ReloadIcon />
                {isLoading ? t("discover.regenerating") : t("discover.regenerate")}
              </Button>
            </Flex>
          </Flex>
        )}
      </Flex>
    </Box>
  );
}
