import { and, eq } from "drizzle-orm";
import { withDatabase } from "../db/access";
import type { Database } from "../db/client";
import { analysisIncidentLinks, auditLog, documentCorrections, documents, incidents } from "../db/schema";
import { toIstIso } from "../inventory/format";
import { applyCorrection, correctionIdentifier, correctionInputSchema, type CorrectionReceipt } from "./corrections";
import { originalDocumentFingerprint, readDocumentCorrections } from "./correction-history";
import { readCopyProvenance } from "./copy-history";
import { readDocumentWritePolicy } from "./eligibility";
import { verifyStoredExtraction } from "./extract";
import { DocumentError } from "./service";

export function correctDocument(db: Database, rawId: string, rawInput: unknown): Promise<CorrectionReceipt> {
  const id = correctionIdentifier.parse(rawId), input = correctionInputSchema.parse(rawInput), correctionId = `correction-${input.requestId}`;
  return withDatabase(db, () => db.transaction(async (tx) => {
    const [doc] = await tx.select().from(documents).where(eq(documents.id, id));
    const [incident] = doc ? await tx.select().from(incidents).where(and(eq(incidents.id, doc.incidentId), eq(incidents.chamberId, "CH-1"))) : [];
    if (!doc || !incident) throw new DocumentError(404, "NOT_FOUND", "That document is not available in CH-1.");
    await readCopyProvenance(tx, doc);
    const [existing] = await tx.select().from(documentCorrections).where(eq(documentCorrections.id, correctionId));
    const state = await readDocumentCorrections(tx, doc, null);
    if (existing) {
      if (existing.documentId !== id || JSON.stringify(correctionInputSchema.parse(existing.requestJson)) !== JSON.stringify(input)) throw new DocumentError(409, "REQUEST_CONFLICT", "This submission identifier belongs to another correction. Refresh before continuing.");
      const saved = state.history.find((row) => row.id === correctionId);
      if (!saved) throw new Error("Correction receipt unavailable");
      return { correctionId, documentId: id, analysisId: input.analysisId, revision: saved.revision, createdAt: saved.createdAt, reused: true };
    }
    const policy = await readDocumentWritePolicy(tx, incident, input.analysisId);
    if (!policy.allowed) throw new DocumentError(409, "RECORD_PROTECTED", policy.reason!);
    if (doc.docType !== "maintenance_report" && doc.docType !== "stock_inspection_report") throw new DocumentError(409, "DOCUMENT_UNSUPPORTED", "Only maintenance and stock inspection reports support these corrections.");
    if (state.latestCorrectionId !== input.expectedCorrectionId) throw new DocumentError(409, "CORRECTION_CONFLICT", "Another correction was saved. Refresh and review the latest document revision before editing.");
    const baseline = doc.extractionSource === "fallback" ? verifyStoredExtraction(doc.rawText, doc.id, doc.incidentId, doc.extractionJson) : null;
    if (!baseline) throw new DocumentError(409, "ORIGINAL_UNAVAILABLE", "The original fallback source could not be verified. Corrections are unavailable; inspect the raw report.");
    const [origin] = await tx.select({ id: analysisIncidentLinks.id }).from(analysisIncidentLinks).where(and(eq(analysisIncidentLinks.incidentId, doc.incidentId), eq(analysisIncidentLinks.analysisId, baseline.association.analysisId))).limit(1);
    if (!origin) throw new DocumentError(409, "ORIGINAL_UNAVAILABLE", "The original document association could not be verified. Inspect the source before continuing.");
    const previous = state.history.at(-1)?.extraction ?? baseline.extraction;
    let extraction;
    try { extraction = applyCorrection(doc.rawText, doc.id, previous, input); }
    catch (error) { throw new DocumentError(400, "UNSUPPORTED_CORRECTION", error instanceof Error ? error.message : "Use exact supporting passages from the original report."); }
    const field = input.change.field;
    const before = { value: previous[field], quotes: previous.evidence_quotes.filter((q) => q.field === field) }, after = { value: extraction[field], quotes: extraction.evidence_quotes.filter((q) => q.field === field) };
    if (JSON.stringify(before) === JSON.stringify(after)) throw new DocumentError(409, "NO_CHANGE", "This correction makes no change. Review the current value and source before submitting.");
    const revision = state.history.length + 1, createdAt = toIstIso(new Date().toISOString());
    await tx.insert(documentCorrections).values({ id: correctionId, documentId: id, revision, previousCorrectionId: state.latestCorrectionId, analysisId: input.analysisId, originalFingerprint: originalDocumentFingerprint(doc), requestJson: input, extractionJson: extraction, actor: "storage_operator", createdAt });
    await tx.insert(auditLog).values({ id: `correction-audit-${input.requestId}`, actor: "storage_operator", action: "document_extraction_corrected", entity: "document", entityId: id, at: createdAt, detail: JSON.stringify({ correctionId, documentId: id, incidentId: incident.id, analysisId: input.analysisId, revision, previousCorrectionId: state.latestCorrectionId, field: input.change.field, before: previous[input.change.field], after: extraction[input.change.field], reason: input.reason, supportConfirmed: true }) });
    return { correctionId, documentId: id, analysisId: input.analysisId, revision, createdAt, reused: false };
  }));
}
