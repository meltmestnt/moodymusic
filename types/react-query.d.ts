// Module augmentation for TanStack Query so `meta.suppressToast` is typed.
// Defined in app/providers.tsx — when a mutation sets it, the global
// MutationCache.onError skips the toast for that one call site.

import "@tanstack/react-query";

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: {
      suppressToast?: boolean;
    };
    mutationMeta: {
      suppressToast?: boolean;
    };
  }
}
