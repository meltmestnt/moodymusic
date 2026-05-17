"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { flushSync } from "react-dom";
import type { SpotifyTrack } from "@/lib/spotify";
import type { OriginPoint, TrackInfoOrigin } from "./track-info-context";

interface SimilarSearchContextValue {
  seed: SpotifyTrack | null;
  originatingId: string | null;
  originatingSource: TrackInfoOrigin | null;
  origin: OriginPoint | null;
  open: (
    track: SpotifyTrack,
    source?: TrackInfoOrigin,
    origin?: OriginPoint,
  ) => void;
  close: () => void;
}

const Ctx = createContext<SimilarSearchContextValue | null>(null);

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

// Mirror of TrackInfoProvider: drives the View Transitions morph from a
// TrackCard into the AI-similar-songs popup. Kept as a separate context
// from TrackInfoProvider so that the wand button and the info button
// stay independent — only one modal can open at a time but each owns
// its own state machine.
export function SimilarSearchProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [seed, setSeed] = useState<SpotifyTrack | null>(null);
  const [originatingId, setOriginatingId] = useState<string | null>(null);
  const [originatingSource, setOriginatingSource] =
    useState<TrackInfoOrigin | null>(null);
  const [origin, setOrigin] = useState<OriginPoint | null>(null);

  // Both .ready and .finished can reject with InvalidStateError when a new
  // VT is started before the previous one has fully settled (rapid open/
  // close, or two cards' wand buttons clicked back-to-back). We always
  // attach .catch() so the rejection never reaches window.unhandledrejection
  // — without this, the global toaster turns the harmless DOMException
  // into a "Transition was aborted because of invalid state" red toast.
  const swallowVtAbort = (transition: ViewTransition) => {
    transition.finished.catch(() => {});
  };

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
        setSeed(track);
        return;
      }
      flushSync(() => {
        setOriginatingId(track.id);
        setOriginatingSource(source);
        setOrigin(originPoint ?? null);
      });
      const t = doc.startViewTransition!(() => {
        flushSync(() => setSeed(track));
      });
      swallowVtAbort(t);
    },
    [],
  );

  const close = useCallback(() => {
    const doc = getDocVT();
    if (!doc) {
      setSeed(null);
      setOriginatingId(null);
      setOriginatingSource(null);
      return;
    }
    const transition = doc.startViewTransition!(() => {
      flushSync(() => setSeed(null));
    });
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
        seed,
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

export function useSimilarSearch() {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error(
      "useSimilarSearch must be used inside SimilarSearchProvider",
    );
  return ctx;
}
