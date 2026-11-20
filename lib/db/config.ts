import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function databaseFilePath(url = process.env.DATABASE_URL ?? "file:./data/coldcover.db") {
  if (!url.startsWith("file:") || url.length === 5 || url.includes(":memory:")) {
    throw new Error("DATABASE_URL must identify a local SQLite file (for example file:./data/coldcover.db).");
  }
  return url.startsWith("file://") ? fileURLToPath(url) : resolve(process.cwd(), url.slice(5));
}

export function databaseUrl() {
  return pathToFileURL(databaseFilePath()).href;
}
