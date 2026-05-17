/**
 * moodymusic Telegram bot.
 *
 * Surfaces the moodymusic Mini App through a small command set:
 *   /start          — welcome + Open App button + mood suggestions
 *   /help           — usage reminder + mood suggestions
 *   /mood <text>    — shortcut: launches the Mini App pre-filled
 *                     with the given mood, via ?q=<text>
 *   any free text   — treated as a mood prompt and routed the same way
 *
 * All actual searching and playback happens inside the Mini App
 * (https://core.telegram.org/bots/webapps), which loads moodymusic at
 * `${WEBAPP_URL}/tg`. The bot is a thin launcher — it never calls the
 * mood-search API directly.
 *
 * Default UI language is Ukrainian. The Mini App has its own per-user
 * language picker (en / uk) that lives on top of these chat replies.
 */

// Reuse Next.js's env loader so this script reads .env.local just like
// the webapp does. @next/env walks .env, .env.local, .env.<NODE_ENV> in
// the same priority order Next applies on boot, so deploys with a
// production .env file pick up the bot token without extra plumbing.
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { Markup, Telegraf } from "telegraf";
import { message } from "telegraf/filters";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBAPP_URL = process.env.TELEGRAM_WEBAPP_URL;
// Shared secret the bot sends to /api/telegram/link/exchange. Optional —
// if it's not set, the linking flow is silently disabled and the bot
// only works as a Mini App launcher (legacy behaviour).
const LINK_API_SECRET = process.env.TELEGRAM_BOT_API_SECRET;
// Where the bot can reach the moodymusic web API. Defaults to the
// public Mini App URL since they're the same origin in production; for
// split deployments (bot off-prem, web on-prem) override via env.
const LINK_API_BASE =
  process.env.MOODYMUSIC_API_URL ?? process.env.TELEGRAM_WEBAPP_URL;

if (!BOT_TOKEN) {
  console.error(
    "[bot] TELEGRAM_BOT_TOKEN is missing. Create a bot with @BotFather and " +
      "add the token to .env.local before running `npm run bot`.",
  );
  process.exit(1);
}

if (!WEBAPP_URL) {
  console.error(
    "[bot] TELEGRAM_WEBAPP_URL is missing. Set it to the public HTTPS URL " +
      "where moodymusic is hosted (Telegram requires HTTPS for Mini Apps). " +
      "Example: https://moodymusic.app",
  );
  process.exit(1);
}

if (!/^https:\/\//.test(WEBAPP_URL)) {
  console.error(
    `[bot] TELEGRAM_WEBAPP_URL must use HTTPS (got: ${WEBAPP_URL}). Telegram ` +
      "rejects http:// Mini App URLs. For local development, expose your dev " +
      "server through a tunnel (ngrok, cloudflared) and use the HTTPS URL.",
  );
  process.exit(1);
}

// The Mini App lives at `/tg`. Strip any trailing slash so the join below
// produces a clean URL regardless of how the env var is written.
const MINI_APP_URL = `${WEBAPP_URL.replace(/\/$/, "")}/tg`;

// Telegram caps web_app button URLs at 256 characters and start_param
// at 64. Encoded mood prompts can exceed both — we truncate to keep the
// button valid; the user sees the input pre-filled with what fits, and
// can edit before submitting.
const MAX_MOOD_LEN = 180;

function moodToWebAppUrl(mood: string): string {
  const trimmed = mood.trim().slice(0, MAX_MOOD_LEN);
  if (!trimmed) return MINI_APP_URL;
  return `${MINI_APP_URL}?q=${encodeURIComponent(trimmed)}`;
}

// Preset mood suggestions surfaced as inline web_app buttons. Each tap
// opens the Mini App directly with `?q=<mood>` so the user lands on the
// results grid in a single hop — no callback round-trip needed.
//
// Kept to six so the keyboard renders as a tidy 3×2 grid on phone widths
// (Telegram packs two buttons per row when label width allows). Labels
// lead with an emoji so they're scannable in dim/cluttered chats.
const SUGGESTIONS: { label: string; mood: string }[] = [
  { label: "🌧 Дощовий вечір", mood: "дощовий вечір, тиха меланхолія" },
  { label: "☀️ Сонячний ранок", mood: "сонячний ранок, бадьорий настрій" },
  { label: "🏃 Тренування", mood: "енергійне тренування, високий темп" },
  { label: "📚 Зосередитись", mood: "глибока концентрація для роботи" },
  { label: "🌙 Пізня поїздка", mood: "нічна поїздка, спокійно але живо" },
  { label: "💖 Закоханість", mood: "м'яко-романтичний настрій" },
];

