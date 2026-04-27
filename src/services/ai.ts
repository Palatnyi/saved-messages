import { GoogleGenerativeAI } from "@google/generative-ai";
import Anthropic from "@anthropic-ai/sdk";

export interface RecurrenceRule {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;   // every N units
  until: string | null; // YYYY-MM-DD end date or null (no end)
}

export interface ReminderItem {
  intent: string;
  remind_at: string | null; // ISO 8601 or null
  recurrence: RecurrenceRule | null;
}

export type DeleteCriteria =
  | { kind: "last"; count: number }
  | { kind: "keywords"; terms: string[] }
  | { kind: "date"; date: string } // YYYY-MM-DD in user's local timezone
  | { kind: "all" }

export type ParsedAction =
  | { action: "remind"; items: ReminderItem[] }
  | { action: "delete"; criteria: DeleteCriteria }
  | { action: "list" }
  | { action: "none" }

const SYSTEM_PROMPT = `You are a smart assistant that parses user messages into structured actions.

The user may want to:
A) Create one or more reminders
B) Delete reminders
C) List / show their reminders
D) Neither (casual chat, questions, greetings)

--- ACTION A: remind ---
Extract ALL tasks/appointments the user wants to be reminded of.
Each reminder:
- "intent": max 6 words, same language as user, no datetime words. Distil core action only.
- "remind_at": ISO 8601 with timezone offset for the FIRST occurrence, or null if no time given.
- "recurrence": null for one-time reminders. For recurring patterns:
    {"freq":"daily"|"weekly"|"monthly"|"yearly","interval":N,"until":"YYYY-MM-DD"|null}
    freq = base unit, interval = every N units (default 1), until = end date or null if open-ended.

--- ACTION B: delete ---
Detect when user wants to delete/remove/cancel reminders. Extract one of these criteria:
- last N: {"kind":"last","count":N} — delete the most recently added reminder(s). Default count=1.
- by content: {"kind":"keywords","terms":[...]} — key nouns/verbs from the description (same language, lowercase).
- by date: {"kind":"date","date":"YYYY-MM-DD"} — resolve the mentioned day against current datetime.
- all: {"kind":"all"} — delete everything.

--- ACTION C: list ---
Detect when user wants to see, show, or check their reminders (e.g. "покажи нагадування", "що в мене заплановано?", "show my reminders", "список задач").
→ {"action":"list"}

--- OUTPUT ---
Respond ONLY with a valid JSON object. No markdown, no code fences.

{"action":"remind","items":[{"intent":"...","remind_at":"..."|null,"recurrence":null|{...}},...]}
{"action":"delete","criteria":{...}}
{"action":"list"}
{"action":"none"}

Current datetime: {{current_datetime}}

Examples:
"нагадай завтра о 17 зателефонувати брату" → {"action":"remind","items":[{"intent":"Зателефонувати брату","remind_at":"2026-04-29T17:00:00+03:00","recurrence":null}]}
"remind me at noon to call the bank about my credit card issue" → {"action":"remind","items":[{"intent":"Call the bank","remind_at":"2026-04-28T12:00:00+03:00","recurrence":null}]}
"нагадуй кожного місяця сплачувати податки" → {"action":"remind","items":[{"intent":"Сплачувати податки","remind_at":null,"recurrence":{"freq":"monthly","interval":1,"until":null}}]}
"нагадуй щодня о 9:00 робити зарядку до кінця травня" → {"action":"remind","items":[{"intent":"Зарядка","remind_at":"2026-04-28T09:00:00+03:00","recurrence":{"freq":"daily","interval":1,"until":"2026-05-31"}}]}
"remind me every 2 weeks to submit a report" → {"action":"remind","items":[{"intent":"Submit report","remind_at":null,"recurrence":{"freq":"weekly","interval":2,"until":null}}]}
"видали останнє нагадування" → {"action":"delete","criteria":{"kind":"last","count":1}}
"delete the last 3 reminders" → {"action":"delete","criteria":{"kind":"last","count":3}}
"видали нагадування про дзвінок братові" → {"action":"delete","criteria":{"kind":"keywords","terms":["дзвінок","брат"]}}
"видали всі нагадування за 23 число" → {"action":"delete","criteria":{"kind":"date","date":"2026-04-23"}}
"видали всі нагадування" → {"action":"delete","criteria":{"kind":"all"}}
"покажи мої нагадування" → {"action":"list"}
"що в мене заплановано?" → {"action":"list"}
"hello" → {"action":"none"}`

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-haiku-4-5-20251001";

