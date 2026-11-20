import { describe, expect, it } from "vitest";
import { z } from "zod";
import { scenarioCatalog } from "../demo/scenarios/catalog";
import { analyzeTemperature } from "./temperature";
import type { TemperatureReading, TemperatureRuleSettings } from "./types";

const settings = { abnormalAboveC: 5, minAbnormalMinutes: 30, maxGapMinutes: 30 };
const base = Date.parse("2026-03-10T00:00:00+05:30");
const row = (minute: number, temperatureC: number, id = `r${minute}`): TemperatureReading => ({ id, recordedAt: new Date(base + minute * 60000).toISOString(), temperatureC });
const stamp = (time: string) => `2026-03-10T${time}+05:30`;

// Catalogue outcomes were authored before this detector existed. Only temporal
// fields are evaluated here; exposure/readiness/priority are not pipeline passes.
describe("Independent scenario temporal oracles", () => {
  it.each(scenarioCatalog)("matches scenario $number: $name", (fixture) => {
    const before = structuredClone(fixture);
    const actual = analyzeTemperature(fixture.readings, settings);
    expect(actual.abnormalIntervals.map(({ start, end, dataGapUncertainty }) => ({ start, end, dataGapUncertainty }))).toEqual(fixture.expected.abnormalIntervals.map(({ start, end, dataGapUncertainty }) => ({ start, end, dataGapUncertainty })));
    expect(actual.briefSpikes.map(({ start, end, durationMinutes }) => ({ start, end, durationMinutes }))).toEqual(fixture.expected.briefSpikes);
    expect(actual.dataGaps.map(({ start, end }) => ({ start, end }))).toEqual(fixture.expected.dataGaps);
    expect(fixture).toEqual(before);
  });
});

