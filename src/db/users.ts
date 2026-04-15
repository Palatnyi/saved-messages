import { getDb } from "../db";

export async function getUserLanguageCode(userId: number): Promise<string | null> {
  const db = await getDb();
  const user = await db.collection("users").findOne(
    { _id: userId as unknown as never },
    { projection: { languageCode: 1 } }
  );
  return (user?.languageCode as string | undefined) ?? null;
}

export async function setUserLanguageCode(userId: number, languageCode: string): Promise<void> {
  const db = await getDb();
  await db.collection("users").updateOne(
    { _id: userId as unknown as never },
    {
      $set: { languageCode },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

export async function getUserTimezone(userId: number): Promise<string | null> {
  const db = await getDb();
  const user = await db.collection("users").findOne(
    { _id: userId as unknown as never },
    { projection: { timezone: 1 } }
  );
  return (user?.timezone as string | undefined) ?? null;
}

export interface UserForAgenda {
  id: number;
  timezone: string;
  languageCode?: string;
  lastNudgeSentAt?: Date | undefined;
}

export async function getUsersWithTimezone(): Promise<UserForAgenda[]> {
  const db = await getDb();
  const docs = await db
    .collection("users")
    .find(
      { timezone: { $exists: true } },
      { projection: { timezone: 1, languageCode: 1, lastNudgeSentAt: 1 } }
    )
    .toArray();
  return docs.map((u) => {
    const entry: UserForAgenda = {
      id: u._id as unknown as number,
      timezone: u.timezone as string,
      lastNudgeSentAt: u.lastNudgeSentAt as Date | undefined,
    };
    const lang = u.languageCode as string | undefined;
    if (lang !== undefined) entry.languageCode = lang;
    return entry;
  });
}

export async function markNudgeSent(userId: number): Promise<void> {
  const db = await getDb();
  await db.collection("users").updateOne(
    { _id: userId as unknown as never },
    { $set: { lastNudgeSentAt: new Date() } }
  );
}

export async function getUserCity(userId: number): Promise<string | null> {
  const db = await getDb();
  const user = await db.collection("users").findOne(
    { _id: userId as unknown as never },
    { projection: { city: 1 } }
  );
  return (user?.city as string | undefined) ?? null;
}

export async function setUserTimezone(userId: number, timezone: string, city: string): Promise<void> {
  const db = await getDb();
  await db.collection("users").updateOne(
    { _id: userId as unknown as never },
    { $set: { timezone, city } }
  );
}
