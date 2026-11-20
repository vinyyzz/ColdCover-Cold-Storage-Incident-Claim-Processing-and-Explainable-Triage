import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { analysisIncidentLinks, analysisRuns, documentCorrections, documents } from "../db/schema";
import { ruleInstantSchema } from "../rules/validation";
import { extractionSchema } from "./contract";
import { applyCorrection, correctionInputSchema, type CorrectionRevision, type DocumentCorrectionState } from "./corrections";
import { verifyStoredExtraction } from "./extract";

export const originalDocumentFingerprint = (doc: typeof documents.$inferSelect) => createHash("sha256").update(JSON.stringify({ rawText: doc.rawText, extractionSource: doc.extractionSource, extractionJson: doc.extractionJson })).digest("hex");

// Unqueued read, sharing the caller's transaction. Never apply future annotations
// to an explicitly selected older analysis, even on a reused incident.
async function readCorrections(db: Pick<Database, "select">, doc: typeof documents.$inferSelect, selectedAnalysisRevision: number | null): Promise<DocumentCorrectionState> {
  const rows = await db.select().from(documentCorrections).where(eq(documentCorrections.documentId, doc.id)).orderBy(documentCorrections.revision);
  if (!rows.length) return { latestCorrectionId: null, selectedCorrectionId: null, history: [] };
  const baseline = doc.extractionSource === "fallback" ? verifyStoredExtraction(doc.rawText, doc.id, doc.incidentId, doc.extractionJson) : null;
  if (!baseline) throw new Error("Correction original source is unavailable");
  const links = await db.select({ id: analysisRuns.id, revision: analysisRuns.revision }).from(analysisRuns).innerJoin(analysisIncidentLinks, eq(analysisIncidentLinks.analysisId, analysisRuns.id)).where(and(eq(analysisIncidentLinks.incidentId, doc.incidentId), eq(analysisRuns.chamberId, "CH-1")));
  const origin = links.find((link) => link.id === baseline.association.analysisId);
  if (!origin || (doc.docType !== "maintenance_report" && doc.docType !== "stock_inspection_report")) throw new Error("Invalid original correction source");
  const fingerprint = originalDocumentFingerprint(doc), history: CorrectionRevision[] = [];
  let previous = baseline.extraction;
  for (const row of rows) {
    const input = correctionInputSchema.parse(row.requestJson), analysis = links.find((link) => link.id === row.analysisId), last = history.at(-1);
    if (row.revision !== history.length + 1 || row.id !== `correction-${input.requestId}` || row.previousCorrectionId !== (last?.id ?? null) || input.expectedCorrectionId !== row.previousCorrectionId || row.originalFingerprint !== fingerprint || input.analysisId !== row.analysisId || row.actor !== "storage_operator" || !analysis || analysis.revision < origin.revision || (last && analysis.revision < last.analysisRevision)) throw new Error("Invalid correction provenance chain");
    const extraction = applyCorrection(doc.rawText, doc.id, previous, input);
    if (JSON.stringify(extractionSchema.parse(row.extractionJson)) !== JSON.stringify(extraction)) throw new Error("Invalid correction snapshot");
    history.push({ id: row.id, documentId: doc.id, revision: row.revision, previousCorrectionId: row.previousCorrectionId, analysisId: row.analysisId, analysisRevision: analysis.revision, createdAt: ruleInstantSchema.parse(row.createdAt), actor: "storage_operator", input, extraction });
    previous = extraction;
  }
  const selected = selectedAnalysisRevision === null ? undefined : history.findLast((row) => row.analysisRevision <= selectedAnalysisRevision);
  return { latestCorrectionId: history.at(-1)!.id, selectedCorrectionId: selected?.id ?? null, history };
}

export async function readDocumentCorrections(db: Pick<Database, "select">, doc: typeof documents.$inferSelect, selectedAnalysisRevision: number | null): Promise<DocumentCorrectionState> {
  try { return await readCorrections(db, doc, selectedAnalysisRevision); }
  catch (error) { throw new Error("Saved document correction history could not be verified", { cause: error }); }
}
