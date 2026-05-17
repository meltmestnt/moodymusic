"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconButton, Box, Flex, Text } from "@radix-ui/themes";
import { Cross1Icon, TrashIcon } from "@radix-ui/react-icons";
import { useI18n } from "@/lib/i18n";

// Swipe threshold as a fraction of the row width. Lower = easier to delete
// by accident; higher = users have to drag almost off-screen. 40% is the
// sweet spot most touch UIs settle on (Mail, Twitter etc).
const SWIPE_COMMIT_FRACTION = 0.4;
// How far the pointer has to move before we consider it a drag (vs a click
// that we should pass through to the navigation handler).
const DRAG_HYSTERESIS_PX = 6;
// Resistance applied to leftward drags so the row doesn't lurch with a
// stray jiggle but still has a tiny bit of give if the user crosses 0.
const LEFTWARD_RESISTANCE = 6;

interface TrackPreview {
  id: string;
  name: string;
  artists: string[];
}

export interface RecentSearchRowProps {
  id: string;
  mood: string;
  createdAt: string;
  resolvedCount: number;
  trackPreview: TrackPreview[];
  rowIndex: number;
  formatRelative: (iso: string) => string;
  onDelete: (id: string) => void;
}

export function RecentSearchRow({
  id,
  mood,
  createdAt,
  resolvedCount,
  trackPreview,
  rowIndex,
  formatRelative,
  onDelete,
}: RecentSearchRowProps) {
  const router = useRouter();
  const { t } = useI18n();

  // Active drag offset (px). Positive = swiped right.
  const [dx, setDx] = useState(0);
  // True while the row is animating off-screen on commit. Locks the
  // pointer handlers so a second drag mid-flight can't resurrect the row.
  const [committing, setCommitting] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const movedRef = useRef(false);
  const widthRef = useRef(0);

  const reset = () => {
    setDx(0);
    draggingRef.current = false;
    movedRef.current = false;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (committing) return;
    // Mouse: only the primary button. Touch/pen: always.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    draggingRef.current = true;
    startXRef.current = e.clientX;
    movedRef.current = false;
    widthRef.current = rootRef.current?.offsetWidth ?? 0;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const raw = e.clientX - startXRef.current;
    if (Math.abs(raw) > DRAG_HYSTERESIS_PX) {
      movedRef.current = true;
      // Suppress text selection / native scroll once we know it's a drag.
      e.preventDefault();
    }
    // Allow a tiny bit of leftward travel for elasticity, but no real
    // negative offset — left-swipe means nothing here.
    const next = raw < 0 ? raw / LEFTWARD_RESISTANCE : raw;
    setDx(next);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    draggingRef.current = false;

    const width = widthRef.current || 200;
    const committed = dx > width * SWIPE_COMMIT_FRACTION;

    if (committed) {
      // Slide off to the right, then call onDelete (parent removes from
      // the list and fires the API).
      setCommitting(true);
      setDx(width + 80);
      // Match the CSS transition duration on .stats-recent-row.
      window.setTimeout(() => onDelete(id), 260);
      return;
    }

    if (movedRef.current) {
      // Drag that didn't reach the threshold — animate back to 0.
      setDx(0);
    } else {
      // Treated as a tap/click — navigate. The mood page reads ?q= and
      // auto-fires the search.
      reset();
      router.push(`/mood?id=${encodeURIComponent(id)}`);
    }
  };

  const onPointerCancel = () => {
    draggingRef.current = false;
    setDx(0);
  };

  // Manual delete via the icon button — bypasses the swipe path, fires the
  // same animation. stopPropagation so the parent click handler / drag
  // handler don't see this as a tap-to-navigate.
  const onDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (committing) return;
    setCommitting(true);
    setDx((rootRef.current?.offsetWidth ?? 200) + 80);
    window.setTimeout(() => onDelete(id), 260);
  };

  // The "delete" trail visible BEHIND the row as it slides right.
  const trailOpacity = Math.min(1, Math.max(0, dx / 60));

  return (
    <div
      className="stats-recent-row-shell"
      data-committing={committing || undefined}
    >
      <div
        className="stats-recent-row-trail"
        aria-hidden
        style={{ opacity: trailOpacity }}
      >
        <TrashIcon width="18" height="18" />
      </div>

      <div
        ref={rootRef}
        className="stats-recent-row"
        role="button"
        tabIndex={0}
        style={{
          ["--row-index" as string]: rowIndex,
          transform: `translateX(${dx}px)`,
          // Disable the slide-back transition during active drag — only
          // when the drag ends (dx goes from N → 0) or the row commits.
          transition: draggingRef.current
            ? "none"
            : "transform 260ms cubic-bezier(0.2, 0.7, 0.2, 1), border-color 140ms ease, background 140ms ease",
        }}
        aria-label={t("stats.recentRowAria", { mood })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            router.push(`/mood?id=${encodeURIComponent(id)}`);
          }
          if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            onDeleteClick(e as unknown as React.MouseEvent);
          }
        }}
      >
        <Flex justify="between" align="center" gap="3" wrap="wrap">
          <Box style={{ minWidth: 0, flex: "1 1 auto" }}>
            <Text size="2" weight="bold" as="div" truncate>
              {mood}
            </Text>
            <Text size="1" color="gray" as="div" truncate>
              {trackPreview
                .map((tp) => `${tp.name} — ${tp.artists[0] ?? "?"}`)
                .join(" · ")}
            </Text>
          </Box>
          <Flex
            gap="3"
            align="center"
            style={{ flex: "0 0 auto", whiteSpace: "nowrap" }}
          >
            <Text size="1" color="gray">
              {resolvedCount} {t("stats.tracksLabel")}
            </Text>
            <Text size="1" color="gray">
              {formatRelative(createdAt)}
            </Text>
            <IconButton
              size="1"
              variant="ghost"
              color="gray"
              className="stats-recent-delete"
              onClick={onDeleteClick}
              onPointerDown={(e) => e.stopPropagation()}
              aria-label={t("stats.recentDeleteAria", { mood })}
              title={t("stats.recentDeleteTooltip")}
            >
              <Cross1Icon />
            </IconButton>
          </Flex>
        </Flex>
      </div>
    </div>
  );
}
