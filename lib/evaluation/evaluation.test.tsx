import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import ScenarioEvaluation, { EvaluationResults, ScenarioDetails } from "../../app/admin/scenarios";
import { initializeDatabase } from "../db/initialize";
import * as t from "../db/schema";
import { getScenario, scenarioCatalog } from "../demo/scenarios/catalog";
import { parseEvaluationReport } from "./contract";
import { computeScenario, evaluateFixture, runAllScenarios } from "./evaluate";
import { evaluationHandler } from "./http";
import { requestScenarioEvaluation } from "./client";

const stamp = "2026-10-31T23:45:00+05:30";
const report = runAllScenarios(stamp);
const actual = (id: string) => report.results.find((row) => row.id === id)!.actual!;
afterEach(() => vi.unstubAllEnvs());

describe("Source-only full deterministic fixture pipeline", () => {
  it.each(scenarioCatalog)("#$number $id matches every independent authored outcome", (fixture) => {
    const row = evaluateFixture(fixture);
    expect(row.error).toBeNull(); expect(row.status).toBe("passed"); expect(row.comparisons.every((check) => check.passed)).toBe(true);
    expect(row.comparisons.length).toBeGreaterThanOrEqual(3);
    expect(row.actual!.intervals.map((interval) => interval.readiness)).toEqual(fixture.expected.abnormalIntervals.map((interval) => interval.readiness));
    expect(row.actual!.intervals.map((interval) => interval.priority)).toEqual(fixture.expected.abnormalIntervals.map((interval) => interval.priority));
  });
  it("runs all30 with367 comparisons and no mutation or wall-clock dependency", () => {
    const before = structuredClone(scenarioCatalog), other = runAllScenarios("2026-11-01T00:45:00+05:30");
    expect(report).toMatchObject({ total: 30, passed: 30, different: 0, errors: 0, persisted: false, mode: "isolated_fixtures" });
    expect(report.results.reduce((n, row) => n + row.comparisons.length, 0)).toBe(367);
    expect(report.results).toEqual(other.results); expect(scenarioCatalog).toEqual(before);
  });
  it("never uses expected results to compute sources, values or associations", () => {
    const fixture = getScenario("worked-example")!, original = evaluateFixture(fixture).actual;
    Object.assign(fixture.expected.abnormalIntervals[0], { exposureValueInr: 1, readiness: "Ready for initial review", priority: "Specialist review required" });
    const changed = evaluateFixture(fixture); expect(changed.status).toBe("different"); expect(changed.actual).toEqual(original);
    expect(changed.comparisons.filter((check) => !check.passed)).toHaveLength(3);
    const { expected, ...source } = fixture;
    expect(expected.abnormalIntervals[0].priority).not.toBe(original!.intervals[0].priority);
    expect(computeScenario(source)).toEqual(original); expect(() => computeScenario(fixture)).toThrow();
  });
  it("reports a changed source as an actual difference instead of copying its oracle", () => {
    const fixture = getScenario("scenario-27")!; fixture.batches[0].recordedValueInr = 0;
    const row = evaluateFixture(fixture); expect(row.status).toBe("different");
    expect(row.actual!.intervals[0]).toMatchObject({ knownValueSubtotalPaise: 6_000_000, priority: "Standard priority" });
    expect(row.comparisons.filter((check) => !check.passed).map((check) => check.id)).toContain("interval-0-priority");
  });
  it("keeps explicit report assignments separate for multiple events", () => {
    const source = actual("scenario-29"); expect(source.intervals).toHaveLength(2);
    for (const [index, interval] of source.intervals.entries()) {
      expect(interval.documentIds).toHaveLength(2); expect(interval.documentIds.every((id) => source.documents.find((doc) => doc.id === id)!.intervalIndex === index)).toBe(true);
      expect(interval.summary.facts.flatMap((fact) => fact.sources).filter((s) => s.type === "document").every((s) => interval.documentIds.includes(s.id))).toBe(true);
    }
  });
  it("creates no batch/triage/summary associations for normal or brief-spike cases", () => {
    for (const id of ["scenario-01", "scenario-02", "scenario-03", "scenario-08", "scenario-09", "scenario-10"]) expect(actual(id).intervals).toEqual([]);
    expect(actual("scenario-10").briefSpikes).toHaveLength(2);
    expect(actual("scenario-30").intervals).toHaveLength(1); expect(actual("scenario-30").briefSpikes[0].durationMinutes).toBe(29);
  });
  it("preserves unknown-cause support, Specialist precedence and neutral date observations", () => {
    expect(actual("scenario-16").intervals[0].reasons.some((reason) => reason.code === "cause_unclear" && reason.sources.some((s) => s.type === "document" && s.quote?.quote.includes("unknown")))).toBe(true);
    expect(actual("scenario-15").intervals[0]).toMatchObject({ knownValueSubtotalPaise: 16_000_000, priority: "Specialist review required" });
    const interval = actual("scenario-17").intervals[0]; expect(interval.dateObservations).toHaveLength(3); expect(interval.reasons.some((r) => r.code === "restart_log_conflict")).toBe(true);
    expect(interval.reasons.some((r) => r.code === "report_date_difference")).toBe(false);
  });
  it("preserves gap, ongoing, missing value, half-open stock and priority threshold boundaries", () => {
    expect(actual("scenario-11").intervals[0]).toMatchObject({ dataGapUncertainty: true, readiness: "Ready for initial review" });
    expect(actual("scenario-18").intervals[0]).toMatchObject({ end: null, ongoing: true, presentPartially: ["C"], priority: "High priority" });
    expect(actual("scenario-26").intervals[0]).toMatchObject({ knownValueSubtotalPaise: 5_000_000, valuationComplete: false, readiness: "Needs more evidence" });
    for (const id of ["scenario-21", "scenario-22"]) expect(actual(id).intervals[0].notPresent).toEqual(["B", "C"]);
    expect(actual("scenario-07").intervals[0]).toMatchObject({ knownValueSubtotalPaise: 15_000_000, priority: "Standard priority" });
  });
  it("does not invent stock-record mappings from inspection batch references", () => {
    const interval = actual("scenario-06").intervals[0]; expect(interval.readiness).toBe("Ready for initial review");
    expect(interval.checklist.find((item) => item.id === "stock_records")?.status).toBe("missing");
    expect(interval.questions.some((q) => q.code === "missing_stock_records")).toBe(true);
  });
  it.each(["foreign chamber", "wrong scenario", "duplicate report", "out-of-range association", "spike association", "unsorted readings"])("fails closed on %s source and leaves other cases available", (kind) => {
    const fixture = getScenario(kind === "spike association" ? "scenario-08" : "worked-example")!;
    if (kind === "foreign chamber") fixture.batches[0].chamberId = "CH-2";
    if (kind === "wrong scenario") fixture.readings[0].scenarioId = "foreign";
    if (kind === "duplicate report") fixture.documents.push(fixture.documents[0]);
    if (kind === "out-of-range association") fixture.documents[0].intervalIndex = 1;
    if (kind === "spike association") fixture.documents.push(getScenario("worked-example")!.documents[0]);
    if (kind === "unsorted readings") fixture.readings.reverse();
    expect(evaluateFixture(fixture)).toMatchObject({ status: "error", actual: null, comparisons: [] });
    expect(evaluateFixture(getScenario("scenario-06")!).status).toBe("passed");
  });
  it("unknown authored reason names fail visibly rather than passing by default", () => {
    const fixture = getScenario("worked-example")!; fixture.expected.abnormalIntervals[0].keyReasons.push("unsupported-oracle-reason");
    expect(evaluateFixture(fixture).comparisons.find((check) => check.id.endsWith("unsupported-oracle-reason"))?.passed).toBe(false);
  });
});

