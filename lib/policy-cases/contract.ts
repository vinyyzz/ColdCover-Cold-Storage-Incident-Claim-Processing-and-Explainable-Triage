import { z } from "zod";
import { ruleInstantSchema } from "../rules/validation";
import { evidenceLabels, extensionIds, policyIds, scheduleIds, type EvidenceKind } from "./catalogue";

export const caseIdSchema = z.uuid().transform((id) => id.toLowerCase());
const reference = z.string().trim().min(1).max(120);
const evidenceKind = z.enum(Object.keys(evidenceLabels) as [EvidenceKind, ...EvidenceKind[]]);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const evidenceInput = z.object({
  kind: evidenceKind, title: reference, text: z.string().min(1).max(8_000).refine((text) => text.trim().length > 0),
}).strict();
export const targetSchema = z.object({
  code: reference, description: reference, type: z.enum(["building", "cold_room", "insulation", "electrical", "other", "equipment"]),
}).strict();
export const caseDraftSchema = z.object({
  title: reference,
  policyId: z.enum(policyIds),
  event: reference,
  incidentId: reference.optional(),
  batchIds: z.array(reference).max(50),
  targets: z.array(targetSchema).max(12),
  extensions: z.array(z.enum(extensionIds)).max(extensionIds.length),
  evidence: z.array(evidenceInput).max(24),
  readings: z.discriminatedUnion("source", [
    z.object({ source: z.literal("stored"), from: ruleInstantSchema, to: ruleInstantSchema }).strict(),
    z.object({ source: z.literal("csv"), csv: z.string().min(1).max(180_000) }).strict(),
    z.object({ source: z.literal("none") }).strict(),
  ]),
}).strict().superRefine((value, ctx) => {
  const reject = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  for (const key of ["batchIds", "extensions"] as const) {
    if (new Set(value[key]).size !== value[key].length) reject(key, "Select each item once.");
  }
  if (new Set(value.targets.map((t) => t.code.toUpperCase())).size !== value.targets.length) reject("targets", "Declare each asset or unit code once.");
  if (value.readings.source === "stored" && Date.parse(value.readings.from) >= Date.parse(value.readings.to)) reject("readings", "Choose an end after the start.");
});
export type CaseDraft = z.infer<typeof caseDraftSchema>;
export const assignmentSchema = z.object({ batchId: reference, scheduleId: z.enum(scheduleIds).nullable(), expectedScheduleId: z.enum(scheduleIds).nullable() }).strict();
export const prepareSchema = z.object({ id: caseIdSchema, draft: caseDraftSchema, expectedHash: digestSchema, confirmed: z.literal(true) }).strict();
export const outcomes = ["Needs more information", "Referred to specialist", "Approved for assessment", "Closed"] as const;
export const reviewInputSchema = z.object({
  id: caseIdSchema, expectedHash: digestSchema, expectedRevision: z.number().int().min(0).max(199),
  confirmed: z.literal(true), decision: z.enum(outcomes), reviewer: reference, comment: z.string().trim().min(1).max(2000),
}).strict();
export type ReviewInput = z.infer<typeof reviewInputSchema>;
