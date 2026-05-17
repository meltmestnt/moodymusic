"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { FeatureFlagKey } from "@/lib/feature-flags";

// Client mirror of lib/feature-flags. The provider fetches /api/feature-flags
// once on mount and exposes a sync `useFeatureFlag(key)` to the rest of
// the app. While the fetch is in flight, every flag reads as `false` —
// same fail-closed behaviour as the server helper.
//
// Re-fetch on focus is intentional: when an admin flips a flag in Mongo,
// users who tab away and come back will pick it up without a hard reload.

type FlagMap = Partial<Record<FeatureFlagKey, boolean>>;

const Ctx = createContext<FlagMap>({});

export function FeatureFlagsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [flags, setFlags] = useState<FlagMap>({});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/feature-flags", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { flags?: FlagMap };
        if (!cancelled && json.flags) setFlags(json.flags);
      } catch {
        // Network/parse error — leave flags empty (fail closed).
      }
    };
    void load();

    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const value = useMemo(() => flags, [flags]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFeatureFlag(key: FeatureFlagKey): boolean {
  return Boolean(useContext(Ctx)[key]);
}
