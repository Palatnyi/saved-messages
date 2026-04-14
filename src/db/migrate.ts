import "dotenv/config";
import { getDb, getClient } from "../db";

async function migrate(): Promise<void> {
  const db = await getDb();

  await db.collection("reminders").createIndex({ userId: 1 });
  await db.collection("reminders").createIndex({ remindAt: 1, status: 1 });

  console.log("Migration complete.");
}

migrate()
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    try { getClient().close(); } catch { /* not yet connected */ }
  });
