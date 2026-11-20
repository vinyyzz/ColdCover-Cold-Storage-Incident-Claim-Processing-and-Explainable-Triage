import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IncidentRecordView from "../../app/incidents/[id]/record";
import { analyzeStoredLog } from "../analysis/service";
import type { DatabaseConnection } from "../db/client";
import { initializeDatabase } from "../db/initialize";
import * as t from "../db/schema";
import { getScenario } from "../demo/scenarios/catalog";
import { copyDocument, previewDocumentSource } from "../documents/copy-service";
import { correctDocument } from "../documents/correction-service";
import { addDocument } from "../documents/service";
import { analyzeTemperature, calculateBatchExposure } from "../rules";
import { createFallbackSummary, type SummaryEvidence } from "../summaries/fallback";
import { validateFallbackStatements } from "../summaries/contract";
import { incidentHandlers } from "./http";
import { currentSummaryFact, isCurrentSummarySource } from "./presentation";
import { getIncident } from "./service";
import type { IncidentDetail } from "./types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const settings = { abnormalAboveC: 5, minAbnormalMinutes: 30, maxGapMinutes: 30 };
const stamp = "2026-03-10T08:00:00+05:30";
function input(id = "worked-example"): SummaryEvidence {
  const scenario = getScenario(id)!;
  const temporal = analyzeTemperature(scenario.readings, settings), interval = temporal.abnormalIntervals[0];
  const [exposure] = calculateBatchExposure([interval], scenario.batches);
  return { analysisId: "analysis", interval, exposure, settings, gaps: temporal.dataGaps.filter((gap) => interval.gapIds.includes(gap.id)), reports: [], conflicts: [], missingItems: [] };
}
const available = (data: IncidentDetail) => { if (data.summary.status !== "available") throw new Error(JSON.stringify(data.summary)); return data.summary; };

