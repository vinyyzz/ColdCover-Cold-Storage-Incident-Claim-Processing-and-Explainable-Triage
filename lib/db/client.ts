import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client/node";
import { drizzle } from "drizzle-orm/libsql";
import { databaseFilePath } from "./config";
import * as schema from "./schema";

export async function openDatabase(url?: string) {
  const path = databaseFilePath(url);
  mkdirSync(dirname(path), { recursive: true });
  // Keep connection-local integrity settings on the same connection.
  const client = createClient({ url: pathToFileURL(path).href, concurrency: 1 });
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("PRAGMA busy_timeout = 5000");
    return { db: drizzle(client, { schema }), client, close: () => client.close() };
  } catch (error) {
    client.close();
    throw error;
  }
}

export type DatabaseConnection = Awaited<ReturnType<typeof openDatabase>>;
export type Database = DatabaseConnection["db"];
