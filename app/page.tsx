"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Box,
  Button,
  Container,
  Flex,
  Grid,
  Heading,
  Text,
} from "@radix-ui/themes";
import {
  ArrowRightIcon,
  BarChartIcon,
  BookmarkIcon,
  HeartIcon,
  LightningBoltIcon,
  MagicWandIcon,
  Pencil2Icon,
  PlayIcon,
  SpeakerLoudIcon,
  StarIcon,
} from "@radix-ui/react-icons";
import { useI18n } from "@/lib/i18n";
import { signInWithProvider } from "@/lib/auth-client";
import { useFeatureFlag } from "@/lib/feature-flags-context";
import { TrackCard } from "@/components/TrackCard";
import { ThrottleCard } from "@/components/ThrottleCard";
import { VoiceInputButton } from "@/components/VoiceInputButton";
import { TelegramConnectButton } from "@/components/TelegramConnectButton";
import {
  MoodSearchError,
  useMoodSearch,
} from "@/lib/mood-search-context";

// Single source of truth for how many tracks the mood search asks the
// AI for. Flat 12 across every viewport — three full rows on 4-col
// desktop, six on 2-col mobile.
const MOOD_PICK_COUNT = 12;

export default function HomePage() {
  const { status } = useSession();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const deezerEnabled = useFeatureFlag("deezer");
  const soundcloudEnabled = useFeatureFlag("soundcloud");
  const youtubeEnabled = useFeatureFlag("youtube");

  // We deliberately do NOT redirect authenticated users away from the
  // landing — they can browse freely, switch providers, or jump back to
  // their library via the topbar / hero CTA.

  const searchSectionRef = useRef<HTMLElement | null>(null);

  // Mood search lives on the global provider — same store as /mood, so a
  // visitor who starts here and then navigates to /mood sees the same
  // textarea content + last result without re-asking the AI.
  const {
    mood,
    setMood,
    data: moodData,
    error: moodError,
    isLoading: moodLoading,
    isError: moodIsError,
    search: runMoodSearch,
  } = useMoodSearch();

  // Mood-search count is a constant — see MOOD_PICK_COUNT above for the
  // rationale on 12.

  // ?q=<text> on the URL → pre-fill the mood textarea, scroll to the
  // section, and submit. Used by mood pills on /ai-mood-search (and any
  // shared link) to hand off a prompt without requiring sign-in.
  useEffect(() => {
    const q = searchParams?.get("q")?.trim();
    if (!q) return;
    setMood(q);
    runMoodSearch(q, MOOD_PICK_COUNT);
    requestAnimationFrame(() => {
      searchSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
    // Run once per distinct ?q= value — the dep on searchParams handles
    // back/forward navigation that swaps the query string. setMood and
    // runMoodSearch are stable references from the provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ─── Throttle countdown (same shape as /mood) ─────────────────────────
  //
  // The mood-search API returns 429 with retryAfterSeconds for both the
  // 15s anon spacing AND the daily-cap exhaustion. We show the ring-
  // countdown only for spacing — daily-cap surfaces the inline error
  // message with a sign-in nudge instead (no point counting down 12 hours).
  const [throttledUntil, setThrottledUntil] = useState<number | null>(null);
  const [throttleTotalSec, setThrottleTotalSec] = useState(0);
  useEffect(() => {
    if (
      moodIsError &&
      moodError instanceof MoodSearchError &&
      moodError.code === "throttled"
    ) {
      const sec = moodError.retryAfterSeconds ?? 15;
      setThrottledUntil(Date.now() + sec * 1000);
      setThrottleTotalSec(sec);
    }
  }, [moodIsError, moodError]);

  const [throttleRemainingSec, setThrottleRemainingSec] = useState(0);
  useEffect(() => {
    if (throttledUntil === null) {
      setThrottleRemainingSec(0);
      return;
    }
    const tick = () => {
      const remaining = Math.max(
        0,
        Math.ceil((throttledUntil - Date.now()) / 1000),
      );
      setThrottleRemainingSec(remaining);
      if (remaining === 0) setThrottledUntil(null);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => clearInterval(id);
  }, [throttledUntil]);

  const isThrottled = throttleRemainingSec > 0;

  const onMoodSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = mood.trim();
    if (trimmed.length < 2) return;
    runMoodSearch(trimmed, MOOD_PICK_COUNT);
  };

  const moodExamples = [
    "home.mood1",
    "home.mood2",
    "home.mood3",
    "home.mood4",
    "home.mood5",
    "home.mood6",
  ] as const;

  const features = [
    {
      icon: <MagicWandIcon />,
      title: t("home.featureMoodTitle"),
      body: t("home.featureMoodBody"),
      accent: "var(--accent-9)",
    },
    {
      icon: <SpeakerLoudIcon />,
      title: t("home.featureMultiTitle"),
      body: t("home.featureMultiBody"),
      accent: "#f5a524",
    },
    {
      icon: <BookmarkIcon />,
      title: t("home.featureLibraryTitle"),
      body: t("home.featureLibraryBody"),
      accent: "#7c3aed",
    },
    {
      icon: <LightningBoltIcon />,
      title: t("home.featureSimilarTitle"),
      body: t("home.featureSimilarBody"),
      accent: "#ec4899",
    },
    {
      icon: <BarChartIcon />,
      title: t("home.featureStatsTitle"),
      body: t("home.featureStatsBody"),
      accent: "#06b6d4",
    },
    {
      icon: <HeartIcon />,
      title: t("home.featureFreeTitle"),
      body: t("home.featureFreeBody"),
      accent: "#ef4444",
    },
  ];

  return (
    <div className="landing">
      {/* ────────────────── HERO ────────────────── */}
      <section className="landing-hero">
        <div className="landing-hero-bg" aria-hidden="true">
          <div className="landing-orb landing-orb-1" />
          <div className="landing-orb landing-orb-2" />
          <div className="landing-orb landing-orb-3" />
          <div className="landing-grid-overlay" />
        </div>

        <Container size="4" px={{ initial: "4", sm: "6" }} className="landing-hero-inner">
          <Flex direction="column" align="center" gap="6" style={{ textAlign: "center" }}>
            <Box className="landing-eyebrow">
              <span className="landing-eyebrow-dot" aria-hidden="true" />
              <Text size="2" weight="medium">
                {t("home.heroEyebrow")}
              </Text>
            </Box>

            <Heading
              as="h1"
              className="landing-hero-title"
              size={{ initial: "8", sm: "9" }}
              weight="bold"
            >
              <span style={{ color: "var(--accent-10)" }}>moody</span>music
            </Heading>

            <Text className="landing-hero-tagline" size={{ initial: "5", sm: "6" }}>
              {t("home.tagline")}
            </Text>

            <Text className="landing-hero-sub" size="4" color="gray">
              {t("home.heroSubhead")}
            </Text>

            <Flex gap="3" wrap="wrap" justify="center" className="landing-hero-cta">
              {status === "authenticated" ? (
                <Button asChild size={{ initial: "3", sm: "4" }} color="grass" className="landing-btn-primary">
                  <Link href="/library">
                    <BookmarkIcon />
                    {t("home.ctaLibrary")}
                    <ArrowRightIcon />
                  </Link>
                </Button>
              ) : (
                <Button
                  size={{ initial: "3", sm: "4" }}
                  color="grass"
                  className="landing-btn-primary"
                  onClick={() =>
                    signInWithProvider("spotify", { callbackUrl: "/library" })
                  }
                >
                  {t("home.ctaSecondary")}
                </Button>
              )}
              <TelegramConnectButton variant="primary" />
              {/* <Button asChild size={{ initial: "3", sm: "4" }} variant="soft" color="violet">
                <Link className="ai-btn-primary" href="/ai-mood-search">
                  <MagicWandIcon />
                  {t("home.ctaPrimary")}
                  <ArrowRightIcon />
                </Link>
              </Button> */}

               {status !== "authenticated" && (
              <Flex
                gap="3"
                wrap="wrap"
                justify="center"
                className="landing-provider-row"
              >
                {deezerEnabled && (
                  <Button
                    variant="soft"
                    size={{ initial: "3", sm: "4" }}
                    color="purple"
                    className="landing-btn-provider"
                    onClick={() =>
                      signInWithProvider("deezer", { callbackUrl: "/library" })
                    }
                  >
                    {t("auth.signInDeezer")}
                  </Button>
                )}
                {soundcloudEnabled && (
                  <Button
                    variant="soft"
                    size={{ initial: "3", sm: "4" }}
                    color="orange"
                    className="landing-btn-provider"
                    onClick={() =>
                      signInWithProvider("soundcloud", { callbackUrl: "/library" })
                    }
                  >
                    {t("auth.signInSoundCloud")}
                  </Button>
                )}
                {youtubeEnabled && (
                  <Button
                    variant="soft"
                    size={{ initial: "3", sm: "4" }}
                    color="red"
                    className="landing-btn-provider"
                    onClick={() =>
                      signInWithProvider("youtube", { callbackUrl: "/library" })
                    }
                  >
                    {t("auth.signInYouTube")}
                  </Button>
                )}
              </Flex>
            )}
            </Flex>

           

            <Text size="1" color="gray" className="landing-preview-note">
              {t("home.previewNote")}
            </Text>
          </Flex>
        </Container>
      </section>

      {/* ────────────────── FREE MOOD SEARCH (anon only) ────────────────── */}
      {status !== "authenticated" && (
        <section
          ref={searchSectionRef}
          className="landing-section landing-section-search"
        >
          <Container size="4" px={{ initial: "4", sm: "6" }}>
            <Flex direction="column" gap="4">
              <Box style={{ textAlign: "center" }}>
                <Heading as="h2" size="6" weight="bold">
                  {t("home.moodSearchTitle")}
                </Heading>
                <Text size="3" color="gray" as="div" mt="2">
                  {t("home.moodSearchSubtitle")}
                </Text>
                {moodData?.anon && (
                  <Text size="2" color="gray" as="div" mt="2">
                    {t("mood.anonRemaining", {
                      remaining: String(moodData.anon.remaining),
                      cap: String(moodData.anon.cap),
                    })}
                  </Text>
                )}
              </Box>

              {isThrottled ? (
                <ThrottleCard
                  remainingSec={throttleRemainingSec}
                  totalSec={throttleTotalSec}
                  title={t("discover.throttledTitle")}
                  body={t("discover.throttledBody")}
                />
              ) : (
                <form onSubmit={onMoodSubmit} aria-busy={moodLoading || undefined}>
                  <Flex className="landing-mood-search" direction="column" gap="3">
                    <div className="mood-input-stage">
                      <Box
                        className="running-ring mood-input-wrap"
                        data-loading={moodLoading ? "true" : undefined}
                        role={moodLoading ? "status" : undefined}
                        aria-live="polite"
                        aria-label={moodLoading ? t("mood.finding") : undefined}
                      >
                        <textarea
                          className="mood-input"
                          placeholder={t("mood.placeholder")}
                          value={mood}
                          onChange={(e) => setMood(e.target.value)}
                          onKeyDown={(e) => {
                            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                              onMoodSubmit(e);
                            }
                          }}
                          disabled={moodLoading}
                          aria-hidden={moodLoading || undefined}
                        />
                        <div className="mood-loader-eq" aria-hidden="true">
                          <span />
                          <span />
                          <span />
                          <span />
                          <span />
                        </div>
                      </Box>
                    </div>
                    <Flex
                      className="mood-actions"
                      data-loading={moodLoading ? "true" : undefined}
                      justify="between"
                      align="center"
                      gap="3"
                      wrap="wrap"
                    >
                      <VoiceInputButton
                        value={mood}
                        onChange={setMood}
                        disabled={moodLoading}
                      />
                      <Flex align="center" gap="3">
                        <Text size="1" color="gray">
                          {t("mood.submitHint")}
                        </Text>
                        <Button
                          size="3"
                          type="submit"
                          disabled={moodLoading || mood.trim().length < 2}
                        >
                          <MagicWandIcon />
                          {moodLoading ? t("mood.finding") : t("mood.find")}
                        </Button>
                      </Flex>
                    </Flex>
                  </Flex>
                </form>
              )}

              {moodIsError && !isThrottled && (
                <Text size="2" color="red" align="center">
                  {(() => {
                    const code =
                      moodError instanceof MoodSearchError
                        ? moodError.code
                        : "upstream_error";
                    if (code === "quota_exceeded") return t("mood.errorQuota");
                    if (code === "rate_limited")
                      return t("mood.errorRateLimited");
                    if (code === "config_error") return t("mood.errorConfig");
                    if (code === "anon_daily_cap")
                      return t("mood.errorAnonCap");
                    return t("mood.error");
                  })()}
                </Text>
              )}

              {moodData && moodData.tracks.length === 0 && !moodLoading && (
                <Text size="2" color="gray" align="center">
                  {t("mood.noResults")}
                </Text>
              )}

              {moodData && moodData.tracks.length > 0 && (
                <Grid
                  columns={{ initial: "1", xs: "2", md: "3", lg: "4" }}
                  gap={{ initial: "3", md: "4" }}
                >
                  {(() => {
                    const list = moodData.tracks.map((p) => p.track);
                    return list.map((track, i) => (
                      <div
                        key={`${track.id}-${i}`}
                        className="discover-card-stagger"
                        style={{ ["--card-index" as string]: i }}
                      >
                        <TrackCard
                          track={track}
                          index={i}
                          queue={list}
                          source="mood"
                        />
                      </div>
                    ));
                  })()}
                </Grid>
              )}
            </Flex>
          </Container>
        </section>
      )}

      {/* ─────── CONNECT ANOTHER PLATFORM (logged-in only) ─────── */}
      {status === "authenticated" &&
        (deezerEnabled || soundcloudEnabled || youtubeEnabled) && (
          <section className="landing-section landing-section-providers">
            <Container size="3" px={{ initial: "4", sm: "6" }}>
              <Flex direction="column" align="center" gap="4">
                <Box style={{ textAlign: "center", maxWidth: 540 }}>
                  <Heading as="h2" size="6" weight="bold">
                    {t("home.switchProviderTitle")}
                  </Heading>
                  <Text size="3" color="gray" as="div" mt="2">
                    {t("home.switchProviderSubtitle")}
                  </Text>
                </Box>
                <Flex
                  gap="3"
                  wrap="wrap"
                  justify="center"
                  className="landing-provider-row"
                >
                  <Button
                    size="3"
                    variant="soft"
                    color="grass"
                    className="landing-btn-provider"
                    onClick={() =>
                      signInWithProvider("spotify", { callbackUrl: "/library" })
                    }
                  >
                    {t("auth.signInSpotify")}
                  </Button>
                  {deezerEnabled && (
                    <Button
                      size="3"
                      variant="soft"
                      color="purple"
                      className="landing-btn-provider"
                      onClick={() =>
                        signInWithProvider("deezer", {
                          callbackUrl: "/library",
                        })
                      }
                    >
                      {t("auth.signInDeezer")}
                    </Button>
                  )}
                  {soundcloudEnabled && (
                    <Button
                      size="3"
                      variant="soft"
                      color="orange"
                      className="landing-btn-provider"
                      onClick={() =>
                        signInWithProvider("soundcloud", {
                          callbackUrl: "/library",
                        })
                      }
                    >
                      {t("auth.signInSoundCloud")}
                    </Button>
                  )}
                  {youtubeEnabled && (
                    <Button
                      size="3"
                      variant="soft"
                      color="red"
                      className="landing-btn-provider"
                      onClick={() =>
                        signInWithProvider("youtube", {
                          callbackUrl: "/library",
                        })
                      }
                    >
                      {t("auth.signInYouTube")}
                    </Button>
                  )}
                </Flex>
              </Flex>
            </Container>
          </section>
        )}

      {/* ────────────────── TELEGRAM BOT ────────────────── */}
      <section className="landing-section landing-section-telegram">
        <Container size="3" px={{ initial: "4", sm: "6" }}>
          <Box className="landing-cta-card">
            <div className="landing-cta-glow" aria-hidden="true" />
            <Flex direction="column" align="center" gap="4" style={{ textAlign: "center" }}>
              <Box className="landing-eyebrow">
                <span className="landing-eyebrow-dot" aria-hidden="true" />
                <Text size="2" weight="medium">
                  {t("telegram.sectionEyebrow")}
                </Text>
              </Box>
              <Heading as="h2" size={{ initial: "7", sm: "8" }} weight="bold">
                {t("telegram.sectionTitle")}
              </Heading>
              <Text size="4" color="gray" style={{ maxWidth: 540 }}>
                {t("telegram.sectionBody")}
              </Text>
              <Flex gap="3" wrap="wrap" justify="center" className="landing-hero-cta">
                <TelegramConnectButton variant="primary" />
              </Flex>
              {status !== "authenticated" && (
                <Text size="1" color="gray">
                  {t("telegram.signedOutNotice")}
                </Text>
              )}
            </Flex>
          </Box>
        </Container>
      </section>

      {/* ────────────────── HOW IT WORKS ────────────────── */}
      <section className="landing-section landing-section-how">
        <Container size="4" px={{ initial: "4", sm: "6" }}>
          <Flex direction="column" align="center" gap="6">
            <Box style={{ textAlign: "center", maxWidth: 640 }}>
              <Heading as="h2" size={{ initial: "7", sm: "8" }} weight="bold">
                {t("home.howTitle")}
              </Heading>
              <Text size="4" color="gray" as="div" mt="3">
                {t("home.howSubtitle")}
              </Text>
            </Box>

            <Grid columns={{ initial: "1", md: "3" }} gap="5" width="100%">
              <Step
                icon={<Pencil2Icon width="22" height="22" />}
                title={t("home.step1Title")}
                body={t("home.step1Body")}
              />
              <Step
                icon={<MagicWandIcon width="22" height="22" />}
                title={t("home.step2Title")}
                body={t("home.step2Body")}
                highlighted
              />
              <Step
                icon={<PlayIcon width="22" height="22" />}
                title={t("home.step3Title")}
                body={t("home.step3Body")}
              />
            </Grid>
          </Flex>
        </Container>
      </section>

      {/* ────────────────── FEATURES ────────────────── */}
      <section className="landing-section landing-section-features">
        <Container size="4" px={{ initial: "4", sm: "6" }}>
          <Flex direction="column" gap="6">
            <Box style={{ textAlign: "center", maxWidth: 640, margin: "0 auto" }}>
              <Heading as="h2" size={{ initial: "7", sm: "8" }} weight="bold">
                {t("home.featuresTitle")}
              </Heading>
              <Text size="4" color="gray" as="div" mt="3">
                {t("home.featuresSubtitle")}
              </Text>
            </Box>

            <Grid columns={{ initial: "1", sm: "2", lg: "3" }} gap="4">
              {features.map((f) => (
                <FeatureCard key={f.title} {...f} />
              ))}
            </Grid>
          </Flex>
        </Container>
      </section>

      {/* ─── MOODS YOU CAN TRY (logged-in users only) ─────────── */}
      {status === "authenticated" && (
        <section className="landing-section landing-section-moods">
          <Container size="4" px={{ initial: "4", sm: "6" }}>
            <Flex direction="column" align="center" gap="6">
              <Box style={{ textAlign: "center", maxWidth: 640 }}>
                <Heading as="h2" size={{ initial: "7", sm: "8" }} weight="bold">
                  {t("home.moodsTitle")}
                </Heading>
                <Text size="4" color="gray" as="div" mt="3">
                  {t("home.moodsSubtitle")}
                </Text>
              </Box>

              <Flex
                gap="3"
                wrap="wrap"
                justify="center"
                className="landing-mood-pills"
              >
                {moodExamples.map((key, i) => {
                  const label = t(key);
                  return (
                    <Link
                      key={key}
                      href={`/mood?q=${encodeURIComponent(label)}`}
                      className="landing-mood-pill"
                      style={{ ["--pill-index" as string]: i }}
                    >
                      <StarIcon />
                      <span>{label}</span>
                    </Link>
                  );
                })}
              </Flex>
            </Flex>
          </Container>
        </section>
      )}

      {/* ────────────────── FINAL CTA ────────────────── */}
      <section className="landing-section landing-section-cta">
        <Container size="3" px={{ initial: "4", sm: "6" }}>
          <Box className="landing-cta-card">
            <div className="landing-cta-glow" aria-hidden="true" />
            <Flex direction="column" align="center" gap="5" style={{ textAlign: "center" }}>
              <Heading as="h2" size={{ initial: "7", sm: "8" }} weight="bold">
                {t("home.finalCtaTitle")}
              </Heading>
              <Text size="4" color="gray" style={{ maxWidth: 540 }}>
                {t("home.finalCtaBody")}
              </Text>
              <Flex gap="3" wrap="wrap" justify="center" className="landing-hero-cta">
                <Button
                  size={{ initial: "3", sm: "4" }}
                  color="grass"
                  className="landing-btn-primary"
                  onClick={() =>
                    signInWithProvider("spotify", { callbackUrl: "/library" })
                  }
                >
                  {t("home.ctaSecondary")}
                </Button>
                <Button asChild size={{ initial: "4" }} variant="soft" color="violet">
                  <Link className="landing-ai-btn" href="/ai-mood-search">
                    <MagicWandIcon />
                    {t("home.ctaPrimary")}
                  </Link>
                </Button>
              </Flex>
            </Flex>
          </Box>
        </Container>
      </section>

      {/* ────────────────── FOOTER ────────────────── */}
      <footer className="landing-footer">
        <Container size="4" px={{ initial: "4", sm: "6" }}>
          <Flex
            direction={{ initial: "column", sm: "row" }}
            align="center"
            justify="between"
            gap="3"
          >
            <Text size="2" color="gray">
              <span style={{ color: "var(--accent-10)" }}>moody</span>music · {t("home.footerTagline")}
            </Text>
            <Flex gap="4" wrap="wrap" justify="center" align="center">
              <Link href="/ai-mood-search" className="landing-footer-link">
                {t("ai.heroEyebrow")}
              </Link>
              <Link href="/mood" className="landing-footer-link">
                {t("nav.mood")}
              </Link>
              <Link href="/discover" className="landing-footer-link">
                {t("nav.discover")}
              </Link>
              <TelegramConnectButton variant="footer" />
            </Flex>
          </Flex>
        </Container>
      </footer>
    </div>
  );
}

const EXAMPLE_KEYS = {
  "home.mood1": true,
  "home.mood2": true,
  "home.mood3": true,
  "home.mood4": true,
  "home.mood5": true,
  "home.mood6": true,
} as const;

function Step({
  icon,
  title,
  body,
  highlighted,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  highlighted?: boolean;
}) {
  return (
    <div className="landing-step" data-highlighted={highlighted || undefined}>
      <div className="landing-step-icon">{icon}</div>
      <Heading as="h3" size="5" weight="bold" mt="3">
        {title}
      </Heading>
      <Text size="3" color="gray" mt="2" as="div">
        {body}
      </Text>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  body,
  accent,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  accent: string;
}) {
  return (
    <div
      className="landing-feature-card"
      style={{ ["--feature-accent" as string]: accent }}
    >
      <div className="landing-feature-icon">{icon}</div>
      <Heading as="h3" size="4" weight="bold" mt="3">
        {title}
      </Heading>
      <Text size="2" color="gray" mt="2" as="div">
        {body}
      </Text>
    </div>
  );
}
