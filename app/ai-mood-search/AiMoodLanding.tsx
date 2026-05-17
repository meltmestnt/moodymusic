"use client";

import Link from "next/link";
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
  ChatBubbleIcon,
  CheckCircledIcon,
  GlobeIcon,
  LightningBoltIcon,
  MagicWandIcon,
  MixerHorizontalIcon,
  PlayIcon,
  RocketIcon,
  TargetIcon,
} from "@radix-ui/react-icons";
import { useI18n } from "@/lib/i18n";
import { signInWithProvider } from "@/lib/auth-client";

export function AiMoodLanding() {
  const { status } = useSession();
  const { t } = useI18n();

  const moodPrompts = [
    "home.mood1",
    "home.mood2",
    "home.mood3",
    "home.mood4",
    "home.mood5",
    "home.mood6",
  ] as const;

  const why = [
    {
      icon: <ChatBubbleIcon width="20" height="20" />,
      title: t("ai.whyVagueTitle"),
      body: t("ai.whyVagueBody"),
    },
    {
      icon: <TargetIcon width="20" height="20" />,
      title: t("ai.whyContextTitle"),
      body: t("ai.whyContextBody"),
    },
    {
      icon: <MixerHorizontalIcon width="20" height="20" />,
      title: t("ai.whyDiverseTitle"),
      body: t("ai.whyDiverseBody"),
    },
    {
      icon: <LightningBoltIcon width="20" height="20" />,
      title: t("ai.whyFastTitle"),
      body: t("ai.whyFastBody"),
    },
  ];

  const faqs = [
    { q: t("ai.faqQ1"), a: t("ai.faqA1") },
    { q: t("ai.faqQ2"), a: t("ai.faqA2") },
    { q: t("ai.faqQ3"), a: t("ai.faqA3") },
    { q: t("ai.faqQ4"), a: t("ai.faqA4") },
    { q: t("ai.faqQ5"), a: t("ai.faqA5") },
  ];

  const ctaHref = status === "authenticated" ? "/mood" : undefined;
  const handlePrimary = () => {
    if (status === "authenticated") return; // Link handles it
    signInWithProvider("spotify", { callbackUrl: "/mood" });
  };

  return (
    <div className="landing landing-ai">
      {/* ────────── HERO ────────── */}
      <section className="landing-hero landing-hero-ai">
        <div className="landing-hero-bg" aria-hidden="true">
          <div className="landing-orb landing-orb-ai-1" />
          <div className="landing-orb landing-orb-ai-2" />
          <div className="landing-orb landing-orb-ai-3" />
          <div className="landing-grid-overlay" />
        </div>

        <Container size="4" px={{ initial: "4", sm: "6" }} className="landing-hero-inner">
          <Grid
            columns={{ initial: "1", lg: "2" }}
            gap="7"
            align="center"
            className="ai-hero-grid"
          >
            <Flex direction="column" gap="5" className="ai-hero-copy">
              <Box className="landing-eyebrow">
                <span className="landing-eyebrow-dot" aria-hidden="true" />
                <Text size="2" weight="medium">
                  {t("ai.heroEyebrow")}
                </Text>
              </Box>

              <Heading
                as="h1"
                className="landing-hero-title ai-hero-title"
                size={{ initial: "8", sm: "9" }}
                weight="bold"
              >
                {t("ai.heroTitle")}
              </Heading>

              <Text size="4" color="gray" className="ai-hero-sub">
                {t("ai.heroSubhead")}
              </Text>

              <Flex gap="3" wrap="wrap" className="ai-hero-cta">
                {ctaHref ? (
                  <Button asChild size="4" color="grass" className="landing-btn-primary">
                    <Link href={ctaHref}>
                      <MagicWandIcon />
                      {t("ai.heroPrimary")}
                      <ArrowRightIcon />
                    </Link>
                  </Button>
                ) : (
                  <Button
                    size="4"
                    color="grass"
                    className="landing-btn-primary"
                    onClick={handlePrimary}
                  >
                    <MagicWandIcon />
                    {t("ai.heroPrimary")}
                    <ArrowRightIcon />
                  </Button>
                )}
                <Button asChild size="4" variant="surface" color="gray">
                  <a href="#how-it-works">
                    {t("ai.heroSecondary")}
                  </a>
                </Button>
              </Flex>

              <Text size="1" color="gray">
                {t("ai.heroNote")}
              </Text>
            </Flex>

            {/* Demo card: shows a mood → resolved playlist mock */}
            <Box className="ai-demo-card">
              <Flex justify="between" align="center" mb="3">
                <Text size="1" color="gray" weight="medium" className="ai-demo-label">
                  {t("ai.demoLabel")}
                </Text>
                <div className="ai-demo-eq" aria-hidden="true">
                  <span /><span /><span /><span /><span />
                </div>
              </Flex>
              <Box className="ai-demo-prompt">
                <Text size="3" weight="medium">
                  “{t("ai.demoMood")}”
                </Text>
              </Box>
              <Flex direction="column" gap="2" mt="3" className="ai-demo-tracks">
                {[
                  t("ai.demoTrack1"),
                  t("ai.demoTrack2"),
                  t("ai.demoTrack3"),
                  t("ai.demoTrack4"),
                ].map((track, i) => (
                  <Flex
                    key={track}
                    align="center"
                    gap="3"
                    className="ai-demo-track"
                    style={{ ["--track-index" as string]: i }}
                  >
                    <div className="ai-demo-track-icon">
                      <PlayIcon />
                    </div>
                    <Text size="2">{track}</Text>
                  </Flex>
                ))}
              </Flex>
            </Box>
          </Grid>
        </Container>
      </section>

      {/* ────────── HOW IT WORKS ────────── */}
      <section id="how-it-works" className="landing-section landing-section-how">
        <Container size="4" px={{ initial: "4", sm: "6" }}>
          <Flex direction="column" align="center" gap="6">
            <Box style={{ textAlign: "center", maxWidth: 640 }}>
              <Heading as="h2" size={{ initial: "7", sm: "8" }} weight="bold">
                {t("ai.howTitle")}
              </Heading>
              <Text size="4" color="gray" as="div" mt="3">
                {t("ai.howSubtitle")}
              </Text>
            </Box>

            <Grid columns={{ initial: "1", md: "3" }} gap="5" width="100%">
              <div className="landing-step">
                <div className="landing-step-icon">
                  <ChatBubbleIcon width="22" height="22" />
                </div>
                <Heading as="h3" size="5" weight="bold" mt="3">
                  {t("ai.howStep1Title")}
                </Heading>
                <Text size="3" color="gray" mt="2" as="div">
                  {t("ai.howStep1Body")}
                </Text>
              </div>
              <div className="landing-step" data-highlighted>
                <div className="landing-step-icon">
                  <MagicWandIcon width="22" height="22" />
                </div>
                <Heading as="h3" size="5" weight="bold" mt="3">
                  {t("ai.howStep2Title")}
                </Heading>
                <Text size="3" color="gray" mt="2" as="div">
                  {t("ai.howStep2Body")}
                </Text>
              </div>
              <div className="landing-step">
                <div className="landing-step-icon">
                  <PlayIcon width="22" height="22" />
                </div>
                <Heading as="h3" size="5" weight="bold" mt="3">
                  {t("ai.howStep3Title")}
                </Heading>
                <Text size="3" color="gray" mt="2" as="div">
                  {t("ai.howStep3Body")}
                </Text>
              </div>
            </Grid>
          </Flex>
        </Container>
      </section>

      {/* ────────── WHY IT'S BETTER ────────── */}
      <section className="landing-section landing-section-why">
        <Container size="4" px={{ initial: "4", sm: "6" }}>
          <Flex direction="column" gap="6">
            <Box style={{ textAlign: "center", maxWidth: 640, margin: "0 auto" }}>
              <Heading as="h2" size={{ initial: "7", sm: "8" }} weight="bold">
                {t("ai.whyTitle")}
              </Heading>
              <Text size="4" color="gray" as="div" mt="3">
                {t("ai.whySubtitle")}
              </Text>
            </Box>

            <Grid columns={{ initial: "1", sm: "2" }} gap="4">
              {why.map((item) => (
                <div key={item.title} className="ai-why-card">
                  <div className="ai-why-icon">{item.icon}</div>
                  <Heading as="h3" size="4" weight="bold" mt="3">
                    {item.title}
                  </Heading>
                  <Text size="2" color="gray" mt="2" as="div">
                    {item.body}
                  </Text>
                </div>
              ))}
            </Grid>
          </Flex>
        </Container>
      </section>

      {/* ────────── EXAMPLE PROMPTS ────────── */}
      <section className="landing-section landing-section-moods">
        <Container size="4" px={{ initial: "4", sm: "6" }}>
          <Flex direction="column" align="center" gap="6">
            <Box style={{ textAlign: "center", maxWidth: 640 }}>
              <Heading as="h2" size={{ initial: "7", sm: "8" }} weight="bold">
                {t("ai.examplesTitle")}
              </Heading>
              <Text size="4" color="gray" as="div" mt="3">
                {t("ai.examplesSubtitle")}
              </Text>
            </Box>

            <Flex gap="3" wrap="wrap" justify="center" className="landing-mood-pills">
              {moodPrompts.map((key, i) => {
                const label = t(key);
                // Authenticated → /mood (AI search). Anonymous → /?q=<label>
                // hands off to the home page's SoundCloud search (no login).
                const target =
                  status === "authenticated"
                    ? `/mood?q=${encodeURIComponent(label)}`
                    : `/?q=${encodeURIComponent(label)}`;
                return (
                  <Link
                    key={key}
                    href={target}
                    className="landing-mood-pill"
                    style={{ ["--pill-index" as string]: i }}
                  >
                    <RocketIcon />
                    <span>{label}</span>
                  </Link>
                );
              })}
            </Flex>
          </Flex>
        </Container>
      </section>

      {/* ────────── FAQ ────────── */}
      <section className="landing-section landing-section-faq">
        <Container size="3" px={{ initial: "4", sm: "6" }}>
          <Flex direction="column" gap="6">
            <Box style={{ textAlign: "center" }}>
              <Heading as="h2" size={{ initial: "7", sm: "8" }} weight="bold">
                {t("ai.faqTitle")}
              </Heading>
            </Box>

            <Flex direction="column" gap="3">
              {faqs.map((faq, i) => (
                <details key={i} className="ai-faq-item">
                  <summary>
                    <Text size="3" weight="medium">
                      {faq.q}
                    </Text>
                  </summary>
                  <Box pt="3">
                    <Text size="3" color="gray">
                      {faq.a}
                    </Text>
                  </Box>
                </details>
              ))}
            </Flex>
          </Flex>
        </Container>
      </section>

      {/* ────────── CTA ────────── */}
      <section className="landing-section landing-section-cta">
        <Container size="3" px={{ initial: "4", sm: "6" }}>
          <Box className="landing-cta-card">
            <div className="landing-cta-glow" aria-hidden="true" />
            <Flex direction="column" align="center" gap="5" style={{ textAlign: "center" }}>
              <Heading as="h2" size={{ initial: "7", sm: "8" }} weight="bold">
                {t("ai.ctaTitle")}
              </Heading>
              <Text size="4" color="gray" style={{ maxWidth: 540 }}>
                {t("ai.ctaBody")}
              </Text>
              <Flex gap="3" wrap="wrap" justify="center">
                {ctaHref ? (
                  <Button asChild size="4" color="grass" className="landing-btn-primary">
                    <Link href={ctaHref}>
                      <MagicWandIcon />
                      {t("ai.heroPrimary")}
                    </Link>
                  </Button>
                ) : (
                  <Button
                    size="4"
                    color="grass"
                    className="landing-btn-primary"
                    onClick={handlePrimary}
                  >
                    <MagicWandIcon />
                    {t("ai.heroPrimary")}
                  </Button>
                )}
                <Flex align="center" gap="2">
                  <CheckCircledIcon color="var(--accent-10)" />
                  <Text size="2" color="gray">
                    <GlobeIcon style={{ verticalAlign: "middle", marginRight: 4 }} />
                    EN · UA
                  </Text>
                </Flex>
              </Flex>
            </Flex>
          </Box>
        </Container>
      </section>

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
            <Flex gap="4" wrap="wrap" justify="center">
              <Link href="/" className="landing-footer-link">
                {t("home.tagline")}
              </Link>
              <Link href="/mood" className="landing-footer-link">
                {t("nav.mood")}
              </Link>
              <Link href="/discover" className="landing-footer-link">
                {t("nav.discover")}
              </Link>
            </Flex>
          </Flex>
        </Container>
      </footer>
    </div>
  );
}
