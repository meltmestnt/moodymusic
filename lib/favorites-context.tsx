"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSession } from "next-auth/react";
import { showError } from "@/lib/toast";

// We keep three sets in memory:
//   saved    — ids known to be saved
//   unsaved  — ids known to be unsaved (queried via /contains)
//   pending  — ids currently being mutated (heart shows a busy state)
//
// A track id absent from all three has unknown state — the heart renders
// neutral until we hydrate it via /api/favorites?ids=.
//
// The library page calls markSaved(loadedIds) because tracks served by
// /me/tracks are by definition saved. The mood page calls hydrate(ids) for
// AI picks, which can be either saved or unsaved.
//
// Anonymous (signed-out) users get a parallel localStorage-only flow:
// favorites persist in `LOCAL_STORAGE_KEY` and the toggle writes there
// instead of /api/favorites. There's no migration to the server when the
// user later signs in — the local entries just stay local.

const LOCAL_STORAGE_KEY = "moodymusic.favorites.anon";

function loadLocalFavorites(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function saveLocalFavorites(ids: Iterable<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify([...ids]),
    );
  } catch {
    // Storage full / private mode — ignore. The runtime state still
    // reflects the toggle; only the persistence is best-effort.
  }
}

interface FavoritesValue {
  isFavorite: (id: string) => boolean;
  isKnown: (id: string) => boolean;
  isPending: (id: string) => boolean;
  toggle: (id: string) => Promise<void>;
  markSaved: (ids: string[]) => void;
  markUnsaved: (ids: string[]) => void;
  hydrate: (ids: string[]) => void;
}

const Ctx = createContext<FavoritesValue | null>(null);

export function FavoritesProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [unsaved, setUnsaved] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());

  // Track ids we've already requested via /contains so the same id isn't
  // re-fetched while sitting on a list. Reset when the session changes.
  const requestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (status === "unauthenticated") {
      // Hydrate from localStorage. Mark every id as "requested" so the
      // server-side hydrate path is skipped (it would 401 anyway).
      const local = loadLocalFavorites();
      requestedRef.current = new Set(local);
      setSaved(new Set(local));
      setUnsaved(new Set());
      setPending(new Set());
    } else if (status === "loading") {
      // Wipe while we figure out which mode we're in. The
      // "unauthenticated" or "authenticated" branches will repopulate.
      requestedRef.current = new Set();
      setSaved(new Set());
      setUnsaved(new Set());
      setPending(new Set());
    }
    // status === "authenticated": don't touch — the per-page hydrate /
    // markSaved calls will populate the sets on demand.
  }, [status]);

  const markSaved = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setSaved((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    setUnsaved((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of ids) {
        if (next.delete(id)) changed = true;
      }
      return changed ? next : prev;
    });
    for (const id of ids) requestedRef.current.add(id);
  }, []);

  const markUnsaved = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setUnsaved((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    setSaved((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of ids) {
        if (next.delete(id)) changed = true;
      }
      return changed ? next : prev;
    });
    for (const id of ids) requestedRef.current.add(id);
  }, []);

  // Fetch saved-status for ids we don't yet know about. Debounced ~120ms so
  // a list rendering 12 cards in the same tick fires one batched request,
  // not twelve.
  const queueRef = useRef<Set<string>>(new Set());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(async () => {
    flushTimerRef.current = null;
    const ids = Array.from(queueRef.current);
    queueRef.current = new Set();
    if (ids.length === 0) return;
    try {
      const url = `/api/favorites?ids=${encodeURIComponent(ids.join(","))}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const json = (await res.json()) as {
        saved: boolean[];
        ids?: string[];
      };
      // The route returns ids in the same order it processed them — we sent
      // a comma-separated list, so they line up with our `ids` array. But
      // the response also echoes them so we can match defensively.
      const orderedIds = json.ids ?? ids;
      const toSave: string[] = [];
      const toUnsave: string[] = [];
      for (let i = 0; i < orderedIds.length; i++) {
        const id = orderedIds[i]!;
        if (json.saved[i]) toSave.push(id);
        else toUnsave.push(id);
      }
      markSaved(toSave);
      markUnsaved(toUnsave);
    } catch {
      // Silent: heart icons will keep showing the unknown state, which is
      // safe (the user can still click and we'll figure it out then).
    }
  }, [markSaved, markUnsaved]);

  const hydrate = useCallback(
    (ids: string[]) => {
      if (status !== "authenticated") return;
      let added = 0;
      for (const id of ids) {
        if (requestedRef.current.has(id)) continue;
        if (saved.has(id) || unsaved.has(id)) continue;
        requestedRef.current.add(id);
        queueRef.current.add(id);
        added++;
      }
      if (added === 0) return;
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      flushTimerRef.current = setTimeout(flush, 120);
    },
    [status, saved, unsaved, flush],
  );

  const isFavorite = useCallback((id: string) => saved.has(id), [saved]);
  const isKnown = useCallback(
    (id: string) => saved.has(id) || unsaved.has(id),
    [saved, unsaved],
  );
  const isPending = useCallback((id: string) => pending.has(id), [pending]);

  const setOnePending = (id: string, on: boolean) =>
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const toggle = useCallback(
    async (id: string) => {
      if (pending.has(id)) return;
      const wasFavorite = saved.has(id);

      // Anonymous path: persist purely to localStorage. No server round-
      // trip, no rollback story — the heart flip and the persist happen
      // synchronously in the same tick.
      if (status !== "authenticated") {
        if (wasFavorite) {
          markUnsaved([id]);
          const next = new Set(saved);
          next.delete(id);
          saveLocalFavorites(next);
        } else {
          markSaved([id]);
          const next = new Set(saved);
          next.add(id);
          saveLocalFavorites(next);
        }
        return;
      }

      // Optimistic: flip immediately so the heart pops/unpops instantly.
      if (wasFavorite) markUnsaved([id]);
      else markSaved([id]);
      setOnePending(id, true);
      try {
        const res = await fetch("/api/favorites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: wasFavorite ? "unsave" : "save",
            ids: [id],
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            code?: string;
            error?: string;
          };
          if (body.code === "scope_missing") {
            // The token was issued without user-library-modify. Tell the
            // user — silently rolling back looks like a broken button.
            showError(
              "Spotify hasn't granted permission to modify your library yet. " +
                "Sign out and back in to grant it.",
              { ttlMs: 9000 },
            );
          } else {
            showError(
              body.error ??
                `Couldn't update favorites (${res.status}). Please try again.`,
            );
          }
          throw new Error(
            body.error ?? `favorites toggle failed (${res.status})`,
          );
        }
      } catch (e) {
        // Roll back the optimistic flip.
        if (wasFavorite) markSaved([id]);
        else markUnsaved([id]);
        // The error path above already showed a toast for HTTP failures;
        // log here for the network / programmer-error fallthrough.
        console.warn("[favorites]", e);
      } finally {
        setOnePending(id, false);
      }
    },
    [pending, saved, status, markSaved, markUnsaved],
  );

  const value = useMemo<FavoritesValue>(
    () => ({
      isFavorite,
      isKnown,
      isPending,
      toggle,
      markSaved,
      markUnsaved,
      hydrate,
    }),
    [isFavorite, isKnown, isPending, toggle, markSaved, markUnsaved, hydrate],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFavorites() {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("useFavorites must be used inside FavoritesProvider");
  return ctx;
}