let _geminiClient: GoogleGenerativeAI | null = null;
let _anthropicClient: Anthropic | null = null;

function getGeminiClient(): GoogleGenerativeAI {
  if (!_geminiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set in environment variables");
    _geminiClient = new GoogleGenerativeAI(apiKey);
  }
  return _geminiClient;
}

function getAnthropicClient(): Anthropic {
  if (!_anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in environment variables");
    _anthropicClient = new Anthropic({ apiKey });
  }
  return _anthropicClient;
}

function parseAIResponse(raw: string): ParsedAction {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "action" in parsed) return parsed as ParsedAction;
    return { action: "none" };
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed && "action" in parsed) return parsed as ParsedAction;
    }
    throw new Error(`Unparseable AI response: ${raw}`);
  }
}

async function parseActionWithGemini(userContent: string, nowIso: string): Promise<ParsedAction> {
  return callWithRetry("Gemini/parseReminder", async () => {
    const model = getGeminiClient().getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: SYSTEM_PROMPT,
    });

    const result = await model.generateContent(
      `Current datetime: ${nowIso}\n${userContent}`
    );

    return parseAIResponse(result.response.text().trim());
  });
}

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  // Claude: 529 overloaded — Gemini: 503 unavailable, 429 rate-limited, 500 internal
  return (
    msg.includes("529") ||
    msg.includes("503") ||
    msg.includes("500") ||
    msg.includes("429") ||
    msg.includes("overloaded") ||
    msg.includes("unavailable") ||
    msg.includes("rate limit") ||
    msg.includes("quota")
  );
}

