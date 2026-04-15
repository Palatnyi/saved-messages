import { GoogleGenerativeAI } from "@google/generative-ai";
import Anthropic from "@anthropic-ai/sdk";

export interface ReminderResult {
  is_reminder: true;
  intent: string;
  remind_at: string; // ISO 8601
}

export interface NotReminderResult {
  is_reminder: false;
}

export type AIResult = ReminderResult | NotReminderResult;

const SYSTEM_PROMPT = `You are a reminder parser. The user will send you a message. 
Your job is to decide whether it expresses something the user wants to remember or do.

Classification rules:
- is_reminder: TRUE — any actionable task, to-do, or thing to remember (e.g., "buy milk", "call mom", "remind me to pay the bill").
- is_reminder: FALSE — greetings, questions, random thoughts, facts, or casual conversation (e.g., "hello", "what time is it?", "I love pizza").

Time resolution rules:
1. Explicit/Relative time given → resolve it against the provided current datetime and return a full ISO 8601 string.
2. No time mentioned → if the user doesn't specify WHEN to do the task, set "remind_at" to null. Do NOT infer or guess a default time.

Output rules:
- remind_at: A full ISO 8601 string (with timezone offset) OR null if no time was mentioned.
- intent: A short, clean action phrase. Remove all datetime-related words and filler words. Write it in the same language as the user's message.
- Respond ONLY with a JSON object. No markdown, no code fences, no explanation.

Current datetime: {{current_datetime}} (Use this to resolve "tomorrow", "next Friday", etc.)

Examples:
{"is_reminder":true,"intent":"Buy milk","remind_at":null}
{"is_reminder":true,"intent":"Call mom","remind_at":"2026-04-05T09:00:00+03:00"}
{"is_reminder":false}`

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

function parseAIResponse(raw: string): AIResult {
  try {
    return JSON.parse(raw) as AIResult;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as AIResult;
    throw new Error(`Unparseable AI response: ${raw}`);
  }
}

async function parseReminderWithGemini(userContent: string, nowIso: string): Promise<AIResult> {
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

async function parseReminderWithClaude(userContent: string, nowIso: string): Promise<AIResult> {
  return callWithRetry("Claude/parseReminder", async () => {
    const message = await getAnthropicClient().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 256,
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

export async function parseReminder(
  text: string,
  nowIso: string,
  replyToText?: string
): Promise<AIResult> {
  const userContent = replyToText
    ? `Original message: ${replyToText}\nFollow-up reply: ${text}`
    : `User message: ${text}`;

  try {
    return await parseReminderWithGemini(userContent, nowIso);
  } catch (err) {
    console.warn("[ai] Gemini failed, falling back to Claude:", err);
    return await parseReminderWithClaude(userContent, nowIso);
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

export async function findCity(query: string): Promise<CityTimezone> {
  try {
    return await findCityWithGemini(query);
  } catch (err) {
    console.warn("[ai] Gemini failed for findCity, falling back to Claude:", err);
    return await findCityWithClaude(query);
  }
}

