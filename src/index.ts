if (process.env.NODE_ENV !== 'production') {
  require('dotenv/config');
}
import { bot, setupBot } from "./bot";
import { startReminderScheduler } from "./services/reminder-scheduler";
import { startAgendaScheduler } from "./services/agenda-scheduler";

console.log("Starting bot...");
setupBot();
startReminderScheduler();
startAgendaScheduler();
bot.start();
