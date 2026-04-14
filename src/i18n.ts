import * as fs from "fs";
import * as path from "path";
import { I18n, type I18nFlavor } from "@grammyjs/i18n";
import { type MyContext } from "./context";

export type { I18nFlavor };

export const SUPPORTED_LOCALES = ["en", "uk", "ru"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Maps a Telegram language_code (e.g. "uk", "ru-RU", "en-US") to a supported locale.
 * Falls back to "uk" when the code is absent or not supported.
 */
export function resolveLocale(code: string | undefined): SupportedLocale {
  if (!code) return "uk";
  const base = (code.split("-")[0] ?? code).toLowerCase();
  return (SUPPORTED_LOCALES as readonly string[]).includes(base)
    ? (base as SupportedLocale)
    : "uk";
}

/**
 * Converts a flat JSON translation map to Project Fluent source text.
 * Placeholder syntax {variable} in values becomes Fluent's { $variable }.
 */
function jsonToFluent(json: Record<string, string>): string {
  return Object.entries(json)
    .map(([key, value]) => {
      const fluent = value.replace(/\{(\w+)\}/g, "{ $$1 }");
      return `${key} = ${fluent}`;
    })
    .join("\n");
}

// Locale is resolved per-request by the DB locale middleware (src/middleware/locale.ts).
// defaultLocale is only a last-resort fallback.
export const i18n = new I18n<MyContext>({
  defaultLocale: "uk",
  useSession: true, // persists chosen locale in ctx.session.__language_code
});

const localesDir = path.resolve(__dirname, "..", "locales");

/** Reads each JSON locale file, converts it to Fluent, and registers it with the i18n instance. */
export function loadLocales(): void {
  for (const locale of SUPPORTED_LOCALES) {
    const filePath = path.join(localesDir, `${locale}.json`);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, string>;
    i18n.loadLocaleSync(locale, { source: jsonToFluent(raw) });
  }
}