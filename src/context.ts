import { Context, SessionFlavor } from "grammy";
import { type ConversationControls } from "@grammyjs/conversations";
import { type I18nFlavor } from "./i18n";

export interface SessionData {
  /** Locale persisted by grammyjs/i18n (useSession: true). Avoids a DB lookup on every message. */
  __language_code?: string;
  /** Reminders held while the user completes city onboarding.
   *  Persisted in session so they survive the conversation round-trips. */
  pendingTasks?: Array<{
    intent: string;
    remindAt: string; // ISO 8601 — adjusted once timezone is confirmed
    msgId: number;
  }>;
}

/** Full context type used throughout the bot. */
export type MyContext = Context
  & SessionFlavor<SessionData>
  & I18nFlavor
  & { conversation: ConversationControls };
