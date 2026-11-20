import { z } from "zod";
import { ruleInstantSchema } from "../rules/validation";

export const RESET_VERSION = "demo-reset-v1";
export const PRIOR_SNAPSHOT_VERSION = "demo-reset-v2";
export const SNAPSHOT_VERSION = "demo-reset-v3";
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export const MAX_SNAPSHOT_ROWS = 250_000;
export const backupIdSchema = z.uuid().transform((id) => id.toLowerCase());
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().safe();
const v2Names = ["chambers", "equipment", "thresholds", "policies", "scenarios", "batches", "temperature_readings", "incidents", "analysis_runs", "analysis_incident_links", "documents", "incident_events", "claims", "review_decisions", "audit_log", "document_corrections", "document_copies", "ai_result_cache", "claim_packets"] as const;
const newNames = ["batch_policy_schedules", "policy_case_packets", "policy_case_reviews"] as const;
export const dataTableNames = [...v2Names, ...newNames] as const;
const v1Names = v2Names.slice(0, -1) as Exclude<typeof v2Names[number], "claim_packets">[];
const emptyPolicyCaseCounts = { batch_policy_schedules: 0, policy_case_packets: 0, policy_case_reviews: 0 };
export const countsSchema = z.union([
  z.record(z.enum(dataTableNames), count),
  z.record(z.enum(v2Names), count).transform((value) => ({ ...value, ...emptyPolicyCaseCounts })),
  z.record(z.enum(v1Names), count).transform((value) => ({ ...value, claim_packets: 0, ...emptyPolicyCaseCounts })),
]);
const common = { requestId: backupIdSchema, expectedState: fingerprint };
export const operationInputSchema = z.discriminatedUnion("action", [
  z.object({ ...common, action: z.literal("reset"), confirmation: z.literal("RESET DEMO") }).strict(),
  z.object({ ...common, action: z.literal("restore"), backupId: backupIdSchema, confirmation: z.literal("RESTORE BACKUP") }).strict(),
]);
export type OperationInput = z.infer<typeof operationInputSchema>;
export const snapshotTableSchema = z.object({ name: z.string().min(1), columns: z.array(z.string().min(1)).min(1), rows: z.array(z.array(z.union([z.string(), z.number().finite(), z.null()]))) }).strict();
export const snapshotSchema = z.union([
  z.object({ version: z.literal(RESET_VERSION), schemaFingerprint: fingerprint, tables: z.array(snapshotTableSchema).length(18) }).strict(),
  z.object({ version: z.literal(PRIOR_SNAPSHOT_VERSION), schemaFingerprint: fingerprint, tables: z.array(snapshotTableSchema).length(19) }).strict(),
  z.object({ version: z.literal(SNAPSHOT_VERSION), schemaFingerprint: fingerprint, tables: z.array(snapshotTableSchema).length(22) }).strict(),
]);
export type ResetSnapshot = z.infer<typeof snapshotSchema>;
export const receiptSchema = z.object({
  version: z.literal(RESET_VERSION), requestId: backupIdSchema, action: z.enum(["reset", "restore"]),
  backupId: backupIdSchema, restoredFrom: backupIdSchema.nullable(), createdAt: ruleInstantSchema,
  beforeCounts: countsSchema, afterCounts: countsSchema, reused: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if ((value.action === "reset") !== (value.restoredFrom === null)) ctx.addIssue({ code: "custom", message: "Receipt action/source differs." });
});
export type OperationReceipt = z.infer<typeof receiptSchema>;
export const backupMetadataSchema = z.object({
  id: backupIdSchema, sequence: count.positive(), action: z.enum(["reset", "restore"]), createdAt: ruleInstantSchema,
  counts: countsSchema, compatible: z.boolean(),
}).strict();
export const resetStatusSchema = z.object({
  version: z.literal(RESET_VERSION), checkedAt: ruleInstantSchema, state: fingerprint, counts: countsSchema,
  backups: z.array(backupMetadataSchema).max(20), nextCursor: count.positive().nullable(),
}).strict();
export type ResetStatus = z.infer<typeof resetStatusSchema>;
export const statusQuerySchema = z.object({ before: z.coerce.number().int().positive().safe().optional() }).strict();
export const operationErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string().min(1) }).strict() }).strict();
