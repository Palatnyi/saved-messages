/// <reference types="jest" />

import { handleNewMessage, handleReply } from "../handlers/message";

// ── Mock dependencies ────────────────────────────────────────────────────────

jest.mock("../services/ai");
jest.mock("../utils/crypto");
jest.mock("../db/reminders");
jest.mock("../db/users");

import { parseReminder } from "../services/ai";
import { encrypt } from "../utils/crypto";
import { upsertUser, saveReminder, upsertReminderByMsgId } from "../db/reminders";
import { getUserTimezone } from "../db/users";

const mockParseReminder = parseReminder as jest.MockedFunction<typeof parseReminder>;
const mockEncrypt = encrypt as jest.MockedFunction<typeof encrypt>;
const mockUpsertUser = upsertUser as jest.MockedFunction<typeof upsertUser>;
const mockSaveReminder = saveReminder as jest.MockedFunction<typeof saveReminder>;
const mockUpsertReminderByMsgId = upsertReminderByMsgId as jest.MockedFunction<typeof upsertReminderByMsgId>;
const mockGetUserTimezone = getUserTimezone as jest.MockedFunction<typeof getUserTimezone>;

// ── Context factory ──────────────────────────────────────────────────────────

function makeCtx(
  text: string,
  opts: {
    userId?: number;
    messageId?: number;
    replyTo?: { text: string; from_id: number; message_id: number };
  } = {}
) {
  const userId = opts.userId ?? 42;
  const messageId = opts.messageId ?? 100;

  const replyToMessage = opts.replyTo
    ? {
        text: opts.replyTo.text,
        message_id: opts.replyTo.message_id,
        from: { id: opts.replyTo.from_id },
      }
    : undefined;

  const session: Record<string, unknown> = {};

  return {
    message: {
      text,
      message_id: messageId,
      from: { id: userId, username: "testuser" },
      reply_to_message: replyToMessage,
    },
    session,
    react: jest.fn().mockResolvedValue(undefined),
    reply: jest.fn().mockResolvedValue(undefined),
  } as unknown as Parameters<typeof handleNewMessage>[0];
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockEncrypt.mockReturnValue("encrypted-payload");
  mockUpsertUser.mockResolvedValue(undefined);
  mockSaveReminder.mockResolvedValue(undefined);
  mockUpsertReminderByMsgId.mockResolvedValue(undefined);
  mockGetUserTimezone.mockResolvedValue("Europe/Kyiv"); // timezone set by default
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("handleNewMessage", () => {
  test("AI does not recognise a reminder — no DB write, no reaction", async () => {
    mockParseReminder.mockResolvedValue({ is_reminder: false });

    const ctx = makeCtx("Hello there!");
    await handleNewMessage(ctx);

    expect(mockUpsertUser).not.toHaveBeenCalled();
    expect(mockSaveReminder).not.toHaveBeenCalled();
    expect(ctx.react).not.toHaveBeenCalled();
  });

  test("AI recognises reminder and timezone is set — saves to DB and reacts", async () => {
    mockParseReminder.mockResolvedValue({
      is_reminder: true,
      intent: "Buy milk",
      remind_at: "2025-06-01T09:00:00+00:00",
    });

    const ctx = makeCtx("Buy milk tomorrow morning", { userId: 42, messageId: 101 });
    await handleNewMessage(ctx);

    expect(mockSaveReminder).toHaveBeenCalledWith(
      42, "encrypted-payload", new Date("2025-06-01T09:00:00+00:00"), 101
    );
    expect(ctx.react).toHaveBeenCalledWith("👍");
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  test("AI recognises reminder but timezone is missing — parks task in session and prompts for city", async () => {
    mockGetUserTimezone.mockResolvedValue(null);
    mockParseReminder.mockResolvedValue({
      is_reminder: true,
      intent: "Call dentist",
      remind_at: "2025-06-02T10:00:00+00:00",
    });

    const ctx = makeCtx("Call dentist tomorrow", { userId: 42, messageId: 55 });
    await handleNewMessage(ctx);

    // Task must be parked in session
    expect(ctx.session.pendingTask).toEqual({
      intent: "Call dentist",
      remindAt: "2025-06-02T10:00:00+00:00",
      msgId: 55,
    });

    // Friendly message + Set City button sent
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("noted your task"),
      expect.objectContaining({ reply_markup: expect.anything() })
    );

    // Nothing saved to DB, no reaction
    expect(mockSaveReminder).not.toHaveBeenCalled();
    expect(ctx.react).not.toHaveBeenCalled();
  });

  test("ignores messages that are replies — skips processing", async () => {
    const ctx = makeCtx("actually remind me at 10am", {
      replyTo: { text: "call the dentist", from_id: 42, message_id: 150 },
    });

    await handleNewMessage(ctx);

    expect(mockParseReminder).not.toHaveBeenCalled();
  });
});

describe("handleReply", () => {
  test("user replies to own message and AI recognises reminder — upserts DB entry and reacts", async () => {
    mockParseReminder.mockResolvedValue({
      is_reminder: true,
      intent: "Call the dentist",
      remind_at: "2025-06-02T10:00:00+00:00",
    });

    const ctx = makeCtx("actually remind me at 10am", {
      userId: 42,
      messageId: 200,
      replyTo: { text: "call the dentist", from_id: 42, message_id: 150 },
    });

    await handleReply(ctx);

    expect(mockUpsertReminderByMsgId).toHaveBeenCalledWith(
      42, "encrypted-payload", new Date("2025-06-02T10:00:00+00:00"), 150, 200
    );
    expect(mockSaveReminder).not.toHaveBeenCalled();
    expect(ctx.react).toHaveBeenCalledWith("👍");
  });

  test("user replies to own message and AI does not recognise reminder — no DB write, no reaction", async () => {
    mockParseReminder.mockResolvedValue({ is_reminder: false });

    const ctx = makeCtx("never mind", {
      userId: 42,
      messageId: 201,
      replyTo: { text: "buy groceries", from_id: 42, message_id: 151 },
    });

    await handleReply(ctx);

    expect(mockSaveReminder).not.toHaveBeenCalled();
    expect(ctx.react).not.toHaveBeenCalled();
  });

  test("ignores replies to other users' messages — skips processing", async () => {
    const ctx = makeCtx("thanks!", {
      userId: 42,
      replyTo: { text: "some other message", from_id: 99, message_id: 300 },
    });

    await handleReply(ctx);

    expect(mockParseReminder).not.toHaveBeenCalled();
  });
});
