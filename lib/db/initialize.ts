import { openDatabase } from "./client";
import { applyMigrations } from "./migrate";
import { seedDatabase } from "./seed";

export async function initializeDatabase(url?: string) {
  const connection = await openDatabase(url);
  try {
    await applyMigrations(connection.db);
    await seedDatabase(connection.db);
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}
