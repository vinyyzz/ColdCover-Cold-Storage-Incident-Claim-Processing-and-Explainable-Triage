import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { analysisIncidentLinks, documentCopies, documents, incidents } from "../db/schema";
import { documentInputSchema } from "./contract";
import { copyInputSchema, copyProvenanceSchema, sourceSnapshotSchema, type CopyProvenance, type SourceSnapshot } from "./copy-contract";
import { readDocumentCorrections } from "./correction-history";
import { verifyStoredExtraction } from "./extract";

type Reader = Pick<Database, "select">;
export function snapshotSource(doc: typeof documents.$inferSelect): SourceSnapshot {
  const parsed = sourceSnapshotSchema.parse(doc);
  const input = documentInputSchema.pick({ docType: true, filename: true, rawText: true }).parse({ docType: doc.docType, filename: doc.filename, rawText: doc.rawText });
  if (input.filename !== doc.filename || (doc.extractionSource === null ? doc.extractionJson !== null : !verifyStoredExtraction(doc.rawText, doc.id, doc.incidentId, doc.extractionJson))) throw new Error("Original source cannot be verified");
  return parsed;
}
export const sourceFingerprint = (snapshot: SourceSnapshot) => createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

// Unqueued; validate immediate provenance and every ancestor without importing
// operator corrections into a new fallback or rewriting older provenance.
async function readProvenance(db: Reader, document: typeof documents.$inferSelect): Promise<CopyProvenance | null> {
  const visited = new Set<string>();
  let current = document, result: CopyProvenance | null = null;
  while (true) {
    if (visited.has(current.id)) throw new Error("Copy ancestry cycle");
    visited.add(current.id);
    const [row] = await db.select().from(documentCopies).where(eq(documentCopies.documentId, current.id));
    if (!row) return result;
    const input = copyInputSchema.parse(row.requestJson), frozen = sourceSnapshotSchema.parse(row.sourceSnapshotJson);
    const [source] = await db.select().from(documents).where(eq(documents.id, row.sourceDocumentId));
    const [origin] = source ? await db.select({ id: incidents.id }).from(incidents).where(and(eq(incidents.id, source.incidentId), eq(incidents.chamberId, "CH-1"))) : [];
    const [target] = await db.select({ id: incidents.id }).from(incidents).where(and(eq(incidents.id, current.incidentId), eq(incidents.chamberId, "CH-1")));
    const [link] = await db.select({ id: analysisIncidentLinks.id }).from(analysisIncidentLinks).where(and(eq(analysisIncidentLinks.analysisId, row.analysisId), eq(analysisIncidentLinks.incidentId, current.incidentId)));
    const baseline = current.extractionSource === "fallback" ? verifyStoredExtraction(current.rawText, current.id, current.incidentId, current.extractionJson) : null;
    if (!source || !origin || !target || !link || !baseline || baseline.association.analysisId !== row.analysisId || source.incidentId === current.incidentId || current.id !== `document-${input.requestId}` || row.sourceDocumentId !== input.sourceDocumentId || row.sourceIncidentId !== source.incidentId || frozen.id !== source.id || frozen.incidentId !== source.incidentId || row.analysisId !== input.analysisId || row.sourceCorrectionId !== input.expectedSourceCorrectionId || row.actor !== "storage_operator" || row.createdAt !== current.uploadedAt || sourceFingerprint(frozen) !== input.expectedSourceFingerprint || sourceFingerprint(snapshotSource(source)) !== input.expectedSourceFingerprint || frozen.rawText !== current.rawText || frozen.filename !== current.filename || frozen.docType !== current.docType) throw new Error("Invalid copied source provenance");
    const history = await readDocumentCorrections(db, source, null);
    const revision = history.history.find((item) => item.id === row.sourceCorrectionId);
    if (row.sourceCorrectionId === null ? row.sourceCorrectionRevision !== 0 : !revision || row.sourceCorrectionRevision !== revision.revision) throw new Error("Invalid reviewed source correction");
    if (!result) result = copyProvenanceSchema.parse({ sourceDocumentId: source.id, sourceIncidentId: source.incidentId, sourceFilename: frozen.filename, sourceUploadedAt: frozen.uploadedAt, sourceFingerprint: input.expectedSourceFingerprint, sourceCorrectionId: row.sourceCorrectionId, sourceCorrectionRevision: row.sourceCorrectionRevision, targetAnalysisId: row.analysisId, copiedAt: row.createdAt, actor: row.actor });
    current = source;
  }
}
export async function readCopyProvenance(db: Reader, document: typeof documents.$inferSelect): Promise<CopyProvenance | null> {
  try { return await readProvenance(db, document); }
  catch (error) { throw new Error("Saved copied-report provenance could not be verified", { cause: error }); }
}
