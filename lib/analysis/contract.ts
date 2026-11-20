import { z } from "zod";

const id = z.string().min(1);
const instant = z.iso.datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)) && !/\.\d{4}/.test(value));
const paise = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reading = z.strictObject({ id, recordedAt: instant, temperatureC: z.number() });
const settings = z.strictObject({ abnormalAboveC: z.number(), minAbnormalMinutes: z.number().int().positive(), maxGapMinutes: z.number().int().positive() });
const batchFields = { id, batchCode: id, ownerName: id, quantityKg: z.number().positive(), recordedValueInr: z.number().nonnegative().nullable(), enteredAt: instant, exitedAt: instant.nullable() };
const gap = z.strictObject({ id, start: instant, end: instant, durationMinutes: z.number().positive(), leftReadingId: id, rightReadingId: id });
const runFields = {
  id, start: instant, end: instant.nullable(), observedUntil: instant, durationMinutes: z.number().nonnegative(), ongoing: z.boolean(),
  startReadingId: id, lastAbnormalReadingId: id, endReadingId: id.nullable(), dataGapUncertainty: z.boolean(), gapIds: z.array(id),
  reviewQuestions: z.array(z.strictObject({ code: z.literal("temperature_data_gap"), gapId: id, text: id, sourceReadingIds: z.tuple([id, id]) })),
};
const interval = z.strictObject({ ...runFields, kind: z.literal("abnormal_interval") });
const spike = z.strictObject({ ...runFields, kind: z.literal("brief_spike"), label: z.literal("Brief spike alert"), provisional: z.boolean() });
const exposure = z.strictObject({
  intervalId: id, start: instant, end: instant.nullable(), label: z.literal("Inventory value under investigation"),
  batches: z.array(z.strictObject({ ...batchFields, batchId: id, classification: z.enum(["present_throughout", "present_partially", "not_present"]), reasonCode: z.enum(["covers_recorded_interval", "stored_at_start_without_exit", "entered_during_interval", "left_during_interval", "entered_and_left_during_interval", "left_at_or_before_start", "entered_at_or_after_end", "empty_storage_period"]), reason: id, overlapStart: instant.nullable(), overlapEnd: instant.nullable(), recordedValuePaise: paise.nullable() })),
  knownValueSubtotalInr: z.number().nonnegative(), knownValueSubtotalInrExact: z.string().regex(/^\d+\.\d{2}$/), knownValueSubtotalPaise: paise,
  valuationComplete: z.boolean(), missingValuationBatchIds: z.array(id),
});
const incident = z.strictObject({ intervalId: id, incidentId: id, status: z.enum(["draft", "claim_prepared", "submitted", "under_review", "decided"]) });
const calculated = z.strictObject({
  status: z.enum(["current", "stale"]), reused: z.boolean(), mode: z.literal("stored_log"), claimPacketsUpdated: z.literal(false),
  analysis: z.strictObject({
    id, revision: z.number().int().positive(), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), createdAt: instant,
    inputs: z.strictObject({ chamberId: z.literal("CH-1"), ruleVersion: id, settings, readings: z.array(reading).min(1), batches: z.array(z.strictObject(batchFields)) }),
    temperature: z.strictObject({ abnormalIntervals: z.array(interval), briefSpikes: z.array(spike), dataGaps: z.array(gap) }),
    exposures: z.array(exposure),
    reconciliation: z.strictObject({ previousAnalysisId: id.nullable(), createdIncidentIds: z.array(id), reusedIncidentIds: z.array(id), retainedPreviousIncidentIds: z.array(id) }),
  }),
  incidents: z.array(incident),
}).superRefine(({ analysis, incidents }, context) => {
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  const readings = new Set(analysis.inputs.readings.map((item) => item.id));
  const gaps = new Set(analysis.temperature.dataGaps.map((item) => item.id));
  const intervals = analysis.temperature.abnormalIntervals;
  if (readings.size !== analysis.inputs.readings.length || gaps.size !== analysis.temperature.dataGaps.length || !unique(intervals.map((item) => item.id))) fail("Source and interval identifiers must be unique.");
  if (analysis.exposures.length !== intervals.length || incidents.length !== intervals.length || !unique(analysis.exposures.map((item) => item.intervalId)) || !unique(incidents.map((item) => item.intervalId)) || !unique(incidents.map((item) => item.incidentId))) fail("Every qualified interval needs one exposure result and incident reference.");
  for (const item of [...intervals, ...analysis.temperature.briefSpikes]) {
    if (item.ongoing !== (item.end === null) || (item.end === null) !== (item.endReadingId === null) || Date.parse(item.end ?? item.observedUntil) < Date.parse(item.start)) fail("Interval observation boundaries are inconsistent.");
    if (![item.startReadingId, item.lastAbnormalReadingId, ...(item.endReadingId ? [item.endReadingId] : [])].every((ref) => readings.has(ref)) || !item.gapIds.every((ref) => gaps.has(ref))) fail("Interval evidence refers to unavailable source records.");
    for (const question of item.reviewQuestions) if (!item.gapIds.includes(question.gapId) || !question.sourceReadingIds.every((ref) => readings.has(ref))) fail("A question refers to unavailable gap evidence.");
  }
  for (const item of analysis.temperature.dataGaps) if (!readings.has(item.leftReadingId) || !readings.has(item.rightReadingId)) fail("Gap endpoints need source readings.");
  for (const item of intervals) {
    const result = analysis.exposures.find((value) => value.intervalId === item.id);
    if (!result || result.start !== item.start || result.end !== item.end || !incidents.some((value) => value.intervalId === item.id)) fail("Interval, exposure and incident references must agree.");
  }
  const sourceBatches = new Set(analysis.inputs.batches.map((item) => item.id));
  if (sourceBatches.size !== analysis.inputs.batches.length) fail("Inventory source identifiers must be unique.");
  for (const item of analysis.exposures) {
    // BigInt division avoids rounding the whole rupees at the integer limit.
    const cents = BigInt(item.knownValueSubtotalPaise);
    const exactSafe = `${cents / BigInt(100)}.${String(cents % BigInt(100)).padStart(2, "0")}`;
    if (item.knownValueSubtotalInrExact !== exactSafe || item.knownValueSubtotalInr !== item.knownValueSubtotalPaise / 100) fail("Monetary precision fields must agree.");
    if (item.batches.length !== sourceBatches.size || !unique(item.batches.map((batch) => batch.id)) || !item.batches.every((batch) => batch.id === batch.batchId && sourceBatches.has(batch.batchId))) fail("Exposure rows must refer to the saved inventory sources exactly once.");
    const missing = item.batches.filter((batch) => batch.classification !== "not_present" && batch.recordedValuePaise === null).map((batch) => batch.id).sort();
    if (JSON.stringify(missing) !== JSON.stringify([...item.missingValuationBatchIds].sort()) || item.valuationComplete !== (missing.length === 0)) fail("Missing valuations must remain explicit.");
  }
});

export const analysisResponseSchema = z.union([
  z.strictObject({ status: z.literal("not_analyzed"), analysis: z.null(), incidents: z.array(z.never()).length(0) }),
  calculated,
]);
export type AnalysisResponse = z.infer<typeof analysisResponseSchema>;
export type CalculatedAnalysis = z.infer<typeof calculated>;

/** Format exact safe integer paise with Indian grouping, without float INR. */
export function formatPaise(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Exact nonnegative integer paise required.");
  const cents = BigInt(value);
  return `₹${(cents / BigInt(100)).toLocaleString("en-IN")}.${String(cents % BigInt(100)).padStart(2, "0")}`;
}
