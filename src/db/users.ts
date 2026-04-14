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

export async function setUserTimezone(userId: number, timezone: string): Promise<void> {
  const db = await getDb();
  await db.collection("users").updateOne(
    { _id: userId as unknown as never },
    { $set: { timezone } }
  );
}
