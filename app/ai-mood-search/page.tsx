import type { Metadata } from "next";
import { AiMoodLanding } from "./AiMoodLanding";

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://moodymusic.app";

export const metadata: Metadata = {
  title: "AI Mood Search — Type a feeling, get a playlist",
  description:
    "Describe a mood in plain language and an AI builds a playlist tuned to that exact moment. Spotify, SoundCloud, and YouTube — no genre tags, no quizzes.",
  keywords: [
    "AI mood search",
    "AI playlist generator",
    "music by feeling",
    "mood to playlist",
    "GPT music recommendations",
    "Spotify AI playlist",
    "SoundCloud AI",
    "YouTube AI playlist",
    "smart music discovery",
  ],
  alternates: {
    canonical: "/ai-mood-search",
  },
  openGraph: {
    type: "website",
    title: "AI Mood Search — Type a feeling, get a playlist",
    description:
      "Describe a mood in plain language and an AI builds a playlist tuned to that exact moment.",
    url: "/ai-mood-search",
    siteName: "moodymusic",
    images: [
      {
        url: "/icon.svg",
        width: 512,
        height: 512,
        alt: "moodymusic AI mood search",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "AI Mood Search — Type a feeling, get a playlist",
    description:
      "Describe a mood in plain language and an AI builds a playlist tuned to that exact moment.",
    images: ["/icon.svg"],
  },
  robots: {
    index: true,
    follow: true,
  },
};

const AI_FAQ_JSONLD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "Do I need a Spotify Premium account?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "No. Premium plays full tracks; free accounts get 30-second previews where Spotify provides them. SoundCloud and YouTube provide their own playback.",
      },
    },
    {
      "@type": "Question",
      name: "Is there a free tier?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes. AI mood search needs sign-in, but the SoundCloud public search on the home page is free and doesn't require any account.",
      },
    },
    {
      "@type": "Question",
      name: "Does the AI know my listening history?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "No. We deliberately don't feed your Spotify history into the prompt — that would push the AI back toward your existing taste. Mood search is for finding new things.",
      },
    },
    {
      "@type": "Question",
      name: "Can I save the playlists?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Each track has a heart button — tap it to save into your Spotify library. Saved tracks accumulate in your favorites and surface in Discover.",
      },
    },
    {
      "@type": "Question",
      name: "Which languages does it understand?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Anything GPT understands. We've tested English and Ukrainian end-to-end. Speak the prompt in your own language — the AI translates internally.",
      },
    },
  ],
};

const AI_HOWTO_JSONLD = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  name: "How to use AI mood search",
  description:
    "Three steps from a sentence describing how you feel to a playlist that fits.",
  step: [
    {
      "@type": "HowToStep",
      position: 1,
      name: "Describe the mood",
      text: "Type or speak a sentence describing how you feel — context, weather, time of day all help.",
    },
    {
      "@type": "HowToStep",
      position: 2,
      name: "AI picks the songs",
      text: "GPT reads your prompt and chooses tracks that fit the emotional shape across genres and eras.",
    },
    {
      "@type": "HowToStep",
      position: 3,
      name: "Press play",
      text: "Tracks are resolved against Spotify's catalogue and queued in the player. Save favorites or find similar.",
    },
  ],
};

export default function AiMoodSearchPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([AI_FAQ_JSONLD, AI_HOWTO_JSONLD]),
        }}
      />
      <link
        rel="canonical"
        href={`${SITE_URL}/ai-mood-search`}
      />
      <AiMoodLanding />
    </>
  );
}
