import "server-only";
import { initializeDatabase } from "./initialize";

let pending: ReturnType<typeof initializeDatabase> | undefined;

// Server-side feature modules use this lazy, non-destructive initialization.
// Scripts/tests use the explicitly owned connection factories instead.
export async function getDatabase() {
  pending ??= initializeDatabase().catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return (await pending).db;
}
