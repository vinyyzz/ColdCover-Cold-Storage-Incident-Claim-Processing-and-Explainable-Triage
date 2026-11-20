import { and, eq, gt, inArray, ne } from "drizzle-orm";
import { withDatabase } from "../db/access";
import type { Database } from "../db/client";
import { documentCopies, documents, incidents } from "../db/schema";
import { toIstIso } from "../inventory/format";
import { copyIdentifier, copyInputSchema, sourceListSchema, sourcePreviewSchema, type CopyReceipt, type SourceList, type SourcePreview } from "./copy-contract";
import { readCopyProvenance, snapshotSource, sourceFingerprint } from "./copy-history";
import { readDocumentCorrections } from "./correction-history";
import { readDocumentWritePolicy } from "./eligibility";
import { DocumentError } from "./errors";
import { writeDocument } from "./service";

type Reader = Pick<Database, "select">;
async function readTarget(db: Reader, id: string) {
  const [target] = await db.select().from(incidents).where(and(eq(incidents.id, id), eq(incidents.chamberId, "CH-1")));
  if (!target) throw new DocumentError(404, "NOT_FOUND", "That incident is not available in CH-1.");
  return target;
}
async function readSource(db: Reader, targetId: string, id: string) {
  const [record] = await db.select({ document: documents, incident: incidents }).from(documents).innerJoin(incidents, eq(incidents.id, documents.incidentId)).where(and(eq(documents.id, id), eq(incidents.chamberId, "CH-1"), inArray(documents.docType, ["maintenance_report", "stock_inspection_report"])));
  if (!record) throw new DocumentError(404, "SOURCE_NOT_FOUND", "That source report is not available in CH-1.");
  if (record.incident.id === targetId) throw new DocumentError(409, "SAME_INCIDENT", "This report already belongs to the selected incident. Inspect its existing document instead.");
  let snapshot;
  try { snapshot = snapshotSource(record.document); }
  catch { throw new DocumentError(409, "SOURCE_UNVERIFIED", "The original report could not be verified for reuse. Inspect the source record before continuing."); }
  const corrections = await readDocumentCorrections(db, record.document, null);
  const provenance = await readCopyProvenance(db, record.document);
  return { ...record, snapshot, fingerprint: sourceFingerprint(snapshot), corrections, provenance };
}

export function listDocumentSources(db: Database, rawTargetId: string, rawAfter?: string): Promise<SourceList> {
  const id = copyIdentifier.parse(rawTargetId), after = rawAfter === undefined ? undefined : copyIdentifier.parse(rawAfter);
  return withDatabase(db, () => db.transaction(async (tx) => {
    await readTarget(tx, id);
    const rows = await tx.select({ id: documents.id, incidentId: documents.incidentId, filename: documents.filename, docType: documents.docType, uploadedAt: documents.uploadedAt, incidentTitle: incidents.title, incidentStatus: incidents.status }).from(documents).innerJoin(incidents, eq(incidents.id, documents.incidentId)).where(and(eq(incidents.chamberId, "CH-1"), ne(documents.incidentId, id), inArray(documents.docType, ["maintenance_report", "stock_inspection_report"]), after ? gt(documents.id, after) : undefined)).orderBy(documents.id).limit(21);
    try { return sourceListSchema.parse({ targetIncidentId: id, checkedAt: toIstIso(new Date().toISOString()), sources: rows.slice(0, 20), nextCursor: rows.length > 20 ? rows[19].id : null }); }
    catch (error) { throw new Error("Stored source catalogue is invalid", { cause: error }); }
  }));
}
export function previewDocumentSource(db: Database, rawTargetId: string, rawSourceId: string): Promise<SourcePreview> {
  const id = copyIdentifier.parse(rawTargetId), sourceId = copyIdentifier.parse(rawSourceId);
  return withDatabase(db, () => db.transaction(async (tx) => {
    await readTarget(tx, id);
    const source = await readSource(tx, id, sourceId);
    try { return sourcePreviewSchema.parse({ targetIncidentId: id, checkedAt: toIstIso(new Date().toISOString()), source: { id: source.document.id, incidentId: source.incident.id, filename: source.snapshot.filename, docType: source.snapshot.docType, rawText: source.snapshot.rawText, uploadedAt: source.snapshot.uploadedAt, incidentTitle: source.incident.title, incidentStatus: source.incident.status }, fingerprint: source.fingerprint, latestCorrectionId: source.corrections.latestCorrectionId, correctionRevision: source.corrections.history.at(-1)?.revision ?? 0, sourceIsCopy: source.provenance !== null }); }
    catch (error) { throw new Error("Stored source preview is invalid", { cause: error }); }
  }));
}
export function copyDocument(db: Database, rawTargetId: string, rawInput: unknown): Promise<CopyReceipt> {
  const id = copyIdentifier.parse(rawTargetId), input = copyInputSchema.parse(rawInput), documentId = `document-${input.requestId}`;
  return withDatabase(db, () => db.transaction(async (tx) => {
    const [existing] = await tx.select().from(documents).where(eq(documents.id, documentId));
    if (existing) {
      const [row] = await tx.select().from(documentCopies).where(eq(documentCopies.documentId, documentId));
      if (existing.incidentId !== id || !row) throw new DocumentError(409, "REQUEST_CONFLICT", "This submission identifier belongs to different report text or a different copy. Refresh before continuing.");
      const saved = await readCopyProvenance(tx, existing);
      if (!saved) throw new Error("Copied receipt unavailable");
      if (JSON.stringify(copyInputSchema.parse(row.requestJson)) !== JSON.stringify(input)) throw new DocumentError(409, "REQUEST_CONFLICT", "This submission identifier belongs to a different copy. Refresh before continuing.");
      return { documentId, incidentId: id, analysisId: input.analysisId, uploadedAt: existing.uploadedAt, extractionSource: "fallback", reused: true, sourceDocumentId: saved.sourceDocumentId, sourceIncidentId: saved.sourceIncidentId };
    }
    const target = await readTarget(tx, id);
    const policy = await readDocumentWritePolicy(tx, target, input.analysisId);
    if (!policy.allowed) throw new DocumentError(409, "RECORD_PROTECTED", policy.reason!);
    const source = await readSource(tx, id, input.sourceDocumentId);
    if (source.fingerprint !== input.expectedSourceFingerprint || source.corrections.latestCorrectionId !== input.expectedSourceCorrectionId) throw new DocumentError(409, "SOURCE_CHANGED", "The source report or its corrections changed after review. Reload the source and confirm the association again.");
    const sourceCorrectionRevision = source.corrections.history.at(-1)?.revision ?? 0;
    const receipt = await writeDocument(tx, id, { requestId: input.requestId, analysisId: input.analysisId, filename: source.snapshot.filename, docType: source.snapshot.docType, rawText: source.snapshot.rawText }, { sourceDocumentId: source.document.id, sourceIncidentId: source.incident.id, sourceFingerprint: source.fingerprint, sourceCorrectionId: source.corrections.latestCorrectionId, sourceCorrectionRevision });
    await tx.insert(documentCopies).values({ documentId, sourceDocumentId: source.document.id, sourceIncidentId: source.incident.id, sourceCorrectionId: source.corrections.latestCorrectionId, sourceCorrectionRevision, analysisId: input.analysisId, requestJson: input, sourceSnapshotJson: source.snapshot, actor: "storage_operator", createdAt: receipt.uploadedAt });
    return { ...receipt, sourceDocumentId: source.document.id, sourceIncidentId: source.incident.id };
  }));
}
