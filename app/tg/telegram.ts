"use client";

import { useEffect, useState } from "react";

// Minimal subset of the Telegram WebApp surface we actually touch. The
// official SDK ships much more, but pulling @twa-dev/types just for these
// fields is overkill — we narrow to what the Mini App reads/calls.
export interface TelegramWebApp {
  ready: () => void;
  expand: () => void;
  close: () => void;
  initData: string;
  initDataUnsafe?: {
    user?: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
      language_code?: string;
    };
    start_param?: string;
  };
  colorScheme: "light" | "dark";
  themeParams: Record<string, string>;
  setHeaderColor?: (color: `#${string}` | "bg_color" | "secondary_bg_color") => void;
  setBackgroundColor?: (color: `#${string}` | "bg_color" | "secondary_bg_color") => void;
  HapticFeedback?: {
    impactOccurred: (style: "light" | "medium" | "heavy") => void;
    selectionChanged: () => void;
  };
  openLink?: (url: string, opts?: { try_instant_view?: boolean }) => void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function useTelegramWebApp(): TelegramWebApp | null {
  const [tg, setTg] = useState<TelegramWebApp | null>(null);

  useEffect(() => {
    // The SDK script is injected from the layout, but its load is async —
    // poll briefly until window.Telegram.WebApp materialises. In practice
    // this resolves on the first tick when running inside Telegram.
    let cancelled = false;
    const tryAttach = () => {
      const candidate = window.Telegram?.WebApp;
      if (candidate) {
        candidate.ready();
        candidate.expand();
        setTg(candidate);
        return true;
      }
      return false;
    };
    if (tryAttach()) return;
    const id = window.setInterval(() => {
      if (cancelled) return;
      if (tryAttach()) window.clearInterval(id);
    }, 100);
    // Give up after 2s — outside Telegram the SDK never appears and we
    // just render in standalone mode.
    const stop = window.setTimeout(() => window.clearInterval(id), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.clearTimeout(stop);
    };
  }, []);

  return tg;
}
