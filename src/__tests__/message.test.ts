/// <reference types="jest" />

import { handleNewMessage, handleReply } from "../handlers/message";

// ── Mock dependencies ────────────────────────────────────────────────────────

jest.mock("../services/ai");
jest.mock("../utils/crypto");
jest.mock("../db/reminders");
jest.mock("../db/users");
jest.mock("../utils/time");

import { parseAction } from "../services/ai";
import { encrypt, decrypt } from "../utils/crypto";
import { upsertUser, saveReminder, upsertReminderByMsgId, getPendingReminders, deleteRemindersByIds } from "../db/reminders";
import { getUserTimezone } from "../db/users";
import { correctRemindAt } from "../utils/time";
import { ObjectId } from "mongodb";

const mockParseAction = parseAction as jest.MockedFunction<typeof parseAction>;
const mockEncrypt = encrypt as jest.MockedFunction<typeof encrypt>;
const mockDecrypt = decrypt as jest.MockedFunction<typeof decrypt>;
const mockUpsertUser = upsertUser as jest.MockedFunction<typeof upsertUser>;
const mockSaveReminder = saveReminder as jest.MockedFunction<typeof saveReminder>;
const mockUpsertReminderByMsgId = upsertReminderByMsgId as jest.MockedFunction<typeof upsertReminderByMsgId>;
const mockGetUserTimezone = getUserTimezone as jest.MockedFunction<typeof getUserTimezone>;
const mockCorrectRemindAt = correctRemindAt as jest.MockedFunction<typeof correctRemindAt>;
const mockGetPendingReminders = getPendingReminders as jest.MockedFunction<typeof getPendingReminders>;
const mockDeleteRemindersByIds = deleteRemindersByIds as jest.MockedFunction<typeof deleteRemindersByIds>;

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
    t: jest.fn().mockReturnValue("noted your task, please set city"),
    react: jest.fn().mockResolvedValue(undefined),
    reply: jest.fn().mockResolvedValue(undefined),
  } as unknown as Parameters<typeof handleNewMessage>[0];
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockEncrypt.mockReturnValue("encrypted-payload");
  mockDecrypt.mockImplementation((s) => s);
  mockUpsertUser.mockResolvedValue(undefined);
  mockSaveReminder.mockResolvedValue(undefined);
  mockUpsertReminderByMsgId.mockResolvedValue(undefined);
  mockGetUserTimezone.mockResolvedValue("Europe/Kyiv");
  mockCorrectRemindAt.mockImplementation((iso) => new Date(iso));
  mockGetPendingReminders.mockResolvedValue([]);
  mockDeleteRemindersByIds.mockResolvedValue(0);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("handleNewMessage", () => {
  test("AI returns none — no DB write, no reaction", async () => {
    mockParseAction.mockResolvedValue({ action: "none" });

    const ctx = makeCtx("Hello there!");
    await handleNewMessage(ctx);

    expect(mockUpsertUser).not.toHaveBeenCalled();
    expect(mockSaveReminder).not.toHaveBeenCalled();
    expect(ctx.react).not.toHaveBeenCalled();
  });

  test("AI recognises reminder and timezone is set — saves to DB and reacts", async () => {
    mockParseAction.mockResolvedValue({
      action: "remind",
      items: [{ intent: "Buy milk", remind_at: "2025-06-01T09:00:00+00:00", recurrence: null }],
    });

    const ctx = makeCtx("Buy milk tomorrow morning", { userId: 42, messageId: 101 });
    await handleNewMessage(ctx);

    expect(mockSaveReminder).toHaveBeenCalledWith(
      42, "encrypted-payload", new Date("2025-06-01T09:00:00+00:00"), 101, undefined
    );
    expect(ctx.react).toHaveBeenCalledWith("👍");
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  test("AI recognises multiple reminders — saves all to DB and reacts once", async () => {
    mockParseAction.mockResolvedValue({
      action: "remind",
      items: [
        { intent: "Call brother", remind_at: "2025-06-01T17:00:00+00:00", recurrence: null },
        { intent: "Check email", remind_at: "2025-06-01T21:00:00+00:00", recurrence: null },
        { intent: "Zoom call", remind_at: "2025-06-01T12:00:00+00:00", recurrence: null },
      ],
    });

    const ctx = makeCtx("нагадай о 17 набрати брату, ввечері переглянути імейл, в обід zoom call", { userId: 42, messageId: 102 });
    await handleNewMessage(ctx);

    expect(mockSaveReminder).toHaveBeenCalledTimes(3);
    expect(ctx.react).toHaveBeenCalledTimes(1);
    expect(ctx.react).toHaveBeenCalledWith("👍");
  });

  test("AI recognises reminder but timezone is missing — parks tasks in session and prompts for city", async () => {
    mockGetUserTimezone.mockResolvedValue(null);
    mockParseAction.mockResolvedValue({
      action: "remind",
      items: [{ intent: "Call dentist", remind_at: "2025-06-02T10:00:00+00:00", recurrence: null }],
    });

    const ctx = makeCtx("Call dentist tomorrow", { userId: 42, messageId: 55 });
    await handleNewMessage(ctx);

    expect(ctx.session.pendingTasks).toEqual([{
      intent: "Call dentist",
      remindAt: "2025-06-02T10:00:00+00:00",
      msgId: 55,
    }]);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("noted your task"),
      expect.objectContaining({ reply_markup: expect.anything() })
    );

    expect(mockSaveReminder).not.toHaveBeenCalled();
    expect(ctx.react).not.toHaveBeenCalled();
  });

  test("ignores messages that are replies — skips processing", async () => {
    const ctx = makeCtx("actually remind me at 10am", {
      replyTo: { text: "call the dentist", from_id: 42, message_id: 150 },
    });

    await handleNewMessage(ctx);

    expect(mockParseAction).not.toHaveBeenCalled();
  });
});

describe("handleNewMessage — delete action", () => {
  const fakeId = new ObjectId();

  test("delete last reminder — removes most recently created and replies with list", async () => {
    mockParseAction.mockResolvedValue({ action: "delete", criteria: { kind: "last", count: 1 } });
    mockGetPendingReminders.mockResolvedValue([
      { _id: fakeId, encryptedPayload: "Call dentist", remindAt: new Date("2025-06-02T10:00:00Z") },
    ]);
    mockDeleteRemindersByIds.mockResolvedValue(1);

    const ctx = makeCtx("видали останнє нагадування");
    await handleNewMessage(ctx);

    expect(mockDeleteRemindersByIds).toHaveBeenCalledWith([fakeId]);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Call dentist"));
  });

  test("delete by keywords — removes matching reminders", async () => {
    mockParseAction.mockResolvedValue({ action: "delete", criteria: { kind: "keywords", terms: ["дзвінок", "брат"] } });
    mockGetPendingReminders.mockResolvedValue([
      { _id: fakeId, encryptedPayload: "дзвінок брату", remindAt: new Date() },
    ]);
    mockDeleteRemindersByIds.mockResolvedValue(1);

    const ctx = makeCtx("видали нагадування про дзвінок братові");
    await handleNewMessage(ctx);

    expect(mockDeleteRemindersByIds).toHaveBeenCalledWith([fakeId]);
  });

  test("delete — nothing matches, replies with not-found", async () => {
    mockParseAction.mockResolvedValue({ action: "delete", criteria: { kind: "keywords", terms: ["зустріч"] } });
    mockGetPendingReminders.mockResolvedValue([
      { _id: fakeId, encryptedPayload: "дзвінок брату", remindAt: new Date() },
    ]);

    const ctx = makeCtx("видали нагадування про зустріч");
    await handleNewMessage(ctx);

    expect(mockDeleteRemindersByIds).not.toHaveBeenCalled();
    expect(ctx.t).toHaveBeenCalledWith("delete-not-found");
  });

  test("delete all — removes all and replies", async () => {
    const id2 = new ObjectId();
    mockParseAction.mockResolvedValue({ action: "delete", criteria: { kind: "all" } });
    mockGetPendingReminders.mockResolvedValue([
      { _id: fakeId, encryptedPayload: "Task A", remindAt: new Date() },
      { _id: id2, encryptedPayload: "Task B", remindAt: new Date() },
    ]);
    mockDeleteRemindersByIds.mockResolvedValue(2);

    const ctx = makeCtx("видали всі нагадування");
    await handleNewMessage(ctx);

    expect(mockDeleteRemindersByIds).toHaveBeenCalledWith([fakeId, id2]);
  });
});

describe("handleReply", () => {
  test("user replies to own message and AI recognises reminder — upserts DB entry and reacts", async () => {
    mockParseAction.mockResolvedValue({
      action: "remind",
      items: [{ intent: "Call the dentist", remind_at: "2025-06-02T10:00:00+00:00", recurrence: null }],
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
    mockParseAction.mockResolvedValue({ action: "none" });

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

    expect(mockParseAction).not.toHaveBeenCalled();
  });
});
