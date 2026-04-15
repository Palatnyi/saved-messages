import { InlineKeyboard } from "grammy";
import { DateTime } from "luxon";
import { type MyContext } from "../context";
import { parseReminder, getWeatherEmoji, transcribeAudio } from "../services/ai";
import { encrypt, decrypt } from "../utils/crypto";
import { upsertUser, saveReminder, upsertReminderByMsgId, getPendingReminders } from "../db/reminders";
import { getUserTimezone, getUserLanguageCode, getUserCity } from "../db/users";
import { languageCommand } from "../commands/language";
import { handleAgendaMessage } from "./agenda";
import { CHANGE_TZ_TRIGGER, CHANGE_LANG_TRIGGER, REMINDERS_TRIGGER, CHECK_AGENDA_TRIGGER } from "../triggers";

async function getLanguageCode(ctx: MyContext, userId: number): Promise<string> {
  if (ctx.session.__language_code) return ctx.session.__language_code;
  return (await getUserLanguageCode(userId)) ?? "en";
}

async function processReminder(
  ctx: MyContext,
  text: string,
  userId: number,
  username: string | undefined,
  msgId: number,
  replyToText?: string,
  originalMsgId?: number
): Promise<void> {
  let result;
  try {
    result = await parseReminder(text, new Date().toISOString(), replyToText);
  } catch (err) {
    console.error("[ai] parseReminder failed:", err);
    await ctx.reply(ctx.t("ai-unavailable"));
    return;
  }

  if (!result.is_reminder || !result.remind_at ) return;

  // ── Timezone check ────────────────────────────────────────────────────────
  const timezone = await getUserTimezone(userId);

  if (!timezone) {
    setTimeout(async () => {
      await ctx.react("👍");
    }, 1500)
    // Park the task in session — the onboarding conversation will save it
    // once the correct timezone is confirmed.
    ctx.session.pendingTask = {
      intent: result.intent,
      remindAt: result.remind_at,
      msgId,
    };

    const keyboard = new InlineKeyboard().text(ctx.t("set-city-button"), "set_city");
    await ctx.reply(ctx.t("got-it-ask-city"), { reply_markup: keyboard });
    return;
  }

  // ── Normal save (timezone already known) ──────────────────────────────────
  try {
    await upsertUser(userId, username);

    const encryptedPayload = encrypt(result.intent);
    const remindAt = new Date(result.remind_at);

    if (originalMsgId !== undefined) {
      await upsertReminderByMsgId(userId, encryptedPayload, remindAt, originalMsgId, msgId);
      console.log(`[reminder] upserted via reply for user ${userId} — intent: "${result.intent}" at ${result.remind_at}`);
    } else {
      await saveReminder(userId, encryptedPayload, remindAt, msgId);
      console.log(`[reminder] saved for user ${userId} — intent: "${result.intent}" at ${result.remind_at}`);
    }

    await ctx.react("👍");
  } catch (err) {
    console.error("[reminder] failed to save:", err);
  }
}

export async function handleListMessages(ctx: MyContext, userId: number): Promise<void> {
  const [reminders, timezone, languageCode, city] = await Promise.all([
    getPendingReminders(userId),
    getUserTimezone(userId),
    getLanguageCode(ctx, userId),
    getUserCity(userId),
  ]);

  if (reminders.length === 0) {
    await ctx.reply(ctx.t("no-reminders"));
    return;
  }

  const zone = timezone ?? "UTC";
  const locale = languageCode ?? "en";
  const lines = reminders.map((r) => {
    const intent = decrypt(r.encryptedPayload);
    const date = DateTime.fromJSDate(r.remindAt).setZone(zone).setLocale(locale).toFormat("ccc, d MMM yyyy, HH:mm");
    return `• ${intent} — ${date}`;
  });

  let header = ctx.t("reminders-list");
  if (city) {
    const emoji = await getWeatherEmoji(city, new Date().toISOString()).catch(() => "");
    header = `${ctx.t("weather-header", { city, emoji })}`
  }

  await ctx.reply(`${header}\n\n${lines.join("\n")}`);
}

export async function handleNewMessage(ctx: MyContext): Promise<void> {
  const msg = ctx.message!;
  const text = msg.text!;
  const trimmed = text.trim();

  if (trimmed === CHANGE_TZ_TRIGGER) {
    await ctx.conversation.enter("onboardingConversation");
    return;
  }

  if (trimmed === CHANGE_LANG_TRIGGER) {
    await languageCommand(ctx);
    return;
  }

  if (trimmed === REMINDERS_TRIGGER) {
    await handleListMessages(ctx, msg.from!.id);
    return;
  }

  if (trimmed === CHECK_AGENDA_TRIGGER) {
    await handleAgendaMessage(ctx);
    return;
  }

  if (text.startsWith("/")) return;
  if (msg.reply_to_message) return;

  await processReminder(ctx, text, msg.from!.id, msg.from!.username, msg.message_id);
}

export async function handleVoiceMessage(ctx: MyContext): Promise<void> {
  const msg = ctx.message!;
  const from = msg.from!;
  const voice = msg.voice ?? msg.audio;
  if (!voice) return;

  const file = await ctx.api.getFile(voice.file_id);
  if (!file.file_path) {
    await ctx.reply(ctx.t("ai-unavailable"));
    return;
  }

  let text: string;
  try {
    const token = process.env.BOT_TOKEN!;
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const mimeType = voice.mime_type ?? "audio/ogg";
    text = await transcribeAudio(buffer.toString("base64"), mimeType);
  } catch (err) {
    console.error("[voice] transcription failed:", err);
    await ctx.reply(ctx.t("ai-unavailable"));
    return;
  }

  if (!text) return;

  await processReminder(ctx, text, from.id, from.username, msg.message_id);
}

export async function handleReply(ctx: MyContext): Promise<void> {
  const msg = ctx.message!;
  const text = msg.text!;
  const from = msg.from!;
  const replyTo = msg.reply_to_message!;

  if (replyTo?.from?.id !== from.id) return;
  if (typeof replyTo?.text !== "string") return;

  await processReminder(
    ctx,
    text,
    from.id,
    from.username,
    msg.message_id,
    replyTo.text,
    replyTo.message_id
  );
}
