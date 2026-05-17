"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Box,
  Button,
  Card,
  Container,
  Flex,
  Grid,
  Heading,
  Text,
} from "@radix-ui/themes";
import {
  ExclamationTriangleIcon,
  ReloadIcon,
} from "@radix-ui/react-icons";
import type { SpotifyTrack } from "@/lib/spotify";
import { TrackCard } from "@/components/TrackCard";
import { EqualizerLoader } from "@/components/EqualizerLoader";
import { ThrottleCard } from "@/components/ThrottleCard";
import { useI18n } from "@/lib/i18n";
import { useFavorites } from "@/lib/favorites-context";
import { formatWait } from "@/lib/format";

interface DiscoverResponse {
  tracks: { track: SpotifyTrack; reason: string | null }[];
  code?: string;
  error?: string;
}

class DiscoverError extends Error {
  constructor(
    public code: string,
    public detail?: string,
    public retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "DiscoverError";
  }
}

async function fetchDiscover(
  seed: string | null,
  signal?: AbortSignal,
): Promise<DiscoverResponse> {
  const url = seed
    ? `/api/discover?seed=${encodeURIComponent(seed)}`
    : "/api/discover";
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      detail?: string;
      retryAfterSeconds?: number;
    };
    throw new DiscoverError(
      body.code ?? "upstream_error",
      body.detail,
      body.retryAfterSeconds,
    );
  }
  return res.json();
}

// Persist the discover result so navigating away + back, or even reloading
// the page, surfaces the same picks instead of re-firing OpenAI. The
// server-side Redis cache only lives 60s; this localStorage layer carries
// the result for the rest of the session (24h cap to keep it fresh-ish).
const STORAGE_KEY = "moodymusic.discover.cache";
const STORAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface CachedDiscover {
  savedAt: number;
  data: DiscoverResponse;
}

function readDiscoverCache(): CachedDiscover | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedDiscover;
    if (!parsed?.data?.tracks?.length) return null;
    if (Date.now() - parsed.savedAt > STORAGE_MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDiscoverCache(data: DiscoverResponse) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ savedAt: Date.now(), data }),
    );
  } catch {
    // Storage full / private mode — silently skip; persistence is a
    // nice-to-have, not load-bearing.
  }
}

// ─── Client-side regenerate throttle ──────────────────────────────────────
//
// Mirrors the server-side throttleMoodSearch schedule so the button is
// disabled BEFORE we even hit the API. The server check is still the
// authoritative one (a stale tab, a script, or a Redis-down dev env can
// all bypass this), but in normal browser use this prevents the user
// from sending burst requests we'd just throttle anyway.

const REGEN_KEY = "moodymusic.discover.regen";
// Sliding window — after this much idle time, the count resets. Mirrors
// THROTTLE_WINDOW_SECONDS on the server (3 hours, longer than the
// largest individual throttle so the count doesn't expire mid-wait).
const REGEN_WINDOW_MS = 3 * 60 * 60 * 1000;

// Mirrors THROTTLE_SCHEDULE_MS in lib/redis.ts. Keep in sync.
//   request #1 free, #2 → 30s, #3 → 90s, #4 → 3m, #5 → 5m, #6+ → 10m.
const REGEN_SCHEDULE_MS = [
  30_000,
  90_000,
  180_000,
  300_000,
  600_000,
];

interface RegenState {
  count: number;
  lastAt: number;
}

function readRegenState(): RegenState {
  if (typeof window === "undefined") return { count: 0, lastAt: 0 };
  try {
    const raw = window.sessionStorage.getItem(REGEN_KEY);
    if (!raw) return { count: 0, lastAt: 0 };
    const parsed = JSON.parse(raw) as RegenState;
    if (Date.now() - parsed.lastAt > REGEN_WINDOW_MS) {
      return { count: 0, lastAt: 0 };
    }
    return parsed;
  } catch {
    return { count: 0, lastAt: 0 };
  }
}

function writeRegenState(state: RegenState) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(REGEN_KEY, JSON.stringify(state));
  } catch {
    /* no-op */
  }
}

// Free for request #1; from #2 onward, scale up per the schedule.
// nextCount is what THIS request would advance to.
function regenRequiredIntervalMs(nextCount: number): number {
  if (nextCount < 2) return 0;
  const idx = Math.min(nextCount - 2, REGEN_SCHEDULE_MS.length - 1);
  return REGEN_SCHEDULE_MS[idx]!;
}

// formatWait + formatCountdown live in lib/format.ts and are shared with
// the mood page so the throttle copy stays consistent across surfaces.

