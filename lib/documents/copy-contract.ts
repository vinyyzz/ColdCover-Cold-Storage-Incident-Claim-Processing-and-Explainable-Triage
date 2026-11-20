import { z } from "zod";
import { ruleInstantSchema } from "../rules/validation";
import { documentInputSchema, receiptSchema } from "./contract";

export const copyIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/);
export const sourceSnapshotSchema = z.object({
  id: copyIdentifier, incidentId: copyIdentifier,
  docType: z.enum(["maintenance_report", "stock_inspection_report"]),
  filename: z.string().min(1).max(160), rawText: documentInputSchema.shape.rawText,
  uploadedAt: z.string().refine((value) => ruleInstantSchema.safeParse(value).success),
  extractionSource: z.literal("fallback").nullable(), extractionJson: z.record(z.string(), z.unknown()).nullable(),
}).strict();
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
export const copyInputSchema = z.object({
  requestId: z.uuid().transform((value) => value.toLowerCase()), analysisId: copyIdentifier,
  sourceDocumentId: copyIdentifier, expectedSourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expectedSourceCorrectionId: copyIdentifier.nullable(), associationConfirmed: z.literal(true),
}).strict();
export type CopyInput = z.infer<typeof copyInputSchema>;
export const copyReceiptSchema = receiptSchema.extend({ sourceDocumentId: copyIdentifier, sourceIncidentId: copyIdentifier }).strict();
export type CopyReceipt = z.infer<typeof copyReceiptSchema>;
const metadataSchema = z.object({ id: copyIdentifier, incidentId: copyIdentifier, filename: z.string().min(1).max(160), docType: z.enum(["maintenance_report", "stock_inspection_report"]), uploadedAt: ruleInstantSchema, incidentTitle: z.string().min(1), incidentStatus: z.enum(["draft", "claim_prepared", "submitted", "under_review", "decided"]) }).strict();
export const sourceListSchema = z.object({ targetIncidentId: copyIdentifier, checkedAt: ruleInstantSchema, sources: z.array(metadataSchema).max(20), nextCursor: copyIdentifier.nullable() }).strict();
export type SourceList = z.infer<typeof sourceListSchema>;
export const sourcePreviewSchema = z.object({ targetIncidentId: copyIdentifier, checkedAt: ruleInstantSchema, source: metadataSchema.extend({ rawText: documentInputSchema.shape.rawText }).strict(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), latestCorrectionId: copyIdentifier.nullable(), correctionRevision: z.number().int().nonnegative(), sourceIsCopy: z.boolean() }).strict();
export type SourcePreview = z.infer<typeof sourcePreviewSchema>;
export const copyProvenanceSchema = z.object({ sourceDocumentId: copyIdentifier, sourceIncidentId: copyIdentifier, sourceFilename: z.string().min(1).max(160), sourceUploadedAt: ruleInstantSchema, sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), sourceCorrectionId: copyIdentifier.nullable(), sourceCorrectionRevision: z.number().int().nonnegative(), targetAnalysisId: copyIdentifier, copiedAt: ruleInstantSchema, actor: z.literal("storage_operator") }).strict();
export type CopyProvenance = z.infer<typeof copyProvenanceSchema>;
export const reportSourceHref = (incidentId: string, documentId: string) => `/incidents/${encodeURIComponent(incidentId)}#source-document-${encodeURIComponent(documentId)}`;