describe("Temperature rules boundaries and evidence", () => {
  it("returns no run for empty/all-normal data, including negative temperatures and threshold equality", () => {
    expect(analyzeTemperature([], settings)).toEqual({ abnormalIntervals: [], briefSpikes: [], dataGaps: [] });
    expect(analyzeTemperature([row(0, -3), row(10, 5), row(20, 0)], settings)).toEqual({ abnormalIntervals: [], briefSpikes: [], dataGaps: [] });
  });
  it("starts strictly above threshold and ends at the first normal, not last high or end of file", () => {
    const result = analyzeTemperature([row(0, 5), row(10, 5.000001), row(20, 6), row(30, 6), row(40, 5), row(50, 3)], settings);
    expect(result.abnormalIntervals).toHaveLength(1);
    expect(result.abnormalIntervals[0]).toMatchObject({ start: stamp("00:10:00"), end: stamp("00:40:00"), observedUntil: stamp("00:40:00"), durationMinutes: 30, startReadingId: "r10", lastAbnormalReadingId: "r30", endReadingId: "r40", ongoing: false, dataGapUncertainty: false });
  });
  it.each([
    ["00:29:00", "spike"], ["00:29:59.999", "spike"], ["00:30:00", "interval"], ["00:30:00.001", "interval"],
  ])("classifies a resolved endpoint at %s as %s", (end, kind) => {
    const result = analyzeTemperature([row(0, 6), row(10, 6), row(20, 6), { id: "closing", recordedAt: stamp(end), temperatureC: 5 }], settings);
    expect(result.abnormalIntervals).toHaveLength(kind === "interval" ? 1 : 0);
    expect(result.briefSpikes).toHaveLength(kind === "spike" ? 1 : 0);
    const run = result.abnormalIntervals[0] ?? result.briefSpikes[0];
    expect(run.end).toBe(stamp(end)); expect(run.ongoing).toBe(false);
    if (kind === "spike") expect(result.briefSpikes[0]).toMatchObject({ label: "Brief spike alert", provisional: false });
  });
  it("does not invent a start before the first reading or an end after a qualified unresolved run", () => {
    const result = analyzeTemperature([row(0, 6), row(10, 7), row(30, 6)], settings);
    expect(result.abnormalIntervals[0]).toMatchObject({ start: stamp("00:00:00"), end: null, observedUntil: stamp("00:30:00"), durationMinutes: 30, ongoing: true, endReadingId: null, lastAbnormalReadingId: "r30" });
  });
  it("uses observed span only for a short unresolved run, even with historical timestamps", () => {
    const result = analyzeTemperature([row(0, 6), row(29, 6)], settings);
    expect(result.abnormalIntervals).toEqual([]);
    expect(result.briefSpikes[0]).toMatchObject({ end: null, durationMinutes: 29, observedUntil: stamp("00:29:00"), ongoing: true, provisional: true });
  });
  it("keeps a single unresolved high reading as a zero-span provisional spike", () => {
    const result = analyzeTemperature([row(0, 3), row(10, 6)], settings);
    expect(result.briefSpikes[0]).toMatchObject({ start: stamp("00:10:00"), end: null, durationMinutes: 0, provisional: true, startReadingId: "r10", lastAbnormalReadingId: "r10" });
    expect(result.abnormalIntervals).toEqual([]);
  });
  it("honors explicit custom thresholds/minimum/gap settings without defaults", () => {
    const result = analyzeTemperature([row(0, 2), row(10, 3), row(20, 2)], { abnormalAboveC: 2, minAbnormalMinutes: 10, maxGapMinutes: 5 });
    expect(result.abnormalIntervals[0]).toMatchObject({ start: stamp("00:10:00"), end: stamp("00:20:00"), durationMinutes: 10, dataGapUncertainty: true });
    expect(result.dataGaps).toHaveLength(2);
  });
  it("does not flag exactly the maximum gap, but flags one millisecond more", () => {
    expect(analyzeTemperature([row(0, 6), row(30, 6), row(40, 3)], settings).dataGaps).toEqual([]);
    const result = analyzeTemperature([row(0, 6), { ...row(30, 6), recordedAt: stamp("00:30:00.001") }, row(40, 3)], settings);
    expect(result.dataGaps).toHaveLength(1); expect(result.abnormalIntervals[0].dataGapUncertainty).toBe(true);
    expect(result.dataGaps[0].durationMinutes).toBeCloseTo(30 + 1 / 60000);
  });
  it("retains one uncertain envelope through a large gap without pretending recovery", () => {
    const result = analyzeTemperature([row(0, 3), row(10, 6), row(50, 7), row(60, 3)], settings);
    expect(result.abnormalIntervals).toHaveLength(1);
    const run = result.abnormalIntervals[0], gap = result.dataGaps[0];
    expect(run).toMatchObject({ start: stamp("00:10:00"), end: stamp("01:00:00"), durationMinutes: 50, dataGapUncertainty: true, gapIds: [gap.id] });
    expect(gap).toMatchObject({ start: stamp("00:10:00"), end: stamp("00:50:00"), durationMinutes: 40, leftReadingId: "r10", rightReadingId: "r50" });
    expect(run.reviewQuestions).toEqual([{ code: "temperature_data_gap", gapId: gap.id, text: `Readings missing between ${stamp("00:10:00")} and ${stamp("00:50:00")}; the true start/end may differ.`, sourceReadingIds: ["r10", "r50"] }]);
  });
  it.each([
    ["ending at first abnormal", [row(0, 3), row(40, 6), row(50, 6), row(60, 6), row(70, 3)]],
    ["ending at closing normal", [row(0, 6), row(10, 6), row(50, 3)]],
    ["starting at closing normal", [row(0, 6), row(10, 6), row(30, 3), row(70, 3)]],
  ])("flags an adjacent gap %s", (_name, readings) => {
    expect(analyzeTemperature(readings, settings).abnormalIntervals[0].dataGapUncertainty).toBe(true);
  });
  it("can link one boundary gap to both neighboring intervals without merging runs", () => {
    const result = analyzeTemperature([row(0, 6), row(10, 6), row(30, 3), row(70, 6), row(80, 6), row(100, 3)], settings);
    expect(result.abnormalIntervals).toHaveLength(2); expect(result.dataGaps).toHaveLength(1);
    expect(result.abnormalIntervals.map((run) => run.gapIds)).toEqual([[result.dataGaps[0].id], [result.dataGaps[0].id]]);
    expect(result.abnormalIntervals[0].end).toBe(stamp("00:30:00")); expect(result.abnormalIntervals[1].start).toBe(stamp("01:10:00"));
  });
  it("reports unrelated normal gaps without linking them to distant intervals", () => {
    const result = analyzeTemperature([row(0, 3), row(40, 3), row(50, 6), row(60, 6), row(80, 3), row(90, 3), row(130, 3)], settings);
    expect(result.dataGaps).toHaveLength(2); expect(result.abnormalIntervals[0]).toMatchObject({ dataGapUncertainty: false, gapIds: [], reviewQuestions: [] });
  });
  it("reports gap-only data without manufacturing an interval or alert", () => {
    const result = analyzeTemperature([row(0, 3), row(90, 5)], settings);
    expect(result.dataGaps).toHaveLength(1); expect(result.abnormalIntervals).toEqual([]); expect(result.briefSpikes).toEqual([]);
  });
  it("attaches uncertainty to provisional spikes without promoting them", () => {
    const result = analyzeTemperature([row(0, 3), row(40, 6)], settings);
    expect(result.abnormalIntervals).toEqual([]); expect(result.briefSpikes[0]).toMatchObject({ dataGapUncertainty: true, provisional: true, durationMinutes: 0 });
    expect(result.briefSpikes[0].reviewQuestions).toHaveLength(1);
  });
  it("normalizes different offsets and fractional seconds without changing source IDs", () => {
    const result = analyzeTemperature([{ id: "start", recordedAt: "2026-03-09T18:30:00.123Z", temperatureC: 6 }, { id: "normal", recordedAt: "2026-03-10T01:00:00.123+06:00", temperatureC: 3 }], settings);
    expect(result.abnormalIntervals[0]).toMatchObject({ start: stamp("00:00:00.123"), end: stamp("00:30:00.123"), durationMinutes: 30, startReadingId: "start", endReadingId: "normal" });
  });
  it("handles midnight/date crossings by instants", () => {
    const result = analyzeTemperature([{ id: "start", recordedAt: "2026-03-10T23:40:00+05:30", temperatureC: 6 }, { id: "high", recordedAt: "2026-03-11T00:00:00+05:30", temperatureC: 6 }, { id: "end", recordedAt: "2026-03-11T00:10:00+05:30", temperatureC: 3 }], settings);
    expect(result.abnormalIntervals[0]).toMatchObject({ start: "2026-03-10T23:40:00+05:30", end: "2026-03-11T00:10:00+05:30", durationMinutes: 30, dataGapUncertainty: false });
  });
  it("provides repeatable collision-safe references and isolated outputs", () => {
    const rows = [row(0, 3, "a|b"), row(40, 3, "c"), row(50, 3, "a"), row(90, 3, "b|c")];
    const first = analyzeTemperature(rows, settings), again = analyzeTemperature(rows, settings);
    expect(first).toEqual(again); expect(new Set(first.dataGaps.map((gap) => gap.id)).size).toBe(2);
    first.dataGaps[0].start = "changed"; expect(analyzeTemperature(rows, settings)).toEqual(again);
    const spike = analyzeTemperature([row(0, 6)], settings).briefSpikes[0];
    const interval = analyzeTemperature([row(0, 6), row(30, 6)], settings).abnormalIntervals[0];
    expect(spike.id).toBe(interval.id);
  });
  it("accepts frozen structural source metadata without reading oracle fields or mutating input", () => {
    const rows = Object.freeze([Object.freeze({ ...row(0, 6), scenarioId: "demo", expected: "irrelevant" }), Object.freeze(row(30, 3))]);
    const config = Object.freeze({ ...settings, id: 1, highExposureThresholdInr: 150000 });
    const result = analyzeTemperature(rows, config);
    expect(result.abnormalIntervals).toHaveLength(1); expect(result).not.toHaveProperty("readiness");
    expect(result.abnormalIntervals[0]).not.toHaveProperty("scenarioId");
  });
  it("handles 20,000 alternating observations/gaps without losing evidence", () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => row(i * 31, i % 2 === 0 ? 6 : 3));
    const result = analyzeTemperature(rows, settings);
    expect(result.abnormalIntervals).toHaveLength(10_000); expect(result.dataGaps).toHaveLength(19_999);
    expect(result.abnormalIntervals.every((run) => run.dataGapUncertainty)).toBe(true);
  });
});

