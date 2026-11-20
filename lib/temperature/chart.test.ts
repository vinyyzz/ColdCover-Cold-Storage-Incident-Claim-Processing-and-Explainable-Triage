import { describe, expect, it } from "vitest";
import { buildChartModel, chartDate, chartPage, CHART_PAGE_SIZE, type ChartReading } from "./chart";
const settings = { normalMinC: 2, normalMaxC: 5, abnormalAboveC: 5, maxGapMinutes: 30 };
const reading = (minute: number, temperatureC: number): ChartReading => ({ id: `reading-${minute}`, recordedAt: new Date(Date.UTC(2026, 2, 10) + minute * 60000).toISOString(), temperatureC, scenarioId: null });

describe("Temperature chart observations (not incident analysis)", () => {
  it("handles an empty series and keeps the normal band and threshold in its domain", () => {
    const model = buildChartModel([], settings);
    expect(model.points).toEqual([]); expect(model.gaps).toEqual([]); expect(model.spans).toEqual([]);
    expect(model.yDomain[0]).toBeLessThan(2); expect(model.yDomain[1]).toBeGreaterThan(5);
  });
  it("shows a single observation without inventing duration or an incident", () => {
    const model = buildChartModel([reading(0, 6)], settings);
    expect(model.spans).toEqual([{ start: Date.parse(reading(0, 6).recordedAt), end: Date.parse(reading(0, 6).recordedAt), count: 1 }]);
    expect(model.xDomain[0]).toBeLessThan(model.points[0].time); expect(model.xDomain[1]).toBeGreaterThan(model.points[0].time);
  });
  it("uses a strict threshold and observed span endpoints rather than a later normal-reading incident end", () => {
    const rows = [reading(0, 5), reading(10, 6), reading(20, 7), reading(30, 3), reading(40, 6)];
    const model = buildChartModel(rows, settings);
    expect(model.aboveCount).toBe(3); expect(model.spans).toHaveLength(2);
    expect(model.spans[0]).toEqual({ start: Date.parse(rows[1].recordedAt), end: Date.parse(rows[2].recordedAt), count: 2 });
    expect(model.points[0].aboveC).toBeNull(); expect(model.spans[1].count).toBe(1);
  });
  it("does not classify a 29-minute observed run as an incident or discard it", () => {
    const model = buildChartModel([reading(0, 6), reading(29, 6)], settings);
    expect(model.spans[0].count).toBe(2); expect(model.aboveCount).toBe(2);
    expect(model).not.toHaveProperty("incidents");
  });
  it("leaves exactly 30-minute spacing joined but breaks a longer gap with a null point", () => {
    const rows = [reading(0, 6), reading(30, 7), reading(60.001, 6)];
    const model = buildChartModel(rows, settings);
    expect(model.gaps).toHaveLength(1); expect(model.gaps[0].minutes).toBeCloseTo(30.001);
    expect(model.points).toHaveLength(4); expect(model.points[2].temperatureC).toBeNull(); expect(model.points[2].aboveC).toBeNull();
    expect(model.points[2].time).toBeGreaterThan(Date.parse(rows[1].recordedAt)); expect(model.points[2].time).toBeLessThan(Date.parse(rows[2].recordedAt));
    expect(model.spans.map((span) => span.count)).toEqual([2, 1]);
  });
  it("detects gaps for normal readings too and uses persisted configuration values", () => {
    const model = buildChartModel([reading(0, 3), reading(20, 3)], { ...settings, abnormalAboveC: 2.5, maxGapMinutes: 15 });
    expect(model.gaps).toHaveLength(1); expect(model.aboveCount).toBe(2); expect(model.spans).toHaveLength(2);
  });
  it("preserves negative readings and rejects non-finite or duplicate/unordered source instants", () => {
    const row = reading(0, -10), input = [row, reading(10, 7)];
    const before = structuredClone(input), model = buildChartModel(input, settings);
    expect(model.yDomain[0]).toBeLessThan(-10); expect(input).toEqual(before);
    expect(() => buildChartModel([row, { ...row, id: "alias", recordedAt: "2026-03-10T05:30:00+05:30" }], settings)).toThrow("strictly increasing");
    expect(() => buildChartModel([reading(10, 3), row], settings)).toThrow();
    expect(() => buildChartModel([reading(0, Infinity)], settings)).toThrow();
    expect(() => buildChartModel([{ ...row, recordedAt: "bad" }], settings)).toThrow();
  });
  it("keeps exact huge finite values for the table while identifying unplottable spans", () => {
    const model = buildChartModel([reading(0, -1e308), reading(10, 1e308)], settings);
    expect(model.plottable).toBe(false); expect(model.yDomain.every(Number.isFinite)).toBe(true);
    expect(model.points[1].temperatureC).toBe(1e308);
    expect(buildChartModel([reading(0, 1.7e308)], settings).plottable).toBe(false);
  });
  it("rejects invalid chart configuration and formats all dates explicitly in IST", () => {
    expect(() => buildChartModel([], { ...settings, maxGapMinutes: 0 })).toThrow("settings");
    expect(() => buildChartModel([], { ...settings, normalMinC: 6 })).toThrow("settings");
    expect(chartDate(Date.parse("2026-03-10T00:00:00.123Z"))).toContain("05:30:00.123");
  });
  it("pages 20,000 readings without thinning or losing any values/extremes", () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => reading(i, i === 10_500 ? 100 : 3));
    const pages = Array.from({ length: 20 }, (_, i) => chartPage(rows, i));
    expect(pages.every((page) => page.readings.length <= CHART_PAGE_SIZE)).toBe(true);
    expect(pages.flatMap((page) => page.readings).map((row) => row.id).sort()).toEqual(rows.map((row) => row.id).sort());
    expect(pages[0].start).toBe(19_000); expect(pages[19].start).toBe(0);
    expect(buildChartModel(pages[9].readings, settings).yDomain[1]).toBeGreaterThan(100);
  });
  it("clamps page bounds after data changes and handles short final/empty pages", () => {
    const rows = Array.from({ length: 1005 }, (_, i) => reading(i, 3));
    expect(chartPage(rows, 0).readings).toHaveLength(1000);
    expect(chartPage(rows, 1).readings).toHaveLength(5);
    expect(chartPage(rows, 999).page).toBe(1); expect(chartPage(rows, -5).page).toBe(0);
    expect(chartPage(rows, NaN).page).toBe(0); expect(chartPage([], 5)).toMatchObject({ readings: [], start: 0, end: 0, page: 0, pageCount: 1 });
  });
});
