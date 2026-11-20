import { describe, expect, it } from "vitest";
import { z } from "zod";
import { scenarioCatalog, getScenario } from "../demo/scenarios/catalog";
import { analyzeTemperature } from "./temperature";
import { calculateBatchExposure, ExposureValueOverflowError } from "./exposure";
import type { ExposureBatchInput, ExposureIntervalInput } from "./types";

const stamp = (time: string) => `2026-03-10T${time}+05:30`;
const interval = (changes: Partial<ExposureIntervalInput> = {}): ExposureIntervalInput => ({ id: "window", kind: "abnormal_interval", start: stamp("01:20:00"), end: stamp("05:40:00"), ...changes });
const batch = (changes: Partial<ExposureBatchInput> = {}): ExposureBatchInput => ({ id: "batch-a", batchCode: "A", ownerName: "Fictional Owner", quantityKg: 10, recordedValueInr: 100, enteredAt: stamp("00:00:00"), exitedAt: null, ...changes });
const settings = { abnormalAboveC: 5, minAbnormalMinutes: 30, maxGapMinutes: 30 };

// These exposure oracles predate both rule implementations. Evaluate actual
// detected intervals, not oracle intervals fed back as inputs.
describe("Independent fixture temporal + batch exposure comparisons", () => {
  it.each(scenarioCatalog)("matches scenario $number: $name", (fixture) => {
    const before = structuredClone(fixture);
    const temporal = analyzeTemperature(fixture.readings, settings);
    const actual = calculateBatchExposure(temporal.abnormalIntervals, fixture.batches);
    expect(actual).toHaveLength(fixture.expected.abnormalIntervals.length);
    actual.forEach((result, index) => {
      const expected = fixture.expected.abnormalIntervals[index];
      for (const [classification, key] of [["present_throughout", "presentThroughout"], ["present_partially", "presentPartially"], ["not_present", "notPresent"]] as const) {
        expect(result.batches.filter((item) => item.classification === classification).map((item) => item.batchCode).sort()).toEqual([...expected[key]].sort());
      }
      expect(result.knownValueSubtotalInr).toBe(expected.exposureValueInr);
      expect(result.valuationComplete).toBe(expected.valuationComplete);
      expect(result.label).toBe("Inventory value under investigation");
    });
    expect(fixture).toEqual(before);
  });
});

