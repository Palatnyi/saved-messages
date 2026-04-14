import { ObjectId } from "mongodb";
import { getDb } from "../db";

interface UserDoc {
  _id: number;
  username?: string;
  languageCode?: string;
  createdAt: Date;
}

interface ReminderDoc {
  _id?: ObjectId;
  userId: number;
  encryptedPayload: string;
  remindAt: Date;
  msgId?: number;
  status: "pending" | "sent" | "failed";
  createdAt: Date;
}

export async function upsertUser(id: number, username?: string): Promise<void> {
  const db = await getDb();
  await db.collection<UserDoc>("users").updateOne(
    { _id: id },
    {
      $set: username !== undefined ? { username } : {},
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

export async function saveReminder(
  userId: number,
  encryptedPayload: string,
  remindAt: Date,
  msgId?: number
): Promise<void> {
  const db = await getDb();
  await db.collection<ReminderDoc>("reminders").insertOne({
    userId,
    encryptedPayload,
    remindAt,
    ...(msgId !== undefined ? { msgId } : {}),
    status: "pending",
    createdAt: new Date(),
  });
}

export async function getPendingReminders(
  userId: number
): Promise<Pick<ReminderDoc, "encryptedPayload" | "remindAt">[]> {
  const db = await getDb();
  return db
    .collection<ReminderDoc>("reminders")
    .find({ userId, status: "pending" }, { projection: { encryptedPayload: 1, remindAt: 1 } })
    .sort({ remindAt: 1 })
    .toArray();
}

/**
 * Returns all pending reminders whose remindAt is on or before now (UTC).
 * Includes _id so callers can delete after sending.
 */
export async function fetchDueReminders(): Promise<
  Required<Pick<ReminderDoc, "_id" | "userId" | "encryptedPayload">>[]
> {
  const db = await getDb();
  return db
    .collection<ReminderDoc>("reminders")
    .find(
      { status: "pending", remindAt: { $lte: new Date() } },
      { projection: { userId: 1, encryptedPayload: 1 } }
    )
    .toArray() as Promise<Required<Pick<ReminderDoc, "_id" | "userId" | "encryptedPayload">>[]>;
}

/**
 * Permanently removes a reminder by its ObjectId.
 */
export async function deleteReminderById(id: ObjectId): Promise<void> {
  const db = await getDb();
  await db.collection<ReminderDoc>("reminders").deleteOne({ _id: id });
}

/**
 * Updates an existing reminder matched by (userId, msgId).
 * If no match (original was never saved), inserts a new entry.
 */
export async function upsertReminderByMsgId(
  userId: number,
  encryptedPayload: string,
  remindAt: Date,
  msgId: number,
  newMsgId: number
): Promise<void> {
  const db = await getDb();
  const result = await db.collection<ReminderDoc>("reminders").updateOne(
    { userId, msgId },
    { $set: { encryptedPayload, remindAt, status: "pending", msgId: newMsgId } }
  );

  if (result.matchedCount === 0) {
    await db.collection<ReminderDoc>("reminders").insertOne({
      userId,
      encryptedPayload,
      remindAt,
      msgId: newMsgId,
      status: "pending",
      createdAt: new Date(),
    });
  }
}