async function callWithRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 2000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (isTransientError(err) && attempt < maxRetries) {
        const delay = baseDelayMs * 2 ** attempt;
        console.warn(`[ai] ${label} transient error, retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
        await new Promise((res) => setTimeout(res, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Unreachable");
}

async function parseActionWithClaude(userContent: string, nowIso: string): Promise<ParsedAction> {
  return callWithRetry("Claude/parseAction", async () => {
    const message = await getAnthropicClient().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: `Current datetime: ${nowIso}\n${userContent}` },
      ],
    });

    const block = message.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("No text block in Claude response");

    return parseAIResponse(block.text.trim());
  });
}

export async function parseAction(
  text: string,
  nowIso: string,
  replyToText?: string
): Promise<ParsedAction> {
  const userContent = replyToText
    ? `Original message: ${replyToText}\nFollow-up reply: ${text}`
    : `User message: ${text}`;

  try {
    return await parseActionWithGemini(userContent, nowIso);
  } catch (err) {
    console.warn("[ai] Gemini failed, falling back to Claude:", err);
    return await parseActionWithClaude(userContent, nowIso);
  }
}


const CITY_SYTEM_PROPT = `
"You are a geographic assistant. Your goal is to identify a city from any text provided by the user (even with typos or in any language) and return its standard English name and IANA Timezone ID.
Rules:
Identify the city and country.
Find the correct IANA Timezone ID (e.g., 'Europe/Kyiv', 'America/New_York').
If the city is ambiguous (e.g., 'London'), prioritize the most famous one or the one in the most likely country.
If no city is found, return {"found": false}.
Output format (strictly JSON) if found:
{
"found": true,
"city": "Kyiv",
"timezone": "Europe/Kyiv",
}"
Output format (strictly JSON) if NOT found:
{
"found": false
}
`

type CityTimezone = { city: string, timezone: string, found: true } | { found: false };

function parseCityResponse(raw: string): CityTimezone {
  try {
    return JSON.parse(raw) as CityTimezone;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as CityTimezone;
    throw new Error(`Unparseable AI response from findCity: ${raw}`);
  }
}

async function findCityWithGemini(query: string): Promise<CityTimezone> {
  return callWithRetry("Gemini/findCity", async () => {
    const model = getGeminiClient().getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: CITY_SYTEM_PROPT,
    });

    const result = await model.generateContent(`User query: ${query}`);
    return parseCityResponse(result.response.text().trim());
  });
}

async function findCityWithClaude(query: string): Promise<CityTimezone> {
  return callWithRetry("Claude/findCity", async () => {
    const message = await getAnthropicClient().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 256,
      system: CITY_SYTEM_PROPT,
      messages: [{ role: "user", content: `User query: ${query}` }],
    });

    const block = message.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("No text block in Claude response");

    return parseCityResponse(block.text.trim());
  });
}

const WEATHER_SYSTEM_PROMPT = `You are a weather emoji assistant. You receive a city name and the current local date and time.
Your task: return 1 or 2 emojis that represent the most likely current weather in that city, based on its climate zone, hemisphere, and current season.

Rules:
- Return ONLY emoji characters — no text, no punctuation, no spaces, no explanation.
- Use 1 emoji for clear conditions, up to 2 for mixed (e.g. partly cloudy with wind).
- Choose from: ☀️ 🌤️ ⛅ ☁️ 🌦️ 🌧️ ⛈️ 🌨️ ❄️ 🌫️ 💨

Examples of valid output: ☀️   🌧️   ⛅   ❄️   🌤️💨`

async function getWeatherEmojiWithGemini(city: string, nowIso: string): Promise<string> {
  return callWithRetry("Gemini/getWeatherEmoji", async () => {
    const model = getGeminiClient().getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: WEATHER_SYSTEM_PROMPT,
    });

    const result = await model.generateContent(
      `City: ${city}\nCurrent datetime: ${nowIso}`
    );

    return result.response.text().trim();
  });
}

async function getWeatherEmojiWithClaude(city: string, nowIso: string): Promise<string> {
  return callWithRetry("Claude/getWeatherEmoji", async () => {
    const message = await getAnthropicClient().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16,
      system: WEATHER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `City: ${city}\nCurrent datetime: ${nowIso}` }],
    });

    const block = message.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("No text block in Claude response");

    return block.text.trim();
  });
}

export async function getWeatherEmoji(city: string, nowIso: string): Promise<string> {
  try {
    return await getWeatherEmojiWithGemini(city, nowIso);
  } catch (err) {
    console.warn("[ai] Gemini failed for getWeatherEmoji, falling back to Claude:", err);
    return await getWeatherEmojiWithClaude(city, nowIso);
  }
}

const TRANSCRIPTION_SYSTEM_PROMPT = `You are a transcription service. Convert the spoken audio into written text.
Return ONLY the spoken words exactly as heard — no summaries, no interpretation, no added punctuation beyond what is natural.
If the audio is silent or inaudible, return an empty string.`

export async function transcribeAudio(fileBase64: string, mimeType: string): Promise<string> {
  return callWithRetry("Gemini/transcribeAudio", async () => {
    const model = getGeminiClient().getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: TRANSCRIPTION_SYSTEM_PROMPT,
    });

    const result = await model.generateContent([
      { inlineData: { data: fileBase64, mimeType } },
      "Transcribe the audio.",
    ]);

    return result.response.text().trim();
  });
}

export async function findCity(query: string): Promise<CityTimezone> {
  try {
    return await findCityWithGemini(query);
  } catch (err) {
    console.warn("[ai] Gemini failed for findCity, falling back to Claude:", err);
    return await findCityWithClaude(query);
  }
}

