/// <reference types="jest" />

import { findCity } from "../services/ai";

// ── Mock @google/generative-ai ───────────────────────────────────────────────

const mockGenerateContent = jest.fn();

jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: mockGenerateContent,
    }),
  })),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockResponse(text: string) {
  mockGenerateContent.mockResolvedValue({
    response: { text: () => text },
  });
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GEMINI_API_KEY = "test-key";
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("findCity", () => {
  test("city found — returns city and timezone", async () => {
    mockResponse(JSON.stringify({ found: true, city: "Kyiv", timezone: "Europe/Kyiv" }));

    const result = await findCity("Kyiv");

    expect(result).toEqual({ found: true, city: "Kyiv", timezone: "Europe/Kyiv" });
  });

  test("city not found — returns { found: false }", async () => {
    mockResponse(JSON.stringify({ found: false }));

    const result = await findCity("asdfghjkl");

    expect(result).toEqual({ found: false });
  });

  test("response wrapped in backtick fences — still parsed correctly", async () => {
    mockResponse("```json\n" + JSON.stringify({ found: true, city: "Paris", timezone: "Europe/Paris" }) + "\n```");

    const result = await findCity("Paris");

    expect(result).toEqual({ found: true, city: "Paris", timezone: "Europe/Paris" });
  });

  test("completely unparseable response — throws", async () => {
    mockResponse("Sorry, I cannot help with that.");

    await expect(findCity("???")).rejects.toThrow("Unparseable AI response from findCity");
  });

  test("passes user query to model", async () => {
    mockResponse(JSON.stringify({ found: true, city: "Tokyo", timezone: "Asia/Tokyo" }));

    await findCity("what timezone is Tokyo in?");

    expect(mockGenerateContent).toHaveBeenCalledWith("User query: what timezone is Tokyo in?");
  });
});
