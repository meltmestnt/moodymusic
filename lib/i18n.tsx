"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Locale = "en" | "uk";

export const LOCALES: { value: Locale; label: string; short: string }[] = [
  { value: "en", label: "English", short: "EN" },
  { value: "uk", label: "Українська", short: "UA" },
];

export const LOCALE_STORAGE_KEY = "moodymusic.locale";
const STORAGE_KEY = LOCALE_STORAGE_KEY;

const en = {
  "nav.library": "Library",
  "nav.mood": "Mood search",
  "nav.discover": "Discover",
  "nav.stats": "Stats",
  "nav.admin": "Admin",
  "auth.signInSpotify": "Sign in with Spotify",
  "auth.signInDeezer": "Sign in with Deezer",
  "auth.signInSoundCloud": "Sign in with SoundCloud",
  "auth.signInYouTube": "Sign in with YouTube",
  "auth.signOut": "Sign out",
  // ─── /auth/error page ──────────────────────────────────────────────
  "authError.title": "Sign-in didn't complete",
  "authError.body":
    "{provider} rejected the callback. This is usually a temporary cookie issue — try signing in again. If the problem persists, sign out of any other {provider} accounts in this browser and try once more.",
  "authError.codeLabel": "error: {code}",
  "authError.reconnecting": "Reconnecting to {provider}…",
  "authError.reconnectingNote": "Just sorting out a cookie hiccup, hold on.",
  "authError.goHome": "Go back home",
  "language.label": "Language",
  "home.tagline": "Match your mood to your music.",
  "home.intro":
    "Sign in with Spotify to browse your saved songs, or describe how you’re feeling and let an AI build a tiny playlist for the moment.",
  "home.previewNote":
    "Spotify Premium plays full tracks. Free accounts play 30-second previews where available.",
  "home.moodSearchTitle": "Or describe a mood without signing in",
  "home.moodSearchSubtitle":
    "Free preview powered by SoundCloud. Sign in for personalized picks and unlimited searches.",
  "home.heroEyebrow": "AI music for the moment you're in",
  "home.heroSubhead":
    "Tell us how you feel. Get a hand-crafted playlist that fits — pulled from Spotify, SoundCloud, or YouTube. No genre tags. No mood quizzes. Just words.",
  "home.ctaPrimary": "Try AI mood search",
  "home.ctaSecondary": "Sign in with Spotify",
  "home.ctaLibrary": "Go to your library",
  "home.switchProviderTitle": "Connect another platform",
  "home.switchProviderSubtitle":
    "You can sign in with a different provider — your existing session stays active until you sign out.",
  "home.howTitle": "From feeling to playlist in three steps",
  "home.howSubtitle":
    "Skip the genre rabbit hole. moodymusic listens to language, not labels.",
  "home.step1Title": "1. Describe the mood",
  "home.step1Body":
    "Type or speak how you feel — “rainy Sunday, slow start, quietly hopeful”. Anything goes. The more honest, the better.",
  "home.step2Title": "2. AI picks the songs",
  "home.step2Body":
    "Our AI reads the vibe and chooses tracks that match — across genres, eras, and moods you didn't know you wanted.",
  "home.step3Title": "3. Press play, instantly",
  "home.step3Body":
    "Plays straight from Spotify Premium, the SoundCloud widget, or YouTube. Save favorites, find similar songs, repeat.",
  "home.featuresTitle": "Built for the way you actually listen",
  "home.featuresSubtitle":
    "A music app that thinks in feelings — and respects the platform you already use.",
  "home.featureMoodTitle": "AI mood search",
  "home.featureMoodBody":
    "Free-form prompts become precise playlists. Powered by GPT — no genre menus, no preset moods.",
  "home.featureMultiTitle": "Three providers, one player",
  "home.featureMultiBody":
    "Spotify for the deep library. SoundCloud for the long tail. YouTube for everything else.",
  "home.featureLibraryTitle": "Your library, smarter",
  "home.featureLibraryBody":
    "Lightning-fast search across saved tracks. Discover learns from what you've already loved.",
  "home.featureSimilarTitle": "Find similar in one tap",
  "home.featureSimilarBody":
    "Heard something good? Surface 8 more tracks just like it — no playlist building required.",
  "home.featureStatsTitle": "Stats that mean something",
  "home.featureStatsBody":
    "See your most-asked moods, top AI-recommended artists, and how your taste changes week to week.",
  "home.featureFreeTitle": "Free preview, no signup",
  "home.featureFreeBody":
    "Search SoundCloud's public catalogue right from the home page — no account, no commitment.",
  "home.moodsTitle": "Try a mood",
  "home.moodsSubtitle":
    "Real prompts that work. Click one to see what AI hears.",
  "home.mood1": "Late drive home, headlights, melancholy but okay",
  "home.mood2": "Sunday morning espresso, soft jazz, no lyrics",
  "home.mood3": "First warm day after a long winter",
  "home.mood4": "3am coding, deep focus, no vocals",
  "home.mood5": "Heartbreak but make it dance",
  "home.mood6": "Energy for a 5k, no metal please",
  "home.finalCtaTitle": "Stop scrolling. Start feeling.",
  "home.finalCtaBody":
    "Sign in once, and every mood becomes a playlist. Or try AI mood search instantly — no account needed for a taste.",
  "home.footerTagline": "Made with care for music nerds.",
  "ai.heroEyebrow": "AI mood search",
  "ai.heroTitle": "Type a feeling. Get a playlist.",
  "ai.heroSubhead":
    "Forget genre tags and mood quizzes. Describe a moment in plain language and an AI builds a tiny playlist tuned to that exact feeling — pulled from Spotify, SoundCloud, or YouTube.",
  "ai.heroPrimary": "Try it now",
  "ai.heroSecondary": "How it works",
  "ai.heroNote": "Sign-in required for AI search. Free preview via SoundCloud on the home page.",
  "ai.demoLabel": "Live example",
  "ai.demoMood": "Late drive home, headlights, melancholy but okay",
  "ai.demoTrack1": "Holocene — Bon Iver",
  "ai.demoTrack2": "Nightcall — Kavinsky",
  "ai.demoTrack3": "A Real Hero — College & Electric Youth",
  "ai.demoTrack4": "Motion Picture Soundtrack — Radiohead",
  "ai.howTitle": "How AI mood search works",
  "ai.howSubtitle": "Three layers between your sentence and your speakers.",
  "ai.howStep1Title": "Mood parsing",
  "ai.howStep1Body":
    "GPT reads your prompt and extracts the emotional shape — energy, valence, tempo intent, lyrical preference, era hints.",
  "ai.howStep2Title": "Catalogue match",
  "ai.howStep2Body":
    "We ask the model for actual songs that fit. Not vague genre buckets — specific tracks, with the artist and title.",
  "ai.howStep3Title": "Resolve & play",
  "ai.howStep3Body":
    "Each suggestion is resolved against Spotify's catalogue and queued in your player. Misses are skipped automatically.",
  "ai.whyTitle": "Why it's better than genre browsing",
  "ai.whySubtitle":
    "Mood is high-dimensional. Genre is one dimension. moodymusic searches the whole space.",
  "ai.whyVagueTitle": "Vagueness welcome",
  "ai.whyVagueBody":
    "“Sad but I want to feel powerful” is a great prompt. The AI handles contradictions you can't put on a playlist title.",
  "ai.whyContextTitle": "Context-aware",
  "ai.whyContextBody":
    "Time of day, weather, what you're doing — all of it counts. The model picks differently for “3am coding” vs “3pm coffee”.",
  "ai.whyDiverseTitle": "Genre-blind",
  "ai.whyDiverseBody":
    "A 90s ambient track and a 2024 indie cut sit next to each other if the mood says so. No algorithm tunnel vision.",
  "ai.whyFastTitle": "Cached & fast",
  "ai.whyFastBody":
    "Repeat moods are cached server-side. The second person to ask for “heartbreak but make it dance” gets it instantly.",
  "ai.examplesTitle": "Prompts that actually work",
  "ai.examplesSubtitle":
    "Steal these. Or write your own — the weirder, the better.",
  "ai.faqTitle": "Common questions",
  "ai.faqQ1": "Do I need a Spotify Premium account?",
  "ai.faqA1":
    "No. Premium plays full tracks; free accounts get 30-second previews where Spotify provides them. SoundCloud and YouTube provide their own playback.",
  "ai.faqQ2": "Is there a free tier?",
  "ai.faqA2":
    "Yes. AI mood search needs sign-in (so we can charge the right account for AI compute), but the SoundCloud public search on the home page is free and doesn't require any account.",
  "ai.faqQ3": "Does the AI know my listening history?",
  "ai.faqA3":
    "No. We deliberately don't feed your Spotify history into the prompt — that would push the AI back toward your existing taste. Mood search is for finding new things.",
  "ai.faqQ4": "Can I save the playlists?",
  "ai.faqA4":
    "Each track has a heart button — tap it to save into your Spotify library. We don't create Spotify playlists yet, but tracks accumulate in your favorites and surface in Discover.",
  "ai.faqQ5": "Which languages does it understand?",
  "ai.faqA5":
    "Anything GPT understands. We've tested English and Ukrainian end-to-end. Speak the prompt in your own language — the AI translates internally.",
  "ai.ctaTitle": "Ready to try it?",
  "ai.ctaBody":
    "Sign in once and every mood becomes a playlist. Two minutes from now you'll have music that fits the exact moment you're in.",
  "library.title": "Your library",
  "library.subtitle":
    "Saved tracks from your Spotify account. Tap any cover to play.",
  "library.loading": "Loading your saved tracks…",
  "library.error": "Failed to load library.",
  "library.loadMore": "Load more",
  "library.loadingMore": "Loading…",
  "library.empty":
    "You don’t have any saved tracks yet — go save some on Spotify and they’ll appear here.",
  "library.searchPlaceholder": "Search by title or artist",
  "library.discoverCta": "Discover",
  "library.searchNoMatch":
    "No tracks match “{q}” in the loaded set. Try “Load more” to widen the search.",
  "mood.title": "How are you feeling?",
  "mood.subtitle":
    "Describe your mood, the moment, the weather — anything. We’ll ask an AI for songs that match and play them through Spotify.",
  "mood.placeholder":
    "Rainy Sunday morning, slow start, want to feel quietly hopeful…",
  "mood.submitHint": "⌘/Ctrl + Enter to submit",
  "voice.start": "Start voice input",
  "voice.stop": "Stop voice input",
  "voice.langCycle": "Switch voice input language",
  "voice.unsupported":
    "Voice input isn't supported in this browser. Try Chrome, Edge, or Safari.",
  "voice.permissionDenied":
    "Microphone permission denied. Allow it in your browser settings to use voice input.",
  "voice.error": "Couldn't start voice input.",
  "mood.find": "Find songs",
  "mood.finding": "Finding songs…",
  "mood.error": "Something went wrong. Please try again.",
  "mood.errorQuota":
    "We’re out of AI credits at the moment. Please try again later.",
  "mood.errorRateLimited":
    "Too many requests right now. Please wait a moment and try again.",
  "mood.errorThrottled": "Slow down — try again in {wait}.",
  "mood.errorConfig":
    "AI mood search isn’t configured on the server. Please contact the admin.",
  "mood.noResults":
    "Couldn’t find matches for that mood. Try rephrasing — a fuller description (era, vibe, activity) usually helps.",
  "mood.picks": "Picks for your mood",
  "mood.anonRemaining":
    "Free preview: {remaining} of {cap} mood searches left today. Sign in for unlimited.",
  "mood.errorAnonCap":
    "You’ve used today’s free searches. Sign in to keep going, or come back tomorrow.",
  "nowPlaying.preview": "30s preview",
  "nowPlaying.region": "Now playing",
  "nowPlaying.on": "On {device}",
  "nowPlaying.play": "Play",
  "nowPlaying.pause": "Pause",
  "nowPlaying.previous": "Previous track",
  "nowPlaying.next": "Next track",
  "nowPlaying.volume": "Volume",
  "nowPlaying.stop": "Stop preview",
  "track.noPreview":
    "No 30-second preview available for this track. Spotify Premium can play it in full.",
  // ─── Playback errors (player-context.tsx) ────────────────────────────
  "playback.notReady": "Audio player isn't ready yet — try again in a moment.",
  "playback.noPlayable":
    "No playable tracks left in this list. Try a different selection or use a Premium account.",
  "playback.autoplayBlocked":
    "Your browser blocked autoplay. Click play on the song again to start it.",
  "playback.notSupported":
    "This track's audio isn't playable in your browser right now.",
  "playback.network":
    "Network problem while loading this track. Check your internet and try again.",
  "playback.decode":
    "This track's audio is corrupted or in an unsupported format.",
  "playback.cantLoad": "Couldn't load this track's audio.",
  "playback.cantStart": "Couldn't start playback.",
  // YouTube IFrame Player error codes 100 / 101 / 150 surface here.
  "playback.notEmbeddable":
    "The uploader has disabled embedded playback for this video. Skipping…",
  "playback.videoUnavailable":
    "This video is unavailable on YouTube — it may be private, removed, or region-restricted. Skipping…",
  "playback.sessionLoading":
    "Still loading your session — try again in a second.",
  "playback.notAccepted": "Spotify didn't accept the play request.",
  // ─── SoundCloud stream errors (matching codes returned by /api/sc-stream) ─
  "sc.unauthorized":
    "You need to sign in with SoundCloud to play this track.",
  "sc.invalidId": "Couldn't play this track — missing or invalid track id.",
  "sc.sessionExpired":
    "Your SoundCloud session expired. Sign out and sign in again to refresh it.",
  "sc.streamingDenied":
    "SoundCloud won't stream this track. The app may not be approved for full-track streaming, or this track is region-restricted.",
  "sc.notFound": "This track is no longer available on SoundCloud.",
  "sc.rateLimited":
    "Hit SoundCloud's rate limit — wait a moment and try again.",
  "sc.upstream5xx":
    "SoundCloud is having a problem on its end. Try again shortly.",
  "sc.refused": "SoundCloud refused to stream this track.",
  "sc.unreachable":
    "Couldn't reach SoundCloud — check your internet and try again.",
  "track.playAria": "Play {name} by {artists}",
  "track.findSimilar": "Find similar",
  "track.findSimilarAria": "Find songs similar to {name}",
  "favorite.add": "Save to favorites",
  "favorite.remove": "Remove from favorites",
  "favorite.aria": "Toggle favorite for {name}",
  "stats.title": "Your stats",
  "stats.subtitle": "Your search history and top artists.",
  "stats.loading": "Loading stats…",
  "stats.error": "Couldn't load stats.",
  "stats.emptyTitle": "No searches yet",
  "stats.emptyBody":
    "Run a mood search and your stats will start filling in here.",
  "stats.totalSearches": "Total searches",
  "stats.uniqueMoods": "Unique moods",
  "stats.uniqueTracks": "Tracks discovered",
  "stats.cacheRate": "Cache hit rate",
  "stats.perDayTitle": "Searches per day",
  "stats.perDaySubtitle": "Last 30 days",
  "stats.topArtistsTitle": "Top artists in your picks",
  "stats.topArtistsSubtitle": "Most-recommended across every mood search",
  "stats.recentTitle": "Recent searches",
  "stats.recentRowAria": "Re-run mood search: {mood}",
  "stats.recentDeleteAria": "Delete search: {mood}",
  "stats.recentDeleteTooltip": "Delete (or swipe right)",
  "stats.searchesLabel": "searches",
  "stats.tracksLabel": "tracks",
  "stats.cachedTag": "cached",
  "trackInfo.open": "More info about {name}",
  "trackInfo.openTitle": "Track info",
  "trackInfo.close": "Close",
  "trackInfo.play": "Play",
  "trackInfo.similar": "Similar songs",
  "trackInfo.errorDetails":
    "Couldn’t load full track details — showing what we have.",
  "trackInfo.type.album": "Album",
  "trackInfo.type.single": "Single",
  "trackInfo.type.compilation": "Compilation",
  "trackInfo.trackOfTotal": "Track {n} of {total}",
  "discover.title": "Discover",
  "discover.subtitle":
    "Fresh tracks picked by AI from patterns in your saved library.",
  "discover.loading": "Listening to your library and picking…",
  "discover.error": "Couldn't fetch recommendations. Please try again.",
  "discover.errorTitle": "Couldn't load recommendations",
  "discover.throttledTitle": "Take a breather",
  "discover.throttledBody":
    "Fresh picks unlock in a moment — we keep things tidy so the AI doesn't burn out.",
  "discover.regenerate": "New picks",
  "discover.regenerating": "Picking…",
  "discover.regenerateWait": "Wait {wait}",
  "discover.emptyLibrary":
    "Save a few tracks on Spotify first — Discover learns from your library.",
  "discover.similarTitle": "Songs like “{name}”",
  "discover.similarSubtitle": "AI picks based on {name} by {artist}.",
  "discover.similarLoading": "Finding songs like “{name}”…",
  "discover.similarNoResults":
    "Couldn't find similar tracks for this one. Try another song.",
  // ─── Telegram integration ──────────────────────────────────────────
  "telegram.connect": "Connect to Telegram",
  "telegram.connectShort": "Telegram",
  "telegram.connected": "Telegram connected",
  "telegram.openBot": "Open in Telegram",
  "telegram.dialogTitle": "Connect moodymusic to Telegram",
  "telegram.dialogBody":
    "Link your moodymusic account with our Telegram bot. Once connected, your favorites and search history sync between the web app and the @moodymusic_music_bot Mini App.",
  "telegram.dialogBodyAnon":
    "Open @moodymusic_music_bot in Telegram to chat with the bot and use moodymusic as a Mini App. Sign in here first to link your account so favorites and history stay in sync.",
  "telegram.startLink": "Open Telegram and link",
  "telegram.linking": "Opening Telegram…",
  "telegram.waitingHint":
    "Tap «Start» inside Telegram. We'll detect the link automatically — keep this window open.",
  "telegram.connectedAs": "Linked to @{username}",
  "telegram.connectedAsName": "Linked to {name}",
  "telegram.linkedAt": "Connected {date}",
  "telegram.unlink": "Disconnect Telegram",
  "telegram.unlinking": "Disconnecting…",
  "telegram.unlinked": "Telegram disconnected.",
  "telegram.errorStart":
    "Couldn't start the link. Please try again in a moment.",
  "telegram.errorNotConfigured":
    "Telegram bot isn't configured on this server.",
  "telegram.errorStorage":
    "Account storage is unavailable, so linking can't work right now. You can still open the bot.",
  "telegram.refresh": "I've finished — check status",
  "telegram.sectionEyebrow": "Telegram bot",
  "telegram.sectionTitle": "moodymusic, in Telegram",
  "telegram.sectionBody":
    "Open @moodymusic_music_bot to search moods on the go, get instant suggestions in chat, and listen inside the Mini App. Connect your web account so favorites and history stay synced.",
  "telegram.sectionCtaConnect": "Connect my account",
  "telegram.sectionCtaOpen": "Open the bot",
  "telegram.footerLink": "Telegram bot",
  "telegram.signedOutNotice":
    "Sign in first to link a Telegram account. You can still open the bot as a guest.",
  // ─── Telegram Mini App (/tg) ──────────────────────────────────────────
  "tg.guestBanner": "Listening as guest — Spotify Premium unlocks full tracks.",
  "tg.signIn": "Sign in",
  "nav.menu": "Menu",
  "nav.close": "Close",
} as const;

