"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Box,
  Button,
  Container,
  Flex,
  Grid,
  Heading,
  Text,
} from "@radix-ui/themes";
import { MagicWandIcon, ReloadIcon } from "@radix-ui/react-icons";
import { TrackCard } from "@/components/TrackCard";
import { ThrottleCard } from "@/components/ThrottleCard";
import { VoiceInputButton } from "@/components/VoiceInputButton";
import { useI18n } from "@/lib/i18n";
import { useFavorites } from "@/lib/favorites-context";
import { formatWait } from "@/lib/format";
import {
  MoodSearchError,
  useMoodSearch,
} from "@/lib/mood-search-context";

// How many tracks to ask the AI for per search. Flat 12 across every
// viewport — three full rows on 4-col desktop, six on 2-col mobile.
// Kept as a constant so the TG Mini App, landing, and /mood page all
// request the same count.
const MOOD_PICK_COUNT = 12;

export default function MoodPage() {
  const { status } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();
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
    loadSaved,
  } = useMoodSearch();

  // Anon visitors are first-class on /mood — the API resolves picks against
  // SoundCloud's public catalogue and applies a flat 15s spacing + daily
  // cap (see app/api/mood-search/route.ts). We no longer redirect them
  // away.
  const isAnon = status === "unauthenticated";

  // Cancel any in-flight mood-search request when the user navigates
  // away (back, sidebar nav, route change). The provider keeps the
  // cached data so coming back to /mood with a previously-completed
  // query still resolves instantly; only the in-flight one is torn
  // down. The cleanup runs on unmount of THIS page component.
  const queryClient = useQueryClient();
  useEffect(() => {
    return () => {
      queryClient.cancelQueries({ queryKey: ["mood-search"] });
    };
  }, [queryClient]);

  // Mood-search count is a constant — see MOOD_PICK_COUNT above.

  // URL → state sync. Two channels, in priority order:
  //   • ?id=<searchId>  — hydrate from the saved row, no AI call. Used
  //     by RecentSearchRow clicks AND by browser reloads after a fresh
  //     search rewrites the URL (see post-search effect below).
  //   • ?q=<mood>       — kick off a live AI search. Used for legacy
  //     links + share URLs. New searches end up writing ?id= instead so
  //     this path is mostly for visitors arriving from outside.
  //
  // pendingPinRef = "we initiated a FRESH AI call and the URL needs to
  // be repinned with its searchId once it lands". Without this flag the
  // post-effect can't tell apart "data.searchId just changed because a
  // fresh AI search completed" from "data.searchId is stale leftover
  // from the previous render, and we're currently mid-loadSaved for a
  // different id." Clobbering the URL in the second case is the bug
  // where clicking an older search briefly shows it, then snaps back
  // to the most-recent search.
  //
  // loadedIdRef = the last id we asked loadSaved to fetch — guards
  // against refires of this effect re-hitting the same row.
  const loadedIdRef = useRef<string | null>(null);
  const pendingPinRef = useRef(false);
  useEffect(() => {
    const idParam = (searchParams.get("id") ?? "").trim();
    if (idParam) {
      if (loadedIdRef.current === idParam) return;
      loadedIdRef.current = idParam;
      // Explicitly NOT a fresh AI call — we're hydrating a saved row.
      // The post-effect uses this to know it shouldn't pin the URL
      // away from idParam if stale data flashes through first.
      pendingPinRef.current = false;
      void loadSaved(idParam).then((payload) => {
        if (payload) {
          setMood(payload.mood);
        } else {
          // 404 / unauthorized — saved row is gone or doesn't belong to
          // this user. Strip the stale ?id from the URL so the page
          // doesn't keep trying to load it on every effect re-run, then
          // fall back to whatever ?q= says (or an empty input).
          loadedIdRef.current = null;
          const q = (searchParams.get("q") ?? "").trim();
          router.replace(q ? `/mood?q=${encodeURIComponent(q)}` : "/mood");
        }
      });
      return;
    }
    const q = (searchParams.get("q") ?? "").trim();
    if (!q) return;
    if (q === activeQuery) return;
    setMood(q);
    // Fresh AI call about to happen — arm the URL pin for when it
    // returns. Without this, an /mood?q=foo direct visit wouldn't
    // get its ?q= rewritten to ?id= after the search completes.
    pendingPinRef.current = true;
    search(q, MOOD_PICK_COUNT);
  }, [searchParams, activeQuery, setMood, search, loadSaved, router]);

  // After a fresh AI search lands, swap the URL from ?q= to ?id=<row>
  // so a reload replays the saved suggestions instead of burning
  // another OpenAI call.
  //
  // Two gates protect against clobbering the URL with stale data:
  //   1. If the URL already pins an id that doesn't match data's id,
  //      the displayed data is stale (loadSaved is in flight for the
  //      URL id). EXCEPT when pendingPinRef is set — that means the
  //      user EXPLICITLY initiated a fresh search (submit/regenerate)
  //      from a saved-id URL and we DO want to overwrite the id with
  //      the new one.
  //   2. lastPinnedIdRef de-dupes — once we've pinned, we don't pin
  //      the same id again on every render.
  // router.replace, not push: URL-tidy, not navigation — browser
  // back/forward shouldn't bounce through the q→id transition.
  const lastPinnedIdRef = useRef<string | null>(null);
  useEffect(() => {
    const searchId = data?.searchId;
    if (!searchId) return;
    if (lastPinnedIdRef.current === searchId) return;
    const urlId = (searchParams.get("id") ?? "").trim();
    if (urlId && urlId === searchId) {
      // Data just synced with what the URL already says (loadSaved
      // landed). Record it so subsequent renders don't trigger.
      lastPinnedIdRef.current = searchId;
      return;
    }
    if (urlId && !pendingPinRef.current) {
      // URL pins a DIFFERENT id and we're not mid-fresh-search.
      // The data we see is stale render leftover — do NOT clobber
      // the URL with it. Wait for loadSaved to bring data in sync.
      return;
    }
    lastPinnedIdRef.current = searchId;
    loadedIdRef.current = searchId; // suppress the id-load effect refire
    pendingPinRef.current = false;
    router.replace(`/mood?id=${encodeURIComponent(searchId)}`);
  }, [data?.searchId, router, searchParams]);

  // Defensive fallback: lock the last non-empty result so the grid below
  // NEVER unmounts mid-search. keepPreviousData covers most cases, but
  // there are render frames around an error -> retry transition where
  // `data` can flip undefined briefly. Keeping a ref-mirror means the
  // cards stay on screen across any such hiccup, eliminating the visual
  // jiggle even when the underlying query state momentarily resets.
  const lastDataRef = useRef(data);
  if (data) lastDataRef.current = data;
  const renderData = data ?? lastDataRef.current;

  // AI picks could be saved or unsaved — query Spotify once we have ids so
  // the heart icons render with the right initial state. Hydrate on every
  // mount (not just first fetch) so persisted results from a previous
  // visit pick up their hearts when this page re-mounts.
  const favorites = useFavorites();
  useEffect(() => {
    const tracks = renderData?.tracks;
    if (!tracks || tracks.length === 0) return;
    favorites.hydrate(tracks.map(({ track }) => track.id));
  }, [renderData, favorites]);

  // ─── Throttle countdown ─────────────────────────────────────────────
  //
  // When the server returns a 429 with retryAfterSeconds, swap the input
  // form for the ring-countdown card (same visual as the discover page).
  // Once the timer hits 0 we drop back to the form. `throttleTotalSec`
  // is captured at the moment we enter the throttled state so the ring's
  // progress can render relative to the original wait, not the live
  // remaining.
  const [throttledUntil, setThrottledUntil] = useState<number | null>(null);
  const [throttleTotalSec, setThrottleTotalSec] = useState(0);
  useEffect(() => {
    if (
      isError &&
      error instanceof MoodSearchError &&
      error.code === "throttled"
    ) {
      const sec = error.retryAfterSeconds ?? 5;
      setThrottledUntil(Date.now() + sec * 1000);
      setThrottleTotalSec(sec);
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
    // Arm the URL pin: this is an explicit fresh search, so the
    // post-effect should rewrite the URL to ?id=<newId> even if it
    // currently holds a saved ?id=<oldId>.
    pendingPinRef.current = true;
    search(trimmed, MOOD_PICK_COUNT);
    // Reflect the search in the URL so reload + share work. Replace, not
    // push: typing/submitting repeatedly shouldn't litter history with one
    // entry per edit. Browser back/forward across distinct searches still
    // works — they each get pushed by the user's prior submits.
    if ((searchParams.get("q") ?? "") !== trimmed) {
      router.push(`/mood?q=${encodeURIComponent(trimmed)}`);
    }
  };

  // Same intent as onSubmit's pendingPinRef arming: regenerate is also
  // an explicit fresh AI call from the user, so its result should
  // overwrite a stale ?id= in the URL.
  const onRegenerate = () => {
    pendingPinRef.current = true;
    regenerate(MOOD_PICK_COUNT);
  };

  return (
    <Container size="3" px={{ initial: "4", sm: "6" }} py="6" className="page-fade-in">
      <Flex direction="column" gap="6">
        <Box>
          <Heading size="7" weight="bold">
            {t("mood.title")}
          </Heading>
          <Text size="2" color="gray">
            {t("mood.subtitle")}
          </Text>
          {isAnon && data?.anon && (
            <Text size="2" color="gray" mt="2" as="p">
              {t("mood.anonRemaining", {
                remaining: String(data.anon.remaining),
                cap: String(data.anon.cap),
              })}
            </Text>
          )}
        </Box>

        {isThrottled ? (
          // While throttled: ring-countdown card replaces the input
          // entirely. Once the timer drains, we fall back to the form
          // below — the user can submit a new search immediately.
          <ThrottleCard
            remainingSec={throttleRemainingSec}
            totalSec={throttleTotalSec}
            title={t("discover.throttledTitle")}
            body={t("discover.throttledBody")}
          />
        ) : (
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
              <Flex
                className="mood-actions"
                data-loading={isLoading ? "true" : undefined}
                justify="between"
                align="center"
                gap="3"
                wrap="wrap"
              >
                <VoiceInputButton
                  value={mood}
                  onChange={setMood}
                  disabled={isLoading}
                />
                <Flex align="center" gap="3">
                  <Text size="1" color="gray">
                    {t("mood.submitHint")}
                  </Text>
                  <Button
                    size="3"
                    type="submit"
                    disabled={isLoading || mood.trim().length < 2}
                  >
                    <MagicWandIcon />
                    {isLoading ? t("mood.finding") : t("mood.find")}
                  </Button>
                </Flex>
              </Flex>
            </Flex>
          </form>
        )}

        {/* Inline error covers the non-throttle codes — throttled is
          * its own visual surface above. */}
        {isError && !isThrottled && (
          <Text color="red">
            {(() => {
              const code =
                error instanceof MoodSearchError
                  ? error.code
                  : "upstream_error";
              if (code === "quota_exceeded") return t("mood.errorQuota");
              if (code === "rate_limited") return t("mood.errorRateLimited");
              if (code === "config_error") return t("mood.errorConfig");
              if (code === "anon_daily_cap") return t("mood.errorAnonCap");
              return t("mood.error");
            })()}
          </Text>
        )}

        {renderData && renderData.tracks.length === 0 && (
          <Text color="gray">{t("mood.noResults")}</Text>
        )}

        {renderData && renderData.tracks.length > 0 && (
          <Flex
            direction="column"
            gap="3"
            className="mood-results-section"
            data-loading={isLoading ? "true" : undefined}
          >
            <Heading size="5">{t("mood.picks")}</Heading>
            <Grid
              className="mood-results-grid"
              columns={{ initial: "1", xs: "2", md: "3", lg: "4" }}
              gap={{ initial: "3", md: "4", lg: "5" }}
            >
              {(() => {
                const tracks = renderData.tracks.map((p) => p.track);
                return tracks.map((track, i) => (
                  // Stable per-slot key so cards do NOT remount when the
                  // mood changes. React reuses the same TrackCard instance
                  // and just diffs the new track props in — the entrance
                  // animation runs exactly once, on first appearance, and
                  // subsequent searches swap card content silently. No
                  // unmount → no flash of empty grid → no jiggle.
                  <TrackCard
                    key={`mood-result-${i}`}
                    track={track}
                    index={i}
                    queue={tracks}
                    source="mood"
                  />
                ));
              })()}
            </Grid>

            {/* Regenerate: visible only once we have results, since "fresh
              * picks for the same mood" only makes sense after a successful
              * search. Reuses the same throttle UI surfacing the discover
              * page uses: when throttled the button label counts down. */}
            <Flex justify="center" mt="3">
              <Button
                size="3"
                variant="soft"
                onClick={onRegenerate}
                disabled={isLoading || isThrottled}
              >
                <ReloadIcon />
                {isLoading
                  ? t("discover.regenerating")
                  : isThrottled
                    ? t("discover.regenerateWait", {
                        wait: formatWait(throttleRemainingSec),
                      })
                    : t("discover.regenerate")}
              </Button>
            </Flex>
          </Flex>
        )}
      </Flex>
    </Container>
  );
}