export default function DiscoverPage() {
  const { status } = useSession();
  const router = useRouter();
  const { t } = useI18n();

  // Bumping the seed bypasses the server-side cache for one fetch.
  // Kept as a string so the React Query key changes — useQuery's
  // built-in dedupe handles repeated mounts.
  const [seed, setSeed] = useState<string | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/");
  }, [status, router]);

  // Cancel any in-flight discover request when the user navigates away.
  // The cached data (gcTime: Infinity) survives so coming back resolves
  // instantly from the previous successful response; only the in-flight
  // OpenAI call is torn down.
  const queryClient = useQueryClient();
  useEffect(() => {
    return () => {
      queryClient.cancelQueries({ queryKey: ["discover"] });
    };
  }, [queryClient]);

  const query = useQuery({
    queryKey: ["discover", seed],
    queryFn: ({ signal }) => fetchDiscover(seed, signal),
    enabled: status === "authenticated",
    // staleTime Infinity + gcTime Infinity: navigation away + back is
    // free, no refetch on remount. Persisted across reload via the
    // localStorage initialData below. The only path to fresh picks is
    // the explicit "New picks" button (which bumps seed → new key →
    // fetch).
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    // Hydrate from localStorage on first mount, but ONLY for the no-seed
    // (default) query. A regenerate click bumps the seed → distinct
    // queryKey → no initialData → fresh fetch.
    initialData: seed ? undefined : () => readDiscoverCache()?.data,
    initialDataUpdatedAt: seed
      ? undefined
      : () => readDiscoverCache()?.savedAt,
    // The page renders its own custom error card (throttled vs generic vs
    // empty-library), so suppress the global toast — otherwise the user
    // sees the inline error AND a red toast saying the same thing.
    meta: { suppressToast: true },
  });

  // Persist successful results (including the regenerated ones — overwrites
  // older entry) so the next reload shows the same picks.
  useEffect(() => {
    if (query.data?.tracks?.length) writeDiscoverCache(query.data);
  }, [query.data]);

  // Throttle countdown — when the server returns 429 with retryAfterSeconds,
  // we disable the regenerate button, tick a countdown into its label, and
  // surface a big animated card with a circular progress ring. Keep both
  // `throttledUntil` and `throttleTotalSec` so the ring's progress can
  // render relative to the original wait, not just the live remaining.
  const [throttledUntil, setThrottledUntil] = useState<number | null>(null);
  const [throttleTotalSec, setThrottleTotalSec] = useState(0);
  useEffect(() => {
    if (
      query.error instanceof DiscoverError &&
      query.error.code === "throttled"
    ) {
      const sec = query.error.retryAfterSeconds ?? 5;
      setThrottledUntil(Date.now() + sec * 1000);
      setThrottleTotalSec(sec);
    }
  }, [query.error]);

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

  // Hydrate favorite state for the resolved tracks so hearts render
  // correctly on first paint.
  const { hydrate } = useFavorites();
  useEffect(() => {
    const tracks = query.data?.tracks;
    if (!tracks || tracks.length === 0) return;
    hydrate(tracks.map(({ track }) => track.id));
  }, [query.data, hydrate]);

  const onRegenerate = () => {
    // Pre-flight client-side throttle check. Read fresh from sessionStorage
    // each click so the count survives page navigation and reload (the
    // server enforces this too via Redis, but checking here means we
    // don't even fire the request when we know it'll be rejected).
    const state = readRegenState();
    const nextCount = state.count + 1;
    const required = regenRequiredIntervalMs(nextCount);
    const now = Date.now();
    if (required > 0 && now - state.lastAt < required) {
      const waitMs = required - (now - state.lastAt);
      setThrottledUntil(now + waitMs);
      setThrottleTotalSec(Math.ceil(waitMs / 1000));
      return;
    }
    // Accepted — bump the local counter and fire.
    writeRegenState({ count: nextCount, lastAt: now });
    setSeed(String(now));
  };

  const isEmptyLibrary =
    query.data?.code === "empty_library" ||
    (query.error instanceof DiscoverError &&
      query.error.code === "empty_library");

  // Loader has three states so we can play an exit animation between
  // "fetch finished" and "grid mounted":
  //   active   — fetch in flight, EQ bars pulsing
  //   exiting  — data just arrived, loader bursts outward + fades
  //   hidden   — grid mounts and stagger-fades in
  // The 320ms timer matches the CSS exit duration. The wasFetchingRef
  // gate keeps the burst animation from flashing when localStorage
  // hydrates the query without ever fetching.
  const [loaderState, setLoaderState] = useState<
    "hidden" | "active" | "exiting"
  >("hidden");
  const wasFetchingRef = useRef(false);

  useEffect(() => {
    if (query.isFetching) {
      wasFetchingRef.current = true;
      setLoaderState("active");
      return;
    }
    if (
      wasFetchingRef.current &&
      query.data?.tracks &&
      query.data.tracks.length > 0
    ) {
      wasFetchingRef.current = false;
      setLoaderState("exiting");
      const handle = window.setTimeout(() => setLoaderState("hidden"), 320);
      return () => clearTimeout(handle);
    }
    setLoaderState("hidden");
  }, [query.isFetching, query.data]);

  const showLoader = loaderState !== "hidden";
  const showGrid =
    !showLoader &&
    !!query.data &&
    query.data.tracks &&
    query.data.tracks.length > 0;

  return (
    <Container size="4" px={{ initial: "4", sm: "6" }} py="6" className="page-fade-in">
      <Flex direction="column" gap="6">
        <Flex
          direction={{ initial: "column", sm: "row" }}
          align={{ initial: "stretch", sm: "end" }}
          justify="between"
          gap="3"
        >
          <Box>
            <Heading size="7" weight="bold">
              {t("discover.title")}
            </Heading>
            <Text size="2" color="gray" as="div">
              {t("discover.subtitle")}
            </Text>
          </Box>
          <Button
            size="3"
            variant="soft"
            onClick={onRegenerate}
            disabled={query.isFetching || isThrottled}
          >
            <ReloadIcon />
            {query.isFetching
              ? t("discover.regenerating")
              : isThrottled
                ? t("discover.regenerateWait", {
                    wait: formatWait(throttleRemainingSec),
                  })
                : t("discover.regenerate")}
          </Button>
        </Flex>

        {showLoader && (
          <EqualizerLoader
            state={loaderState === "exiting" ? "exiting" : "active"}
            label={t("discover.loading")}
          />
        )}

        {/* Throttle gets its own dedicated card with the live countdown
          * ring — feels like a deliberate "take a beat" moment instead of
          * a generic error. Renders even without query.isError if the
          * client-side pre-flight throttle fired (no request was sent). */}
        {isThrottled && (
          <ThrottleCard
            remainingSec={throttleRemainingSec}
            totalSec={throttleTotalSec}
            title={t("discover.throttledTitle")}
            body={t("discover.throttledBody")}
          />
        )}

        {query.isError && !isThrottled && (
          <ErrorCard
            title={t("discover.errorTitle")}
            body={(() => {
              const code =
                query.error instanceof DiscoverError
                  ? query.error.code
                  : "upstream_error";
              if (code === "quota_exceeded") return t("mood.errorQuota");
              if (code === "rate_limited") return t("mood.errorRateLimited");
              if (code === "config_error") return t("mood.errorConfig");
              if (code === "empty_library") return t("discover.emptyLibrary");
              return t("discover.error");
            })()}
            detail={
              query.error instanceof DiscoverError
                ? query.error.detail
                : undefined
            }
          />
        )}

        {isEmptyLibrary && !query.isError && !showLoader && (
          <Text color="gray">{t("discover.emptyLibrary")}</Text>
        )}

        {showGrid && (
          <>
            <Grid
              className="discover-grid"
              columns={{ initial: "1", xs: "2", md: "3", lg: "4" }}
              gap={{ initial: "3", md: "4", lg: "5" }}
            >
              {(() => {
                const tracks = query.data!.tracks.map((p) => p.track);
                return tracks.map((track, i) => (
                  <div
                    key={`${track.id}-${i}`}
                    className="discover-card-stagger"
                    style={{ ["--card-index" as string]: i }}
                  >
                    <TrackCard
                      track={track}
                      index={i}
                      queue={tracks}
                      source="mood"
                    />
                  </div>
                ));
              })()}
            </Grid>

            {/* Bottom-of-page regenerate. Mirrors the header button so a
              * user who has scrolled all the way through the picks doesn't
              * have to scroll back up to ask for new ones. Shares the
              * throttle / loading state with the header button. */}
            <Flex justify="center" mt="2">
              <Button
                size="3"
                variant="soft"
                onClick={onRegenerate}
                disabled={query.isFetching || isThrottled}
              >
                <ReloadIcon />
                {query.isFetching
                  ? t("discover.regenerating")
                  : isThrottled
                    ? t("discover.regenerateWait", {
                        wait: formatWait(throttleRemainingSec),
                      })
                    : t("discover.regenerate")}
              </Button>
            </Flex>
          </>
        )}
      </Flex>
    </Container>
  );
}

// Generic error card for non-throttle failures. Same visual language as
// ThrottleCard so the page never flashes between "polished card" and
// "naked red text".
function ErrorCard({
  title,
  body,
  detail,
}: {
  title: string;
  body: string;
  detail?: string;
}) {
  return (
    <Card size="3" className="discover-error-card">
      <Flex direction="column" align="center" gap="3" py="5" px="4">
        <div className="discover-error-icon" aria-hidden>
          <ExclamationTriangleIcon width="28" height="28" />
        </div>
        <Heading size="5" weight="bold">
          {title}
        </Heading>
        <Text size="2" color="gray" align="center" style={{ maxWidth: 420 }}>
          {body}
        </Text>
        {detail && (
          <Text
            size="1"
            color="gray"
            style={{
              fontFamily: "ui-monospace, monospace",
              opacity: 0.7,
            }}
          >
            {detail}
          </Text>
        )}
      </Flex>
    </Card>
  );
}
