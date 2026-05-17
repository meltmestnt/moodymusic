"use client";

import { Box, Flex, IconButton, Text, Tooltip } from "@radix-ui/themes";
import { InfoCircledIcon, MagicWandIcon } from "@radix-ui/react-icons";
import type { MouseEvent } from "react";
import { useSession } from "next-auth/react";
// MouseEvent re-typed inline below where needed to satisfy DOM target.
import type { SpotifyTrack } from "@/lib/spotify";
import { usePlayer } from "@/lib/player-context";
import { useI18n } from "@/lib/i18n";
import { originFromClick, useTrackInfo } from "@/lib/track-info-context";
import { useSimilarSearch } from "@/lib/similar-search-context";
import { Equalizer } from "./Equalizer";
import { FavoriteButton } from "./FavoriteButton";

interface Props {
  track: SpotifyTrack;
  index?: number;
  // The full visible list this card belongs to. When the user clicks play,
  // we hand the queue (starting at this track) to the player so the next
  // tracks auto-advance — Spotify queues them for Premium, and the preview
  // <audio>'s "ended" event walks the list for Free.
  queue?: SpotifyTrack[];
  // Where this card lives ("library" or "mood"). Recorded as the play
  // event's source on the server so we can analyse where users discover
  // music. Defaults to "unknown" if a parent doesn't pass it.
  source?: "library" | "mood";
}

// Inline icons sized + positioned so the path's centroid sits exactly at the
// viewBox centre (12,12). Radix's PlayIcon path is left-of-centre inside its
// own viewBox, which makes the triangle look offset inside our rainbow chip
// even with a margin-based optical correction — so we draw our own.
function PlaySvg() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M9 6 L18 12 L9 18 Z" />
    </svg>
  );
}

function PauseSvg() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="8" y="6" width="3" height="12" rx="1" />
      <rect x="13" y="6" width="3" height="12" rx="1" />
    </svg>
  );
}

export function TrackCard({ track, index = 0, queue, source }: Props) {
  const player = usePlayer();
  const { t } = useI18n();
  const trackInfo = useTrackInfo();
  const similarSearch = useSimilarSearch();
  const { status } = useSession();
  // AI-driven "find similar" hits /api/discover which 401s for anon users
  // — hide the wand button rather than dangle a broken affordance.
  const isAuthenticated = status === "authenticated";
  const isCurrent = player.current?.id === track.id;
  const isPlayingThis = isCurrent && player.isPlaying;
  const showEq = isPlayingThis;
  const playable = player.isPlayable(track);

  const art = track.album.images[0]?.url;
  const artistNames = track.artists.map((a) => a.name).join(", ");

  // View-transition glue. The whole card-wrap carries a unique
  // view-transition-name when this card is the active morph origin,
  // so the browser interpolates the card's bounding box into the
  // modal's. The originator drops its name when the modal claims it,
  // so the post-snapshot has exactly one named element on the new side.
  // Two modals can morph from a card — info or similar-search — and only
  // one can be open at a time, so the OR-pattern handles both.
  const isInfoOrigin =
    trackInfo.originatingId === track.id &&
    trackInfo.originatingSource === "card";
  const isSimilarOrigin =
    similarSearch.originatingId === track.id &&
    similarSearch.originatingSource === "card";
  const isActiveOrigin = isInfoOrigin || isSimilarOrigin;
  const isInModal =
    trackInfo.selected?.id === track.id ||
    similarSearch.seed?.id === track.id;
  const cardVtName =
    isActiveOrigin && !isInModal ? `track-card-${track.id}` : undefined;

  // Click on a card that's the active track → toggle (pause/resume) instead
  // of restarting from the start. Otherwise → start playback for this track.
  const onClick = () => {
    if (!playable) return;
    if (isCurrent) void player.toggle();
    else void player.play(track, queue, source);
  };

  // The favorite button can't be a descendant of the play <button> (nested
  // <button> is invalid HTML). We render them as siblings inside a relative
  // wrapper, with the heart absolutely positioned in the top-right corner.
  const card = (
    <div
      className="track-card-wrap stagger-item"
      data-playing={isCurrent || undefined}
      data-playable={playable || undefined}
      data-vt-active={isActiveOrigin || undefined}
      style={{
        ["--card-index" as string]: index,
        viewTransitionName: cardVtName,
      }}
    >
      <button
        type="button"
        className="track-card"
        data-playing={isCurrent || undefined}
        onClick={onClick}
        disabled={!playable}
        style={{
          opacity: playable ? 1 : 0.55,
          textAlign: "left",
          appearance: "none",
          font: "inherit",
          color: "inherit",
          width: "100%",
          background: "transparent",
          border: 0,
          padding: 0,
        }}
        aria-label={t("track.playAria", { name: track.name, artists: artistNames })}
      >
        <Box className="track-art-wrap">
          <Box className="track-art">
            {art ? (
              // Native lazy-loading: the browser defers fetching until
              // the image is near the viewport, and decoding="async"
              // pushes the JPEG decode off the main thread. Combined
              // with `content-visibility: auto` on .track-card-wrap,
              // this is a no-library substitute for grid virtualization.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={art} alt="" loading="lazy" decoding="async" />
            ) : null}
          </Box>
          <Box className="track-play-hint" aria-hidden="true">
            {isPlayingThis ? <PauseSvg /> : <PlaySvg />}
          </Box>
          {showEq && <Equalizer />}
        </Box>
        <Flex direction="column" className="track-meta" gap="1">
          <Text className="track-title" title={track.name}>
            {track.name}
          </Text>
          <Text className="track-artist" title={artistNames}>
            {artistNames}
          </Text>
        </Flex>
      </button>
      {status === "authenticated" && (
        <div className="track-card-favorite">
          <FavoriteButton
            trackId={track.id}
            trackName={track.name}
            size="2"
            variant="soft"
            stopPropagation
          />
        </div>
      )}
      <div className="track-card-info">
        <IconButton
          type="button"
          size="2"
          variant="soft"
          radius="full"
          color="gray"
          className="track-card-info-btn"
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            e.preventDefault();
            trackInfo.open(track, "card", originFromClick(e));
          }}
          aria-label={t("trackInfo.open", { name: track.name })}
          title={t("trackInfo.openTitle")}
        >
          <InfoCircledIcon />
        </IconButton>
      </div>
      {isAuthenticated && (
        <div className="track-card-similar">
          <IconButton
            type="button"
            size="2"
            variant="soft"
            radius="full"
            color="gray"
            className="track-card-info-btn"
            onClick={(e: MouseEvent<HTMLButtonElement>) => {
              e.stopPropagation();
              e.preventDefault();
              similarSearch.open(track, "card", originFromClick(e));
            }}
            aria-label={t("track.findSimilarAria", { name: track.name })}
            title={t("track.findSimilar")}
          >
            <MagicWandIcon />
          </IconButton>
        </div>
      )}
    </div>
  );

  if (playable) return card;
  return <Tooltip content={t("track.noPreview")}>{card}</Tooltip>;
}
