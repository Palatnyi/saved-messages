import { InlineKeyboard } from "grammy";
import { ObjectId } from "mongodb";
import { DateTime } from "luxon";
import { type MyContext } from "../context";
import { parseAction, transcribeAudio, type ReminderItem, type DeleteCriteria } from "../services/ai";
import { encrypt, decrypt } from "../utils/crypto";
import { upsertUser, saveReminder, upsertReminderByMsgId, getPendingReminders, deleteReminderById, deleteRemindersByIds } from "../db/reminders";
import { getUserTimezone, getUserLanguageCode } from "../db/users";
import { correctRemindAt } from "../utils/time";

import { languageCommand } from "../commands/language";
import { handleAgendaMessage } from "./agenda";
import { CHANGE_TZ_TRIGGER, CHANGE_LANG_TRIGGER, REMINDERS_TRIGGER, CHECK_AGENDA_TRIGGER } from "../triggers";

async function getLanguageCode(ctx: MyContext, userId: number): Promise<string> {
  if (ctx.session.__language_code) return ctx.session.__language_code;
  return (await getUserLanguageCode(userId)) ?? "en";
}

async function handleDeleteAction(
  ctx: MyContext,
  userId: number,
  criteria: DeleteCriteria,
  timezone: string | null
): Promise<void> {
  const all = await getPendingReminders(userId);

  if (all.length === 0) {
    await ctx.reply(ctx.t("no-reminders"));
    return;
  }

  let toDelete: typeof all;

  switch (criteria.kind) {
    case "all":
      toDelete = all;
      break;

    case "last": {
      // Sort by _id descending: ObjectId encodes insertion timestamp + counter,
      // so this reliably reflects the order records were added to the DB.
      const sorted = [...all].sort((a, b) => (b._id.toString() > a._id.toString() ? 1 : -1));
      toDelete = sorted.slice(0, criteria.count);
      break;
    }

    case "date": {
      if (!timezone) {
        const keyboard = new InlineKeyboard().text(ctx.t("set-city-button"), "set_city");
        await ctx.reply(ctx.t("got-it-ask-city"), { reply_markup: keyboard });
        return;
      }
      const target = DateTime.fromISO(criteria.date, { zone: timezone });
      toDelete = all.filter((r) =>
        DateTime.fromJSDate(r.remindAt).setZone(timezone).hasSame(target, "day")
      );
      break;
    }

    case "keywords": {
      const terms = criteria.terms.map((t) => t.toLowerCase());
      toDelete = all.filter((r) => {
        const intent = decrypt(r.encryptedPayload).toLowerCase();
        return terms.some((term) => intent.includes(term));
      });
      break;
    }
  }

  if (toDelete.length === 0) {
    await ctx.reply(ctx.t("delete-not-found"));
    return;
  }

  await deleteRemindersByIds(toDelete.map((r) => r._id));

  const lines = [ctx.t("deleted-header")];
  for (const r of toDelete) {
    const intent = decrypt(r.encryptedPayload);
    lines.push(`• ${intent}`);
  }
  console.log(`[reminder] deleted ${toDelete.length} for user ${userId} — criteria: ${JSON.stringify(criteria)}`);
  await ctx.reply(lines.join("\n"));
}

async function processMessage(
  ctx: MyContext,
  text: string,
  userId: number,
  username: string | undefined,
  msgId: number,
  replyToText?: string,
  originalMsgId?: number
): Promise<void> {
  const timezone = await getUserTimezone(userId);
  const nowIso = timezone
    ? DateTime.now().setZone(timezone).toISO()!
    : new Date().toISOString();

  let parsed;
  try {
    parsed = await parseAction(text, nowIso, replyToText);
  } catch (err) {
    console.error("[ai] parseAction failed:", err);
    await ctx.reply(ctx.t("ai-unavailable"));
    return;
  }

  if (parsed.action === "none") return;

  if (parsed.action === "delete") {
    await handleDeleteAction(ctx, userId, parsed.criteria, timezone);
    return;
  }

  // ── action === "remind" ───────────────────────────────────────────────────
  const withTime = parsed.items.filter((r: ReminderItem) => r.remind_at !== null);
  if (withTime.length === 0) return;

  if (!timezone) {
    setTimeout(async () => { await ctx.react("👍"); }, 1500);
    ctx.session.pendingTasks = withTime.map((r: ReminderItem) => ({
      intent: r.intent,
      remindAt: r.remind_at!,
      msgId,
    }));
    const keyboard = new InlineKeyboard().text(ctx.t("set-city-button"), "set_city");
    await ctx.reply(ctx.t("got-it-ask-city"), { reply_markup: keyboard });
    return;
  }

  try {
    await upsertUser(userId, username);

    for (const item of withTime) {
      const encryptedPayload = encrypt(item.intent);
      const remindAt = correctRemindAt(item.remind_at!, timezone);

      if (originalMsgId !== undefined) {
        await upsertReminderByMsgId(userId, encryptedPayload, remindAt, originalMsgId, msgId);
        console.log(`[reminder] upserted via reply for user ${userId} — intent: "${item.intent}" at ${item.remind_at}`);
      } else {
        await saveReminder(userId, encryptedPayload, remindAt, msgId);
        console.log(`[reminder] saved for user ${userId} — intent: "${item.intent}" at ${item.remind_at}`);
      }
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

  await processMessage(ctx, text, msg.from!.id, msg.from!.username, msg.message_id);
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

  await processMessage(ctx, text, from.id, from.username, msg.message_id);
}

export async function handleReply(ctx: MyContext): Promise<void> {
  const msg = ctx.message!;
  const text = msg.text!;
  const from = msg.from!;
  const replyTo = msg.reply_to_message!;

  if (replyTo?.from?.id !== from.id) return;
  if (typeof replyTo?.text !== "string") return;

  await processMessage(
    ctx,
    text,
    from.id,
    from.username,
    msg.message_id,
    replyTo.text,
    replyTo.message_id
  );
}
