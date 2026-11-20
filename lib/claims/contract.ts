import { z } from "zod";
import { ruleInstantSchema } from "../rules/validation";

export const CLAIM_VERSION = "claim-packet-v1";
export const CLAIM_DISCLAIMER = "This report organises evidence for human review. It does not determine spoilage, loss amount, or claim payment.";
export const MAX_PACKET_BYTES = 16 * 1024 * 1024;
export const claimIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const prepareInputSchema = z.object({
  requestId: z.uuid().transform((id) => id.toLowerCase()), analysisId: claimIdentifier, policyId: claimIdentifier,
  expectedSourceToken: hashSchema, evidenceReviewed: z.literal(true),
}).strict();
export type PrepareInput = z.infer<typeof prepareInputSchema>;
export const sourceTableNames = ["chambers", "equipment", "thresholds", "policies", "scenarios", "batches", "temperature_readings", "incidents", "analysis_runs", "analysis_incident_links", "documents", "incident_events", "document_corrections", "document_copies"] as const;
export const sourceTableSchema = z.object({ name: z.enum(sourceTableNames), columns: z.array(z.string().min(1)).min(1), rows: z.array(z.array(z.union([z.string(), z.number().finite(), z.null()]))) }).strict();
export const frozenPacketSchema = z.object({
  version: z.literal(CLAIM_VERSION), claimId: claimIdentifier, incidentId: claimIdentifier, analysisId: claimIdentifier,
  policyId: claimIdentifier, preparedAt: ruleInstantSchema, actor: z.literal("storage_operator"), disclaimer: z.literal(CLAIM_DISCLAIMER),
  sourceToken: hashSchema, resetSequence: z.number().int().nonnegative().safe(),
  sources: z.array(sourceTableSchema).length(sourceTableNames.length), resultJson: z.json(), resultHash: hashSchema,
}).strict();
export type FrozenPacket = z.infer<typeof frozenPacketSchema>;
export const claimReceiptSchema = z.object({ version: z.literal(CLAIM_VERSION), claimId: claimIdentifier, incidentId: claimIdentifier, analysisId: claimIdentifier, preparedAt: ruleInstantSchema, reused: z.boolean() }).strict();
export type ClaimReceipt = z.infer<typeof claimReceiptSchema>;
export const previewSchema = z.object({
  version: z.literal(CLAIM_VERSION), incidentId: claimIdentifier, analysisId: claimIdentifier, checkedAt: ruleInstantSchema,
  sourceToken: hashSchema,
  policy: z.object({ id: claimIdentifier, name: z.string().min(1), demonstrationLabel: z.string().min(1), wording: z.string().min(1), notes: z.string().min(1), recordsRequiredText: z.string().min(1), machineryBreakdownCoverRequired: z.boolean() }).strict(),
  readiness: z.enum(["Needs more evidence", "Ready for initial review"]), priority: z.enum(["Specialist review required", "High priority", "Standard priority"]),
  knownValueSubtotalPaise: z.number().int().nonnegative().safe(), valuationComplete: z.boolean(),
  checklist: z.array(z.object({ id: z.string(), text: z.string(), status: z.enum(["provided", "missing", "not_applicable"]) }).strict()),
  documentIds: z.array(claimIdentifier),
}).strict();
export type ClaimPreview = z.infer<typeof previewSchema>;
export const pendingPreparationSchema = z.object({ incidentId: claimIdentifier, input: prepareInputSchema }).strict();
