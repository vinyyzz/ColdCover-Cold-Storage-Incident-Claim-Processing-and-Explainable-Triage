import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AnalysisResults from "../../app/temperature/analysis-results";
import { getScenario } from "../demo/scenarios/catalog";
import { analyzeTemperature, calculateBatchExposure } from "../rules";
import { requestStoredAnalysis } from "./client";
import { analysisResponseSchema, formatPaise, type CalculatedAnalysis } from "./contract";

function payload(id = "worked-example"): CalculatedAnalysis {
  const fixture = getScenario(id)!;
  const settings = { abnormalAboveC: 5, minAbnormalMinutes: 30, maxGapMinutes: 30 };
  const readings = fixture.readings.map(({ id, recordedAt, temperatureC }) => ({ id, recordedAt, temperatureC }));
  const batches = fixture.batches.map(({ id, batchCode, ownerName, quantityKg, recordedValueInr, enteredAt, exitedAt }) => ({ id, batchCode, ownerName, quantityKg, recordedValueInr, enteredAt, exitedAt }));
  const temperature = analyzeTemperature(readings, settings);
  const incidents = temperature.abnormalIntervals.map((item, index) => ({ intervalId: item.id, incidentId: `calculated-incident-${index}`, status: "draft" as const }));
  return { status: "current", reused: false, mode: "stored_log", claimPacketsUpdated: false, incidents, analysis: {
    id: "revision-one", revision: 1, createdAt: "2026-10-27T08:00:00+05:30", sourceFingerprint: "a".repeat(64),
    inputs: { chamberId: "CH-1", ruleVersion: "temperature-exposure-v1", settings, readings, batches },
    temperature, exposures: calculateBatchExposure(temperature.abnormalIntervals, batches),
    reconciliation: { previousAnalysisId: null, createdIncidentIds: incidents.map((item) => item.incidentId), reusedIncidentIds: [], retainedPreviousIncidentIds: [] },
  } };
}
const empty = { status: "not_analyzed", analysis: null, incidents: [] };
const signal = () => new AbortController().signal;

describe("Analysis browser contract and request boundary", () => {
  it("accepts explicit empty/current/stale responses without changing source offsets", () => {
    expect(analysisResponseSchema.parse(empty)).toEqual(empty);
    const value = payload(); value.status = "stale";
    value.analysis.inputs.readings[8].recordedAt = "2026-03-09T19:50:00Z";
    expect(analysisResponseSchema.parse(value)).toEqual(value);
  });
  it.each([
    ["unexpected oracle", (value: CalculatedAnalysis) => Object.assign(value, { expected: {} })],
    ["wrong chamber", (value: CalculatedAnalysis) => Object.assign(value.analysis.inputs, { chamberId: "CH-2" })],
    ["unsafe subtotal", (value: CalculatedAnalysis) => { value.analysis.exposures[0].knownValueSubtotalPaise = Number.MAX_SAFE_INTEGER + 1; }],
    ["rounded exact currency", (value: CalculatedAnalysis) => { value.analysis.exposures[0].knownValueSubtotalInrExact = "80000.01"; }],
    ["missing exposure", (value: CalculatedAnalysis) => { value.analysis.exposures = []; }],
    ["duplicate incident", (value: CalculatedAnalysis) => { value.incidents.push(value.incidents[0]); }],
    ["dangling reading", (value: CalculatedAnalysis) => { value.analysis.temperature.abnormalIntervals[0].startReadingId = "missing"; }],
    ["duplicate source", (value: CalculatedAnalysis) => { value.analysis.inputs.readings.push(value.analysis.inputs.readings[0]); }],
    ["ongoing mismatch", (value: CalculatedAnalysis) => { value.analysis.temperature.abnormalIntervals[0].ongoing = true; }],
    ["invented batch", (value: CalculatedAnalysis) => { value.analysis.exposures[0].batches[0].batchId = "missing"; }],
    ["missing value presented complete", (value: CalculatedAnalysis) => { value.analysis.exposures[0].batches[0].recordedValuePaise = null; }],
    ["NaN observation", (value: CalculatedAnalysis) => { value.analysis.inputs.readings[0].temperatureC = NaN; }],
  ])("rejects %s instead of rendering unverified evidence", (_label, mutate) => {
    const value = payload(); mutate(value);
    expect(analysisResponseSchema.safeParse(value).success).toBe(false);
  });
  it.each(["GET", "POST"] as const)("requests %s with no cache, no fixture/body override and cancellation", async (method) => {
    const value = payload(), abort = signal();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
    expect(await requestStoredAnalysis(method, abort, fetcher)).toEqual(value);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/analyze", { method, cache: "no-store", signal: abort });
  });
  it("permits not_analyzed GET but rejects a non-current successful POST", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(empty));
    expect(await requestStoredAnalysis("GET", signal(), fetcher)).toEqual(empty);
    await expect(requestStoredAnalysis("POST", signal(), fetcher)).rejects.toThrow("could not be verified");
    const stale = payload(); stale.status = "stale";
    fetcher.mockImplementation(async () => Response.json(stale));
    await expect(requestStoredAnalysis("POST", signal(), fetcher)).rejects.toThrow("could not be verified");
  });
  it("shows a structured server error and gives a safe fallback for malformed errors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { message: "Import readings before analysis." } }, { status: 409 })).mockResolvedValueOnce(Response.json({ sql: "private SQL" }, { status: 500 }));
    await expect(requestStoredAnalysis("POST", signal(), fetcher)).rejects.toThrow("Import readings before analysis.");
    await expect(requestStoredAnalysis("GET", signal(), fetcher)).rejects.toThrow("Analysis is unavailable");
  });
  it("handles malformed JSON, network failures and successful invalid shapes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("<html>error</html>")).mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(Response.json({ mode: "preview", persisted: false }));
    await expect(requestStoredAnalysis("GET", signal(), fetcher)).rejects.toThrow("could not be read");
    await expect(requestStoredAnalysis("GET", signal(), fetcher)).rejects.toThrow("could not be reached");
    await expect(requestStoredAnalysis("GET", signal(), fetcher)).rejects.toThrow("could not be verified");
  });
  it("keeps an aborted request distinguishable from an application error", async () => {
    const abort = new AbortController(); abort.abort();
    const failure = new DOMException("Aborted", "AbortError");
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(failure);
    await expect(requestStoredAnalysis("GET", abort.signal, fetcher)).rejects.toBe(failure);
  });
  it("formats paise exactly with Indian grouping, including zero and the safe limit", () => {
    expect(formatPaise(0)).toBe("₹0.00");
    expect(formatPaise(8_000_000)).toBe("₹80,000.00");
    expect(formatPaise(Number.MAX_SAFE_INTEGER)).toBe("₹9,00,71,99,25,47,409.91");
    for (const invalid of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => formatPaise(invalid)).toThrow(RangeError);
  });
});

