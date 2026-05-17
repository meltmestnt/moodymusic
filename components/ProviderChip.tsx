"use client";

import { Flex, Text, Tooltip } from "@radix-ui/themes";
import type { MusicProvider } from "@/types/next-auth";

// "Signed in via X" badge — a tiny brand glyph + provider name. The chip
// gets a soft brand-tinted background + thin brand-tinted border so it
// reads as "this is your Spotify/Deezer/etc. session" without leaving the
// surrounding crimson theme. The brand color only colors this single chip;
// the rest of the UI stays on the app accent.
//
// Variants:
//   • compact — small pill (TopBar). Logo + label, no prefix.
//   • full    — taller pill with a leading "Signed in via" line above the
//               provider name. Used in the MobileMenu identity row where
//               there's vertical room for the extra context.
//   • minimal — logo only, tooltip-driven. Currently unused.

const PROVIDERS: Record<
  MusicProvider,
  { label: string; brand: string; logo: (size: number) => React.ReactNode }
> = {
  spotify: {
    label: "Spotify",
    brand: "#1DB954",
    logo: (s) => (
      <svg viewBox="0 0 24 24" width={s} height={s} aria-hidden="true">
        <circle cx="12" cy="12" r="12" fill="#1DB954" />
        <path
          d="M17.5 10.7c-3-1.8-7.9-2-10.7-1.1-.5.1-1-.1-1.1-.6-.1-.5.1-1 .6-1.1 3.3-1 8.6-.8 12 1.2.4.3.6.9.3 1.3-.3.4-.8.5-1.1.3zm-.1 2.6c-.2.4-.7.5-1.1.3-2.5-1.5-6.3-2-9.2-1.1-.4.1-.9-.1-1-.5-.1-.4.1-.9.5-1 3.4-1 7.6-.5 10.5 1.3.3.2.4.6.3 1zm-1.1 2.5c-.2.3-.6.4-.9.2-2.2-1.3-5-1.6-8.2-.9-.3.1-.7-.1-.8-.5-.1-.3.1-.7.5-.8 3.6-.8 6.7-.4 9.2 1.1.3.2.4.6.2.9z"
          fill="#000"
        />
      </svg>
    ),
  },
  deezer: {
    label: "Deezer",
    brand: "#A238FF",
    logo: (s) => (
      <svg viewBox="0 0 24 24" width={s} height={s} aria-hidden="true">
        <rect x="2" y="14" width="3.5" height="3.5" fill="#40AB5D" rx="0.5" />
        <rect x="6.5" y="14" width="3.5" height="3.5" fill="#3FC0F0" rx="0.5" />
        <rect x="11" y="14" width="3.5" height="3.5" fill="#FFCD00" rx="0.5" />
        <rect x="15.5" y="14" width="3.5" height="3.5" fill="#F37520" rx="0.5" />
        <rect x="6.5" y="10" width="3.5" height="3.5" fill="#3FC0F0" rx="0.5" />
        <rect x="11" y="10" width="3.5" height="3.5" fill="#FFCD00" rx="0.5" />
        <rect x="15.5" y="10" width="3.5" height="3.5" fill="#F37520" rx="0.5" />
        <rect x="11" y="6" width="3.5" height="3.5" fill="#FFCD00" rx="0.5" />
        <rect x="15.5" y="6" width="3.5" height="3.5" fill="#F37520" rx="0.5" />
      </svg>
    ),
  },
  soundcloud: {
    label: "SoundCloud",
    brand: "#FF5500",
    logo: (s) => (
      <svg viewBox="0 0 24 24" width={s} height={s} aria-hidden="true">
        <circle cx="12" cy="12" r="12" fill="#FF5500" />
        <path
          d="M4 14v3M6 12v5M8 11v6M10 10v7M12 8v9M14 9v8M17 11v6"
          stroke="#fff"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  youtube: {
    label: "YouTube",
    brand: "#FF0000",
    logo: (s) => (
      <svg viewBox="0 0 24 24" width={s} height={s} aria-hidden="true">
        <rect x="2" y="5" width="20" height="14" rx="3" fill="#FF0000" />
        <path d="M10 9 L16 12 L10 15 Z" fill="#fff" />
      </svg>
    ),
  },
};

interface Props {
  provider: MusicProvider;
  variant?: "compact" | "full" | "minimal";
  className?: string;
}

export function ProviderChip({
  provider,
  variant = "compact",
  className,
}: Props) {
  const info = PROVIDERS[provider];
  if (!info) return null;

  if (variant === "minimal") {
    return (
      <Tooltip content={`Signed in via ${info.label}`}>
        <span
          className={className}
          style={{ display: "inline-flex" }}
        >
          {info.logo(14)}
        </span>
      </Tooltip>
    );
  }

  // brand color used at low opacity for a soft tint. Last byte = alpha:
  //   1a ≈ 10%  (background fill)
  //   33 ≈ 20%  (border line)
  //   80 ≈ 50%  (subtle hover state, reserved)
  const bgTint = `${info.brand}1a`;
  const borderTint = `${info.brand}33`;

  if (variant === "full") {
    // Mobile menu treatment: vertically split chip with a small uppercase
    // "Signed in via" prefix above a bolder brand name. The leading logo
    // gets its own dedicated square so the eye anchors there first; the
    // text block sits to its right with a clear typographic hierarchy.
    return (
      <span
        className={
          className ? `provider-chip provider-chip-full ${className}` : "provider-chip provider-chip-full"
        }
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px 5px 6px",
          borderRadius: 999,
          background: bgTint,
          border: `1px solid ${borderTint}`,
          lineHeight: 1.1,
          whiteSpace: "nowrap",
          maxWidth: "fit-content",
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            borderRadius: 999,
            background: "rgba(0, 0, 0, 0.25)",
          }}
        >
          {info.logo(14)}
        </span>
        <Flex direction="column" gap="0" style={{ minWidth: 0 }}>
          <Text
            size="1"
            color="gray"
            style={{
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              lineHeight: 1,
            }}
          >
            Signed in via
          </Text>
          <Text
            size="2"
            weight="bold"
            style={{ lineHeight: 1.15, color: "var(--gray-12)" }}
          >
            {info.label}
          </Text>
        </Flex>
      </span>
    );
  }

  // compact (default) — single-line pill for the TopBar.
  return (
    <Tooltip content={`Signed in via ${info.label}`}>
      <span
        className={
          className ? `provider-chip ${className}` : "provider-chip"
        }
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 10px 3px 4px",
          borderRadius: 999,
          background: bgTint,
          border: `1px solid ${borderTint}`,
          color: "var(--gray-12)",
          lineHeight: 1,
          whiteSpace: "nowrap",
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            borderRadius: 999,
            background: "rgba(0, 0, 0, 0.25)",
          }}
        >
          {info.logo(12)}
        </span>
        <Text size="1" weight="medium">
          {info.label}
        </Text>
      </span>
    </Tooltip>
  );
}
