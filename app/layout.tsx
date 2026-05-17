import "@radix-ui/themes/styles.css";
import "./globals.css";

import type { Metadata, Viewport } from "next";
import { Providers } from "./providers";
import { ThemeShell } from "@/components/ThemeShell";
import { TopBar } from "@/components/TopBar";
import { NowPlayingBar } from "@/components/NowPlayingBar";
import { Toaster } from "@/components/Toaster";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import { TrackInfoModal } from "@/components/TrackInfoModal";
import { SimilarSearchModal } from "@/components/SimilarSearchModal";

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://moodymusic.app";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "moodymusic — match your mood to your music",
    template: "%s · moodymusic",
  },
  description:
    "Describe how you feel and let AI build the perfect playlist. Sign in with Spotify, SoundCloud, or YouTube — moodymusic turns moods into music in seconds.",
  applicationName: "moodymusic",
  keywords: [
    "AI playlist generator",
    "mood music",
    "music by mood",
    "Spotify AI",
    "SoundCloud search",
    "AI DJ",
    "playlist by feeling",
    "smart music recommendations",
    "moodymusic",
  ],
  authors: [{ name: "moodymusic" }],
  creator: "moodymusic",
  publisher: "moodymusic",
  manifest: "/manifest.webmanifest",
  alternates: {
    canonical: "/",
    languages: {
      en: "/",
      uk: "/",
    },
  },
  openGraph: {
    type: "website",
    siteName: "moodymusic",
    title: "moodymusic — match your mood to your music",
    description:
      "Describe how you feel and let AI build the perfect playlist. Spotify, SoundCloud, and YouTube — all in one mood-aware player.",
    url: "/",
    locale: "uk_UA",
    images: [
      {
        url: "/icon.svg",
        width: 512,
        height: 512,
        alt: "moodymusic",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "moodymusic — match your mood to your music",
    description:
      "Describe how you feel and let AI build a tiny playlist for the moment. Spotify · SoundCloud · YouTube.",
    images: ["/icon.svg"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  category: "music",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "moodymusic",
  },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="uk" suppressHydrationWarning>
      <head>
        {/* Warm the TLS handshake to Spotify's image CDN before the
         * first album-art request. The album thumbnails come from
         * i.scdn.co; preconnecting saves ~100-200ms on the first image
         * load on a fresh page visit. crossOrigin is required so the
         * preconnect is reused for image fetches (which are CORS-clean
         * by default). */}
        <link rel="preconnect" href="https://i.scdn.co" crossOrigin="" />
        <link rel="dns-prefetch" href="https://i.scdn.co" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "WebSite",
                  "@id": `${SITE_URL}/#website`,
                  name: "moodymusic",
                  url: SITE_URL,
                  description:
                    "AI-powered music discovery. Describe your mood and get a tailored playlist from Spotify, SoundCloud, or YouTube.",
                  inLanguage: ["en", "uk"],
                  potentialAction: {
                    "@type": "SearchAction",
                    target: `${SITE_URL}/mood?q={search_term_string}`,
                    "query-input": "required name=search_term_string",
                  },
                },
                {
                  "@type": "Organization",
                  "@id": `${SITE_URL}/#organization`,
                  name: "moodymusic",
                  url: SITE_URL,
                  logo: `${SITE_URL}/icon.svg`,
                },
                {
                  "@type": "SoftwareApplication",
                  name: "moodymusic",
                  applicationCategory: "MusicApplication",
                  operatingSystem: "Web",
                  url: SITE_URL,
                  offers: {
                    "@type": "Offer",
                    price: "0",
                    priceCurrency: "USD",
                  },
                  description:
                    "Describe your mood and let AI build a playlist tailored to that exact moment.",
                },
              ],
            }),
          }}
        />
      </head>
      <body suppressHydrationWarning>
        <Providers>
          <ThemeShell>
            <TopBar />
            <main className="app-main">{children}</main>
            <NowPlayingBar />
            <TrackInfoModal />
            <SimilarSearchModal />
            <Toaster />
            <ServiceWorkerRegister />
          </ThemeShell>
        </Providers>
      </body>
    </html>
  );
}
