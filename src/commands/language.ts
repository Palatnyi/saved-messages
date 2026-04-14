import { InlineKeyboard } from "grammy";
import { type MyContext } from "../context";
import { SUPPORTED_LOCALES, type SupportedLocale } from "../i18n";
import { setUserLanguageCode } from "../db/users";

const LANGUAGE_LABELS: Record<SupportedLocale, string> = {
  uk: "🇺🇦 Українська",
  en: "🇬🇧 English",
  ru: "🇷🇺 Русский",
};

/** Builds the language-picker inline keyboard. */
function buildKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const locale of SUPPORTED_LOCALES) {
    kb.text(LANGUAGE_LABELS[locale], `set_lang:${locale}`).row();
  }
  return kb;
}

/** /language and /lang command — shows the language picker. */
export async function languageCommand(ctx: MyContext): Promise<void> {
  await ctx.reply(ctx.t("language-choose"), { reply_markup: buildKeyboard() });
}

/**
 * Callback handler for set_lang:<locale> buttons.
 * Saves the new language to MongoDB, immediately switches the locale
 * in the current context, then edits the picker message with a
 * confirmation written in the newly chosen language.
 */
export async function languageCallbackHandler(ctx: MyContext): Promise<void> {
  await ctx.answerCallbackQuery();

  const data = ctx.callbackQuery?.data ?? "";
  const locale = data.replace("set_lang:", "") as SupportedLocale;

  if (!(SUPPORTED_LOCALES as readonly string[]).includes(locale)) return;

  const userId = ctx.from!.id;
  await setUserLanguageCode(userId, locale);

  // useLocale switches the locale for this request and, via useSession: true,
  // persists it to ctx.session.__language_code automatically.
  ctx.i18n.useLocale(locale);

  await ctx.editMessageText(ctx.t("language-set"));
}
