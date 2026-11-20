import "./load-env";
import { openDatabase } from "../lib/db/client";
import { applyMigrations } from "../lib/db/migrate";

async function main() {
  const connection = await openDatabase();
  try {
    await applyMigrations(connection.db);
    console.log("ColdCover database migrations applied. No demo records inserted.");
  } finally {
    connection.close();
  }
}

main().catch((error: unknown) => { console.error("Migration failed:", error); process.exitCode = 1; });
