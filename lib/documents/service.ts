import { and, eq } from "drizzle-orm";
import { withDatabase } from "../db/access";
import type { Database } from "../db/client";
import { auditLog, documentCopies, documents, incidentEvents, incidents } from "../db/schema";
import { incidentIdSchema } from "../incidents/service";
import { toIstIso } from "../inventory/format";
import { documentInputSchema, type DocumentInput, type DocumentReceipt } from "./contract";
import { readDocumentWritePolicy } from "./eligibility";
import { extractDocument, verifyStoredExtraction } from "./extract";

import { DocumentError } from "./errors";
export { DocumentError } from "./errors";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export function addDocument(db: Database, rawIncidentId: string, rawInput: unknown): Promise<DocumentReceipt> {
  const id = incidentIdSchema.parse(rawIncidentId), input = documentInputSchema.parse(rawInput);
  const documentId = `document-${input.requestId.toLowerCase()}`;
  return withDatabase(db, () => db.transaction(async (tx) => {
    const [existing] = await tx.select().from(documents).where(eq(documents.id, documentId));
    if (existing) {
      const [copy] = await tx.select({ id: documentCopies.documentId }).from(documentCopies).where(eq(documentCopies.documentId, documentId));
      if (copy) throw new DocumentError(409, "REQUEST_CONFLICT", "This submission identifier already belongs to a report copy.");
      const saved = verifyStoredExtraction(existing.rawText, existing.id, existing.incidentId, existing.extractionJson);
      if (existing.incidentId !== id || existing.filename !== input.filename || existing.docType !== input.docType || existing.rawText !== input.rawText || existing.extractionSource !== "fallback" || saved?.association.analysisId !== input.analysisId) throw new DocumentError(409, "REQUEST_CONFLICT", "This submission identifier already belongs to different text. Refresh before making a new submission.");
      return { documentId, incidentId: id, analysisId: input.analysisId, uploadedAt: existing.uploadedAt, extractionSource: "fallback", reused: true };
    }
    const [incident] = await tx.select().from(incidents).where(and(eq(incidents.id, id), eq(incidents.chamberId, "CH-1")));
    if (!incident) throw new DocumentError(404, "NOT_FOUND", "That incident is not available in CH-1.");
    const policy = await readDocumentWritePolicy(tx, incident, input.analysisId);
    if (!policy.allowed) throw new DocumentError(409, "RECORD_PROTECTED", policy.reason!);
    return writeDocument(tx, id, input);
  }));
}

// Unqueued insert primitive; caller owns transaction, eligibility and idempotency.
export async function writeDocument(tx: Transaction, id: string, input: DocumentInput, origin?: { sourceDocumentId: string; sourceIncidentId: string; sourceFingerprint: string; sourceCorrectionId: string | null; sourceCorrectionRevision: number }): Promise<DocumentReceipt> {
  const documentId = `document-${input.requestId.toLowerCase()}`;
  const attached = await tx.select({ rawText: documents.rawText, docType: documents.docType }).from(documents).where(eq(documents.incidentId, id));
  if (attached.some((doc) => doc.docType === input.docType && doc.rawText === input.rawText)) throw new DocumentError(409, "DUPLICATE_DOCUMENT", "This report text is already attached. Refresh evidence to inspect it.");
  const uploadedAt = toIstIso(new Date().toISOString());
  const extraction = extractDocument(input.rawText, documentId, { method: "operator_selected", incidentId: id, analysisId: input.analysisId });
  if (!verifyStoredExtraction(input.rawText, documentId, id, extraction)) throw new Error("Extraction failed source verification");
  await tx.insert(documents).values({ id: documentId, incidentId: id, docType: input.docType, filename: input.filename, rawText: input.rawText, uploadedAt, extractionJson: extraction, extractionSource: "fallback" });
  await tx.insert(incidentEvents).values({ id: `upload-${input.requestId.toLowerCase()}`, incidentId: id, occurredAt: uploadedAt, eventType: "document_uploaded", description: origin ? "Operator explicitly copied report text from another record and ran independent fallback extraction. Original evidence is preserved; association requires human review." : `Operator attached ${input.docType.replaceAll("_", " ")} text with deterministic fallback extraction. Reported facts require review.`, sourceType: "document", sourceRef: documentId });
  await tx.insert(auditLog).values({ id: `document-audit-${input.requestId.toLowerCase()}`, actor: "storage_operator", action: origin ? "document_copied" : "document_attached", entity: "document", entityId: documentId, at: uploadedAt, detail: JSON.stringify({ incidentId: id, analysisId: input.analysisId, association: "operator_selected", extractionSource: "fallback", extractorVersion: extraction.extractorVersion, docType: input.docType, filename: input.filename, ...(origin ? { copiedFrom: origin } : {}) }) });
  return { documentId, incidentId: id, analysisId: input.analysisId, uploadedAt, extractionSource: "fallback", reused: false };
}