function suggestionsKeyboard(includeOpenApp: boolean) {
  const suggestionButtons = SUGGESTIONS.map((s) =>
    Markup.button.webApp(s.label, moodToWebAppUrl(s.mood)),
  );
  // 2-column layout: pair up buttons into rows of two.
  const rows: ReturnType<typeof Markup.button.webApp>[][] = [];
  for (let i = 0; i < suggestionButtons.length; i += 2) {
    rows.push(suggestionButtons.slice(i, i + 2));
  }
  if (includeOpenApp) {
    rows.push([Markup.button.webApp("🎧 Відкрити moodymusic", MINI_APP_URL)]);
  }
  return Markup.inlineKeyboard(rows);
}

function openAppKeyboard(mood?: string) {
  return Markup.inlineKeyboard([
    Markup.button.webApp(
      mood ? "🎧 Відкрити підбірку" : "🎧 Відкрити moodymusic",
      moodToWebAppUrl(mood ?? ""),
    ),
  ]);
}

const bot = new Telegraf(BOT_TOKEN);

const LINK_PAYLOAD_PREFIX = "link_";

interface ExchangeResponse {
  ok?: boolean;
  webProvider?: string;
  alreadyLinked?: boolean;
  error?: string;
}

// Calls /api/telegram/link/exchange with the link token + Telegram user
// info. Returns the parsed response or null if the API isn't reachable
// or the secret isn't configured. The bot stays usable either way —
// linking just silently no-ops on misconfigured deployments.
async function exchangeLinkToken(
  token: string,
  ctx: import("telegraf").Context,
): Promise<ExchangeResponse | null> {
  if (!LINK_API_SECRET || !LINK_API_BASE) return null;
  const from = ctx.from;
  if (!from) return null;
  try {
    const res = await fetch(
      `${LINK_API_BASE.replace(/\/$/, "")}/api/telegram/link/exchange`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Secret": LINK_API_SECRET,
        },
        body: JSON.stringify({
          token,
          telegramUserId: from.id,
          telegramUsername: from.username ?? null,
          telegramFirstName: from.first_name ?? null,
          telegramLastName: from.last_name ?? null,
        }),
      },
    );
    const json = (await res.json().catch(() => ({}))) as ExchangeResponse;
    if (!res.ok) {
      console.warn("[bot] link exchange failed", res.status, json);
      return json;
    }
    return json;
  } catch (e) {
    console.warn("[bot] link exchange request errored:", e);
    return null;
  }
}

// Telegram /start delivers the deep-link payload as the first argument.
// Telegraf normalises it onto ctx.startPayload (or the second token of
// the message text). Returns trimmed payload or "".
function readStartPayload(ctx: import("telegraf").Context): string {
  // Telegraf v4 typings don't expose ctx.startPayload on Context — it
  // lives on a narrowed StartContext. Read it via a typed cast so we
  // don't depend on a context-narrowing import path.
  const fromCtx = (ctx as unknown as { startPayload?: string }).startPayload;
  if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx.trim();
  const text =
    ctx.message && "text" in ctx.message ? ctx.message.text ?? "" : "";
  // /start <payload> or /start@bot <payload>
  const m = text.match(/^\/start(?:@\w+)?\s+(\S+)/i);
  return m?.[1]?.trim() ?? "";
}