describe("Rules input rejection (no silent coercion, sorting or merging)", () => {
  it.each([
    ["NaN", [{ ...row(0, 3), temperatureC: NaN }]],
    ["Infinity", [{ ...row(0, 3), temperatureC: Infinity }]],
    ["negative Infinity", [{ ...row(0, 3), temperatureC: -Infinity }]],
    ["numeric string", [{ ...row(0, 3), temperatureC: "3" }]],
    ["missing timezone", [{ ...row(0, 3), recordedAt: "2026-03-10T00:00:00" }]],
    ["invalid calendar", [{ ...row(0, 3), recordedAt: "2026-02-30T00:00:00Z" }]],
    ["submillisecond timestamp", [{ ...row(0, 3), recordedAt: stamp("00:00:00.0001") }]],
    ["normalization beyond supported year", [{ ...row(0, 3), recordedAt: "9999-12-31T23:59:00Z" }]],
    ["blank ID", [{ ...row(0, 3), id: " " }]],
    ["missing ID", [{ recordedAt: row(0, 3).recordedAt, temperatureC: 3 }]],
    ["duplicate IDs", [row(0, 3, "same"), row(10, 3, "same")]],
    ["duplicate instants", [row(0, 3), { ...row(10, 3), recordedAt: stamp("00:00:00") }]],
    ["unordered instants", [row(10, 3), row(0, 3)]],
  ])("rejects %s", (_name, rows) => { expect(() => analyzeTemperature(rows as readonly TemperatureReading[], settings)).toThrow(z.ZodError); });
  it.each([
    ["non-finite threshold", { abnormalAboveC: Infinity }],
    ["numeric string threshold", { abnormalAboveC: "5" }],
    ["missing minimum", { minAbnormalMinutes: undefined }],
    ["zero minimum", { minAbnormalMinutes: 0 }],
    ["negative gap", { maxGapMinutes: -1 }],
    ["fractional duration", { minAbnormalMinutes: 1.5 }],
    ["unsafe duration", { maxGapMinutes: Number.MAX_SAFE_INTEGER }],
  ])("rejects %s", (_name, changes) => { expect(() => analyzeTemperature([], { ...settings, ...changes } as TemperatureRuleSettings)).toThrow(z.ZodError); });
  it("reports the location of invalid ordering for a later API boundary", () => {
    try { analyzeTemperature([row(10, 3), row(0, 3)], settings); throw new Error("Expected validation error"); }
    catch (error) { expect(error).toBeInstanceOf(z.ZodError); expect((error as z.ZodError).issues[0].path).toEqual(["readings", 1, "recordedAt"]); }
  });
});
