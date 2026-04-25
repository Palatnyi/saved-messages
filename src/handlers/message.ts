import { InlineKeyboard } from "grammy";
import { ObjectId } from "mongodb";
import { DateTime } from "luxon";
import { type MyContext } from "../context";
import { parseReminder, transcribeAudio } from "../services/ai";
import { encrypt, decrypt } from "../utils/crypto";
import { upsertUser, saveReminder, upsertReminderByMsgId, getPendingReminders, deleteReminderById } from "../db/reminders";
import { getUserTimezone, getUserLanguageCode } from "../db/users";
import { correctRemindAt } from "../utils/time";

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
  // Fetch timezone first so the AI receives the user's local time.
  // This ensures relative terms like "tomorrow" resolve against the correct date.
  const timezone = await getUserTimezone(userId);
  const nowIso = timezone
    ? DateTime.now().setZone(timezone).toISO()!
    : new Date().toISOString();

  let result;
  try {
    result = await parseReminder(text, nowIso, replyToText);
  } catch (err) {
    console.error("[ai] parseReminder failed:", err);
    await ctx.reply(ctx.t("ai-unavailable"));
    return;
  }

  if (!result.is_reminder || !result.remind_at) return;

  if (!timezone) {
    setTimeout(async () => {
      await ctx.react("👍");
    }, 1500);
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
  // AI was given local time with offset → remind_at already carries the correct
  // offset, so a plain Date parse gives the right UTC instant.
  try {
    await upsertUser(userId, username);

    const encryptedPayload = encrypt(result.intent);
    const remindAt = correctRemindAt(result.remind_at, timezone);

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

function buildRemindersMessage(
  reminders: Awaited<ReturnType<typeof getPendingReminders>>,
  zone: string,
  locale: string
): { text: string; keyboard: InlineKeyboard } {
  const groups = new Map<string, typeof reminders>();
  for (const r of reminders) {
    const dateKey = DateTime.fromJSDate(r.remindAt).setZone(zone).toFormat("yyyy-MM-dd");
    if (!groups.has(dateKey)) groups.set(dateKey, []);
    groups.get(dateKey)!.push(r);
  }

  const keyboard = new InlineKeyboard();
  const lines: string[] = [];

  for (const [dateKey, dayReminders] of [...groups.entries()].sort()) {
    const dateLabel = DateTime.fromISO(dateKey, { zone }).setLocale(locale).toFormat("cccc, d MMM yyyy");
    lines.push(`*${dateLabel}*`);
    for (const r of dayReminders) {
      const intent = decrypt(r.encryptedPayload);
      const time = DateTime.fromJSDate(r.remindAt).setZone(zone).toFormat("HH:mm");
      lines.push(`• ${intent} — ${time}`);
      keyboard.text(`🗑 ${intent}`, `del_rem:${r._id.toHexString()}`).row();
    }
    lines.push("");
  }

  return { text: lines.join("\n").trimEnd(), keyboard };
}

const FRIENDLY_EMOJIS = ["🌟", "🎯", "🌈", "🦋", "🌸", "🚀", "🎉", "🌻", "🍀", "⚡", "🎵", "🦄", "🌊", "🍭", "🐬"];

export async function handleListMessages(ctx: MyContext, userId: number): Promise<void> {
  const [reminders, timezone, languageCode] = await Promise.all([
    getPendingReminders(userId),
    getUserTimezone(userId),
    getLanguageCode(ctx, userId),
  ]);

  if (reminders.length === 0) {
    await ctx.reply(ctx.t("no-reminders"));
    return;
  }

  const zone = timezone ?? "UTC";
  const locale = languageCode ?? "en";
  const { text, keyboard } = buildRemindersMessage(reminders, zone, locale);

  const emoji = FRIENDLY_EMOJIS[Math.floor(Math.random() * FRIENDLY_EMOJIS.length)];
  const today = DateTime.now().setZone(zone).setLocale(locale).toFormat("cccc, d MMM yyyy");
  const header = `${emoji} *${today}*\n\n`;

  await ctx.reply(header + text, { reply_markup: keyboard, parse_mode: "Markdown" });
}

export async function handleDeleteReminder(ctx: MyContext): Promise<void> {
  await ctx.answerCallbackQuery();

  const idStr = ctx.callbackQuery!.data!.slice("del_rem:".length);
  const reminderId = new ObjectId(idStr);
  const userId = ctx.from!.id;

  await deleteReminderById(reminderId);

  const [reminders, timezone, languageCode] = await Promise.all([
    getPendingReminders(userId),
    getUserTimezone(userId),
    getLanguageCode(ctx, userId),
  ]);

  if (reminders.length === 0) {
    await ctx.editMessageText(ctx.t("no-reminders"));
    return;
  }

  const zone = timezone ?? "UTC";
  const locale = languageCode ?? "en";
  const { text, keyboard } = buildRemindersMessage(reminders, zone, locale);

  await ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: "Markdown" });
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
