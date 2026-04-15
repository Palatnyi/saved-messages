import { InlineKeyboard } from "grammy";
import { DateTime } from "luxon";
import { type MyContext } from "../context";
import { getTodayReminders } from "../db/reminders";
import { getUserTimezone, getUserLanguageCode } from "../db/users";
import { decrypt } from "../utils/crypto";

async function buildAgendaText(
  ctx: MyContext,
  userId: number
): Promise<string> {
  const [timezone, languageCode] = await Promise.all([
    getUserTimezone(userId),
    getUserLanguageCode(userId),
  ]);

  const zone = timezone ?? "UTC";
  const locale = languageCode ?? "en";
  const localNow = DateTime.now().setZone(zone);
  const startUtc = localNow.startOf("day").toUTC().toJSDate();
  const endUtc = localNow.endOf("day").toUTC().toJSDate();

  const reminders = await getTodayReminders(userId, startUtc, endUtc);

  if (reminders.length === 0) return ctx.t("agenda-empty");

  const lines = reminders.map((r) => {
    const intent = decrypt(r.encryptedPayload);
    const time = DateTime.fromJSDate(r.remindAt)
      .setZone(zone)
      .setLocale(locale)
      .toFormat("HH:mm");
    return `• ${intent} — ${time}`;
  });

  return `${ctx.t("agenda-header")}\n\n${lines.join("\n")}`;
}

/** Called from the inline keyboard "Yes, show me" button — edits the nudge message. */
export async function handleAgendaShow(ctx: MyContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const text = await buildAgendaText(ctx, ctx.from!.id);
  await ctx.editMessageText(text);
}

/** Called from the /check_agenda text command — reproduces the full morning nudge flow. */
export async function handleAgendaMessage(ctx: MyContext): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text(ctx.t("agenda-show-btn"), "agenda_show")
    .text(ctx.t("agenda-later-btn"), "agenda_later");

  await ctx.reply(ctx.t("agenda-nudge"), { reply_markup: keyboard });
}

export async function handleAgendaLater(ctx: MyContext): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage();
}