type Key = keyof typeof en;
type Dict = Record<Key, string>;

const uk: Dict = {
  "nav.library": "Бібліотека",
  "nav.mood": "Пошук за настроєм",
  "nav.discover": "Відкриття",
  "nav.stats": "Статистика",
  "nav.admin": "Адмін",
  "auth.signInSpotify": "Увійти через Spotify",
  "auth.signInDeezer": "Увійти через Deezer",
  "auth.signInSoundCloud": "Увійти через SoundCloud",
  "auth.signInYouTube": "Увійти через YouTube",
  "auth.signOut": "Вийти",
  // ─── /auth/error page ──────────────────────────────────────────────
  "authError.title": "Вхід не завершився",
  "authError.body":
    "{provider} відхилив підтвердження. Зазвичай це тимчасова проблема з cookie — спробуй увійти ще раз. Якщо не допомогло, вийди з усіх інших акаунтів {provider} у цьому браузері та спробуй знову.",
  "authError.codeLabel": "помилка: {code}",
  "authError.reconnecting": "Перепідключаємось до {provider}…",
  "authError.reconnectingNote": "Виправляємо невелику проблему з cookie, секунду.",
  "authError.goHome": "На головну",
  "language.label": "Мова",
  "home.tagline": "Підбирай музику під свій настрій.",
  "home.intro":
    "Увійди через Spotify, щоб переглядати збережені пісні, або опиши, як ти почуваєшся — і ШІ складе невеликий плейлист на цю мить.",
  "home.previewNote":
    "Spotify Premium відтворює пісні повністю. Безкоштовні акаунти грають 30-секундні фрагменти, якщо вони доступні.",
  "home.moodSearchTitle": "Або опиши настрій — без входу",
  "home.moodSearchSubtitle":
    "Безкоштовне превʼю на базі SoundCloud. Увійди — і отримай персональні підбірки без обмежень.",
  "home.heroEyebrow": "ШІ-музика для миті, в якій ти зараз",
  "home.heroSubhead":
    "Розкажи, що відчуваєш. Отримай плейлист, який точно потрапляє у вайб — зі Spotify, SoundCloud чи YouTube. Жодних жанрів. Жодних опитувань. Лише слова.",
  "home.ctaPrimary": "Спробувати ШІ-пошук за настроєм",
  "home.ctaSecondary": "Увійти через Spotify",
  "home.ctaLibrary": "До твоєї бібліотеки",
  "home.switchProviderTitle": "Підключити іншу платформу",
  "home.switchProviderSubtitle":
    "Можеш увійти через іншого провайдера — поточна сесія залишається активною, поки не вийдеш.",
  "home.howTitle": "Від відчуття до плейлиста за три кроки",
  "home.howSubtitle":
    "Без жанрових меню — moodymusic слухає мову, а не ярлики.",
  "home.step1Title": "1. Опиши настрій",
  "home.step1Body":
    "Введи або скажи, як почуваєшся — «дощовий недільний ранок, повільний старт, тиха надія». Будь-що. Що щиріше — то краще.",
  "home.step2Title": "2. ШІ підбирає пісні",
  "home.step2Body":
    "ШІ зчитує вайб і добирає треки під нього — з різних жанрів, епох і настроїв, про які ти не здогадувався.",
  "home.step3Title": "3. Тиснеш play",
  "home.step3Body":
    "Грає прямо зі Spotify Premium, SoundCloud-віджета чи YouTube. Зберігай улюблене, шукай схоже, повторюй.",
  "home.featuresTitle": "Створено під твій спосіб слухати",
  "home.featuresSubtitle":
    "Музичний застосунок, що думає у відчуттях — і поважає платформу, якою ти вже користуєшся.",
  "home.featureMoodTitle": "ШІ-пошук за настроєм",
  "home.featureMoodBody":
    "Вільні підказки перетворюються на точні плейлисти. На основі GPT — без жанрових меню та шаблонних настроїв.",
  "home.featureMultiTitle": "Три провайдери — один плеєр",
  "home.featureMultiBody":
    "Spotify для глибокої бібліотеки. SoundCloud для нішевого. YouTube — для всього іншого.",
  "home.featureLibraryTitle": "Твоя бібліотека — розумніша",
  "home.featureLibraryBody":
    "Миттєвий пошук серед збережених треків. Discover вчиться на тому, що ти вже любиш.",
  "home.featureSimilarTitle": "Схожі — в один тап",
  "home.featureSimilarBody":
    "Сподобався трек? Покажемо 8 схожих — без ручного складання плейлиста.",
  "home.featureStatsTitle": "Статистика зі змістом",
  "home.featureStatsBody":
    "Дивись, які настрої запитуєш найчастіше, які виконавці лідирують у підбірках і як змінюється твій смак.",
  "home.featureFreeTitle": "Безкоштовне превʼю",
  "home.featureFreeBody":
    "Шукай у публічному каталозі SoundCloud прямо з головної — без акаунта.",
  "home.moodsTitle": "Спробуй настрій",
  "home.moodsSubtitle":
    "Реальні підказки, які працюють. Натисни — і дивись, що почує ШІ.",
  "home.mood1": "Нічна дорога додому, фари, легка меланхолія, але все ок",
  "home.mood2": "Недільний ранок, еспресо, мʼякий джаз без вокалу",
  "home.mood3": "Перший теплий день після довгої зими",
  "home.mood4": "3 ночі, код, глибокий фокус, без вокалу",
  "home.mood5": "Розбите серце — але танцювально",
  "home.mood6": "Енергія на пробіжку, тільки без металу",
  "home.finalCtaTitle": "Досить гортати. Починай відчувати.",
  "home.finalCtaBody":
    "Увійди один раз — і будь-який настрій стає плейлистом. Або спробуй ШІ-пошук одразу, без акаунта.",
  "home.footerTagline": "Зроблено з любовʼю до музичних задротів.",
  "ai.heroEyebrow": "ШІ-пошук за настроєм",
  "ai.heroTitle": "Напиши відчуття. Отримай плейлист.",
  "ai.heroSubhead":
    "Забудь жанрові ярлики й опитування про настрій. Опиши момент звичайними словами — ШІ збере невеликий плейлист, налаштований саме під це відчуття. Зі Spotify, SoundCloud або YouTube.",
  "ai.heroPrimary": "Спробувати зараз",
  "ai.heroSecondary": "Як це працює",
  "ai.heroNote":
    "Для ШІ-пошуку потрібен вхід. Безкоштовне превʼю — у SoundCloud на головній.",
  "ai.demoLabel": "Живий приклад",
  "ai.demoMood": "Нічна дорога додому, фари, легка меланхолія, але все ок",
  "ai.demoTrack1": "Holocene — Bon Iver",
  "ai.demoTrack2": "Nightcall — Kavinsky",
  "ai.demoTrack3": "A Real Hero — College & Electric Youth",
  "ai.demoTrack4": "Motion Picture Soundtrack — Radiohead",
  "ai.howTitle": "Як працює ШІ-пошук за настроєм",
  "ai.howSubtitle": "Три шари між твоїм реченням і колонками.",
  "ai.howStep1Title": "Розбір настрою",
  "ai.howStep1Body":
    "GPT читає підказку і витягує емоційну форму — енергію, валентність, темп, ставлення до вокалу, натяки на епоху.",
  "ai.howStep2Title": "Підбір каталогу",
  "ai.howStep2Body":
    "Просимо модель назвати реальні пісні, що пасують. Не жанри — конкретні треки з виконавцем і назвою.",
  "ai.howStep3Title": "Резолв і відтворення",
  "ai.howStep3Body":
    "Кожна пропозиція знаходиться у каталозі Spotify і додається в чергу. Те, що не знайдено — пропускаємо.",
  "ai.whyTitle": "Чому це краще за перегляд жанрів",
  "ai.whySubtitle":
    "Настрій — багатовимірний. Жанр — один вимір. moodymusic шукає у всьому просторі.",
  "ai.whyVagueTitle": "Невизначеність — це ок",
  "ai.whyVagueBody":
    "«Сумно, але хочеться відчувати силу» — чудова підказка. ШІ розуміє суперечності, які не вмістиш у назву плейлиста.",
  "ai.whyContextTitle": "Контекст",
  "ai.whyContextBody":
    "Час доби, погода, що ти робиш — усе це враховується. «3 ночі, код» дає інший підбір, ніж «3 дня, кава».",
  "ai.whyDiverseTitle": "Без жанрових тунелів",
  "ai.whyDiverseBody":
    "Ембієнт 90-х і інді 2024-го можуть стояти поруч, якщо так каже настрій. Жодного зацикленого алгоритму.",
  "ai.whyFastTitle": "Кеш і швидкість",
  "ai.whyFastBody":
    "Повторні настрої кешуються на сервері. Другому, хто запитає те ж саме — вже миттєво.",
  "ai.examplesTitle": "Підказки, що справді працюють",
  "ai.examplesSubtitle":
    "Бери ці або пиши свої — що дивніше, то краще.",
  "ai.faqTitle": "Часті питання",
  "ai.faqQ1": "Чи потрібен Spotify Premium?",
  "ai.faqA1":
    "Ні. Premium відтворює повністю; безкоштовні акаунти отримують 30-секундні фрагменти, де Spotify їх дає. SoundCloud і YouTube мають власне відтворення.",
  "ai.faqQ2": "Чи є безкоштовний тариф?",
  "ai.faqA2":
    "Так. Для ШІ-пошуку потрібен вхід (щоб правильно списати ШІ-обчислення), але публічний пошук SoundCloud на головній — безкоштовний і без акаунта.",
  "ai.faqQ3": "Чи знає ШІ мою історію прослуховувань?",
  "ai.faqA3":
    "Ні. Ми навмисно не передаємо твою Spotify-історію у запит — це зміщувало б ШІ до твого нинішнього смаку. Мета пошуку — нове.",
  "ai.faqQ4": "Чи можна зберігати плейлисти?",
  "ai.faqA4":
    "У кожного треку є серце — натисни, щоб зберегти у Spotify. Своїх плейлистів поки не створюємо, але збережене зʼявляється у Discover.",
  "ai.faqQ5": "Які мови розуміє?",
  "ai.faqA5":
    "Будь-які, що знає GPT. Перевірено англійську й українську. Пиши своєю — ШІ перекладає всередині.",
  "ai.ctaTitle": "Готовий спробувати?",
  "ai.ctaBody":
    "Один вхід — і будь-який настрій стає плейлистом. За дві хвилини матимеш музику, яка точно пасує до моменту.",
  "library.title": "Твоя бібліотека",
  "library.subtitle":
    "Збережені треки з твого акаунту Spotify. Торкнись обкладинки, щоб увімкнути.",
  "library.loading": "Завантажуємо збережені треки…",
  "library.error": "Не вдалося завантажити бібліотеку.",
  "library.loadMore": "Завантажити ще",
  "library.loadingMore": "Завантаження…",
  "library.empty":
    "Ще немає збережених треків — додай улюблені у Spotify, і вони з’являться тут.",
  "library.searchPlaceholder": "Пошук за назвою чи виконавцем",
  "library.discoverCta": "Відкрити",
  "library.searchNoMatch":
    "Серед завантажених немає треків зі збігом «{q}». Натисни «Завантажити ще», щоб розширити пошук.",
  "mood.title": "Який у тебе настрій?",
  "mood.subtitle":
    "Опиши свій настрій, момент, погоду — будь-що. Ми попросимо ШІ підібрати пісні та програємо їх через Spotify.",
  "mood.placeholder":
    "Дощовий недільний ранок, повільний початок, хочеться тихої надії…",
  "mood.submitHint": "⌘/Ctrl + Enter, щоб надіслати",
  "voice.start": "Голосовий ввід",
  "voice.stop": "Зупинити голосовий ввід",
  "voice.langCycle": "Змінити мову голосового вводу",
  "voice.unsupported":
    "Голосовий ввід не підтримується в цьому браузері. Спробуй Chrome, Edge або Safari.",
  "voice.permissionDenied":
    "Доступ до мікрофона заборонено. Дозволь його в налаштуваннях браузера.",
  "voice.error": "Не вдалося запустити голосовий ввід.",
  "mood.find": "Знайти пісні",
  "mood.finding": "Шукаємо пісні…",
  "mood.error": "Щось пішло не так. Спробуй ще раз.",
  "mood.errorQuota":
    "Наразі у нас закінчилися кредити ШІ. Спробуй пізніше.",
  "mood.errorRateLimited":
    "Забагато запитів. Зачекай кілька секунд і спробуй ще раз.",
  "mood.errorThrottled": "Не так швидко — спробуй ще раз через {wait}.",
  "mood.errorConfig":
    "Пошук за настроєм не налаштовано на сервері. Звернись до адміністратора.",
  "mood.noResults":
    "Не вдалося знайти треки для цього настрою. Спробуй переформулювати — повніший опис (епоха, вайб, заняття) зазвичай допомагає.",
  "mood.picks": "Підбірка під твій настрій",
  "mood.anonRemaining":
    "Безкоштовне превʼю: лишилось {remaining} з {cap} пошуків за настроєм на сьогодні. Увійди — і без обмежень.",
  "mood.errorAnonCap":
    "Сьогодні ти використав/-ла усі безкоштовні пошуки. Увійди, щоб продовжити, або повертайся завтра.",
  "nowPlaying.preview": "30-сек. фрагмент",
  "nowPlaying.region": "Зараз грає",
  "nowPlaying.on": "На пристрої {device}",
  "nowPlaying.play": "Відтворити",
  "nowPlaying.pause": "Пауза",
  "nowPlaying.previous": "Попередній трек",
  "nowPlaying.next": "Наступний трек",
  "nowPlaying.volume": "Гучність",
  "nowPlaying.stop": "Зупинити фрагмент",
  "track.noPreview":
    "Для цього треку немає 30-секундного фрагмента. Spotify Premium може програти його повністю.",
  "track.findSimilar": "Знайти схожі",
  "track.findSimilarAria": "Знайти пісні, схожі на {name}",
  // ─── Playback errors ────────────────────────────────────────────────
  "playback.notReady":
    "Аудіоплеєр ще не готовий — спробуй за мить.",
  "playback.noPlayable":
    "У цьому списку не залишилось треків для відтворення. Спробуй інший набір або акаунт Premium.",
  "playback.autoplayBlocked":
    "Браузер заблокував автоматичне відтворення. Натисни «грати» на пісні ще раз.",
  "playback.notSupported":
    "Аудіо цього треку зараз неможливо відтворити у твоєму браузері.",
  "playback.network":
    "Проблема з мережею при завантаженні треку. Перевір з’єднання й спробуй ще раз.",
  "playback.decode":
    "Аудіо цього треку пошкоджене або у форматі, який не підтримується.",
  "playback.cantLoad": "Не вдалося завантажити аудіо цього треку.",
  "playback.cantStart": "Не вдалося розпочати відтворення.",
  "playback.notEmbeddable":
    "Автор вимкнув вбудоване відтворення цього відео. Пропускаємо…",
  "playback.videoUnavailable":
    "Це відео недоступне на YouTube — можливо, приватне, видалене чи обмежене у твоєму регіоні. Пропускаємо…",
  "playback.sessionLoading":
    "Сесія ще завантажується — спробуй за секунду.",
  "playback.notAccepted": "Spotify не прийняв запит на відтворення.",
  // ─── SoundCloud stream errors ──────────────────────────────────────
  "sc.unauthorized":
    "Щоб увімкнути цей трек, увійди через SoundCloud.",
  "sc.invalidId":
    "Не вдалося відтворити трек — відсутній або хибний ідентифікатор.",
  "sc.sessionExpired":
    "Сесія SoundCloud закінчилась. Вийди та увійди знову, щоб оновити її.",
  "sc.streamingDenied":
    "SoundCloud не дозволяє відтворити цей трек. Можливо, додатку не дозволено повне відтворення, або трек обмежений у твоєму регіоні.",
  "sc.notFound": "Цей трек більше не доступний на SoundCloud.",
  "sc.rateLimited":
    "Перевищено ліміт запитів до SoundCloud — зачекай мить і спробуй ще раз.",
  "sc.upstream5xx":
    "У SoundCloud зараз неполадки. Спробуй пізніше.",
  "sc.refused": "SoundCloud відмовив у відтворенні цього треку.",
  "sc.unreachable":
    "Не вдалося зв’язатися з SoundCloud — перевір з’єднання й спробуй ще раз.",
  "track.playAria": "Відтворити {name} — {artists}",
  "favorite.add": "Додати в улюблене",
  "favorite.remove": "Видалити з улюбленого",
  "favorite.aria": "Перемкнути улюблене для {name}",
  "stats.title": "Твоя статистика",
  "stats.subtitle": "Історія пошуків та улюблені виконавці.",
  "stats.loading": "Завантажуємо статистику…",
  "stats.error": "Не вдалося завантажити статистику.",
  "stats.emptyTitle": "Поки що немає пошуків",
  "stats.emptyBody":
    "Зроби пошук за настроєм — і статистика почне наповнюватись.",
  "stats.totalSearches": "Усього пошуків",
  "stats.uniqueMoods": "Унікальних настроїв",
  "stats.uniqueTracks": "Знайдено треків",
  "stats.cacheRate": "Влучань у кеш",
  "stats.perDayTitle": "Пошуки за день",
  "stats.perDaySubtitle": "Останні 30 днів",
  "stats.topArtistsTitle": "Топ виконавців",
  "stats.topArtistsSubtitle":
    "Найчастіше рекомендовані по всіх пошуках за настроєм",
  "stats.recentTitle": "Останні пошуки",
  "stats.recentRowAria": "Повторити пошук: {mood}",
  "stats.recentDeleteAria": "Видалити пошук: {mood}",
  "stats.recentDeleteTooltip": "Видалити (або змахнути праворуч)",
  "stats.searchesLabel": "пошуків",
  "stats.tracksLabel": "треків",
  "stats.cachedTag": "кеш",
  "trackInfo.open": "Докладніше про {name}",
  "trackInfo.openTitle": "Інформація про трек",
  "trackInfo.close": "Закрити",
  "trackInfo.play": "Відтворити",
  "trackInfo.similar": "Схожі пісні",
  "trackInfo.errorDetails":
    "Не вдалося завантажити повну інформацію — показуємо те, що маємо.",
  "trackInfo.type.album": "Альбом",
  "trackInfo.type.single": "Сингл",
  "trackInfo.type.compilation": "Збірка",
  "trackInfo.trackOfTotal": "Трек {n} з {total}",
  "discover.title": "Відкриття",
  "discover.subtitle":
    "Свіжі треки, підібрані ШІ за патернами твоєї бібліотеки.",
  "discover.loading": "Слухаємо твою бібліотеку та підбираємо…",
  "discover.error": "Не вдалося отримати рекомендації. Спробуй ще раз.",
  "discover.errorTitle": "Не вдалося завантажити рекомендації",
  "discover.throttledTitle": "Почекай трохи",
  "discover.throttledBody":
    "Свіжі підбірки вже скоро — ми не даємо ШІ перевтомитися.",
  "discover.regenerate": "Нові підбірки",
  "discover.regenerating": "Підбираємо…",
  "discover.regenerateWait": "Зачекай {wait}",
  "discover.emptyLibrary":
    "Спочатку збережи кілька треків у Spotify — Discover вчиться з твоєї бібліотеки.",
  "discover.similarTitle": "Пісні, схожі на «{name}»",
  "discover.similarSubtitle": "Підбірка ШІ на основі {name} — {artist}.",
  "discover.similarLoading": "Шукаємо пісні, схожі на «{name}»…",
  "discover.similarNoResults":
    "Не знайшли схожих треків для цієї пісні. Спробуй іншу.",
  // ─── Telegram інтеграція ──────────────────────────────────────────
  "telegram.connect": "Підключити Telegram",
  "telegram.connectShort": "Telegram",
  "telegram.connected": "Telegram підключено",
  "telegram.openBot": "Відкрити у Telegram",
  "telegram.dialogTitle": "Підключити moodymusic до Telegram",
  "telegram.dialogBody":
    "Звʼяжи акаунт moodymusic із нашим Telegram-ботом. Після підключення улюблене та історія пошуків синхронізуються між вебверсією і Mini App у @moodymusic_music_bot.",
  "telegram.dialogBodyAnon":
    "Відкрий @moodymusic_music_bot у Telegram, щоб спілкуватися з ботом і користуватись moodymusic як Mini App. Спочатку увійди тут — і звʼяжи акаунт, щоб улюблене та історія були спільні.",
  "telegram.startLink": "Відкрити Telegram і звʼязати",
  "telegram.linking": "Відкриваємо Telegram…",
  "telegram.waitingHint":
    "Натисни «Start» у Telegram. Ми автоматично побачимо звʼязок — не закривай це вікно.",
  "telegram.connectedAs": "Підключено до @{username}",
  "telegram.connectedAsName": "Підключено до {name}",
  "telegram.linkedAt": "Підключено {date}",
  "telegram.unlink": "Відʼєднати Telegram",
  "telegram.unlinking": "Відʼєднуємо…",
  "telegram.unlinked": "Telegram відʼєднано.",
  "telegram.errorStart": "Не вдалося розпочати. Спробуй ще раз за мить.",
  "telegram.errorNotConfigured":
    "Telegram-бот не налаштований на цьому сервері.",
  "telegram.errorStorage":
    "Сховище акаунтів недоступне — звʼязати зараз не вийде. Ти все одно можеш відкрити бот.",
  "telegram.refresh": "Я завершив — перевір статус",
  "telegram.sectionEyebrow": "Telegram-бот",
  "telegram.sectionTitle": "moodymusic — у Telegram",
  "telegram.sectionBody":
    "Відкрий @moodymusic_music_bot, щоб шукати настрої на ходу, отримувати миттєві підказки у чаті й слухати в Mini App. Звʼяжи вебакаунт — і улюблене з історією будуть спільними.",
  "telegram.sectionCtaConnect": "Звʼязати акаунт",
  "telegram.sectionCtaOpen": "Відкрити бот",
  "telegram.footerLink": "Telegram-бот",
  "telegram.signedOutNotice":
    "Увійди, щоб звʼязати акаунт із Telegram. Або відкрий бот як гість.",
  // ─── Telegram Mini App (/tg) ──────────────────────────────────────────
  "tg.guestBanner":
    "Слухаєш як гість — Spotify Premium відкриває повні треки.",
  "tg.signIn": "Увійти",
  "nav.menu": "Меню",
  "nav.close": "Закрити",
};

const dictionaries: Record<Locale, Dict> = { en, uk };

interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: Key, vars?: Record<string, string>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("uk");

  // Load saved preference after mount; avoids SSR/CSR mismatch on the first
  // paint (the <html> element already has suppressHydrationWarning).
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "uk") setLocaleState(saved);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    window.localStorage.setItem(STORAGE_KEY, l);
    setLocaleState(l);
  }, []);

  const t = useCallback<I18nValue["t"]>(
    (key, vars) => {
      let out: string = dictionaries[locale][key] ?? en[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          out = out.replaceAll(`{${k}}`, v);
        }
      }
      return out;
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within LanguageProvider");
  return ctx;
}
