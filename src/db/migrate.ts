import "dotenv/config";
import { cityMapping } from "city-timezones";
import { getDb, getClient } from "../db";

function randomCity(): string {
  const entry = cityMapping[Math.floor(Math.random() * cityMapping.length)];
  return entry?.city ?? "London";
}

async function migrate(): Promise<void> {
  const db = await getDb();

  await db.collection("reminders").createIndex({ userId: 1 });
  await db.collection("reminders").createIndex({ remindAt: 1, status: 1 });

  // Backfill city for users that don't have one yet
  const users = await db.collection("users").find({ city: { $exists: false } }).toArray();
  if (users.length > 0) {
    const ops = users.map((u) => ({
      updateOne: {
        filter: { _id: u._id },
        update: { $set: { city: randomCity() } },
      },
    }));
    await db.collection("users").bulkWrite(ops);
    console.log(`Backfilled city for ${users.length} user(s).`);
  }

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