describe("Evaluation response, request and browser contracts", () => {
  it.each(["totals", "duplicate case", "comparison flag", "passing status", "missing result", "foreign citation", "wrong original", "foreign correction", "wrong assignment", "extraction passage", "batch partition", "checklist source"])("rejects corrupt %s responses", (kind) => {
    const value = structuredClone(report), row = value.results[3], interval = row.actual!.intervals[0];
    if (kind === "totals") value.passed--;
    if (kind === "duplicate case") value.results[1].id = value.results[0].id;
    if (kind === "comparison flag") row.comparisons[0].passed = false;
    if (kind === "passing status") row.status = "different";
    if (kind === "missing result") value.results.pop();
    if (kind === "foreign citation") interval.summary.statements[0].source_ids = ["foreign"];
    if (kind === "wrong original") row.actual!.documents[0].rawText = "changed original";
    if (kind === "foreign correction") { const source = interval.summary.facts.flatMap((f) => f.sources).find((s) => s.type === "document")!; if (source.type === "document") source.correctionId = "foreign"; }
    if (kind === "wrong assignment") row.actual!.documents[0].intervalIndex = 9;
    if (kind === "extraction passage") row.actual!.documents[0].extraction.evidence_quotes[0].end++;
    if (kind === "batch partition") interval.notPresent = [];
    if (kind === "checklist source") interval.checklist[0].sources = [{ type: "reading", id: "foreign" }];
    expect(() => parseEvaluationReport(value)).toThrow();
  });
  it.each([undefined, "", "   ", "{}"])("accepts only an empty evaluation request (%s), returning no-store", async (body) => {
    const handler = evaluationHandler(() => report), response = await handler(new Request("http://test/api/admin/run-scenarios", { method: "POST", body, headers: { "Content-Type": "application/json" } }));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store"); expect(parseEvaluationReport(await response.json()).passed).toBe(30);
  });
  it.each([["{", 400], ["[]", 400], ["null", 400], ['{"readings":[]}', 400], ['{"settings":{}}', 400], ['{"expected":{}}', 400], [" ".repeat(1025), 413]])("rejects invalid/oversized input before evaluation", async (body, status) => {
    const run = vi.fn(() => report), response = await evaluationHandler(run)(new Request("http://test/api/admin/run-scenarios", { method: "POST", body: String(body), headers: { "Content-Type": "application/json" } }));
    expect(response.status).toBe(status); expect(run).not.toHaveBeenCalled(); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects wrong content type and malformed UTF8 before running", async () => {
    const run = vi.fn(() => report), handler = evaluationHandler(run);
    expect((await handler(new Request("http://test", { method: "POST", body: "{}", headers: { "Content-Type": "text/plain" } }))).status).toBe(415);
    expect((await handler(new Request("http://test", { method: "POST", body: new Uint8Array([0xff]) }))).status).toBe(400); expect(run).not.toHaveBeenCalled();
  });
  it("does not expose thrown diagnostics or fabricate a completed run", async () => {
    const response = await evaluationHandler(() => { throw new Error("private diagnostic"); })(new Request("http://test", { method: "POST" }));
    expect(response.status).toBe(500); const value = await response.json(); expect(value.error.code).toBe("EVALUATION_UNAVAILABLE"); expect(JSON.stringify(value)).not.toContain("private diagnostic"); expect(value).not.toHaveProperty("passed");
  });
  it("client sends only an empty POST, validates response and preserves caller abort signal", async () => {
    const signal = new AbortController().signal, fetcher = vi.fn<typeof fetch>(async () => Response.json(report));
    expect((await requestScenarioEvaluation(signal, fetcher)).passed).toBe(30);
    expect(fetcher).toHaveBeenCalledWith("/api/admin/run-scenarios", expect.objectContaining({ method: "POST", body: "{}", cache: "no-store", signal }));
    await expect(requestScenarioEvaluation(signal, vi.fn(async () => Response.json({ ...report, passed: 29 })))).rejects.toThrow("could not be verified");
    await expect(requestScenarioEvaluation(signal, vi.fn(async () => new Response("private server diagnostic", { status: 500 })))).rejects.toThrow("could not be completed");
    await expect(requestScenarioEvaluation(signal, vi.fn(async () => new Response("not JSON")))).rejects.toThrow("could not be verified");
    await expect(requestScenarioEvaluation(signal, vi.fn(async () => { throw new Error("private transport diagnostic"); }))).rejects.toThrow("Check the connection and try again");
  });
  it("renders an explicit empty state, status labels and source-linked escaped detail", () => {
    const empty = renderToStaticMarkup(createElement(ScenarioEvaluation)); expect(empty).toContain("No evaluation yet"); expect(empty).toContain("Run all 30 scenarios"); expect(empty).not.toContain("30 of 30 scenarios matched");
    const results = renderToStaticMarkup(createElement(EvaluationResults, { report })); expect(results).toContain("30 of 30 scenarios matched"); expect(results).toContain("367 comparisons"); expect(results).toContain("Differences and errors");
    const detail = renderToStaticMarkup(createElement(ScenarioDetails, { row: report.results[3] }));
    for (const text of ["₹80,000.00", "Needs more evidence", "Statement sources", "Full original fictional report", "AI unavailable — using rule-based fallback", "Source-verified extraction", "Exact original offsets"]) expect(detail).toContain(text);
    const changed = structuredClone(report.results[3]); changed.actual!.documents[0].rawText = "<script>fictional</script>";
    const escaped = renderToStaticMarkup(createElement(ScenarioDetails, { row: changed })); expect(escaped).toContain("&lt;script&gt;fictional&lt;/script&gt;"); expect(escaped).not.toContain("<script>fictional</script>");
  });
  it("keeps the operator-like database unchanged and ignores persisted criteria", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coldcover-evaluation-")), url = pathToFileURL(join(dir, "operator-like.db")).href;
    vi.stubEnv("DATABASE_URL", url); const connection = await initializeDatabase(url);
    try {
      await connection.db.update(t.thresholds).set({ abnormalAboveC: 100, highExposureThresholdInr: 1 });
      await connection.db.insert(t.claims).values({ id: "packet", incidentId: "demo-incident-01", policyId: "coldcover-demo-policy", readiness: "Needs more evidence", priority: "Standard priority", triageReasonsJson: [], exposureValueInr: 80000, summaryJson: [{ text: "Preserve historical packet", source_ids: ["old"] }], missingEvidenceJson: [], createdAt: stamp });
      await connection.db.insert(t.reviewDecisions).values({ id: "review", claimId: "packet", reviewerName: "Fictional reviewer", status: "closed", comment: "Preserve", decidedAt: stamp });
      async function dump() { const names = (await connection.client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows; const rows: Record<string, unknown> = {}; for (const { name } of names) rows[String(name)] = (await connection.client.execute(`SELECT * FROM "${name}" ORDER BY 1`)).rows; return rows; }
      const before = await dump(), response = await evaluationHandler()(new Request("http://test", { method: "POST" }));
      expect(response.status).toBe(200); expect(parseEvaluationReport(await response.json()).passed).toBe(30); expect(await dump()).toEqual(before);
    } finally { connection.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
