"use client";

import { useState } from "react";
import { SessionProvider } from "next-auth/react";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { PlayerProvider } from "@/lib/player-context";
import { FavoritesProvider } from "@/lib/favorites-context";
import { FeatureFlagsProvider } from "@/lib/feature-flags-context";
import { LanguageProvider } from "@/lib/i18n";
import { MoodSearchProvider } from "@/lib/mood-search-context";
import { TrackInfoProvider } from "@/lib/track-info-context";
import { SimilarSearchProvider } from "@/lib/similar-search-context";
import { showError } from "@/lib/toast";

// Pull the most useful message out of whatever React Query / fetch threw.
// Skips the cases where a toast would be noise: 401 (handled by redirecting
// to sign-in elsewhere) and AbortError (the user navigated away).
function toastFromQueryError(err: unknown) {
  if (err instanceof Error && err.name === "AbortError") return;
  const status = (err as { status?: number })?.status;
  if (status === 401) return;
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "Something went wrong";
  showError(msg);
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              const status = (error as { status?: number })?.status;
              if (status === 401 || status === 403) return false;
              return failureCount < 2;
            },
          },
        },
        // Global error sinks — every failed query and mutation flows through
        // the toast emitter unless the call site has already shown its own
        // (mutations can suppress by setting meta.suppressToast).
        queryCache: new QueryCache({
          onError: (err, query) => {
            if (query.meta?.suppressToast) return;
            toastFromQueryError(err);
          },
        }),
        mutationCache: new MutationCache({
          onError: (err, _vars, _ctx, mutation) => {
            if (mutation.meta?.suppressToast) return;
            toastFromQueryError(err);
          },
        }),
      }),
  );

  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        <FeatureFlagsProvider>
          <LanguageProvider>
            <FavoritesProvider>
              <MoodSearchProvider>
                <TrackInfoProvider>
                  <SimilarSearchProvider>
                    <PlayerProvider>{children}</PlayerProvider>
                  </SimilarSearchProvider>
                </TrackInfoProvider>
              </MoodSearchProvider>
            </FavoritesProvider>
          </LanguageProvider>
        </FeatureFlagsProvider>
      </QueryClientProvider>
    </SessionProvider>
  );
}