describe("Rendered analysis evidence", () => {
  const html = (value: CalculatedAnalysis) => renderToStaticMarkup(createElement(AnalysisResults, { result: value }));
  it("renders selectable intervals, exact subtotal, explicit presence/reasons and retained-evidence wording", () => {
    const markup = html(payload());
    for (const text of ["Inventory value under investigation", "₹80,000.00", "Present throughout", "Not present", "aria-pressed=\"true\"", "worked-example-reading-008", "never moved automatically", "Claim packets have not been updated"]) expect(markup).toContain(text);
    expect(markup).toContain('href="/incidents/calculated-incident-0?revision=revision-one"');
  });
  it("renders missing valuations as incomplete and preserves zero as a known recorded value", () => {
    const value = payload("scenario-26");
    expect(html(value)).toContain("Known subtotal only · incomplete valuation. Missing values: B");
    value.analysis.exposures[0].batches[0].recordedValuePaise = 0;
    expect(html(value)).toContain("₹0.00");
    expect(html(value)).toContain("Not recorded");
  });
  it("renders spike-only results without incident or stock-exposure sections", () => {
    const markup = html(payload("scenario-08"));
    expect(markup).toContain("No qualified investigation intervals");
    expect(markup).toContain("No incident or batch exposure created");
    expect(markup).not.toContain("Interval batch evidence table");
  });
  it("renders ongoing observation limits and linked missing-evidence questions", () => {
    expect(html(payload("scenario-18"))).toContain("No normal endpoint recorded");
    expect(html(payload("scenario-18"))).toContain("Still unresolved at the last observed high reading");
    const markup = html(payload("scenario-11"));
    expect(markup).toContain("Data-gap uncertainty");
    expect(markup).toContain("Questions from missing evidence");
    expect(markup).toContain("Associated with selected interval");
    expect(markup).toContain("true start/end may differ");
  });
  it("renders multiple interval choices without a combined monetary total and escapes source names", () => {
    const value = payload("scenario-29");
    value.analysis.exposures[0].batches[0].ownerName = "<script>private</script>";
    const markup = html(value);
    expect(markup).toContain("Interval 1"); expect(markup).toContain("Interval 2");
    expect(markup).toContain("₹80,000.00"); expect(markup).not.toContain("₹1,80,000");
    expect(markup).toContain("&lt;script&gt;private&lt;/script&gt;");
  });
});
