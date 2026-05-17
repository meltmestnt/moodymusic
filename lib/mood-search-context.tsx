"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { SpotifyTrack } from "@/lib/spotify";

export interface MoodResponse {
  tracks: { track: SpotifyTrack; reason: string | null }[];
  // Stable id from the searches collection — when present, the /mood
  // page replaces the URL with ?id=<id> so refresh + back/forward replay
  // the saved suggestions instead of hitting OpenAI again. Absent for
  // anon visitors and when Mongo isn't configured.
  searchId?: string | null;
  // Only present for anonymous callers — surfaces the per-IP daily budget
  // so the UI can render "N free searches left" without a second roundtrip.
  anon?: {
    remaining: number;
    cap: number;
  };
}

// Shape of GET /api/searches/[id] — kept in sync with the SavedSearchResponse
// declared in app/api/searches/[id]/route.ts. We re-declare here so this
// module stays free of server-route imports.
interface SavedSearchPayload {
  id: string;
  mood: string;
  createdAt: string;
  tracks: { track: SpotifyTrack; reason: string | null }[];
}

export class MoodSearchError extends Error {
  // retryAfterSeconds is populated for the server-side throttle response
  // (code: "throttled") so the page can render "try again in Ns" with the
  // exact wait. Undefined for any other error code.
  constructor(
    public code: string,
    public retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "MoodSearchError";
  }
}

async function postMood(
  mood: string,
  count: number,
  signal?: AbortSignal,
): Promise<MoodResponse> {
  const res = await fetch("/api/mood-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mood, count }),
    // React Query passes its own signal; if it aborts (cancelQueries or
    // an unmount with appropriate config) the fetch is torn down.
    signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      retryAfterSeconds?: number;
    };
    throw new MoodSearchError(
      body.code ?? "upstream_error",
      body.retryAfterSeconds,
    );
  }
  return res.json();
}

interface MoodSearchContextValue {
  /** Current text in the textarea — persists across page navigations. */
  mood: string;
  setMood: (s: string) => void;
  /** The mood string the latest search is keyed on. Null until the user
   *  has searched at least once. The /mood page mirrors this in `?q=`. */
  activeQuery: string | null;
  data: MoodResponse | undefined;
  error: Error | null;
  /** True while a fetch for the current query is in flight. */
  isLoading: boolean;
  isError: boolean;
  /** Kick off a search. `count` is how many tracks to ask OpenAI for
   *  (8 on desktop, 6 on smaller viewports so two rows always come back
   *  full). The cache key is the mood alone, so a previously-searched
   *  query resolves from cache regardless of the current viewport. */
  search: (mood: string, count: number) => void;
  /** Re-run the active query, bypassing the React Query cache so the
   *  user gets new picks. The server's cache key folds in the user's
   *  recently-shown tracks, so the AI is asked for fresh songs that
   *  don't repeat what they just saw. */
  regenerate: (count: number) => void;
  /** Hydrate the visible state from a saved search row instead of
   *  calling OpenAI. Used by the /mood page when arriving via ?id=<id>
   *  (recent-searches click, or browser reload after a fresh search
   *  rewrote the URL). Resolves with the saved row's mood text so the
   *  caller can also reflect it back into the textarea. */
  loadSaved: (id: string) => Promise<SavedSearchPayload | null>;
  reset: () => void;
}

const Ctx = createContext<MoodSearchContextValue | null>(null);

// Lives at the providers level so navigating away from /mood and back
// doesn't unmount the result. Backed by useQuery keyed on the mood string —
// every distinct search this session stays cached, so browser back/forward
// across past searches resolves instantly without re-firing OpenAI.
export function MoodSearchProvider({ children }: { children: React.ReactNode }) {
  const [mood, setMood] = useState("");
  const [activeQuery, setActiveQuery] = useState<string | null>(null);
  // Bumped on regenerate so the same mood reruns through useQuery instead
  // of resolving from React Query's in-memory cache. The server-side
  // cache key already incorporates the user's recent-history hash, so a
  // regenerate on the same mood naturally pulls fresh AI picks.
  const [regenSeed, setRegenSeed] = useState(0);
  // count isn't part of the cache key — we capture it via a ref so the
  // queryFn picks up the latest value without re-keying. Same mood at a
  // different viewport is still a cache hit.
  const countRef = useRef<number>(8);
  const queryClient = useQueryClient();

  const query = useQuery<MoodResponse, Error>({
    queryKey: ["mood-search", activeQuery, regenSeed],
    queryFn: ({ signal }) => postMood(activeQuery!, countRef.current, signal),
    enabled: !!activeQuery,
    // Past searches stay valid for the whole session — the AI's picks for
    // a given mood don't go stale in any meaningful sense.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    // When the user submits a new search, keep the previous result visible
    // until the new one lands. Without this, switching keys flips `data`
    // to `undefined` instantly and the result grid below disappears,
    // jiggling the rest of the layout while the morph runs above.
    placeholderData: keepPreviousData,
    // Page renders its own localized error message per code; suppress the
    // generic global toast so we don't show two layers of the same error.
    meta: { suppressToast: true },
  });

  const search = useCallback((m: string, count: number) => {
    countRef.current = count;
    // A new search resets the regen counter — the next regenerate
    // for THIS mood starts from scratch.
    setRegenSeed(0);
    setActiveQuery(m);
  }, []);

  const regenerate = useCallback(
    (count: number) => {
      if (!activeQuery) return;
      countRef.current = count;
      setRegenSeed((s) => s + 1);
    },
    [activeQuery],
  );

  // Load a saved search by id. Fetches /api/searches/[id], seeds the
  // React Query cache for the exact key useQuery is keyed on, then
  // points activeQuery at the saved mood. useQuery sees the cache hit
  // and returns the saved tracks instantly — no OpenAI call, no
  // network roundtrip past the single GET.
  //
  // Returns the saved payload on success (so the caller can also set
  // the textarea mood) or null on any failure. Errors are swallowed
  // because the caller decides the fallback — usually firing a fresh
  // AI search instead.
  const loadSaved = useCallback(
    async (id: string): Promise<SavedSearchPayload | null> => {
      try {
        const res = await fetch(`/api/searches/${encodeURIComponent(id)}`);
        if (!res.ok) return null;
        const payload = (await res.json()) as SavedSearchPayload;
        // Seed BEFORE flipping activeQuery so useQuery's enabled gate
        // sees a cached value the moment the key changes — no fetch
        // fires. searchId on the seeded payload pins the row to its
        // saved id; subsequent URL syncs round-trip the same id.
        queryClient.setQueryData<MoodResponse>(
          ["mood-search", payload.mood, 0],
          { tracks: payload.tracks, searchId: payload.id },
        );
        setRegenSeed(0);
        setActiveQuery(payload.mood);
        return payload;
      } catch {
        return null;
      }
    },
    [queryClient],
  );

  const reset = useCallback(() => {
    setMood("");
    setActiveQuery(null);
    setRegenSeed(0);
  }, []);

  const value = useMemo<MoodSearchContextValue>(
    () => ({
      mood,
      setMood,
      activeQuery,
      data: query.data,
      error: query.error,
      isLoading: query.isFetching,
      isError: query.isError,
      search,
      regenerate,
      loadSaved,
      reset,
    }),
    [
      mood,
      activeQuery,
      query.data,
      query.error,
      query.isFetching,
      query.isError,
      search,
      regenerate,
      loadSaved,
      reset,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMoodSearch() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMoodSearch must be used inside MoodSearchProvider");
  return ctx;
}
