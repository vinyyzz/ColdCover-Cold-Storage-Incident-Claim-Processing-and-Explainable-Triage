import { eq } from "drizzle-orm";
import { analysisResponseSchema } from "../analysis/contract";
import { readLatestStoredAnalysis } from "../analysis/service";
import type { Database } from "../db/client";
import { claims, incidents } from "../db/schema";
import { documentInputPolicy } from "./contract";

// Unqueued; callers must own the transaction/connection queue.
export async function readDocumentWritePolicy(db: Pick<Database, "select" | "all">, incident: typeof incidents.$inferSelect, analysisId: string) {
  const latest = analysisResponseSchema.parse(await readLatestStoredAnalysis(db));
  const [claim] = await db.select({ id: claims.id }).from(claims).where(eq(claims.incidentId, incident.id)).limit(1);
  return documentInputPolicy(incident.chamberId === "CH-1" && latest.status === "current" && latest.analysis.id === analysisId && latest.incidents.some((link) => link.incidentId === incident.id), incident.status === "draft", !!claim);
}
