"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Box,
  Button,
  Container,
  Flex,
  Grid,
  Heading,
  Spinner,
  Text,
  TextField,
} from "@radix-ui/themes";
import { LightningBoltIcon, MagnifyingGlassIcon } from "@radix-ui/react-icons";
import type { SavedTrack, SpotifyPaging, SpotifyTrack } from "@/lib/spotify";
import { TrackCard } from "@/components/TrackCard";
import { EqualizerLoader } from "@/components/EqualizerLoader";
import { useI18n } from "@/lib/i18n";
import { useFavorites } from "@/lib/favorites-context";

const PAGE_SIZE = 50;

async function fetchPage(offset: number): Promise<SpotifyPaging<SavedTrack>> {
  const res = await fetch(`/api/library?offset=${offset}&limit=${PAGE_SIZE}`);
  if (!res.ok) throw Object.assign(new Error("library fetch failed"), { status: res.status });
  return res.json();
}

export default function LibraryPage() {
  const { status } = useSession();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const { t } = useI18n();
  // Loader state mirrors the /discover pattern: active while the first page
  // is in flight, exiting for the burst-out animation, hidden once the grid
  // takes over. Subsequent infinite-scroll page loads don't re-trigger this
  // — the gate is `query.isLoading` (true only when there's no data yet).
  const [loaderState, setLoaderState] = useState<
    "hidden" | "active" | "exiting"
  >("hidden");
  const wasFetchingRef = useRef(false);

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/");
  }, [status, router]);

  const query = useInfiniteQuery({
    queryKey: ["library"],
    enabled: status === "authenticated",
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchPage(pageParam as number),
    getNextPageParam: (last) =>
      last.next ? last.offset + last.limit : undefined,
  });

  const allTracks: SpotifyTrack[] = useMemo(
    () =>
      query.data?.pages.flatMap((p) => p.items.map((i) => i.track)) ?? [],
    [query.data],
  );

  // Every track served by /me/tracks is by definition saved — tell the
  // favorites store so its hearts render filled without an extra round-trip.
  // We destructure markSaved (a stable useCallback) instead of depending on
  // the whole favorites context value: that value reference changes after
  // every toggle, which would otherwise re-run this effect and clobber an
  // unfavourite the user just performed.
  const { markSaved } = useFavorites();
  useEffect(() => {
    if (allTracks.length === 0) return;
    markSaved(allTracks.map((t) => t.id));
  }, [allTracks, markSaved]);

  // Auto-fetch the next page when the bottom sentinel actually enters the
  // viewport. Two guards against firing page 2 on initial load (when the
  // user hasn't asked for more):
  //   1. We only attach the observer after the user has scrolled — until
  //      then there's no reason to assume they want the next page.
  //   2. rootMargin is 0, so the sentinel must truly be in view.
  // Tanstack Query already dedupes concurrent fetches, so an accidental
  // double-trigger from a fast scroll is a no-op.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const fetchNextRef = useRef(query.fetchNextPage);
  fetchNextRef.current = query.fetchNextPage;
  const [hasScrolled, setHasScrolled] = useState(false);
  useEffect(() => {
    if (hasScrolled) return;
    const onScroll = () => {
      if (window.scrollY > 0) setHasScrolled(true);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [hasScrolled]);
  useEffect(() => {
    if (!query.hasNextPage || !hasScrolled) return;
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void fetchNextRef.current();
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [query.hasNextPage, hasScrolled]);

  // Eager-fetch-while-searching. The default infinite-scroll only
  // loads the next page when the bottom sentinel scrolls into view —
  // fine for browsing, but fatal for client-side search: a user who
  // types "lil peep" with only 50 tracks loaded would see whatever
  // matches are in those first 50 and miss the rest of their library.
  // While `search` is non-empty we cascade through pages without
  // waiting for the user to scroll, until hasNextPage flips to false.
  // We pass the search input through a ref-tracked flag so the
  // cascade halts immediately when the user clears the box.
  const searchActive = search.trim().length > 0;
  useEffect(() => {
    if (!searchActive) return;
    if (!query.hasNextPage) return;
    if (query.isFetching) return;
    void fetchNextRef.current();
  }, [searchActive, query.hasNextPage, query.isFetching, query.data]);

  useEffect(() => {
    if (query.isLoading) {
      wasFetchingRef.current = true;
      setLoaderState("active");
      return;
    }
    if (wasFetchingRef.current && allTracks.length > 0) {
      wasFetchingRef.current = false;
      setLoaderState("exiting");
      const handle = window.setTimeout(() => setLoaderState("hidden"), 320);
      return () => clearTimeout(handle);
    }
    setLoaderState("hidden");
  }, [query.isLoading, allTracks.length]);

  const showLoader = loaderState !== "hidden";

  // Client-side filter on whatever pages we've already loaded. The Spotify
  // saved-tracks endpoint has no server-side `q=` parameter, so for now
  // search means "narrow what's already on screen". Scrolling to load more
  // pages widens the searchable set.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allTracks;
    return allTracks.filter((t) => {
      if (t.name.toLowerCase().includes(q)) return true;
      return t.artists.some((a) => a.name.toLowerCase().includes(q));
    });
  }, [allTracks, search]);

  return (
    <Container size="4" px={{ initial: "4", sm: "6" }} py="6" className="page-fade-in">
      <Flex direction="column" gap="5">
        <Flex
          direction={{ initial: "column", lg: "row" }}
          align={{ initial: "stretch", lg: "end" }}
          justify="between"
          gap="3"
        >
          <Box style={{ minWidth: 0 }}>
            <Heading size="7" weight="bold">
              {t("library.title")}
            </Heading>
            <Text size="2" color="gray" as="p" style={{ margin: 0 }}>
              {t("library.subtitle")}
            </Text>
          </Box>
          <Flex
            gap="3"
            align="center"
            justify={{ initial: "start", lg: "end" }}
            wrap={{ initial: "wrap", sm: "nowrap" }}
            // flex 1 1 auto lets this side absorb all the leftover row
            // width on lg+. Without this it stayed shrink-only and the
            // search box could never get wider than its own basis,
            // clipping long placeholders like the Ukrainian
            // "Пошук за назвою чи виконавцем".
            style={{ flex: "1 1 auto", minWidth: 0 }}
          >
            <Button
              size="3"
              variant="soft"
              aria-label={t("library.discoverCta")}
              onClick={() => router.push("/discover")}
              style={{ flexShrink: 0 }}
            >
              <LightningBoltIcon />
              {t("library.discoverCta")}
            </Button>
            <Box style={{ flex: "1 1 420px", minWidth: 280 }}>
              <TextField.Root
                size="3"
                placeholder={t("library.searchPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              >
                <TextField.Slot>
                  <MagnifyingGlassIcon />
                </TextField.Slot>
              </TextField.Root>
            </Box>
          </Flex>
        </Flex>

        {showLoader && (
          <EqualizerLoader
            state={loaderState === "exiting" ? "exiting" : "active"}
            label={t("library.loading")}
          />
        )}
        {query.isError && (
          <Text color="red">
            {(query.error as Error)?.message ?? t("library.error")}
          </Text>
        )}

        {!showLoader && visible.length > 0 && (
          <Grid
            columns={{ initial: "1", xs: "2", md: "3", lg: "4" }}
            gap={{ initial: "3", md: "4", lg: "5" }}
          >
            {visible.map((track, i) => {
              // Stagger only the first batch (first page = 50). Later
              // infinite-scroll cards mount immediately with no per-card
              // delay so the user isn't waiting on a wave to clear.
              const stagger = i < 24;
              return (
                <div
                  key={`${track.id}-${i}`}
                  className={stagger ? "discover-card-stagger" : undefined}
                  style={
                    stagger
                      ? ({ ["--card-index" as string]: i } as React.CSSProperties)
                      : undefined
                  }
                >
                  <TrackCard
                    track={track}
                    index={i % 24}
                    queue={visible}
                    source="library"
                  />
                </div>
              );
            })}
          </Grid>
        )}

        {search && visible.length === 0 && allTracks.length > 0 && (
          <Text color="gray">
            {t("library.searchNoMatch", { q: search })}
          </Text>
        )}

        {query.hasNextPage && (
          <div
            ref={sentinelRef}
            aria-hidden
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              minHeight: 80,
              padding: "16px 0 24px",
            }}
          >
            <Spinner size="3" />
          </div>
        )}

        {!showLoader && allTracks.length === 0 && !query.isError && (
          <Text color="gray">{t("library.empty")}</Text>
        )}
      </Flex>
    </Container>
  );
}
