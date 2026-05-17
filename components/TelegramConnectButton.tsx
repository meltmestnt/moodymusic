"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Box,
  Button,
  Dialog,
  Flex,
  IconButton,
  Spinner,
  Text,
  Tooltip,
} from "@radix-ui/themes";
import {
  CheckCircledIcon,
  PaperPlaneIcon,
} from "@radix-ui/react-icons";
import { useI18n } from "@/lib/i18n";
import { showError, showInfo } from "@/lib/toast";

type Variant = "icon" | "pill" | "primary" | "soft" | "footer";

interface Props {
  variant?: Variant;
  className?: string;
}

interface StatusResponse {
  signedIn: boolean;
  linked?: boolean;
  botConfigured?: boolean;
  botUrl?: string | null;
  telegram?: {
    telegramUserId: number;
    telegramUsername: string | null;
    telegramFirstName: string | null;
    linkedAt: string;
  } | null;
}

interface StartResponse {
  url?: string;
  botUrl?: string | null;
  error?: string;
}

const STATUS_URL = "/api/telegram/link/status";
const START_URL = "/api/telegram/link/start";
const UNLINK_URL = "/api/telegram/link/unlink";

// Inline SVG so the topbar / footer don't need to load an icon font for a
// single glyph. Telegram's paper-plane mark, simplified to a single path
// at viewBox 24×24. `currentColor` lets it inherit Radix Button colors.
function TelegramIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      fill="currentColor"
    >
      <path d="M9.78 15.27 9.5 19.1c.4 0 .57-.17.78-.37l1.87-1.79 3.88 2.84c.71.4 1.22.19 1.41-.66l2.56-12.01.01-.01c.23-1.06-.39-1.47-1.07-1.21L3.34 9.92c-1.03.4-1.02.97-.18 1.23l4.27 1.33 9.93-6.25c.47-.31.9-.14.55.17z" />
    </svg>
  );
}

