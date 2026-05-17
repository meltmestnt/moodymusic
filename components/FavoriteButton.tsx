"use client";

import { useEffect, type MouseEvent } from "react";
import { IconButton } from "@radix-ui/themes";
import { HeartFilledIcon, HeartIcon } from "@radix-ui/react-icons";
import { useFavorites } from "@/lib/favorites-context";
import { useI18n } from "@/lib/i18n";

interface Props {
  trackId: string;
  trackName: string;
  size?: "1" | "2" | "3";
  variant?: "ghost" | "soft";
  // When the button sits on a clickable parent (TrackCard fires play on
  // click), set true so the heart click doesn't bubble up.
  stopPropagation?: boolean;
}

export function FavoriteButton({
  trackId,
  trackName,
  size = "2",
  variant = "ghost",
  stopPropagation,
}: Props) {
  const { isFavorite, isPending, toggle, hydrate } = useFavorites();
  const { t } = useI18n();
  const isFav = isFavorite(trackId);
  const pending = isPending(trackId);

  // Self-hydrate. Without this, the now-playing footer's heart stays
  // empty for any track that wasn't already in the favorites store —
  // e.g. when a library track auto-advances to one that lives on a
  // not-yet-loaded library page. hydrate() dedupes against ids it has
  // already requested, so calling on every FavoriteButton instance still
  // results in a single batched /me/tracks/contains call per unknown id.
  useEffect(() => {
    hydrate([trackId]);
  }, [trackId, hydrate]);

  const onClick = (e: MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    e.preventDefault();
    void toggle(trackId);
  };

  return (
    <IconButton
      type="button"
      size={size}
      variant={variant}
      radius="full"
      color={isFav ? undefined : "gray"}
      onClick={onClick}
      disabled={pending}
      aria-pressed={isFav}
      aria-label={t("favorite.aria", { name: trackName })}
      title={isFav ? t("favorite.remove") : t("favorite.add")}
      className="favorite-btn"
      data-active={isFav || undefined}
    >
      {isFav ? <HeartFilledIcon /> : <HeartIcon />}
    </IconButton>
  );
}
