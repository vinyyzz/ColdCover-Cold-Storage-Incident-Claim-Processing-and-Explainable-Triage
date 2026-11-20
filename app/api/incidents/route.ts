import { connection } from "next/server";
import { getDatabase } from "@/lib/db";
import { incidentHandlers } from "@/lib/incidents/http";

export async function GET() {
  await connection();
  return incidentHandlers(getDatabase).GET();
}
