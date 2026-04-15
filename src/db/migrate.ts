import "dotenv/config";
import { cityMapping } from "city-timezones";
import { getDb, getClient } from "../db";
import { encrypt } from "../utils/crypto";

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

  // Seed 5 test reminders for today for each user (for /check_agenda testing)
  const allUsers = await db.collection("users").find({}).toArray();
  if (allUsers.length > 0) {
    const testTasks = [
      "Buy groceries",
      "Call dentist",
      "Send weekly report",
      "Review pull requests",
      "Team standup meeting",
    ];

    const now = new Date();
    const ops = allUsers.flatMap((user) =>
      testTasks.map((task, i) => {
        const remindAt = new Date(now);
        remindAt.setUTCHours(8 + i * 2, 0, 0, 0); // 08:00, 10:00, 12:00, 14:00, 16:00 UTC
        return {
          insertOne: {
            document: {
              userId: user._id as unknown as number,
              encryptedPayload: encrypt(task),
              remindAt,
              status: "pending" as const,
              createdAt: new Date(),
            },
          },
        };
      })
    );

    await db.collection("reminders").bulkWrite(ops);
    console.log(`Seeded 5 test reminders for ${allUsers.length} user(s).`);
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