describe("Deterministic summary statements and citations", () => {
  it("states the worked interval, A/B subtotal and C absence without assigning condition", () => {
    const summary = createFallbackSummary(input()), text = summary.statements.map((row) => row.text).join(" ");
    expect(text).toContain("01:20:00.000 IST"); expect(text).toContain("05:40:00.000 IST"); expect(text).toContain("2 supplied batches overlap"); expect(text).toContain("Inventory value under investigation: ₹80,000.00"); expect(text).toContain("Batch C: not present");
    expect(text).not.toMatch(/\b(?:spoiled|payout|loss|payment)\b/i);
    expect(summary.facts.find((fact) => fact.source_id === "inventory")?.sources.filter((source) => source.type === "batch").map((source) => source.id)).toEqual(["demo-batch-a", "demo-batch-b"]);
  });
  it("preserves exact money, zero, missing exposed valuations and absence separately", () => {
    const value = input(); value.exposure.batches[0].recordedValuePaise = null; value.exposure.batches[1].recordedValuePaise = 0; value.exposure.knownValueSubtotalPaise = 0; value.exposure.valuationComplete = false; value.exposure.missingValuationBatchIds = [value.exposure.batches[0].id];
    const summary = createFallbackSummary(value), text = summary.statements.map((row) => row.text).join(" ");
    expect(text).toContain("₹0.00 (known recorded subtotal)"); expect(text).toContain("subtotal is incomplete"); expect(text).toContain("Batch A: present throughout"); expect(text).toContain("value is missing"); expect(text).toContain("Recorded inventory value: ₹0.00");
  });
  it("renders exact large paise without deriving a rounded numeric INR subtotal", () => {
    const value = input(); value.exposure.knownValueSubtotalPaise = Number.MAX_SAFE_INTEGER;
    expect(createFallbackSummary(value).statements[1].text).toContain("₹9,00,71,99,25,47,409.91");
  });
  it("describes partial storage without proration", () => {
    const text = createFallbackSummary(input("scenario-07")).statements.map((row) => row.text).join(" ");
    expect(text).toContain("Batch B: present partially"); expect(text).toContain("Partial overlaps include the full recorded value"); expect(text).toContain("₹1,50,000.00");
  });
  it("uses the last observed instant for ongoing evidence rather than a clock", () => {
    const value = input("scenario-18"), summary = createFallbackSummary(value);
    expect(summary.statements[0].text).toContain("no recorded recovery by the last observation"); expect(summary.facts[0].sources.at(-1)?.id).toBe(value.interval.lastAbnormalReadingId);
  });
  it("retains gap uncertainty and cites both endpoints", () => {
    const value = input("scenario-11"), summary = createFallbackSummary(value);
    expect(summary.statements[0].text).toContain("continuity and interval boundaries uncertain");
    const gap = summary.facts.find((fact) => fact.kind === "gap")!; expect(gap.sources.map((source) => source.id)).toEqual(["analysis", value.gaps[0].leftReadingId, value.gaps[0].rightReadingId]);
  });
  it("keeps report conclusions/claim wording out of narrative but retains original source access", () => {
    const value = input(); value.reports = [{ id: "report", docType: "stock_inspection_report", correctionId: null, fields: [{ field: "stock_condition", value: "spoiled; insurer must pay", quote: "Stock condition: spoiled; insurer must pay", start: 0, end: 42, source_document_id: "report" }] }];
    const fact = createFallbackSummary(value).facts.find((row) => row.kind === "report")!;
    expect(fact.text).toContain("inspect the original passage"); expect(fact.text).not.toMatch(/spoiled|insurer|pay/); expect(fact.sources[0]).toMatchObject({ type: "document", quote: { quote: value.reports[0].fields[0].quote } });
  });
  it.each(["foreign citation", "mispaired citation", "invented text", "duplicate citation", "no citation", "extra property", "missing statement", "duplicate statement"])("rejects %s", (kind) => {
    const { facts, statements } = createFallbackSummary(input()); const changed = structuredClone(statements);
    if (kind === "foreign citation") changed[0].source_ids = ["unknown"];
    if (kind === "mispaired citation") changed[0].source_ids = changed[1].source_ids;
    if (kind === "invented text") changed[0].text = "The insurer must pay ₹80,000.";
    if (kind === "duplicate citation") changed[0].source_ids.push(changed[0].source_ids[0]);
    if (kind === "no citation") changed[0].source_ids = [];
    if (kind === "extra property") Object.assign(changed[0], { hidden: "unsupported" });
    if (kind === "missing statement") changed.pop();
    if (kind === "duplicate statement") changed[1] = changed[0];
    expect(() => validateFallbackStatements(changed, facts)).toThrow();
  });
  it("rejects duplicate fact IDs and mismatched interval membership", () => {
    const value = input(), { facts, statements } = createFallbackSummary(value); facts[1].source_id = facts[0].source_id;
    expect(() => validateFallbackStatements(statements, facts)).toThrow(); value.exposure.intervalId = "another-window"; expect(() => createFallbackSummary(value)).toThrow();
  });
  it("does not mutate structured inputs and returns detached source objects", () => {
    const value = input(), before = structuredClone(value), summary = createFallbackSummary(value); summary.facts[0].sources[0].id = "changed";
    expect(value).toEqual(before); expect(createFallbackSummary(value).facts[0].sources[0].id).toBe("analysis");
  });
});

