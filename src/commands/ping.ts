import { CommandContext, Context } from "grammy";
import { testConnection } from "../db";

export async function pingCommand(ctx: CommandContext<Context>): Promise<void> {
  await ctx.reply("Pong!");

  try {
    await testConnection();
    console.log(`[ping] DB connection successful (user: ${ctx.from?.username ?? ctx.from?.id})`);
  } catch (err) {
    console.error("[ping] DB connection failed:", err);
  }
}
