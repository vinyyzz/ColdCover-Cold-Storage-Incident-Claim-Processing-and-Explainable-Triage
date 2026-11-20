import { describe, expect, it } from "vitest";
import { workedExampleReadings } from "../worked-example";
import { at } from "./builders";
import { createScenarioCatalog, getScenario, scenarioCatalog } from "./catalog";

function assertIst(value: string) {
  expect(value).toMatch(/^2026-03-\d{2}T\d{2}:\d{2}:00\+05:30$/);
  expect(Number.isFinite(Date.parse(value))).toBe(true);
}

describe("Scenario source integrity (not rules-engine evaluation)", () => {
  it.each(scenarioCatalog)("#$number $name", (scenario) => {
    const times = scenario.readings.map((reading) => Date.parse(reading.recordedAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
    expect(new Set(scenario.readings.map((reading) => reading.id)).size).toBe(times.length);
    expect(scenario.readings.length).toBeGreaterThanOrEqual(140);
    expect(scenario.readings[0].recordedAt).toBe(at(0));
    expect(scenario.readings.at(-1)?.recordedAt).toBe(at(1430));
    for (const reading of scenario.readings) {
      assertIst(reading.recordedAt);
      expect(reading.chamberId).toBe("CH-1");
      expect(reading.scenarioId).toBe(scenario.id);
      expect(Number.isFinite(reading.temperatureC)).toBe(true);
    }
    const batchCodes = scenario.batches.map((batch) => batch.batchCode);
    expect(new Set(batchCodes).size).toBe(batchCodes.length);
    for (const batch of scenario.batches) {
      assertIst(batch.enteredAt);
      expect(batch.quantityKg).toBeGreaterThan(0);
      if (batch.recordedValueInr !== null) expect(batch.recordedValueInr).toBeGreaterThanOrEqual(0);
      if (batch.exitedAt !== null) {
        assertIst(batch.exitedAt);
        expect(Date.parse(batch.exitedAt)).toBeGreaterThanOrEqual(Date.parse(batch.enteredAt));
      }
    }
    for (const interval of scenario.expected.abnormalIntervals) {
      assertIst(interval.start);
      const startReading = scenario.readings.find((reading) => reading.recordedAt === interval.start);
      expect(startReading?.temperatureC).toBeGreaterThan(5);
      if (interval.end !== null) {
        assertIst(interval.end);
        expect(scenario.readings.find((reading) => reading.recordedAt === interval.end)?.temperatureC).toBeLessThanOrEqual(5);
      }
      const partition = [...interval.presentThroughout, ...interval.presentPartially, ...interval.notPresent];
      expect([...partition].sort()).toEqual([...batchCodes].sort());
      expect(new Set(partition).size).toBe(partition.length);
      expect(interval.keyReasons.length).toBeGreaterThan(0);
    }
    for (const spike of scenario.expected.briefSpikes) {
      assertIst(spike.start);
      expect(spike.durationMinutes).toBeLessThan(30);
      if (spike.end !== null) {
        assertIst(spike.end);
        expect((Date.parse(spike.end) - Date.parse(spike.start)) / 60000).toBe(spike.durationMinutes);
      }
    }
    for (const gap of scenario.expected.dataGaps) {
      assertIst(gap.start); assertIst(gap.end);
      const startIndex = scenario.readings.findIndex((reading) => reading.recordedAt === gap.start);
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(scenario.readings[startIndex + 1].recordedAt).toBe(gap.end);
      expect((Date.parse(gap.end) - Date.parse(gap.start)) / 60000).toBeGreaterThan(30);
    }
    expect(new Set(scenario.documents.map((doc) => doc.id)).size).toBe(scenario.documents.length);
    for (const document of scenario.documents) {
      expect(document.intervalIndex).toBeGreaterThanOrEqual(0);
      expect(document.intervalIndex).toBeLessThan(scenario.expected.abnormalIntervals.length);
      expect(document.rawText).toContain("FICTIONAL DEMONSTRATION RECORD");
      const words = document.rawText.trim().split(/\s+/).length;
      expect(words).toBeGreaterThanOrEqual(100);
      expect(words).toBeLessThanOrEqual(250);
    }
  });

  it("has exactly the thirty numbered cases and category counts from the specification", () => {
    expect(scenarioCatalog.map((s) => s.number)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(new Set(scenarioCatalog.map((s) => s.id)).size).toBe(30);
    const counts: Record<string, number> = {};
    for (const scenario of scenarioCatalog) counts[scenario.category] = (counts[scenario.category] ?? 0) + 1;
    expect(counts).toEqual({ normal: 3, standard_incident: 4, brief_spike: 3, missing_readings: 3, conflicting_evidence: 4, ongoing: 3, stock_timing: 3, missing_evidence: 3, high_exposure: 2, multiple_events: 1, boundary: 1 });
  });

  it("is reproducible and returns isolated simulator inputs", () => {
    expect(createScenarioCatalog()).toEqual(createScenarioCatalog());
    const copy = getScenario("worked-example")!;
    copy.batches[0].recordedValueInr = 1;
    copy.readings[0].temperatureC = 99;
    copy.expected.abnormalIntervals[0].keyReasons.push("changed");
    expect(getScenario("worked-example")!.batches[0].recordedValueInr).toBe(50000);
    expect(getScenario("worked-example")!.readings).toEqual(workedExampleReadings());
    expect(getScenario("worked-example")!.expected.abnormalIntervals[0].keyReasons).toEqual(["missing_inspection_report"]);
    expect(getScenario("missing-id")).toBeUndefined();
  });

  it("preserves the independent worked-example oracle and missing inspection", () => {
    const scenario = getScenario("worked-example")!;
    expect(scenario.expected.abnormalIntervals[0]).toMatchObject({ start: at(80), end: at(340), presentThroughout: ["A", "B"], notPresent: ["C"], exposureValueInr: 80000, readiness: "Needs more evidence", priority: "Standard priority" });
    expect(scenario.documents.map((doc) => doc.docType)).toEqual(["maintenance_report"]);
  });

  it("includes exact threshold/gap/minimum-duration and stock-boundary source cases", () => {
    expect(getScenario("scenario-02")!.readings.some((reading) => reading.temperatureC === 5)).toBe(true);
    const boundary = getScenario("scenario-30")!;
    expect(boundary.expected.abnormalIntervals.map((i) => [i.start, i.end])).toEqual([[at(80), at(110)]]);
    expect(boundary.expected.briefSpikes[0]).toEqual({ start: at(160), end: at(189), durationMinutes: 29 });
    const times = boundary.readings.map((reading) => Date.parse(reading.recordedAt));
    expect(times.some((time, index) => index > 0 && time - times[index - 1] === 30 * 60000)).toBe(true);
    expect(boundary.expected.dataGaps).toEqual([]);
    expect(getScenario("scenario-21")!.batches.find((b) => b.batchCode === "B")!.exitedAt).toBe(at(80));
    expect(getScenario("scenario-22")!.batches.find((b) => b.batchCode === "B")!.enteredAt).toBe(at(340));
    expect(getScenario("scenario-07")!.expected.abnormalIntervals[0]).toMatchObject({ exposureValueInr: 150000, priority: "Standard priority" });
    expect(getScenario("scenario-06")!.documents[0].rawText).toContain(at(280));
    expect(getScenario("scenario-15")!.expected.abnormalIntervals[0]).toMatchObject({ exposureValueInr: 160000, priority: "Specialist review required" });
  });

  it("keeps missing values explicit and separates readiness from priority", () => {
    const missing = getScenario("scenario-26")!;
    expect(missing.batches.find((b) => b.batchCode === "B")!.recordedValueInr).toBeNull();
    expect(missing.expected.abnormalIntervals[0]).toMatchObject({ valuationComplete: false, exposureValueInr: 50000, readiness: "Needs more evidence", priority: "Standard priority" });
    expect(getScenario("scenario-19")!.expected.abnormalIntervals[0]).toMatchObject({ end: null, readiness: "Needs more evidence", priority: "High priority" });
    expect(getScenario("scenario-25")!.documents.map((doc) => doc.docType)).toEqual(["stock_inspection_report"]);
  });

  it("links both incidents' documents to distinct windows without persisting results", () => {
    const scenario = getScenario("scenario-29")!;
    expect(scenario.expected.abnormalIntervals.map((i) => [i.start, i.end, i.exposureValueInr])).toEqual([[at(80), at(160), 80000], [at(600), at(720), 100000]]);
    expect(scenario.documents.filter((doc) => doc.intervalIndex === 0)).toHaveLength(2);
    expect(scenario.documents.filter((doc) => doc.intervalIndex === 1)).toHaveLength(2);
    expect(scenario.documents.find((doc) => doc.intervalIndex === 1 && doc.docType === "stock_inspection_report")!.rawText).toContain(at(780));
  });
});
