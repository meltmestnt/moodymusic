"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { Avatar, Box, Button, Flex, Heading } from "@radix-ui/themes";
import {
  BarChartIcon,
  BookmarkIcon,
  ExitIcon,
  LightningBoltIcon,
  MagicWandIcon,
  PersonIcon,
} from "@radix-ui/react-icons";
import { useI18n } from "@/lib/i18n";
import { signInWithProvider } from "@/lib/auth-client";
import { useFeatureFlag } from "@/lib/feature-flags-context";
import { LanguagePicker } from "./LanguagePicker";
import { TelegramConnectButton } from "./TelegramConnectButton";
import { MobileMenu } from "./MobileMenu";
import { ProviderChip } from "./ProviderChip";

export function TopBar() {
  const { data: session, status } = useSession();
  const pathname = usePathname() ?? "/";
  const { t } = useI18n();
  const deezerEnabled = useFeatureFlag("deezer");
  const soundcloudEnabled = useFeatureFlag("soundcloud");
  const youtubeEnabled = useFeatureFlag("youtube");

  // Telegram Mini App route owns its own chrome — Telegram supplies the
  // window header and the in-app surface is too narrow to share the
  // moodymusic top bar without clipping.
  if (pathname.startsWith("/tg")) return null;

  return (
    <Box
      className="app-header"
      px={{ initial: "4", sm: "6" }}
      py="3"
      style={{ height: 60 }}
    >
      <Flex
        align="center"
        justify="between"
        height="100%"
        gap={{ initial: "2", sm: "5" }}
        wrap="nowrap"
      >
        <Flex align="center" gap={{ initial: "3", sm: "6" }} minWidth="0">
          <Link href="/" className="topbar-logo">
            <Heading
              size="4"
              weight="bold"
              style={{ letterSpacing: "-0.01em", whiteSpace: "nowrap" }}
            >
              <span style={{ color: "var(--accent-10)" }}>moody</span>
              <span className="topbar-logo-suffix">music</span>
            </Heading>
          </Link>
          {session && (
            <Flex
              gap={{ initial: "1", sm: "4" }}
              align="center"
              className="topbar-desktop-nav"
            >
              <NavLink
                href="/library"
                active={pathname.startsWith("/library")}
                icon={<BookmarkIcon />}
                label={t("nav.library")}
              />
              <NavLink
                href="/mood"
                active={pathname.startsWith("/mood")}
                icon={<MagicWandIcon />}
                label={t("nav.mood")}
              />
              <NavLink
                href="/discover"
                active={pathname.startsWith("/discover")}
                icon={<LightningBoltIcon />}
                label={t("nav.discover")}
              />
              <NavLink
                href="/stats"
                active={pathname.startsWith("/stats")}
                icon={<BarChartIcon />}
                label={t("nav.stats")}
              />
              {/* Admin link is gated by `session.isAdmin` — derived
                * server-side from email + provider, see lib/auth-admin.
                * The /admin/users page itself re-checks the flag, so
                * hiding the link is a UX nicety, not a security gate. */}
              {session.isAdmin && (
                <NavLink
                  href="/admin/users"
                  active={pathname.startsWith("/admin")}
                  icon={<PersonIcon />}
                  label={t("nav.admin")}
                />
              )}
            </Flex>
          )}
        </Flex>

        {/* Mobile (≤ 700px): single hamburger that opens the MobileMenu
          * dialog. Desktop cluster below is CSS-hidden at the same break. */}
        <MobileMenu />

        <Flex
          align="center"
          gap={{ initial: "2", sm: "3" }}
          flexShrink="0"
          className="topbar-desktop-cluster"
        >
          <TelegramConnectButton variant="icon" />
          <LanguagePicker />
          {status === "loading" ? null : session ? (
            <>
              {/* "Signed in via X" chip — only meaningful when we know
                * the provider. Hidden on very narrow desktops via CSS
                * (.topbar-provider-chip) so it doesn't crowd the avatar
                * + sign-out at ~700-900px. */}
              {session.provider && (
                <ProviderChip
                  provider={session.provider}
                  className="topbar-provider-chip"
                />
              )}
              <Avatar
                src={session.user?.image ?? undefined}
                fallback={(session.user?.name ?? "?")[0]?.toUpperCase() ?? "?"}
                size="2"
                radius="full"
              />
              <Button
                variant="ghost"
                color="gray"
                onClick={() => signOut({ callbackUrl: "/" })}
                aria-label={t("auth.signOut")}
              >
                <ExitIcon />
                <span className="topbar-signout-text">{t("auth.signOut")}</span>
              </Button>
            </>
          ) : (
            // Provider buttons hidden on phone widths — they overflow the
            // bar at ≤ 700px and the landing hero already gives anon
            // visitors the same sign-in affordances directly below.
            <Flex gap="2" className="topbar-signin-buttons">
              {/* Brand-colored sign-in buttons — each carries its provider's
                * recognisable color (Spotify green, Deezer purple, etc.) so
                * users see the familiar visual cue, even though the overall
                * app theme is crimson. */}
              <Button
                color="grass"
                onClick={() => signInWithProvider("spotify")}
              >
                {t("auth.signInSpotify")}
              </Button>
              {deezerEnabled && (
                <Button
                  color="purple"
                  onClick={() => signInWithProvider("deezer")}
                >
                  {t("auth.signInDeezer")}
                </Button>
              )}
              {soundcloudEnabled && (
                <Button
                  color="orange"
                  onClick={() => signInWithProvider("soundcloud")}
                >
                  {t("auth.signInSoundCloud")}
                </Button>
              )}
              {youtubeEnabled && (
                <Button
                  color="red"
                  onClick={() => signInWithProvider("youtube")}
                >
                  {t("auth.signInYouTube")}
                </Button>
              )}
            </Flex>
          )}
        </Flex>
      </Flex>
    </Box>
  );
}

function NavLink({
  href,
  active,
  icon,
  label,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="topbar-nav-link"
      data-active={active || undefined}
      aria-label={label}
      title={label}
      style={{
        color: active ? "var(--gray-12)" : "var(--gray-11)",
        background: active ? "var(--gray-4)" : "transparent",
      }}
    >
      <span className="topbar-nav-icon" aria-hidden>
        {icon}
      </span>
      <span className="topbar-nav-label">{label}</span>
    </Link>
  );
}
