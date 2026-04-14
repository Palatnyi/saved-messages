import { bot } from "../bot";
import { fetchDueReminders, deleteReminderById } from "../db/reminders";
import { decrypt } from "../utils/crypto";

const INTERVAL_MS = 60_000; // 1 minute

/**
 * Fetches all reminders whose remindAt <= UTC now, sends each one to the
 * corresponding Telegram user, then deletes the reminder from the database.
 *
 * remindAt is always stored as UTC (timezone offset is applied at save-time),
 * so comparing against new Date() is correct regardless of the server's
 * local timezone.
 */
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

  // Run once immediately so overdue reminders are handled on boot, then repeat.
  sendDueReminders();
  setInterval(sendDueReminders, INTERVAL_MS);
}
