import { InlineKeyboard } from "grammy";
import { DateTime } from "luxon";
import { bot } from "../bot";
import { getTodayReminders } from "../db/reminders";
import { getUsersWithTimezone, markNudgeSent } from "../db/users";
import { i18n, resolveLocale } from "../i18n";

const NUDGE_HOUR = 7; // 07:00 in the user's local timezone
const INTERVAL_MS = 60_000;

async function checkAndSendAgenda(): Promise<void> {
  let users;
  try {
    users = await getUsersWithTimezone();
  } catch (err) {
    console.error("[agenda] DB query failed:", err);
    return;
  }

  for (const user of users) {
    try {
      const localNow = DateTime.now().setZone(user.timezone);

      // Only fire at 07:00 in the user's timezone
      if (localNow.hour !== NUDGE_HOUR || localNow.minute !== 0) continue;

      // Skip if already nudged today
      if (user.lastNudgeSentAt) {
        const lastLocal = DateTime.fromJSDate(user.lastNudgeSentAt).setZone(user.timezone);
        if (lastLocal.startOf("day").valueOf() === localNow.startOf("day").valueOf()) continue;
      }

      // Only nudge if there are reminders today
      const startUtc = localNow.startOf("day").toUTC().toJSDate();
      const endUtc = localNow.endOf("day").toUTC().toJSDate();
      const todayReminders = await getTodayReminders(user.id, startUtc, endUtc);
      if (todayReminders.length === 0) continue;

      const locale = resolveLocale(user.languageCode);
      const t = (key: string): string => i18n.t(locale, key);

      const keyboard = new InlineKeyboard()
        .text(t("agenda-show-btn"), "agenda_show")
        .text(t("agenda-later-btn"), "agenda_later");

      await bot.api.sendMessage(user.id, t("agenda-nudge"), { reply_markup: keyboard });
      await markNudgeSent(user.id);
      console.log(`[agenda] nudge sent to user ${user.id}`);
    } catch (err) {
      console.error(`[agenda] failed for user ${user.id}:`, err);
    }
  }
}

export function startAgendaScheduler(): void {
  console.log("[agenda] scheduler started — checking every minute");
  setInterval(checkAndSendAgenda, INTERVAL_MS);
}