bot.start(async (ctx) => {
  const name = ctx.from?.first_name ?? "друже";

  // Handle account-link deep links first. These come in as
  //   /start link_<base64url-token>
  // when the web app's "Connect to Telegram" button opens t.me/<bot>.
  // On success we reply with confirmation and skip the welcome blob —
  // the user came here for one purpose, give them confirmation only.
  const payload = readStartPayload(ctx);
  if (payload.startsWith(LINK_PAYLOAD_PREFIX)) {
    const token = payload.slice(LINK_PAYLOAD_PREFIX.length);
    const result = await exchangeLinkToken(token, ctx);
    if (result?.ok) {
      await ctx.reply(
        `✅ Готово, ${name}! Твій акаунт moodymusic тепер пов'язаний із Telegram.\n\n` +
          "Тепер усе, що ти зберігаєш чи слухаєш у Mini App, синхронізується з вебверсією — і навпаки.\n\n" +
          "Можеш одразу спробувати:",
        suggestionsKeyboard(true),
      );
      return;
    }
    // Token unknown / expired / server unreachable — explain and offer
    // the standard launcher so the user isn't left empty-handed.
    await ctx.reply(
      "⚠️ Не вдалося підтвердити посилання — воно могло вже бути використане або застаріло (живе 15 хв).\n\n" +
        "Відкрий moodymusic у браузері й натисни «Connect to Telegram» ще раз.\n\n" +
        "Або просто користуйся ботом:",
      openAppKeyboard(),
    );
    return;
  }

  // First-open intro: tell the user what the bot is, what it does, and
  // how to drive it — all in one tap-friendly message. Telegram fires
  // /start the first time a user opens the bot AND every time they hit
  // the "Restart" button, so this doubles as a refresher.
  await ctx.reply(
    `Привіт, ${name}! 🎧\n\n` +
      "*moodymusic* — це бот, який підбирає музику під твій настрій. " +
      "Опиши словами, як ти себе почуваєш — і ШІ збере для тебе невеличку " +
      "підбірку пісень саме під цей момент.\n\n" +
      "Як користуватись:\n" +
      "• напиши будь-який настрій у чат (наприклад «спокійний вечір з кавою»)\n" +
      "• або обери одну з готових ідей нижче\n" +
      "• треки грають прямо в Telegram\n\n" +
      "З чого почнемо?",
    { parse_mode: "Markdown", ...suggestionsKeyboard(true) },
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
    "Команди:\n" +
      "• /start — відкрити moodymusic\n" +
      "• /mood <настрій> — підбірка під конкретний настрій\n" +
      "• або просто напиши, як ти себе почуваєш.\n\n" +
      "Музика грає прямо в Telegram — повні треки для Spotify Premium, " +
      "30-секундні прев'ю для решти.\n\n" +
      "Або обери одну з готових ідей нижче:",
    suggestionsKeyboard(true),
  );
});

bot.command("mood", async (ctx) => {
  const raw = ctx.message.text ?? "";
  // Strip the leading "/mood" (or "/mood@botname") and any whitespace.
  const arg = raw.replace(/^\/mood(?:@\w+)?\s*/i, "").trim();
  if (!arg) {
    await ctx.reply(
      "Розкажи, який настрій — наприклад `/mood нічна поїздка, спокійно але живо`.\n\n" +
        "Або обери з готових нижче:",
      { parse_mode: "Markdown", ...suggestionsKeyboard(false) },
    );
    return;
  }
  await ctx.reply(
    `Збираю підбірку для: _${arg.slice(0, MAX_MOOD_LEN)}_`,
    { parse_mode: "Markdown", ...openAppKeyboard(arg) },
  );
});

// Plain text → treat as mood prompt. Filters out commands (they're
// caught above), captions, photos, etc. so we don't react to noise in
// group chats. Length-gated to avoid spam from forwarded essays.
bot.on(message("text"), async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text || text.startsWith("/")) return;
  if (text.length < 2) return;
  await ctx.reply(
    `Збираю підбірку для: _${text.slice(0, MAX_MOOD_LEN)}_`,
    { parse_mode: "Markdown", ...openAppKeyboard(text) },
  );
});

bot.catch((err, ctx) => {
  console.error(`[bot] error for update ${ctx.update.update_id}:`, err);
});

bot.launch().then(() => {
  console.log(`[bot] launched. Mini App URL: ${MINI_APP_URL}`);
});

// Graceful shutdown so the bot can be restarted cleanly during dev
// (`tsx watch`) without leaving a polling connection orphaned upstream.
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
