import { connection } from "next/server";
import { getDatabase } from "@/lib/db";
import { analysisHandlers } from "@/lib/analysis/http";

const handlers = analysisHandlers(getDatabase);

export const POST = handlers.POST;

export async function GET() {
  await connection();
  return handlers.GET();
}
