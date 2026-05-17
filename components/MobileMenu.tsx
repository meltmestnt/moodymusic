"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import {
  Avatar,
  Button,
  Dialog,
  Flex,
  IconButton,
  Separator,
  Text,
  VisuallyHidden,
} from "@radix-ui/themes";
import {
  BarChartIcon,
  BookmarkIcon,
  Cross1Icon,
  ExitIcon,
  HamburgerMenuIcon,
  LightningBoltIcon,
  MagicWandIcon,
  PersonIcon,
} from "@radix-ui/react-icons";
import { useI18n, LOCALES, type Locale } from "@/lib/i18n";
import { signInWithProvider } from "@/lib/auth-client";
import { useFeatureFlag } from "@/lib/feature-flags-context";
import { TelegramConnectButton } from "./TelegramConnectButton";
import { ProviderChip } from "./ProviderChip";

// Phone-only header drawer. The desktop TopBar packs nav + language +
// telegram + avatar + signout across one row, which fits >~700px but
// gets visually crammed below that — especially after the Telegram icon
// landed. This component collapses everything-but-the-logo into a
// hamburger that opens a single Dialog.
//
// Visibility is CSS-driven: `.topbar-mobile-menu` is hidden on >700px
// (globals.css) and the desktop right-cluster (`.topbar-desktop-cluster`)
// is hidden ≤700px. Single source of truth on a media query keeps the
// burger from appearing as a duplicate alongside the desktop layout.
export function MobileMenu() {
  const { data: session, status } = useSession();
  const pathname = usePathname() ?? "/";
  const { t, locale, setLocale } = useI18n();
  const [open, setOpen] = useState(false);
  const deezerEnabled = useFeatureFlag("deezer");
  const soundcloudEnabled = useFeatureFlag("soundcloud");
  const youtubeEnabled = useFeatureFlag("youtube");

  const closeAnd = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <IconButton
          variant="ghost"
          color="gray"
          size="3"
          aria-label={t("nav.menu")}
          className="topbar-mobile-menu"
        >
          <HamburgerMenuIcon width="20" height="20" />
        </IconButton>
      </Dialog.Trigger>
      <Dialog.Content
        maxWidth="360px"
        className="mobile-menu-content"
      >
        <VisuallyHidden>
          <Dialog.Title>{t("nav.menu")}</Dialog.Title>
        </VisuallyHidden>

        {/* Header row: identity + close button. Mirrors the role the avatar
         * plays in the desktop topbar — at-a-glance "who am I signed in as"
         * before any actions. */}
        <Flex align="center" justify="between" gap="3" mb="3">
          {session ? (
            <Flex direction="column" gap="1" minWidth="0">
              <Flex align="center" gap="2" minWidth="0">
                <Avatar
                  src={session.user?.image ?? undefined}
                  fallback={
                    (session.user?.name ?? "?")[0]?.toUpperCase() ?? "?"
                  }
                  size="2"
                  radius="full"
                />
                <Text
                  size="2"
                  weight="medium"
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {session.user?.name ?? session.user?.email ?? ""}
                </Text>
              </Flex>
              {session.provider && (
                <ProviderChip provider={session.provider} variant="full" />
              )}
            </Flex>
          ) : (
            <Text size="2" weight="medium" color="gray">
              {t("nav.menu")}
            </Text>
          )}
          <Dialog.Close>
            <IconButton variant="ghost" color="gray" aria-label={t("nav.close")}>
              <Cross1Icon />
            </IconButton>
          </Dialog.Close>
        </Flex>

        {/* Nav links — same set as the desktop topbar, rendered as full-
         * width rows so they're easy to tap. */}
        {session && (
          <Flex direction="column" gap="1">
            <MenuRow
              href="/library"
              active={pathname.startsWith("/library")}
              icon={<BookmarkIcon />}
              label={t("nav.library")}
              onSelect={() => setOpen(false)}
            />
            <MenuRow
              href="/mood"
              active={pathname.startsWith("/mood")}
              icon={<MagicWandIcon />}
              label={t("nav.mood")}
              onSelect={() => setOpen(false)}
            />
            <MenuRow
              href="/discover"
              active={pathname.startsWith("/discover")}
              icon={<LightningBoltIcon />}
              label={t("nav.discover")}
              onSelect={() => setOpen(false)}
            />
            <MenuRow
              href="/stats"
              active={pathname.startsWith("/stats")}
              icon={<BarChartIcon />}
              label={t("nav.stats")}
              onSelect={() => setOpen(false)}
            />
            {session.isAdmin && (
              <MenuRow
                href="/admin/users"
                active={pathname.startsWith("/admin")}
                icon={<PersonIcon />}
                label={t("nav.admin")}
                onSelect={() => setOpen(false)}
              />
            )}
          </Flex>
        )}

        {session && <Separator size="4" my="3" />}

        {/* Telegram + language: the two "settings"-style toggles that
         * lived in the desktop right-cluster. Telegram opens its own
         * dialog on top of this one — Radix stacks dialogs cleanly. */}
        <Flex direction="column" gap="2">
          <TelegramConnectButton variant="soft" className="mobile-menu-tg" />
          <Flex direction="column" gap="1" mt="2">
            <Text size="1" color="gray" mb="1">
              {t("language.label")}
            </Text>
            <Flex gap="2">
              {LOCALES.map((l) => (
                <Button
                  key={l.value}
                  size="2"
                  variant={l.value === locale ? "solid" : "soft"}
                  color="gray"
                  onClick={() => setLocale(l.value as Locale)}
                  style={{ flex: 1 }}
                >
                  {l.label}
                </Button>
              ))}
            </Flex>
          </Flex>
        </Flex>

        <Separator size="4" my="3" />

        {/* Auth row at the bottom — sign in (multi-provider) for anons,
         * sign out for authenticated. */}
        {status === "loading" ? null : session ? (
          <Button
            color="gray"
            variant="soft"
            onClick={closeAnd(() => signOut({ callbackUrl: "/" }))}
            style={{ width: "100%" }}
          >
            <ExitIcon />
            {t("auth.signOut")}
          </Button>
        ) : (
          <Flex direction="column" gap="2">
            {/* Brand-colored provider buttons — each keeps its
              * recognisable brand color even though the app theme is
              * crimson. */}
            <Button
              color="grass"
              onClick={closeAnd(() => signInWithProvider("spotify"))}
              style={{ width: "100%" }}
            >
              {t("auth.signInSpotify")}
            </Button>
            {deezerEnabled && (
              <Button
                color="purple"
                variant="soft"
                onClick={closeAnd(() => signInWithProvider("deezer"))}
                style={{ width: "100%" }}
              >
                {t("auth.signInDeezer")}
              </Button>
            )}
            {soundcloudEnabled && (
              <Button
                color="orange"
                variant="soft"
                onClick={closeAnd(() => signInWithProvider("soundcloud"))}
                style={{ width: "100%" }}
              >
                {t("auth.signInSoundCloud")}
              </Button>
            )}
            {youtubeEnabled && (
              <Button
                color="red"
                variant="soft"
                onClick={closeAnd(() => signInWithProvider("youtube"))}
                style={{ width: "100%" }}
              >
                {t("auth.signInYouTube")}
              </Button>
            )}
          </Flex>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function MenuRow({
  href,
  active,
  icon,
  label,
  onSelect,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onSelect: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onSelect}
      className="mobile-menu-row"
      data-active={active || undefined}
    >
      <span aria-hidden style={{ display: "inline-flex" }}>
        {icon}
      </span>
      <span>{label}</span>
    </Link>
  );
}
