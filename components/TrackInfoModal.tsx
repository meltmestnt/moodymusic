"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
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
import { useTrackInfo } from "@/lib/track-info-context";
import { usePlayer } from "@/lib/player-context";
import { FavoriteButton } from "./FavoriteButton";

interface TrackInfoResponse {
  track: SpotifyTrack;
  similar: SpotifyTrack[];
}

async function fetchTrackInfo(id: string): Promise<TrackInfoResponse> {
  const res = await fetch(`/api/track-info?id=${encodeURIComponent(id)}`);
  if (!res.ok) {
    throw new Error(`track-info failed (${res.status})`);
  }
  return res.json();
}

// Singleton modal mounted at the root layout. Reads `selected` from
// useTrackInfo() and renders a fullscreen-ish dialog whenever a track is
// selected. Fetches richer detail (full album metadata + artist's top
// tracks) on open.
export function TrackInfoModal() {
  const { selected, origin, close } = useTrackInfo();
  const { t } = useI18n();
  const player = usePlayer();
  const { status } = useSession();
  const [hasOpened, setHasOpened] = useState(false);

  useEffect(() => {
    if (selected) setHasOpened(true);
  }, [selected]);

  const open = !!selected;
  const trackId = selected?.id ?? null;

  // Anon users hit /api/track-info → 401 (the route reads the session for
  // the upstream music-service token). The base track passed via `selected`
  // already has enough metadata to render the modal; we just skip the
  // enrichment fetch and the "similar tracks" rail rather than showing a
  // red error banner for an expected unauthenticated state.
  const enrichEnabled = !!trackId && status === "authenticated";

  const query = useQuery<TrackInfoResponse, Error>({
    queryKey: ["track-info", trackId],
    queryFn: () => fetchTrackInfo(trackId!),
    enabled: enrichEnabled,
    staleTime: 5 * 60_000, // 5 minutes — track metadata doesn't change much
    retry: 1,
    meta: { suppressToast: true },
  });

  // Always render the dialog after first open so its exit animation can
  // play. Before first open, save the cycles.
  if (!hasOpened) return null;

  // Fall back to the bare track passed in if the detail fetch hasn't
  // landed yet — the user gets art + title + artists immediately, the
  // album release date and similar songs fade in when ready.
  const track = query.data?.track ?? selected;
  const similar = query.data?.similar ?? [];

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
        maxWidth="900px"
        // The modal claims the same view-transition-name as the
        // originating element (which drops its own name when
        // `selected` is set). The browser interpolates the bounding
        // box between the two — the card visually expands into the
        // popup. Gated on `selected` so the name vanishes the moment
        // the close transition flips selected to null.
        style={
          {
            viewTransitionName: selected
              ? `track-card-${selected.id}`
              : undefined,
          } as React.CSSProperties
        }
      >
        {/* Hidden Dialog.Title satisfies the Radix a11y requirement
          * without changing the visible layout — the visible h-tag
          * inside the body block is the actual heading users see. */}
        <VisuallyHidden>
          <Dialog.Title>
            {track ? track.name : t("trackInfo.openTitle")}
          </Dialog.Title>
        </VisuallyHidden>
        {track ? (
          <Flex direction="column" gap="5" className="track-info-content">
            <Flex justify="end">
              <IconButton
                variant="ghost"
                color="gray"
                onClick={close}
                aria-label={t("trackInfo.close")}
              >
                <Cross1Icon />
              </IconButton>
            </Flex>

            <Flex
              direction={{ initial: "column", sm: "row" }}
              gap="5"
              align={{ initial: "stretch", sm: "start" }}
            >
              <Box className="track-info-art" flexShrink="0">
                {track.album.images[0]?.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={track.album.images[0].url}
                    alt={track.album.name}
                  />
                ) : null}
              </Box>

              <Flex direction="column" gap="3" flexGrow="1" minWidth="0">
                <Box>
                  <Text size="1" color="gray" as="div">
                    {track.album.album_type
                      ? t(`trackInfo.type.${track.album.album_type}`)
                      : t("trackInfo.type.album")}
                  </Text>
                  <Heading
                    size={{ initial: "6", sm: "8" }}
                    weight="bold"
                    style={{ letterSpacing: "-0.02em" }}
                  >
                    {track.name}
                  </Heading>
                </Box>

                <Text size="3" color="gray">
                  {track.artists.map((a) => a.name).join(", ")}
                </Text>

                <Flex
                  gap="3"
                  wrap="wrap"
                  align="center"
                  className="track-info-meta"
                >
                  <Text size="2" color="gray">
                    {track.album.name}
                  </Text>
                  {track.album.release_date && (
                    <Text size="2" color="gray">
                      ·{" "}
                      {new Date(track.album.release_date).getFullYear() ||
                        track.album.release_date}
                    </Text>
                  )}
                  <Text size="2" color="gray">
                    · {formatDuration(track.duration_ms)}
                  </Text>
                </Flex>

                {(() => {
                  const albumType = track.album.album_type ?? "album";
                  const parts: string[] = [
                    t(`trackInfo.type.${albumType}`),
                  ];
                  if (track.track_number && track.album.total_tracks) {
                    parts.push(
                      t("trackInfo.trackOfTotal", {
                        n: String(track.track_number),
                        total: String(track.album.total_tracks),
                      }),
                    );
                  }
                  if (track.album.release_date) {
                    const year =
                      new Date(track.album.release_date).getFullYear() ||
                      track.album.release_date;
                    parts.push(String(year));
                  }
                  if (track.album.label) parts.push(track.album.label);
                  return (
                    <Text
                      size="2"
                      color="gray"
                      className="track-info-description"
                    >
                      {parts.join(" · ")}
                    </Text>
                  );
                })()}

                <Flex gap="3" wrap="wrap" mt="2">
                  <PlayBtn track={track} player={player} />
                  {status === "authenticated" && (
                    <FavoriteButton
                      trackId={track.id}
                      trackName={track.name}
                      size="3"
                      variant="soft"
                    />
                  )}
                </Flex>
              </Flex>
            </Flex>

            {/* Similar tracks expand-on-arrive. The wrap is always rendered
             * so the grid-template-rows trick can animate from 0fr → 1fr
             * once the data lands. data-loaded toggles based on whether
             * the request has settled with at least one similar track. */}
            <div
              className="track-info-similar-wrap"
              data-loaded={similar.length > 0 ? "true" : undefined}
              aria-hidden={similar.length === 0 || undefined}
            >
              <div className="track-info-similar-inner">
                {similar.length > 0 && (
                  <Box className="track-info-similar">
                    <Heading size="4" mb="3">
                      {t("trackInfo.similar")}
                    </Heading>
                    {/* No inner ScrollArea — the similar list flows into the
                      * modal's own vertical scroll so the user scrolls once,
                      * not a nested scroll-inside-scroll. */}
                    <Grid columns={{ initial: "1", sm: "2" }} gap="2">
                      {similar.map((s, i) => (
                        <SimilarTrackRow
                          key={s.id}
                          track={s}
                          player={player}
                          index={i}
                        />
                      ))}
                    </Grid>
                  </Box>
                )}
              </div>
            </div>

            {query.isError && (
              <Text size="2" color="red">
                {t("trackInfo.errorDetails")}
              </Text>
            )}
          </Flex>
        ) : null}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function PlayBtn({
  track,
  player,
}: {
  track: SpotifyTrack;
  player: ReturnType<typeof usePlayer>;
}) {
  const { t } = useI18n();
  const isCurrent = player.current?.id === track.id;
  const isPlaying = isCurrent && player.isPlaying;
  const playable = player.isPlayable(track);
  const onClick = () => {
    if (!playable) return;
    if (isCurrent) void player.toggle();
    else void player.play(track, [track]);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!playable}
      className="track-info-play-btn"
    >
      {isPlaying ? t("nowPlaying.pause") : t("trackInfo.play")}
    </button>
  );
}

function SimilarTrackRow({
  track,
  player,
  index,
}: {
  track: SpotifyTrack;
  player: ReturnType<typeof usePlayer>;
  index: number;
}) {
  const playable = player.isPlayable(track);
  const isCurrent = player.current?.id === track.id;
  const art = track.album.images[track.album.images.length - 1]?.url;
  const onClick = () => {
    if (!playable) return;
    if (isCurrent) void player.toggle();
    else void player.play(track, [track]);
  };
  return (
    <button
      type="button"
      className="track-info-similar-row"
      data-playing={isCurrent || undefined}
      onClick={onClick}
      disabled={!playable}
      style={{ ["--row-index" as string]: index }}
    >
      <Box className="track-info-similar-art">
        {art ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={art} alt="" />
        ) : null}
      </Box>
      <Box minWidth="0" style={{ textAlign: "left", flex: "1 1 0" }}>
        <Text as="div" size="2" weight="medium" truncate>
          {track.name}
        </Text>
        <Text as="div" size="1" color="gray" truncate>
          {track.artists.map((a) => a.name).join(", ")}
        </Text>
      </Box>
    </button>
  );
}

function formatDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
