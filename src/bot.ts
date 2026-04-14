import "dotenv/config";
import { Bot, session } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import { onboardingConversation } from "./conversations/onboarding";
import { type MyContext, type SessionData } from "./context";
import { pingCommand } from "./commands/ping";
import { languageCommand, languageCallbackHandler } from "./commands/language";
import { handleNewMessage, handleReply } from "./handlers/message";
import { i18n, loadLocales } from "./i18n";
import { localeMiddleware } from "./middleware/locale";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN is not set in environment variables");

export const bot = new Bot<MyContext>(token);

export function setupBot(): void {
  // Load locale files before attaching middleware so translations are ready.
  loadLocales();

  // ── Middleware ───────────────────────────────────────────────────────────────
  // Session must come before i18n (i18n stores the chosen locale in session).
  bot.use(session({ initial: (): SessionData => ({}) }));
  bot.use(i18n);
  bot.use(localeMiddleware()); // reads languageCode from DB and sets ctx locale
  bot.use(conversations());
  bot.use(createConversation(onboardingConversation));

  // ── Commands ─────────────────────────────────────────────────────────────────
  bot.command("ping", pingCommand);
  bot.command(["language", "lang"], languageCommand);

  // ── Callback queries ─────────────────────────────────────────────────────────
  bot.callbackQuery(/^set_lang:/, languageCallbackHandler);

  // ── Onboarding entry point ───────────────────────────────────────────────────
  bot.callbackQuery("set_city", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("onboardingConversation");
  });

  // ── Message handlers ─────────────────────────────────────────────────────────
  bot.on("message:text", async (ctx, next) => {
    await handleNewMessage(ctx);
    await next();
  });

  bot.on("message:text", async (ctx, next) => {
    await handleReply(ctx);
    await next();
  });

  // ── Error handler ─────────────────────────────────────────────────────────────
  bot.catch((err) => {
    console.error("Bot error:", err);
  });
}
