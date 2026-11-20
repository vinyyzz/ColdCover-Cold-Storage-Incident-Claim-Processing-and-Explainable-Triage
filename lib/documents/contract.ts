import { z } from "zod";
import { ruleInstantSchema } from "../rules/validation";

export const MAX_DOCUMENT_BYTES = 256 * 1024;
export const documentInputSchema = z.object({
  requestId: z.uuid(),
  analysisId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/),
  docType: z.enum(["maintenance_report", "stock_inspection_report"]),
  filename: z.string().trim().min(1).max(160).refine((s) => !/[\\/\u0000-\u001f\u007f]/.test(s), "Use a display filename without paths or control characters."),
  rawText: z.string().min(1).max(50_000).refine((s) => s.trim().length > 0 && s.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s), "Paste nonblank report text without control characters."),
}).strict();
export type DocumentInput = z.infer<typeof documentInputSchema>;
export const scalarFields = ["equipment_id", "reported_fault", "reported_cause", "fault_time", "repair_time", "restart_time", "stock_condition", "inspection_date"] as const;
export const arrayFields = ["observations", "batches_mentioned"] as const;
export const fieldSchema = z.enum([...scalarFields, ...arrayFields]);
export type ExtractionField = z.infer<typeof fieldSchema>;
export const fieldLabels: Record<ExtractionField, string> = {
  equipment_id: "Reported equipment ID", reported_fault: "Reported fault", reported_cause: "Reported cause",
  fault_time: "Reported fault time", repair_time: "Reported repair time", restart_time: "Reported restart time",
  stock_condition: "Reported stock condition", inspection_date: "Reported inspection time", observations: "Reported observations", batches_mentioned: "Batch references",
};
export const passageSchema = z.object({ quote: z.string().min(1).max(600), start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict();
export const quoteSchema = passageSchema.extend({
  field: fieldSchema, value: z.string().min(1), source_document_id: z.string().min(1),
  time_zone_context: passageSchema.optional(),
}).strict();
export const extractionSchema = z.object({
  equipment_id: z.string().nullable(), reported_fault: z.string().nullable(), reported_cause: z.string().nullable(),
  fault_time: ruleInstantSchema.nullable(), repair_time: ruleInstantSchema.nullable(), restart_time: ruleInstantSchema.nullable(),
  observations: z.array(z.string()).max(100), stock_condition: z.string().nullable(), inspection_date: ruleInstantSchema.nullable(),
  batches_mentioned: z.array(z.string()).max(100), evidence_quotes: z.array(quoteSchema).max(1000),
}).strict();
export type ExtractedFacts = z.infer<typeof extractionSchema>;
export type EvidenceQuote = ExtractedFacts["evidence_quotes"][number];
export const storedExtractionSchema = z.object({
  schemaVersion: z.literal(1), extractorVersion: z.literal("fallback-v1"), sourceDocumentId: z.string().min(1),
  association: z.object({ method: z.literal("operator_selected"), incidentId: z.string().min(1), analysisId: z.string().min(1) }).strict(),
  extraction: extractionSchema, warnings: z.array(z.string()).max(100),
}).strict();
export type StoredExtraction = z.infer<typeof storedExtractionSchema>;
export const receiptSchema = z.object({ documentId: z.string(), incidentId: z.string(), analysisId: z.string(), uploadedAt: ruleInstantSchema, extractionSource: z.literal("fallback"), reused: z.boolean() }).strict();
export type DocumentReceipt = z.infer<typeof receiptSchema>;

export function documentInputPolicy(current: boolean, draft: boolean, hasClaim: boolean) {
  const reason = !current ? "New text requires the latest fresh incident revision. Refresh or reanalyse, then open its current record." : !draft || hasClaim ? "Prepared, submitted or reviewed records are read-only. Their evidence is preserved." : null;
  return { allowed: reason === null, reason };
}
