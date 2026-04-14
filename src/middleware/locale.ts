import { type MiddlewareFn } from "grammy";
import { type MyContext } from "../context";
import { getUserLanguageCode, setUserLanguageCode } from "../db/users";
import { resolveLocale } from "../i18n";

/**
 * Per-request locale middleware.
 *
 * Resolution order:
 *   1. User's `languageCode` stored in MongoDB (persistent preference).
 *   2. For new users: Telegram's `ctx.from.language_code`, mapped to a supported
 *      locale and defaulting to "uk" — then saved to the DB immediately.
 *
 * Must be registered after the `i18n` middleware so that `ctx.i18n` is available.
 */
export function localeMiddleware(): MiddlewareFn<MyContext> {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return next();

    // grammyjs/i18n (useSession: true) already restored the locale from session —
    // only hit the DB when it's absent (first message from this user).
    if (ctx.session.__language_code) return next();

    let languageCode = await getUserLanguageCode(userId);

    if (languageCode === null) {
      // New user — detect from Telegram settings, default to "uk", persist.
      languageCode = resolveLocale(ctx.from?.language_code);
      await setUserLanguageCode(userId, languageCode);
    }

    // useLocale also writes __language_code to session (via useSession: true).
    ctx.i18n.useLocale(languageCode);
    return next();
  };
}
