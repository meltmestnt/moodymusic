# moodymusic

Small Next.js + TypeScript + Radix UI webapp.

- Sign in with Spotify, browse your saved tracks, and play them with a
  circular equalizer animation over the album art.
- Describe your mood on `/mood` — an LLM proposes songs that match, we
  resolve each to a real Spotify track and play it inline.

## Stack

- Next.js 15 (App Router) + React 19 + TypeScript
- `@radix-ui/themes` (dark, `accentColor="grass"`)
- `next-auth` Spotify provider
- `@tanstack/react-query`
- `openai` (Chat Completions, `gpt-4o-mini` by default, JSON mode)
- Spotify Web Playback SDK (Premium) with HTMLAudio preview-URL fallback
- MongoDB *(optional)* — analytics persistence for searches / plays /
  favorites. Skipped gracefully if `MONGODB_URI` isn't set.

## Setup

1. **Spotify** — create an app at <https://developer.spotify.com/dashboard>.
   Add `http://127.0.0.1:3001/api/auth/callback/spotify` as a redirect URI
   (or whichever host:port you'll run dev on — it must match NEXTAUTH_URL
   exactly). Spotify rejects `localhost` for new apps, so use `127.0.0.1`.
   Copy the client id and secret.

2. **OpenAI** — grab a key from <https://platform.openai.com/api-keys>.

3. **MongoDB** *(optional, for analytics persistence)* — easiest path is
   the bundled docker-compose stack:

   ```bash
   npm run db:up        # starts mongo + mongo-express on 27017 / 8081
   ```

   The default `.env.local` already points at it. Browse the data at
   <http://localhost:8081>. If you'd rather use Atlas, swap `MONGODB_URI`
   for the Atlas connection string. With the URI blank the app simply
   skips logging and runs unchanged. Indexes auto-create on first use.

   Other db scripts: `npm run db:down` (stop), `npm run db:reset` (stop
   + wipe volume), `npm run db:logs`, `npm run db:shell` (mongosh).

4. **Env** — copy `.env.example` to `.env.local` and fill it in. Generate
   `NEXTAUTH_SECRET` with `openssl rand -base64 32`.

5. **Install & run:**

   ```bash
   npm install
   npm run dev
   ```

   Open <http://localhost:3000>.

## Telegram bot

`npm run bot` launches a Telegram bot that opens moodymusic as a Mini App
inside Telegram. The bot itself is a thin launcher — all searching and
playback happen inside the Mini App, which mounts the existing webapp at
`/tg`.

1. Talk to <https://t.me/BotFather>:
   - `/newbot` to create a bot and receive a token.
   - `/setdomain` — set it to your HTTPS URL (e.g. `moodymusic.app`).
2. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBAPP_URL` in `.env.local`.
   Telegram requires HTTPS for Mini Apps; for local dev expose the dev
   server through a tunnel (e.g. `ngrok http 3001`) and use that URL.
3. `npm run bot` (one-shot) or `npm run bot:dev` (auto-restart on edits).

Commands the bot exposes:
- `/start` — welcome + Open App button
- `/mood <vibe>` — launches the Mini App with the prompt pre-filled
- Any plain text — same as `/mood`, treats the message as a mood

The Mini App works for guests via the existing anonymous SoundCloud
fallback. A "Sign in" pill in the header opens the standard Spotify
OAuth flow for Premium users who want full-track playback.

## Playback notes

- Spotify **Premium** accounts play full tracks via the Web Playback SDK.
- **Free / open** accounts can only play 30-second `preview_url` clips, and
  some tracks have no preview at all (those cards render dimmed with a
  tooltip). This is a Spotify API restriction, not something we can work
  around client-side.

## Layout

```
app/
  api/auth/[...nextauth]/route.ts   NextAuth (Spotify)
  api/library/route.ts              Server-side proxy of /me/tracks
  api/mood-search/route.ts          OpenAI → resolve → Spotify search
  layout.tsx, page.tsx              Theme + landing
  library/page.tsx                  Saved-tracks grid
  mood/page.tsx                     Mood input + results
  tg/page.tsx                       Telegram Mini App entrypoint
components/
  TopBar.tsx                        Sticky header w/ sign-in
  TrackCard.tsx                     Square card, round art, equalizer
  Equalizer.tsx                     36-bar circular pulse
  NowPlayingBar.tsx                 Fixed bottom playback control
lib/
  auth.ts                           NextAuth options + token refresh
  spotify.ts                        Web API client
  player-context.tsx                SDK + preview unified player
bot/
  index.ts                          Telegram bot (telegraf launcher)
types/
  next-auth.d.ts                    Session augmentation
  spotify-web-playback-sdk.d.ts     Minimal SDK typings
```
