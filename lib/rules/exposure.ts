import { z } from "zod";
import { ruleInstantSchema } from "./validation";
import type { BatchExposure, BatchPresenceReason, ExposureBatchInput, ExposureIntervalInput, IntervalBatchExposure } from "./types";

const nonblank = z.string().min(1).refine((value) => value.trim().length > 0, "Use a nonblank source identifier or name.");
// Convert the canonical decimal representation, not value * 100: binary
// multiplication can add a paise near the safe-integer limit. BigInt stays
// internal; returned monetary fields are safe JSON-serializable integers.
export function inrToPaise(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  const [coefficient, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = BigInt(whole + fraction), shift = 2 + Number(exponent) - fraction.length;
  let paise: bigint;
  if (shift >= 0) paise = digits * BigInt(10) ** BigInt(shift);
  else {
    const denominator = BigInt(10) ** BigInt(-shift), remainder = digits % denominator;
    const distance = remainder < denominator - remainder ? remainder : denominator - remainder;
    if (distance * BigInt(1_000_000) >= denominator) return undefined;
    paise = digits / denominator + (remainder * BigInt(2) >= denominator ? BigInt(1) : BigInt(0));
  }
  return paise <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(paise) : undefined;
}
const money = z.number().nonnegative().refine((value) => inrToPaise(value) !== undefined, "Recorded INR values need at most two decimal places within safe integer-paise precision.");

const inputSchema = z.object({
  intervals: z.array(z.object({ id: nonblank, kind: z.literal("abnormal_interval"), start: ruleInstantSchema, end: ruleInstantSchema.nullable() }).superRefine((interval, context) => {
    if (interval.end !== null && Date.parse(interval.end) <= Date.parse(interval.start)) context.addIssue({ code: "custom", path: ["end"], message: "A resolved investigation interval must end after its start." });
  })),
  batches: z.array(z.object({
    id: nonblank.max(120), batchCode: nonblank.max(40), ownerName: nonblank.max(120), quantityKg: z.number().positive(), recordedValueInr: money.nullable(), enteredAt: ruleInstantSchema, exitedAt: ruleInstantSchema.nullable(),
  }).superRefine((batch, context) => {
    if (batch.exitedAt !== null && Date.parse(batch.exitedAt) < Date.parse(batch.enteredAt)) context.addIssue({ code: "custom", path: ["exitedAt"], message: "Batch exit cannot precede entry." });
  })),
}).superRefine(({ intervals, batches }, context) => {
  const intervalIds = new Set<string>(), batchIds = new Set<string>(), codes = new Set<string>();
  intervals.forEach((interval, index) => {
    if (intervalIds.has(interval.id)) context.addIssue({ code: "custom", path: ["intervals", index, "id"], message: "Investigation interval IDs must be unique." });
    intervalIds.add(interval.id);
  });
  batches.forEach((batch, index) => {
    const code = batch.batchCode.trim().toUpperCase();
    if (batchIds.has(batch.id)) context.addIssue({ code: "custom", path: ["batches", index, "id"], message: "Batch IDs must be unique; do not count one record twice." });
    if (codes.has(code)) context.addIssue({ code: "custom", path: ["batches", index, "batchCode"], message: "Batch codes must be unique, ignoring case and surrounding spaces." });
    batchIds.add(batch.id); codes.add(code);
  });
});

export class ExposureValueOverflowError extends RangeError {
  constructor() { super("Recorded-value subtotal exceeds safe integer-paise precision."); this.name = "ExposureValueOverflowError"; }
}
const reasons: Record<BatchPresenceReason, string> = {
  covers_recorded_interval: "Recorded storage covers the investigation interval.",
  stored_at_start_without_exit: "Recorded in storage at the interval start, with no exit recorded.",
  entered_during_interval: "Recorded entry is after the interval start with a positive overlap.",
  left_during_interval: "Recorded exit is within the investigation interval.",
  entered_and_left_during_interval: "Recorded entry and exit are within the investigation interval.",
  left_at_or_before_start: "Recorded exit is at or before the interval start.",
  entered_at_or_after_end: "Recorded entry is at or after the interval end.",
  empty_storage_period: "Recorded entry and exit are the same instant; no positive storage period is recorded.",
};

/**
 * Calculate each qualified window independently for caller-selected chamber
 * records. Never aggregate windows, prorate values, infer stock condition or
 * mutate source records. Brief spikes/drafts are rejected at this boundary.
 */
export function calculateBatchExposure(intervals: readonly ExposureIntervalInput[], batches: readonly ExposureBatchInput[]): IntervalBatchExposure[] {
  const parsed = inputSchema.parse({ intervals, batches });
  const sources = parsed.batches.map((batch) => ({ batch, entry: Date.parse(batch.enteredAt), exit: batch.exitedAt === null ? Infinity : Date.parse(batch.exitedAt), paise: batch.recordedValueInr === null ? null : inrToPaise(batch.recordedValueInr) ?? null }));
  return parsed.intervals.map((interval) => {
    const start = Date.parse(interval.start), end = interval.end === null ? Infinity : Date.parse(interval.end);
    let subtotal = 0;
    const missingValuationBatchIds: string[] = [];
    const rows: BatchExposure[] = sources.map(({ batch, entry, exit, paise }) => {
      let classification: BatchExposure["classification"], reasonCode: BatchPresenceReason;
      if (entry === exit) { classification = "not_present"; reasonCode = "empty_storage_period"; }
      else if (exit <= start) { classification = "not_present"; reasonCode = "left_at_or_before_start"; }
      else if (entry >= end) { classification = "not_present"; reasonCode = "entered_at_or_after_end"; }
      else if (entry <= start && exit >= end) { classification = "present_throughout"; reasonCode = interval.end === null ? "stored_at_start_without_exit" : "covers_recorded_interval"; }
      else {
        classification = "present_partially";
        const enters = entry > start, leaves = exit < end;
        reasonCode = enters && leaves ? "entered_and_left_during_interval" : enters ? "entered_during_interval" : "left_during_interval";
      }
      const present = classification !== "not_present";
      if (present) {
        if (paise === null) missingValuationBatchIds.push(batch.id);
        else {
          if (paise > Number.MAX_SAFE_INTEGER - subtotal) throw new ExposureValueOverflowError();
          subtotal += paise;
        }
      }
      const overlapStart = present ? (entry > start ? batch.enteredAt : interval.start) : null;
      const overlapEnd = !present ? null : end <= exit ? interval.end : batch.exitedAt;
      return { ...batch, batchId: batch.id, classification, reasonCode, reason: reasons[reasonCode], overlapStart, overlapEnd, recordedValuePaise: paise };
    });
    const exactPaise = BigInt(subtotal);
    const knownValueSubtotalInrExact = `${exactPaise / BigInt(100)}.${(exactPaise % BigInt(100)).toString().padStart(2, "0")}`;
    return { intervalId: interval.id, start: interval.start, end: interval.end, label: "Inventory value under investigation", batches: rows, knownValueSubtotalInr: subtotal / 100, knownValueSubtotalInrExact, knownValueSubtotalPaise: subtotal, valuationComplete: missingValuationBatchIds.length === 0, missingValuationBatchIds };
  });
}
