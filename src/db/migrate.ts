import "dotenv/config";
import { cityMapping } from "city-timezones";
import { getDb, getClient } from "../db";
import { encrypt } from "../utils/crypto";

const isProd = process.env.NODE_ENV === "production";
const dbName = isProd ? "savedMessageePROD" : "savedMessagesTEST";

function randomCity(): string {
  const entry = cityMapping[Math.floor(Math.random() * cityMapping.length)];
  return entry?.city ?? "London";
}

async function migrateStructure(): Promise<void> {
  const db = await getDb();

  // --- reminders collection ---
  await db.collection("reminders").createIndex({ userId: 1 }, { background: true });
  await db.collection("reminders").createIndex(
    { remindAt: 1, status: 1 },
    { background: true }
  );
  await db.collection("reminders").createIndex(
    { userId: 1, msgId: 1 },
    { sparse: true, background: true }
  );
  console.log("Indexes ensured on 'reminders'.");

  // --- users collection ---
  await db.collection("users").createIndex({ username: 1 }, { sparse: true, background: true });
  console.log("Indexes ensured on 'users'.");

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
}

async function seedTestData(): Promise<void> {
  const db = await getDb();

  let allUsers = await db.collection("users").find({}).toArray();
  if (allUsers.length === 0) {
    await db.collection("users").insertOne({
      _id: 258158316 as unknown as never,
      createdAt: new Date("2026-04-15T15:20:12.297+00:00"),
      languageCode: "uk",
      username: "palatnyi",
      timezone: "Europe/London",
      city: "London",
      lastNudgeSentAt: new Date("2026-04-16T06:00:28.454+00:00"),
    });
    console.log("No users found — created default user 'palatnyi' (id: 258158316).");
    allUsers = await db.collection("users").find({}).toArray();
  }

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

async function migrate(): Promise<void> {
  console.log(`Running migration against: ${dbName} (NODE_ENV=${process.env.NODE_ENV ?? "unset"})`);

  await migrateStructure();

  if (!isProd) {
    console.log("Non-production environment — seeding test data.");
    await seedTestData();
  } else {
    console.log("Production environment — skipping test data seed.");
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
