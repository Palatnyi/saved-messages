import "dotenv/config";
import { MongoClient, Db } from "mongodb";

let _client: MongoClient | null = null;
let _db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (!_db) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not set in environment variables");
    const dbName = process.env.NODE_ENV === "production" ? "savedMessageePROD" : "savedMessagesTEST";
    _client = new MongoClient(uri);
    await _client.connect();
    _db = _client.db(dbName);
  }
  return _db;
}

export async function testConnection(): Promise<void> {
  const db = await getDb();
  await db.command({ ping: 1 });
}

export function getClient(): MongoClient {
  if (!_client) throw new Error("DB not connected yet — call getDb() first");
  return _client;
}

export default { getClient };
