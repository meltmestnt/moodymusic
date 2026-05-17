"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Box,
  Dialog,
  Flex,
  Grid,
  Heading,
  IconButton,
  Text,
  VisuallyHidden,
} from "@radix-ui/themes";
import { Cross1Icon } from "@radix-ui/react-icons";
import type { SpotifyTrack } from "@/lib/spotify";
import { useI18n } from "@/lib/i18n";
import { useSimilarSearch } from "@/lib/similar-search-context";
import { useFavorites } from "@/lib/favorites-context";
import { TrackCard } from "./TrackCard";
import { EqualizerLoader } from "./EqualizerLoader";
import { formatWait } from "@/lib/format";

interface DiscoverResponse {
  tracks: { track: SpotifyTrack; reason: string | null }[];
  code?: string;
  error?: string;
}

class SimilarError extends Error {
  constructor(
    public code: string,
    public retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "SimilarError";
  }
}

async function fetchSimilar(
  seed: SpotifyTrack,
  signal?: AbortSignal,
): Promise<DiscoverResponse> {
  const params = new URLSearchParams({
    similar: seed.id,
    title: seed.name,
    artist: seed.artists[0]?.name ?? "",
  });
  const res = await fetch(`/api/discover?${params.toString()}`, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      retryAfterSeconds?: number;
    };
    throw new SimilarError(
      body.code ?? "upstream_error",
      body.retryAfterSeconds,
    );
  }
  return res.json();
}

// Singleton modal mounted at the root layout. Reads `seed` from
// useSimilarSearch() and renders an info-modal-shaped dialog whenever a
// seed is set. Reuses the `track-info-dialog` CSS so the morph + glassy
// overlay match the regular info modal exactly.
export function SimilarSearchModal() {
  const { seed, close } = useSimilarSearch();
  const { t } = useI18n();
  const [hasOpened, setHasOpened] = useState(false);

  useEffect(() => {
    if (seed) setHasOpened(true);
  }, [seed]);

  const open = !!seed;
  const seedId = seed?.id ?? null;

  const query = useQuery<DiscoverResponse, SimilarError>({
    queryKey: ["similar-search", seedId],
    queryFn: ({ signal }) => fetchSimilar(seed!, signal),
    enabled: !!seed,
    staleTime: 10 * 60_000,
    retry: false,
    meta: { suppressToast: true },
  });

  // Cancel the in-flight request when the user closes the modal — no
  // point waiting for OpenAI to deliver picks the user will never see.
  // We track the previous seedId so we know which query key to cancel
  // (cancelling all "similar-search" queries also works but is broader
  // than necessary).
  const queryClient = useQueryClient();
  const prevSeedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevSeedIdRef.current && !seedId) {
      queryClient.cancelQueries({
        queryKey: ["similar-search", prevSeedIdRef.current],
      });
    }
    prevSeedIdRef.current = seedId;
  }, [seedId, queryClient]);

  const { hydrate } = useFavorites();
  useEffect(() => {
    const tracks = query.data?.tracks;
    if (!tracks || tracks.length === 0) return;
    hydrate(tracks.map(({ track }) => track.id));
  }, [query.data, hydrate]);

  if (!hasOpened) return null;

  const tracks = query.data?.tracks?.map((p) => p.track) ?? [];

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <Dialog.Content
        className="track-info-dialog"
        size="4"
        maxWidth="1100px"
        // Claim the same view-transition-name as the originating card so
        // the browser interpolates the bounding box during the morph.
        style={
          {
            viewTransitionName: seed ? `track-card-${seed.id}` : undefined,
          } as React.CSSProperties
        }
      >
        {/* Hidden Dialog.Title satisfies Radix's a11y requirement; the
          * visible heading inside the body block is the actual title users
          * read. */}
        <VisuallyHidden>
          <Dialog.Title>
            {seed
              ? t("discover.similarTitle", { name: seed.name })
              : t("trackInfo.openTitle")}
          </Dialog.Title>
        </VisuallyHidden>
        {seed ? (
          <Flex direction="column" gap="5" className="track-info-content">
            <Flex justify="between" align="center" gap="3">
              <Box style={{ flex: "1 1 0", minWidth: 0 }}>
                <Heading
                  size={{ initial: "5", sm: "6" }}
                  weight="bold"
                  style={{ letterSpacing: "-0.02em" }}
                >
                  {t("discover.similarTitle", { name: seed.name })}
                </Heading>
                <Text size="2" color="gray" as="div">
                  {t("discover.similarSubtitle", {
                    name: seed.name,
                    artist: seed.artists[0]?.name ?? "",
                  })}
                </Text>
              </Box>
              <IconButton
                variant="ghost"
                color="gray"
                onClick={close}
                aria-label={t("trackInfo.close")}
              >
                <Cross1Icon />
              </IconButton>
            </Flex>

            {query.isFetching && (
              <EqualizerLoader
                state="active"
                label={t("discover.similarLoading", { name: seed.name })}
              />
            )}

            {query.isError && (
              <Text size="2" color="red">
                {(() => {
                  const code = query.error?.code ?? "upstream_error";
                  if (code === "throttled") {
                    const sec = query.error?.retryAfterSeconds ?? 0;
                    return t("discover.regenerateWait", {
                      wait: formatWait(sec),
                    });
                  }
                  if (code === "quota_exceeded") return t("mood.errorQuota");
                  if (code === "rate_limited")
                    return t("mood.errorRateLimited");
                  if (code === "config_error") return t("mood.errorConfig");
                  return t("discover.error");
                })()}
              </Text>
            )}

            {!query.isFetching && tracks.length > 0 && (
              <Grid
                columns={{ initial: "1", xs: "2", md: "3", lg: "4" }}
                gap={{ initial: "3", md: "4" }}
              >
                {tracks.map((track, i) => (
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
                ))}
              </Grid>
            )}

            {!query.isFetching &&
              !query.isError &&
              query.data &&
              tracks.length === 0 && (
                <Text size="2" color="gray">
                  {t("discover.similarNoResults")}
                </Text>
              )}
          </Flex>
        ) : null}
      </Dialog.Content>
    </Dialog.Root>
  );
}
