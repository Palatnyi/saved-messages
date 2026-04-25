import { DateTime } from "luxon";

/**
 * The AI resolves wall-clock time against the UTC "now" it was given, but has
 * no knowledge of the user's timezone. Re-interpret the stored wall-clock
 * components as a local time in the user's confirmed timezone.
 *
 * Example: stored = "2025-06-02T09:00:00Z", timezone = "Europe/Kyiv" (UTC+3)
 *   → user meant 09:00 Kyiv = 06:00 UTC → returns Date for 06:00 UTC.
 */
export function correctRemindAt(isoFromAI: string, timezone: string): Date {
  // Strip any offset/Z so we get the bare wall-clock time the AI wrote.
  // DateTime.fromISO with { zone: "UTC" } would convert the instant to UTC,
  // making "+03:00" times lose 3 hours before we reinterpret them.
  const noOffset = isoFromAI.replace(/Z$|[+-]\d{2}:?\d{2}$/, "");
  const stored = DateTime.fromISO(noOffset);
  return DateTime.fromObject(
    {
      year: stored.year,
      month: stored.month,
      day: stored.day,
      hour: stored.hour,
      minute: stored.minute,
      second: stored.second,
    },
    { zone: timezone }
  ).toJSDate();
}
