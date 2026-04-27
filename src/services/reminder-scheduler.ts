import { DateTime } from "luxon";
import { bot } from "../bot";
import { fetchDueReminders, deleteReminderById, saveReminder, type StoredRecurrence } from "../db/reminders";
import { decrypt } from "../utils/crypto";

const INTERVAL_MS = 60_000; // 1 minute

function nextOccurrence(remindAt: Date, rule: StoredRecurrence): Date {
  const dt = DateTime.fromJSDate(remindAt);
  switch (rule.freq) {
    case "daily":   return dt.plus({ days: rule.interval }).toJSDate();
    case "weekly":  return dt.plus({ weeks: rule.interval }).toJSDate();
    case "monthly": return dt.plus({ months: rule.interval }).toJSDate();
    case "yearly":  return dt.plus({ years: rule.interval }).toJSDate();
  }
}

async function sendDueReminders(): Promise<void> {
  let reminders;
  try {
    reminders = await fetchDueReminders();
  } catch (err) {
    console.error("[scheduler] DB query failed:", err);
    return;
  }

  if (reminders.length === 0) return;

  console.log(`[scheduler] processing ${reminders.length} due reminder(s)`);

  for (const reminder of reminders) {
    try {
      const text = decrypt(reminder.encryptedPayload);
      await bot.api.sendMessage(reminder.userId, `⏰ ${text}`);

      if (reminder.recurrence) {
        const next = nextOccurrence(reminder.remindAt, reminder.recurrence);
        const withinBounds = !reminder.recurrence.until || next <= reminder.recurrence.until;
        if (withinBounds) {
          await saveReminder(reminder.userId, reminder.encryptedPayload, next, undefined, reminder.recurrence);
          console.log(`[scheduler] scheduled next recurrence for user ${reminder.userId} at ${next.toISOString()}`);
        }
      }

      await deleteReminderById(reminder._id);
      console.log(`[scheduler] sent and removed reminder ${reminder._id} for user ${reminder.userId}`);
    } catch (err) {
      console.error(
        `[scheduler] failed for reminder ${reminder._id} (user ${reminder.userId}):`,
        err
      );
    }
  }
}

export function startReminderScheduler(): void {
  console.log("[scheduler] reminder scheduler started — checking every minute");
  sendDueReminders();
  setInterval(sendDueReminders, INTERVAL_MS);
}
