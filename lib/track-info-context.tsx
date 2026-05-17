"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { flushSync } from "react-dom";
import type { SpotifyTrack } from "@/lib/spotify";

export interface OriginPoint {
  /** Viewport-relative x-coordinate (px) where the morph should start
   *  expanding from / collapsing back to. */
  x: number;
  y: number;
}

/** Where the morph originated. The same track can show in three places
 *  at once (a card in the grid, the footer's art, the footer's title);
 *  combined with originatingId, exactly ONE element on the page may
 *  carry view-transition-name at a time. */
export type TrackInfoOrigin = "card" | "footer-text" | "footer-art";

interface TrackInfoContextValue {
  selected: SpotifyTrack | null;
  originatingId: string | null;
  originatingSource: TrackInfoOrigin | null;
  /** Click point — drives the post-VT circular clip expansion. */
  origin: OriginPoint | null;
  open: (
    track: SpotifyTrack,
    source?: TrackInfoOrigin,
    origin?: OriginPoint,
  ) => void;
  close: () => void;
}

const Ctx = createContext<TrackInfoContextValue | null>(null);

type ViewTransition = { finished: Promise<void> };
type DocumentWithVT = Document & {
  startViewTransition?: (cb: () => void) => ViewTransition;
};
function getDocVT(): DocumentWithVT | null {
  if (typeof document === "undefined") return null;
  const doc = document as DocumentWithVT;
  if (typeof doc.startViewTransition !== "function") return null;
  return doc;
}

// Singleton state for the "track info" modal. The modal opens via a
// View Transitions morph FROM the originating element (card / footer
// art / footer title) into the centered modal — both endpoints are
// rendered as circles so the morph itself is a circular shape. After
// the VT settles, a follow-up clip-path animation expands the modal
// from a small circle to fullscreen, anchored at the click point.
export function TrackInfoProvider({ children }: { children: React.ReactNode }) {
  const [selected, setSelected] = useState<SpotifyTrack | null>(null);
  const [originatingId, setOriginatingId] = useState<string | null>(null);
  const [originatingSource, setOriginatingSource] =
    useState<TrackInfoOrigin | null>(null);
  const [origin, setOrigin] = useState<OriginPoint | null>(null);

  const open = useCallback(
    (
      track: SpotifyTrack,
      source: TrackInfoOrigin = "card",
      originPoint?: OriginPoint,
    ) => {
      const doc = getDocVT();
      if (!doc) {
        setOriginatingId(track.id);
        setOriginatingSource(source);
        setOrigin(originPoint ?? null);
        setSelected(track);
        return;
      }
      // Stage 1 (sync, BEFORE the view transition): tag the originator
      // so the pre-snapshot has exactly one element with the matching
      // view-transition-name on the page.
      flushSync(() => {
        setOriginatingId(track.id);
        setOriginatingSource(source);
        setOrigin(originPoint ?? null);
      });
      // Stage 2: start the transition. The callback flips `selected`,
      // which makes the originator drop its name and the modal claim
      // it. The browser snapshots both states and morphs the bounding
      // box from the originator's rectangle to the modal's rectangle.
      // .finished can reject with InvalidStateError if another VT is
      // already running (rapid open/close, two wand clicks back-to-back).
      // Catch the rejection so the global window.unhandledrejection
      // listener doesn't surface a red toast for the harmless abort.
      const t = doc.startViewTransition!(() => {
        flushSync(() => setSelected(track));
      });
      t.finished.catch(() => {});
    },
    [],
  );

  const close = useCallback(() => {
    const doc = getDocVT();
    if (!doc) {
      setSelected(null);
      setOriginatingId(null);
      setOriginatingSource(null);
      return;
    }
    const transition = doc.startViewTransition!(() => {
      flushSync(() => setSelected(null));
    });
    // Wait for the close morph to finish before releasing the
    // originator — releasing too early would mean nothing carries the
    // name in the post-snapshot, leaving the morph nothing to land on.
    transition.finished
      .then(() => {
        setOriginatingId(null);
        setOriginatingSource(null);
      })
      .catch(() => {
        setOriginatingId(null);
        setOriginatingSource(null);
      });
  }, []);

  return (
    <Ctx.Provider
      value={{
        selected,
        originatingId,
        originatingSource,
        origin,
        open,
        close,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useTrackInfo() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTrackInfo must be used inside TrackInfoProvider");
  return ctx;
}

/** Helper for click handlers — derives the origin point from a click
 *  event's currentTarget bounding rect. */
export function originFromClick(
  e: { currentTarget: { getBoundingClientRect(): DOMRect } },
): OriginPoint {
  const rect = e.currentTarget.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}