describe("Batch overlap boundaries and recorded-value evidence", () => {
  it("returns the worked example's A/B ₹80,000 subtotal and excludes late C", () => {
    const source = getScenario("worked-example")!;
    const [result] = calculateBatchExposure(analyzeTemperature(source.readings, settings).abnormalIntervals, source.batches);
    expect(result.knownValueSubtotalPaise).toBe(8_000_000); expect(result.knownValueSubtotalInr).toBe(80_000);
    expect(result.batches.filter((item) => item.classification !== "not_present").map((item) => item.batchCode)).toEqual(["A", "B"]);
    expect(result.batches.find((item) => item.batchCode === "C")).toMatchObject({ classification: "not_present", reasonCode: "entered_at_or_after_end", overlapStart: null, overlapEnd: null });
    expect(result.valuationComplete).toBe(true);
  });
  it.each([
    { name: "left before start", changes: { exitedAt: stamp("01:19:59.999") }, classification: "not_present", reason: "left_at_or_before_start" },
    { name: "left exactly at start", changes: { exitedAt: stamp("01:20:00") }, classification: "not_present", reason: "left_at_or_before_start" },
    { name: "arrived exactly at end", changes: { enteredAt: stamp("05:40:00") }, classification: "not_present", reason: "entered_at_or_after_end" },
    { name: "arrived after end", changes: { enteredAt: stamp("05:40:00.001") }, classification: "not_present", reason: "entered_at_or_after_end" },
    { name: "entered at start and exited at end", changes: { enteredAt: stamp("01:20:00"), exitedAt: stamp("05:40:00") }, classification: "present_throughout", reason: "covers_recorded_interval" },
    { name: "entered during", changes: { enteredAt: stamp("02:00:00") }, classification: "present_partially", reason: "entered_during_interval" },
    { name: "left during", changes: { exitedAt: stamp("03:00:00") }, classification: "present_partially", reason: "left_during_interval" },
    { name: "entered and left during", changes: { enteredAt: stamp("02:00:00"), exitedAt: stamp("03:00:00") }, classification: "present_partially", reason: "entered_and_left_during_interval" },
    { name: "one millisecond overlap", changes: { enteredAt: stamp("05:39:59.999"), exitedAt: stamp("05:40:00") }, classification: "present_partially", reason: "entered_during_interval" },
    { name: "zero-length storage within window", changes: { enteredAt: stamp("02:00:00"), exitedAt: stamp("02:00:00") }, classification: "not_present", reason: "empty_storage_period" },
  ])("classifies $name", ({ changes, classification, reason }) => {
    const [result] = calculateBatchExposure([interval()], [batch(changes)]);
    expect(result.batches[0]).toMatchObject({ classification, reasonCode: reason, batchId: "batch-a" });
    expect(result.knownValueSubtotalInr).toBe(classification === "not_present" ? 0 : 100);
  });
  it("normalizes offsets and compares instants at exact boundaries", () => {
    const [result] = calculateBatchExposure([interval({ start: "2026-03-09T19:50:00Z", end: "2026-03-10T00:10:00Z" })], [batch({ enteredAt: "2026-03-09T19:50:00.000Z", exitedAt: "2026-03-10T06:10:00+06:00" })]);
    expect(result.batches[0]).toMatchObject({ classification: "present_throughout", overlapStart: stamp("01:20:00"), overlapEnd: stamp("05:40:00"), enteredAt: stamp("01:20:00"), exitedAt: stamp("05:40:00") });
  });
  it("handles midnight/date crossings by instants", () => {
    const [result] = calculateBatchExposure([interval({ start: stamp("23:30:00"), end: "2026-03-11T00:30:00+05:30" })], [batch({ enteredAt: "2026-03-11T00:00:00+05:30" })]);
    expect(result.batches[0]).toMatchObject({ classification: "present_partially", overlapStart: "2026-03-11T00:00:00+05:30", overlapEnd: "2026-03-11T00:30:00+05:30" });
  });
  it("requires no exit for throughout an ongoing interval and never invents an end", () => {
    const [result] = calculateBatchExposure([interval({ end: null })], [batch(), batch({ id: "b", batchCode: "B", exitedAt: stamp("03:00:00") }), batch({ id: "c", batchCode: "C", enteredAt: "2026-03-11T00:00:00+05:30" })]);
    expect(result.batches.map((item) => item.classification)).toEqual(["present_throughout", "present_partially", "present_partially"]);
    expect(result.batches[0]).toMatchObject({ reasonCode: "stored_at_start_without_exit", overlapEnd: null });
    expect(result.batches[1].overlapEnd).toBe(stamp("03:00:00")); expect(result.batches[2].overlapEnd).toBeNull();
  });
  it("does not prorate partial stock by minutes or multiply its value by quantity", () => {
    const [result] = calculateBatchExposure([interval()], [batch({ quantityKg: 1000, enteredAt: stamp("05:39:59.999"), recordedValueInr: 123.45 })]);
    expect(result.knownValueSubtotalPaise).toBe(12345); expect(result.knownValueSubtotalInr).toBe(123.45);
  });
  it("keeps missing exposed value null and distinguishes known zero", () => {
    const [result] = calculateBatchExposure([interval()], [batch({ recordedValueInr: null }), batch({ id: "zero", batchCode: "ZERO", recordedValueInr: 0 }), batch({ id: "known", batchCode: "KNOWN", recordedValueInr: 12.34 })]);
    expect(result).toMatchObject({ knownValueSubtotalPaise: 1234, knownValueSubtotalInr: 12.34, valuationComplete: false, missingValuationBatchIds: ["batch-a"] });
    expect(result.batches[0]).toMatchObject({ recordedValueInr: null, recordedValuePaise: null });
    expect(result.batches[1]).toMatchObject({ recordedValueInr: 0, recordedValuePaise: 0 });
    expect(calculateBatchExposure([interval()], [batch({ recordedValueInr: 0 })])[0].valuationComplete).toBe(true);
    expect(calculateBatchExposure([interval()], [batch({ recordedValueInr: null })])[0]).toMatchObject({ knownValueSubtotalInrExact: "0.00", valuationComplete: false, missingValuationBatchIds: ["batch-a"] });
  });
  it("ignores absent missing valuation for completeness and treats no overlaps as an empty known subtotal", () => {
    const [result] = calculateBatchExposure([interval()], [batch({ enteredAt: stamp("06:00:00"), recordedValueInr: null })]);
    expect(result).toMatchObject({ knownValueSubtotalInr: 0, valuationComplete: true, missingValuationBatchIds: [] });
    expect(calculateBatchExposure([interval()], [])[0]).toMatchObject({ batches: [], knownValueSubtotalPaise: 0, valuationComplete: true });
    expect(calculateBatchExposure([], [batch()])).toEqual([]);
  });
  it("returns separate window subtotals without inventing a combined total", () => {
    const results = calculateBatchExposure([interval(), interval({ id: "second", start: stamp("06:00:00"), end: stamp("07:00:00") })], [batch()]);
    expect(results.map((item) => item.knownValueSubtotalInr)).toEqual([100, 100]); expect(results).not.toHaveProperty("grandTotal");
    expect(results.map((item) => item.intervalId)).toEqual(["window", "second"]);
  });
  it("preserves input order for overlapping windows and limits completeness to each window", () => {
    const results = calculateBatchExposure([interval({ id: "later", start: stamp("04:00:00"), end: stamp("06:00:00") }), interval({ id: "earlier", start: stamp("01:00:00"), end: stamp("05:00:00") })], [batch({ recordedValueInr: null, enteredAt: stamp("05:30:00") })]);
    expect(results.map((item) => item.intervalId)).toEqual(["later", "earlier"]);
    expect(results.map((item) => item.valuationComplete)).toEqual([false, true]);
  });
  it("sums decimal currency in exact integer paise, including floating-point artifacts", () => {
    const [result] = calculateBatchExposure([interval()], [batch({ recordedValueInr: 0.1 }), batch({ id: "b", batchCode: "B", recordedValueInr: 0.2 }), batch({ id: "c", batchCode: "C", recordedValueInr: 0.1 + 0.2 }), batch({ id: "d", batchCode: "D", recordedValueInr: 19.99 })]);
    expect(result.batches.map((item) => item.recordedValuePaise)).toEqual([10, 20, 30, 1999]);
    expect(result.knownValueSubtotalPaise).toBe(2059); expect(result.knownValueSubtotalInr).toBe(20.59);
  });
  it("converts large canonical decimal values without a binary-multiplication extra paise", () => {
    const [result] = calculateBatchExposure([interval()], [batch({ recordedValueInr: 90_071_992_547_409.9 }), batch({ id: "cent", batchCode: "CENT", recordedValueInr: 0.01 })]);
    expect(result.batches[0].recordedValuePaise).toBe(9_007_199_254_740_990);
    expect(result.knownValueSubtotalPaise).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.knownValueSubtotalInrExact).toBe("90071992547409.91");
    expect(JSON.parse(JSON.stringify(result)).knownValueSubtotalPaise).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("rejects an overflowing subtotal before returning unsafe or partial results", () => {
    expect(() => calculateBatchExposure([interval()], [batch({ recordedValueInr: 90_071_992_547_409.9 }), batch({ id: "two-cents", batchCode: "TWO", recordedValueInr: 0.02 })])).toThrow(ExposureValueOverflowError);
  });
  it("does not count large absent values toward the interval's subtotal overflow", () => {
    const [result] = calculateBatchExposure([interval()], [batch({ recordedValueInr: 90_071_992_547_409.9, enteredAt: stamp("06:00:00") }), batch({ id: "small", batchCode: "SMALL", recordedValueInr: 0.02 })]);
    expect(result.knownValueSubtotalPaise).toBe(2);
  });
  it("accepts frozen source metadata and returns isolated evidence records", () => {
    const source = Object.freeze({ ...batch(), chamberId: "CH-1" });
    const rows = Object.freeze([source]), windows = Object.freeze([Object.freeze(interval())]);
    const first = calculateBatchExposure(windows, rows), second = calculateBatchExposure(windows, rows);
    first[0].batches[0].ownerName = "Changed fictional output";
    expect(source.ownerName).toBe("Fictional Owner"); expect(calculateBatchExposure(windows, rows)).toEqual(second);
  });
  it("accepts opaque interval references anchored to long valid reading IDs", () => {
    const temporal = analyzeTemperature([{ id: "a".repeat(120), recordedAt: stamp("00:00:00"), temperatureC: 6 }, { id: "normal", recordedAt: stamp("00:30:00"), temperatureC: 3 }], settings);
    expect(calculateBatchExposure(temporal.abnormalIntervals, [batch()])[0].intervalId).toBe(temporal.abnormalIntervals[0].id);
  });
  it("never produces exposures for actual brief spikes", () => {
    const fixture = getScenario("scenario-08")!;
    const temporal = analyzeTemperature(fixture.readings, settings);
    expect(temporal.briefSpikes).toHaveLength(1); expect(calculateBatchExposure(temporal.abnormalIntervals, fixture.batches)).toEqual([]);
    expect(() => calculateBatchExposure(temporal.briefSpikes as unknown as ExposureIntervalInput[], fixture.batches)).toThrow(z.ZodError);
  });
});

describe("Exposure input validation", () => {
  it.each([
    ["negative value", { recordedValueInr: -1 }], ["fractional paise", { recordedValueInr: 1.001 }], ["unsafe value", { recordedValueInr: 90_071_992_547_409.92 }],
    ["Infinity value", { recordedValueInr: Infinity }], ["NaN value", { recordedValueInr: NaN }], ["numeric string", { recordedValueInr: "100" }],
    ["missing value", { recordedValueInr: undefined }], ["zero quantity", { quantityKg: 0 }], ["negative quantity", { quantityKg: -1 }], ["infinite quantity", { quantityKg: Infinity }],
    ["blank ID", { id: " " }], ["blank code", { batchCode: " " }], ["blank owner", { ownerName: "" }],
    ["missing timezone", { enteredAt: "2026-03-10T00:00:00" }], ["invalid calendar", { enteredAt: "2026-02-30T00:00:00Z" }], ["exit before entry", { enteredAt: stamp("02:00:00"), exitedAt: stamp("01:00:00") }],
    ["submillisecond storage", { enteredAt: stamp("00:00:00.0001") }],
  ])("rejects %s", (_name, changes) => { expect(() => calculateBatchExposure([interval()], [batch(changes as Partial<ExposureBatchInput>)])).toThrow(z.ZodError); });
  it.each([
    ["null draft start", { start: null }], ["missing start", { start: undefined }], ["spike kind", { kind: "brief_spike" }],
    ["zero-length interval", { end: stamp("01:20:00") }], ["reversed interval", { end: stamp("01:00:00") }], ["missing offset", { start: "2026-03-10T01:20:00" }], ["blank interval ID", { id: " " }],
  ])("rejects %s", (_name, changes) => { expect(() => calculateBatchExposure([interval(changes as Partial<ExposureIntervalInput>)], [batch()])).toThrow(z.ZodError); });
  it("rejects duplicate batch IDs/codes or interval IDs instead of double counting", () => {
    expect(() => calculateBatchExposure([interval()], [batch(), batch({ batchCode: "B" })])).toThrow(z.ZodError);
    expect(() => calculateBatchExposure([interval()], [batch(), batch({ id: "different", batchCode: " a " })])).toThrow(z.ZodError);
    expect(() => calculateBatchExposure([interval(), interval()], [batch()])).toThrow(z.ZodError);
  });
});
