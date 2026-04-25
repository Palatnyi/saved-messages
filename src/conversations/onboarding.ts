import { InlineKeyboard } from "grammy";
import { Conversation } from "@grammyjs/conversations";
import { DateTime } from "luxon";
import { type MyContext } from "../context";
import { setUserTimezone } from "../db/users";
import { upsertUser, saveReminder } from "../db/reminders";
import { encrypt } from "../utils/crypto";
import { correctRemindAt } from "../utils/time";
import { findCity } from "../services/ai";
import { i18n, resolveLocale } from "../i18n";
import { CHANGE_TZ_TRIGGER, CHANGE_LANG_TRIGGER, REMINDERS_TRIGGER } from "../triggers";
import { languageCommand } from "../commands/language";
import { handleListMessages } from "../handlers/message";

type MyConversation = Conversation<MyContext, MyContext>;

/**
 * Checks whether `query` is a non-timezone trigger, forwards to the
 * corresponding handler, and returns true — signalling the conversation
 * should exit. Returns false when the query is not a recognised trigger.
 */
async function forwardTrigger(ctx: MyContext, query: string, userId: number): Promise<boolean> {
  switch (query) {
    case CHANGE_LANG_TRIGGER:
      await languageCommand(ctx);
      return true;
    case REMINDERS_TRIGGER:
      await handleListMessages(ctx, userId);
      return true;
    default:
      return false;
  }
}

function currentTimeIn(timezone: string): string {
  return DateTime.now().setZone(timezone).toFormat("HH:mm");
}

// ── Conversation ─────────────────────────────────────────────────────────────

export async function onboardingConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const userId = ctx.from!.id;
  const username = ctx.from?.username;


  const locale = resolveLocale(ctx.from?.language_code);
  const t = (key: string, vars?: Record<string, string>): string =>
    i18n.t(locale, key, vars);

  const cancelKeyboard = new InlineKeyboard().text(t("cancel"), "cancel_tz");

  await ctx.reply(t("ask-city"), { reply_markup: cancelKeyboard });

  while (true) {
    const cityCtx = await conversation.wait();

    if (cityCtx.callbackQuery?.data === "cancel_tz") {
      await cityCtx.answerCallbackQuery();
      return;
    }

    const query = cityCtx.message?.text?.trim();
    if (!query) continue;

    if (await forwardTrigger(cityCtx, query, userId)) return;
    if (query === CHANGE_TZ_TRIGGER) { await cityCtx.reply(t("ask-city"), { reply_markup: cancelKeyboard }); continue; }

    const cityResponse = await conversation.external(async () => await findCity(query));

    if (!cityResponse.found) {
      await cityCtx.reply(t("city-not-found"));
      continue;
    }

    const { city, timezone } = cityResponse;
    const time = await conversation.external(() => currentTimeIn(timezone));
    const keyboard = new InlineKeyboard()
      .text(t("confirm-yes"), "tz_yes")
      .text(t("confirm-no"), "tz_no");

    await cityCtx.reply(t("confirm-timezone", { time, city }), {
      reply_markup: keyboard,
    });

    let confirmed = false;
    let lastCtx: MyContext = cityCtx;
    while (!confirmed) {
      const confirmCtx = await conversation.wait();
      lastCtx = confirmCtx;
      const text = confirmCtx.message?.text?.trim();

      if (text !== undefined) {
        if (await forwardTrigger(confirmCtx, text, userId)) return;
        if (text === CHANGE_TZ_TRIGGER) { await confirmCtx.reply(t("ask-city")); break; }
        continue;
      }

      const data = confirmCtx.callbackQuery?.data;
      if (!data || (data !== "tz_yes" && data !== "tz_no" && data !== "cancel_tz")) continue;

      await confirmCtx.answerCallbackQuery();
      if (data === "cancel_tz") return;
      if (data === "tz_no") { await confirmCtx.reply(t("ask-city-again"), { reply_markup: cancelKeyboard }); break; }
      confirmed = true;
    }
    if (!confirmed) continue;

    // ── User confirmed ────────────────────────────────────────────────────────
    await conversation.external(async (outerCtx) => {
      await upsertUser(userId, username);
      await setUserTimezone(userId, timezone, city);

      const pending = outerCtx.session.pendingTask;
      if (pending) {
        const encryptedPayload = encrypt(pending.intent);
        const remindAt = correctRemindAt(pending.remindAt, timezone);
        await saveReminder(userId, encryptedPayload, remindAt, pending.msgId);
        delete outerCtx.session.pendingTask;
      }
    });

    await lastCtx.reply(t("synced"));
    return;
  }
}