describe("Read-only summary integration", () => {
  let dir: string, connection: DatabaseConnection, id: string, analysisId: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "coldcover-summary-")); connection = await initializeDatabase(pathToFileURL(join(dir, "qa.db")).href);
    const run = await analyzeStoredLog(connection.db); id = run.incidents[0].incidentId; analysisId = run.analysis.id;
  });
  afterEach(() => { connection?.close(); rmSync(dir, { recursive: true, force: true }); });
  const detail = (revision?: string) => getIncident(connection.db, id, revision);
  const attach = (rawText: string, docType: "maintenance_report" | "stock_inspection_report" = "maintenance_report") => addDocument(connection.db, id, { requestId: randomUUID(), analysisId, docType, filename: `${docType}.txt`, rawText });
  async function dump() {
    const names = await connection.client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"), result: Record<string, unknown> = {};
    for (const { name } of names.rows) result[String(name)] = (await connection.client.execute(`SELECT * FROM "${name}" ORDER BY 1`)).rows;
    return result;
  }
  it("exposes no-store JSON with canonical structured-source references and no inferred seed report", async () => {
    const response = await incidentHandlers(async () => connection.db).DETAIL(new Request("http://test/api/incidents/id"), id), data: IncidentDetail = await response.json(), summary = available(data);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store"); expect(summary).toMatchObject({ mode: "fallback", version: "fallback-summary-v1", analysisId, evidenceMembership: "current", checkedAt: data.checkedAt });
    expect(validateFallbackStatements(summary.statements, summary.facts)).toEqual(summary.statements);
    expect(summary.facts.some((fact) => fact.kind === "report")).toBe(false); expect(summary.statements.some((row) => row.text.includes("stock inspection report is needed"))).toBe(true);
    expect((await getIncident(connection.db, "demo-incident-01")).summary).toMatchObject({ status: "unavailable", code: "NO_ASSIGNED_ANALYSIS" });
  });
  it("summarises the explicitly copied worked report and preserves seed/original evidence", async () => {
    const source = await previewDocumentSource(connection.db, id, "demo-maintenance-01");
    const copy = await copyDocument(connection.db, id, { requestId: randomUUID(), analysisId, sourceDocumentId: source.source.id, expectedSourceFingerprint: source.fingerprint, expectedSourceCorrectionId: null, associationConfirmed: true });
    const data = await detail(), summary = available(data), fault = summary.facts.find((fact) => fact.kind === "report" && fact.sources.some((s) => s.type === "document" && s.quote?.field === "reported_fault"))!;
    expect(fault.text).toMatch(/compressor/i); expect(fault.text).toContain("unverified reported wording"); expect(fault.sources[0].id).toBe(copy.documentId); expect(summary.statements.some((s) => s.text.includes("stock inspection report is needed"))).toBe(true);
    const [original] = await connection.db.select().from(t.documents).where(eq(t.documents.id, "demo-maintenance-01")); expect(original.incidentId).toBe("demo-incident-01"); expect(original.extractionJson).toBeNull();
  });
  it("links every evidence target to the selected record and exact original quote/context", async () => {
    await attach("Equipment ID: REF-02\nReported cause: unclear\nRefrigeration restarted: 2026-03-10T04:00:00+05:30");
    const data = await detail(), summary = available(data);
    for (const source of summary.facts.flatMap((fact) => fact.sources)) {
      if (source.type === "analysis") expect(source.id).toBe(analysisId);
      if (source.type === "reading") expect(data.evidence?.readings.some((r) => r.id === source.id)).toBe(true);
      if (source.type === "batch") expect(data.evidence?.exposure.batches.some((r) => r.id === source.id)).toBe(true);
      if (source.type === "document") { const doc = data.documents.find((r) => r.id === source.id)!; expect(doc).toBeDefined(); if (source.quote) expect(doc.rawText.slice(source.quote.start, source.quote.end)).toBe(source.quote.quote); }
    }
    expect(summary.facts.filter((fact) => fact.kind === "conflict")).toHaveLength(3);
  });
  it("withholds inspected summary facts and report passages after a clear correction", async () => {
    const doc = await attach("Reported cause: compressor fault"), first = available(await detail()), fact = first.facts.find((row) => row.kind === "report")!, source = fact.sources[0];
    expect(currentSummaryFact(first, fact)).toEqual(fact); expect(isCurrentSummarySource(first, source)).toBe(true);
    await correctDocument(connection.db, doc.documentId, { requestId: randomUUID(), analysisId, expectedCorrectionId: null, reason: "Fictional operator cleared unsupported cause", change: { field: "reported_cause", value: null, evidence_quotes: [], supportConfirmed: true } });
    const next = available(await detail()); expect(currentSummaryFact(next, fact)).toBeNull(); expect(isCurrentSummarySource(next, source)).toBe(false);
    expect(currentSummaryFact({ status: "unavailable", code: "QA", reason: "Unavailable" }, fact)).toBeNull(); expect(isCurrentSummarySource(next, null)).toBe(false);
  });
  it("keeps original correction evidence for old selections and excludes future-origin attachments", async () => {
    const raw = "Equipment ID: REF-01\nNotebook identifies REF-02.", doc = await attach(raw), before = available(await detail());
    await connection.db.insert(t.temperatureReadings).values({ id: "later-normal", chamberId: "CH-1", recordedAt: "2026-03-11T00:00:00+05:30", temperatureC: 3 }); const run = await analyzeStoredLog(connection.db); const oldId = analysisId; analysisId = run.analysis.id;
    await correctDocument(connection.db, doc.documentId, { requestId: randomUUID(), analysisId, expectedCorrectionId: null, reason: "Fictional source review", change: { field: "equipment_id", value: "REF-02", evidence_quotes: [{ field: "equipment_id", value: "REF-02", quote: "Notebook identifies REF-02.", start: raw.indexOf("Notebook"), end: raw.length, source_document_id: doc.documentId }], supportConfirmed: true } });
    const later = await attach("Reported cause: future-only supplementary finding"), current = available(await detail()), historical = available(await detail(oldId));
    expect(current.evidenceMembership).toBe("current"); expect(historical.evidenceMembership).toBe("historical"); expect(historical.statements).toEqual(before.statements); expect(historical.facts).toEqual(before.facts);
    expect(current.facts.some((f) => f.sources.some((s) => s.type === "document" && s.correctionId !== null))).toBe(true); expect(historical.facts.some((f) => f.sources.some((s) => s.id === later.documentId))).toBe(false);
  });
  it("retains saved values when live inventory makes evidence stale", async () => {
    await connection.db.update(t.batches).set({ recordedValueInr: null }).where(eq(t.batches.id, "demo-batch-a"));
    const summary = available(await detail()); expect(summary.evidenceMembership).toBe("stale"); expect(summary.statements[1].text).toContain("₹80,000.00"); expect(summary.statements[1].text).not.toContain("incomplete");
  });
  it.each(["equipment", "policy", "extraction"])("withholds summary for unverified %s context", async (kind) => {
    if (kind === "equipment") await connection.db.delete(t.equipment);
    if (kind === "policy") await connection.db.update(t.policies).set({ wording: " " });
    if (kind === "extraction") { const doc = await attach("Reported cause: compressor fault"); await connection.db.update(t.documents).set({ extractionJson: null }).where(eq(t.documents.id, doc.documentId)); }
    const data = await detail(); expect(data.summary.status).toBe("unavailable"); expect(renderToStaticMarkup(createElement(IncidentRecordView, { data }))).toContain("Summary unavailable");
  });
  it("renders escaped statement buttons, fallback badge and accessible source inspection", async () => {
    await attach("Reported fault: <script>fictional compressor finding</script>");
    const html = renderToStaticMarkup(createElement(IncidentRecordView, { data: await detail() }));
    for (const text of ["Evidence-linked incident summary", "AI unavailable — using rule-based fallback", 'aria-controls="summary-source"', 'id="summary-source"', "Summary statement sources", "&lt;script&gt;fictional compressor finding&lt;/script&gt;"]) expect(html).toContain(text);
    expect(html).not.toContain("<script>fictional compressor finding</script>");
  });
  it("preserves every table including prepared claim/review packets across repeated summary reads", async () => {
    await attach("Reported cause: compressor fault"); await connection.db.insert(t.claims).values({ id: "claim", incidentId: id, policyId: "coldcover-demo-policy", readiness: "Needs more evidence", priority: "Standard priority", triageReasonsJson: [], exposureValueInr: 80000, summaryJson: [{ text: "Historical packet", source_ids: ["immutable"] }], missingEvidenceJson: [], createdAt: stamp });
    await connection.db.insert(t.reviewDecisions).values({ id: "review", claimId: "claim", reviewerName: "Fictional reviewer", status: "closed", comment: "Preserve", decidedAt: stamp });
    const before = await dump(); await Promise.all([detail(), detail(), getIncident(connection.db, "demo-incident-01")]); expect(await dump()).toEqual(before);
  });
});
