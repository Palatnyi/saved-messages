import "dotenv/config";
import { getDb, getClient } from "../db";


const collectionsToClear = ["reminders", "users"];

async function deleteAllData(): Promise<void> {
  const db = await getDb();

  for (const collectionName of collectionsToClear) {
    await db.collection(collectionName).deleteMany({});
  }
}   

deleteAllData()
  .then(() => {
    console.log("All data deleted successfully.");
  })
  .catch((err) => {
    console.error("Failed to delete data:", err);
    process.exit(1);
  })
  .finally(async () => {
    getClient().close()
        .then(() => console.log("Database connection closed."))
        .catch((err) => console.error("Failed to close database connection:", err));
  });