"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { Theme } from "@radix-ui/themes";

// Wraps the app in a Radix Theme with a unified crimson accent across
// every provider. Crimson is a deep, sophisticated pink-red that reads
// as "moodymusic" rather than borrowing each streaming service's brand
// color (which made the UI re-skin every time a user switched provider).
//
// `data-provider` is still stamped on the root so provider-specific
// CSS (e.g. a tiny Spotify/Deezer hue accent on the provider chip in
// the TopBar) can key off the source without changing the accent.
export function ThemeShell({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const provider = session?.provider;

  useEffect(() => {
    const html = document.documentElement;
    if (provider) html.setAttribute("data-provider", provider);
    else html.removeAttribute("data-provider");
    return () => {
      html.removeAttribute("data-provider");
    };
  }, [provider]);

  return (
    <Theme appearance="dark" accentColor="crimson" radius="large" scaling="100%">
      {children}
    </Theme>
  );
}
