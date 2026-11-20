import "./load-env";
import { initializeDatabase } from "../lib/db/initialize";

async function main() {
  const connection = await initializeDatabase();
  connection.close();
  console.log("ColdCover demo seeded: missing records added; existing records preserved. No analysis or claim generated.");
}

main().catch((error: unknown) => { console.error("Seed failed:", error); process.exitCode = 1; });
