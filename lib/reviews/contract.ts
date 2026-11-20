import { z } from "zod";
import { claimIdentifier, hashSchema } from "../claims/contract";
import { ruleInstantSchema } from "../rules/validation";

export const REVIEW_VERSION = "review-v1";
export const MAX_REVIEW_HISTORY = 200;
export const decisionStatuses = ["approved_for_assessment", "needs_more_info", "referred_to_specialist", "closed"] as const;
export const decisionStatusSchema = z.enum(decisionStatuses);
export type DecisionStatus = z.infer<typeof decisionStatusSchema>;
export const decisionLabels: Record<DecisionStatus, string> = { approved_for_assessment: "Approved for assessment", needs_more_info: "Needs more information", referred_to_specialist: "Referred to specialist", closed: "Closed" };
export const incidentWorkflowSchema = z.enum(["draft", "claim_prepared", "submitted", "under_review", "decided"]);
const text = (max: number) => z.string().trim().min(1).max(max).refine((value) => value.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), "Use readable text.");
export const decisionInputSchema = z.object({
  requestId: z.uuid().transform((value) => value.toLowerCase()), expectedLatestDecisionId: claimIdentifier.nullable(),
  expectedRevision: z.number().int().nonnegative().max(MAX_REVIEW_HISTORY - 1), expectedState: hashSchema,
  status: decisionStatusSchema, reviewerName: text(120).refine((value) => !/[\r\n\t]/u.test(value), "Use a single-line reviewer name."), comment: text(2000), packetReviewed: z.literal(true),
}).strict().superRefine((value, ctx) => { if ((value.expectedLatestDecisionId === null) !== (value.expectedRevision === 0)) ctx.addIssue({ code: "custom", message: "Previous decision and revision differ." }); });
export type DecisionInput = z.infer<typeof decisionInputSchema>;
export const legacyDecisionSchema = z.object({ id: claimIdentifier, claimId: claimIdentifier, reviewerName: text(120), status: decisionStatusSchema, comment: text(2000), decidedAt: ruleInstantSchema }).strict();
export const decisionRecordSchema = legacyDecisionSchema.extend({ revision: z.number().int().positive().max(MAX_REVIEW_HISTORY), previousDecisionId: claimIdentifier.nullable(), packetHash: hashSchema }).strict();
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;
export const decisionAuditSchema = z.object({
  version: z.literal(REVIEW_VERSION), claimId: claimIdentifier, packetHash: hashSchema, revision: z.number().int().positive().max(MAX_REVIEW_HISTORY),
  resetSequence: z.number().int().nonnegative().safe(), beforeWorkflow: incidentWorkflowSchema, afterWorkflow: z.enum(["under_review", "decided"]), request: decisionInputSchema,
}).strict();
export const decisionReceiptSchema = z.object({ version: z.literal(REVIEW_VERSION), requestId: z.uuid(), claimId: claimIdentifier, decision: decisionRecordSchema, workflow: z.enum(["under_review", "decided"]), reused: z.boolean() }).strict();
export type DecisionReceipt = z.infer<typeof decisionReceiptSchema>;
export const workflowFor = (status: DecisionStatus) => status === "approved_for_assessment" || status === "closed" ? "decided" as const : "under_review" as const;
export const reviewStateSchema = z.discriminatedUnion("status", [
  z.object({ version: z.literal(REVIEW_VERSION), status: z.literal("available"), claimId: claimIdentifier, checkedAt: ruleInstantSchema, packetHash: hashSchema, state: hashSchema, workflow: incidentWorkflowSchema, latestDecisionId: claimIdentifier.nullable(), history: z.array(decisionRecordSchema).max(MAX_REVIEW_HISTORY), canRecord: z.boolean(), reason: z.string().min(1).nullable() }).strict(),
  z.object({ version: z.literal(REVIEW_VERSION), status: z.literal("unavailable"), claimId: claimIdentifier, checkedAt: ruleInstantSchema, reason: z.string().min(1), legacyHistory: z.array(legacyDecisionSchema).max(MAX_REVIEW_HISTORY) }).strict(),
]).superRefine((value, ctx) => {
  if (value.status !== "available") return;
  const last = value.history.at(-1);
  if (value.latestDecisionId !== (last?.id ?? null) || value.history.some((row, i) => row.claimId !== value.claimId || row.packetHash !== value.packetHash || row.revision !== i + 1 || row.previousDecisionId !== (value.history[i - 1]?.id ?? null) || (i > 0 && value.history[i - 1].status === "closed")) || new Set(value.history.map((row) => row.id)).size !== value.history.length || (value.canRecord && ((last ? value.workflow !== workflowFor(last.status) : !["claim_prepared", "submitted"].includes(value.workflow)) || value.reason !== null || last?.status === "closed" || value.history.length >= MAX_REVIEW_HISTORY)) || (!value.canRecord && value.reason === null)) ctx.addIssue({ code: "custom", message: "Review state and history differ." });
});
export type ReviewState = z.infer<typeof reviewStateSchema>;
const entrySchema = z.object({
  id: claimIdentifier, title: z.string().min(1), preparedAt: ruleInstantSchema, workflow: incidentWorkflowSchema,
  packetStatus: z.enum(["verified", "legacy", "unavailable"]), readiness: z.enum(["Needs more evidence", "Ready for initial review"]).nullable(), priority: z.enum(["Specialist review required", "High priority", "Standard priority"]).nullable(),
  knownValueSubtotalPaise: z.number().int().nonnegative().safe().nullable(), valuationComplete: z.boolean().nullable(), reasons: z.array(z.string().min(1)), latestDecision: decisionStatusSchema.nullable(), canRecord: z.boolean(), reason: z.string().min(1).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.packetStatus === "verified" ? value.readiness === null || value.priority === null || value.knownValueSubtotalPaise === null || value.valuationComplete === null : value.readiness !== null || value.priority !== null || value.knownValueSubtotalPaise !== null || value.valuationComplete !== null || value.reasons.length > 0 || value.canRecord) ctx.addIssue({ code: "custom", message: "Queue evidence availability differs." });
});
export const reviewerIndexSchema = z.object({ version: z.literal(REVIEW_VERSION), checkedAt: ruleInstantSchema, entries: z.array(entrySchema).max(20), nextCursor: claimIdentifier.nullable() }).strict();
export type ReviewerIndex = z.infer<typeof reviewerIndexSchema>;
export const reviewQuerySchema = z.object({ after: claimIdentifier.optional() }).strict();
export const pendingDecisionSchema = z.object({ claimId: claimIdentifier, input: decisionInputSchema }).strict();