export function TelegramConnectButton({
  variant = "soft",
  className,
}: Props) {
  const { data: session, status: sessionStatus } = useSession();
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const pollRef = useRef<number | null>(null);

  const isSignedIn = sessionStatus === "authenticated";

  // Fetch status on mount and whenever the dialog opens. Cheap (single
  // Mongo lookup) and keeps the rendered state honest if linking just
  // happened in another tab.
  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch(STATUS_URL);
      const json = (await res.json()) as StatusResponse;
      setStatus(json);
      return json;
    } catch {
      // Status is best-effort — a transient network failure shouldn't
      // disable the button, just leave us showing the previous state.
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, sessionStatus]);

  // Poll while we're waiting for the user to complete the link inside
  // Telegram. The bot's exchange call updates the link row server-side
  // and the next status read flips us into the "connected" state. We
  // stop polling on success, tab-blur (browser pauses setInterval anyway,
  // but we belt-and-suspenders the cleanup), or dialog close.
  useEffect(() => {
    if (!waiting) {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = window.setInterval(async () => {
      const next = await refreshStatus();
      if (next?.linked) {
        setWaiting(false);
        showInfo(t("telegram.connected"));
      }
    }, 3000);
    return () => {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [waiting, refreshStatus, t]);

  const onClickButton = useCallback(async () => {
    // Anonymous users get a straight deep-link to the bot — no dialog,
    // no token. Open Telegram and we're done. (Per product call.)
    if (!isSignedIn) {
      const url = status?.botUrl ?? null;
      if (!url) {
        showError(t("telegram.errorNotConfigured"));
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    setOpen(true);
  }, [isSignedIn, status?.botUrl, t]);

  const onStartLink = useCallback(async () => {
    setLinking(true);
    try {
      const res = await fetch(START_URL, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as StartResponse;
      if (!res.ok || !json.url) {
        const code = json.error ?? "";
        if (code === "telegram_not_configured") {
          showError(t("telegram.errorNotConfigured"));
        } else if (code === "storage_unavailable" && json.botUrl) {
          // Tokens require Mongo. If it's down, fall through to the
          // plain bot link so the user can at least talk to the bot.
          showError(t("telegram.errorStorage"));
          window.open(json.botUrl, "_blank", "noopener,noreferrer");
        } else {
          showError(t("telegram.errorStart"));
        }
        return;
      }
      setLinkUrl(json.url);
      // Open the deep link immediately. On desktop this hands off to
      // Telegram Desktop / web client; on mobile, to the Telegram app.
      window.open(json.url, "_blank", "noopener,noreferrer");
      setWaiting(true);
    } catch {
      showError(t("telegram.errorStart"));
    } finally {
      setLinking(false);
    }
  }, [t]);

  const onUnlink = useCallback(async () => {
    setUnlinking(true);
    try {
      await fetch(UNLINK_URL, { method: "POST" });
      await refreshStatus();
      showInfo(t("telegram.unlinked"));
    } catch {
      showError(t("telegram.errorStart"));
    } finally {
      setUnlinking(false);
    }
  }, [refreshStatus, t]);

  const linked = !!status?.linked;
  const tgName =
    status?.telegram?.telegramUsername ??
    status?.telegram?.telegramFirstName ??
    "";
  const linkedAtLabel = (() => {
    const raw = status?.telegram?.linkedAt;
    if (!raw) return null;
    try {
      return new Date(raw).toLocaleDateString(
        locale === "uk" ? "uk-UA" : "en-US",
        { year: "numeric", month: "short", day: "numeric" },
      );
    } catch {
      return null;
    }
  })();

  // ─── Trigger element ──────────────────────────────────────────────
  // The "trigger" is what users see in the topbar, hero, etc. We render
  // it manually instead of via Dialog.Trigger because anonymous users
  // shouldn't open the dialog at all — they go straight to the bot.
  const triggerLabel = linked
    ? t("telegram.connected")
    : t("telegram.connect");
  const trigger = (() => {
    if (variant === "icon") {
      const tooltipText = isSignedIn
        ? linked
          ? t("telegram.connected")
          : t("telegram.connect")
        : t("telegram.openBot");
      return (
        <Tooltip content={tooltipText}>
          <IconButton
            variant="ghost"
            color={linked ? "green" : "gray"}
            onClick={onClickButton}
            aria-label={tooltipText}
            className={className}
          >
            <TelegramIcon size={16} />
          </IconButton>
        </Tooltip>
      );
    }
    if (variant === "footer") {
      return (
        <button
          type="button"
          onClick={onClickButton}
          className={className ?? "landing-footer-link"}
          style={{
            background: "transparent",
            border: 0,
            padding: 0,
            cursor: "pointer",
            font: "inherit",
            color: "inherit",
          }}
        >
          {t("telegram.footerLink")}
        </button>
      );
    }
    if (variant === "primary") {
      return (
        <Button
          size={{ initial: "3", sm: "4" }}
          color={linked ? "green" : "blue"}
          className={className}
          onClick={onClickButton}
        >
          {linked ? <CheckCircledIcon /> : <TelegramIcon size={18} />}
          {triggerLabel}
        </Button>
      );
    }
    if (variant === "pill") {
      return (
        <Button
          size="2"
          variant="soft"
          color={linked ? "green" : "blue"}
          onClick={onClickButton}
          className={className}
        >
          <TelegramIcon size={14} />
          {linked ? t("telegram.connectShort") : t("telegram.connect")}
        </Button>
      );
    }
    // soft (default)
    return (
      <Button
        size="3"
        variant="soft"
        color={linked ? "green" : "blue"}
        className={className}
        onClick={onClickButton}
      >
        <TelegramIcon size={16} />
        {triggerLabel}
      </Button>
    );
  })();

  return (
    <>
      {trigger}

      {/* Anonymous users never open the dialog — onClickButton bails
       * out before setOpen(true). Auth-only surface below. */}
      {isSignedIn && (
        <Dialog.Root
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) {
              setWaiting(false);
              setLinkUrl(null);
              // One last refresh on close so a user who completed the
              // link in another tab sees the chip update immediately.
              void refreshStatus();
            }
          }}
        >
          <Dialog.Content maxWidth="440px">
            <Dialog.Title>
              <Flex align="center" gap="2">
                <TelegramIcon size={20} />
                <span>{t("telegram.dialogTitle")}</span>
              </Flex>
            </Dialog.Title>

            {linked ? (
              <Box mt="3">
                <Flex align="center" gap="2" mb="2">
                  <CheckCircledIcon
                    style={{ color: "var(--green-10)" }}
                    width="18"
                    height="18"
                  />
                  <Text size="3" weight="medium">
                    {tgName
                      ? status?.telegram?.telegramUsername
                        ? t("telegram.connectedAs", { username: tgName })
                        : t("telegram.connectedAsName", { name: tgName })
                      : t("telegram.connected")}
                  </Text>
                </Flex>
                {linkedAtLabel && (
                  <Text size="2" color="gray">
                    {t("telegram.linkedAt", { date: linkedAtLabel })}
                  </Text>
                )}
                <Flex justify="end" gap="2" mt="4">
                  <Dialog.Close>
                    <Button variant="soft" color="gray">
                      {t("trackInfo.close")}
                    </Button>
                  </Dialog.Close>
                  <Button
                    color="red"
                    variant="soft"
                    onClick={onUnlink}
                    disabled={unlinking}
                  >
                    {unlinking ? (
                      <>
                        <Spinner /> {t("telegram.unlinking")}
                      </>
                    ) : (
                      t("telegram.unlink")
                    )}
                  </Button>
                </Flex>
              </Box>
            ) : (
              <Box mt="3">
                <Dialog.Description size="2" color="gray">
                  {t("telegram.dialogBody")}
                </Dialog.Description>
                {waiting && linkUrl && (
                  <Box
                    mt="3"
                    p="3"
                    style={{
                      background: "var(--blue-a3)",
                      border: "1px solid var(--blue-a6)",
                      borderRadius: "var(--radius-3)",
                    }}
                  >
                    <Flex align="center" gap="2">
                      <Spinner />
                      <Text size="2">{t("telegram.waitingHint")}</Text>
                    </Flex>
                  </Box>
                )}
                <Flex justify="end" gap="2" mt="4" wrap="wrap">
                  <Dialog.Close>
                    <Button variant="soft" color="gray">
                      {t("trackInfo.close")}
                    </Button>
                  </Dialog.Close>
                  {waiting ? (
                    <Button
                      color="blue"
                      variant="soft"
                      onClick={() => void refreshStatus()}
                    >
                      {t("telegram.refresh")}
                    </Button>
                  ) : (
                    <Button
                      color="blue"
                      onClick={onStartLink}
                      disabled={linking}
                    >
                      {linking ? (
                        <>
                          <Spinner /> {t("telegram.linking")}
                        </>
                      ) : (
                        <>
                          <PaperPlaneIcon /> {t("telegram.startLink")}
                        </>
                      )}
                    </Button>
                  )}
                </Flex>
              </Box>
            )}
          </Dialog.Content>
        </Dialog.Root>
      )}
    </>
  );
}
