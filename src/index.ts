import "dotenv/config";
import { bot, setupBot } from "./bot";
import { startReminderScheduler } from "./services/reminder-scheduler";

console.log("Starting bot...");
setupBot();
startReminderScheduler();
bot.start();
