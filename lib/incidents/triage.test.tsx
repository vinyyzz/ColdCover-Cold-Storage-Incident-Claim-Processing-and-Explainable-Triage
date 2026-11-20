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
import { analyzeStoredLog, latestStoredAnalysis } from "../analysis/service";
import type { DatabaseConnection } from "../db/client";
import { initializeDatabase } from "../db/initialize";
import * as t from "../db/schema";
import { addDocument } from "../documents/service";
import { correctDocument } from "../documents/correction-service";
import { copyDocument, previewDocumentSource } from "../documents/copy-service";
import { extractDocument } from "../documents/extract";
import { incidentHandlers } from "./http";
import { getIncident } from "./service";
import type { IncidentDetail } from "./types";
import { isCurrentTriageSource } from "./presentation";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const stamp = "2026-03-10T08:00:00+05:30";
const raw = "FICTIONAL report\nEquipment ID: REF-01\nReported cause: unclear\nRefrigeration restarted: 2026-03-10T04:00:00+05:30\nNotebook identifies REF-02.";
const available = (data: IncidentDetail) => { if (data.triage.status !== "available") throw new Error(JSON.stringify(data.triage)); return data.triage; };
describe("Read-only incident workspace triage", () => {
  let dir: string, connection: DatabaseConnection, id: string, analysisId: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "coldcover-workspace-")); connection = await initializeDatabase(pathToFileURL(join(dir, "qa.db")).href);
    const run = await analyzeStoredLog(connection.db); id = run.incidents[0].incidentId; analysisId = run.analysis.id;
  });
  afterEach(() => { connection?.close(); rmSync(dir, { recursive: true, force: true }); });
  const detail = (revision?: string) => getIncident(connection.db, id, revision);
  const attach = (text = raw, type: "maintenance_report" | "stock_inspection_report" = "maintenance_report") => addDocument(connection.db, id, { requestId: randomUUID(), analysisId, docType: type, filename: `${type}.txt`, rawText: text });
  const api = () => incidentHandlers(async () => connection.db).DETAIL(new Request("http://test/api/incidents/id"), id);
  const html = async (revision?: string) => renderToStaticMarkup(createElement(IncidentRecordView, { data: await detail(revision) }));
  async function dump() {
    const names = await connection.client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const result: Record<string, unknown> = {};
    for (const { name } of names.rows) result[String(name)] = (await connection.client.execute(`SELECT * FROM "${name}" ORDER BY 1`)).rows;
    return result;
  }
  it("exposes real current triage/criteria in API with no-store and checkedAt", async () => {
    const response = await api(), data: IncidentDetail = await response.json(), triage = available(data);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(triage.checkedAt).toBe(data.checkedAt); expect(triage.evidenceMembership).toBe("current");
    expect(triage.result.readiness.status).toBe("Needs more evidence"); expect(triage.result.priority.status).toBe("Standard priority");
    expect(triage.criteria).toMatchObject({ basis: "current_records", settingsId: "1", highExposureThresholdPaise: 15_000_000, equipment: { code: "REF-01" }, policy: { id: "coldcover-demo-policy" } });
  });
  it("does not borrow the unassigned seed report or infer its association", async () => {
    const triage = available(await detail());
    expect(triage.result.checklist.find((row) => row.id === "maintenance_report")?.status).toBe("missing");
    const seed = await getIncident(connection.db, "demo-incident-01"); expect(seed.triage).toMatchObject({ status: "unavailable", code: "NO_ASSIGNED_ANALYSIS" }); expect(seed.documents[0].extractionSource).toBeNull();
  });
  it("evaluates an explicitly copied seed report and preserves the source original", async () => {
    const preview = await previewDocumentSource(connection.db, id, "demo-maintenance-01");
    const saved = await copyDocument(connection.db, id, { requestId: randomUUID(), analysisId, sourceDocumentId: preview.source.id, expectedSourceFingerprint: preview.fingerprint, expectedSourceCorrectionId: null, associationConfirmed: true });
    const result = available(await detail()).result; expect(result.readiness.reasons.map((row) => row.code)).toEqual(["missing_stock_inspection_report"]);
    expect(result.priority.status).toBe("Standard priority"); expect(result.checklist.find((row) => row.id === "maintenance_report")?.sources[0].id).toBe(saved.documentId);
    const [seed] = await connection.db.select().from(t.documents).where(eq(t.documents.id, "demo-maintenance-01")); expect(seed.incidentId).toBe("demo-incident-01"); expect(seed.extractionJson).toBeNull();
  });
  it("uses verified attached reports and does not turn report presence into stock findings", async () => {
    await attach("Equipment ID: REF-01\nReported cause: compressor fault"); await attach("Stock condition: separate assessment required", "stock_inspection_report");
    const result = available(await detail()).result; expect(result.readiness.status).toBe("Ready for initial review"); expect(result.priority.status).toBe("Standard priority");
    expect(await html()).toContain("Neither determines stock condition");
  });
  it("uses full saved inputs after live inventory changes and labels stale evidence", async () => {
    await connection.db.update(t.batches).set({ recordedValueInr: null }).where(eq(t.batches.id, "demo-batch-a"));
    const record = await detail(), triage = available(record); expect(triage.evidenceMembership).toBe("stale");
    expect(triage.result.checklist.find((row) => row.id === "batch_valuations")?.status).toBe("provided");
    expect(record.evidence?.readings).toHaveLength(27); expect(await html()).toContain("Saved evidence · stale at last check");
  });
  it("labels current high-exposure criteria on historical evidence without modifying snapshots", async () => {
    const [before] = await connection.db.select().from(t.analysisRuns).where(eq(t.analysisRuns.id, analysisId));
    await connection.db.insert(t.temperatureReadings).values({ id: "later-normal", chamberId: "CH-1", recordedAt: "2026-03-11T00:00:00+05:30", temperatureC: 3 }); await analyzeStoredLog(connection.db);
    await connection.db.update(t.thresholds).set({ highExposureThresholdInr: 79_999.99 });
    const record = await detail(analysisId), triage = available(record);
    expect(triage.evidenceMembership).toBe("historical"); expect(triage.criteria.highExposureThresholdPaise).toBe(7_999_999); expect(triage.result.priority.status).toBe("High priority"); expect(record.documentInput.allowed).toBe(false);
    const rendered = await html(analysisId); expect(rendered).toContain("Current review criteria applied to saved evidence"); expect(rendered).toContain("not a historical triage snapshot");
    const [after] = await connection.db.select().from(t.analysisRuns).where(eq(t.analysisRuns.id, analysisId)); expect(after).toEqual(before);
  });
  it("refreshes threshold-driven priority even when temperature analysis remains current", async () => {
    expect(available(await detail()).result.priority.status).toBe("Standard priority");
    await connection.db.update(t.thresholds).set({ highExposureThresholdInr: 79_999.99 });
    expect((await latestStoredAnalysis(connection.db)).status).toBe("current"); expect(available(await detail()).result.priority.status).toBe("High priority");
  });
  it("does not apply later report attachments to an older reused revision", async () => {
    const firstId = analysisId; await connection.db.insert(t.temperatureReadings).values({ id: "later-normal", chamberId: "CH-1", recordedAt: "2026-03-11T00:00:00+05:30", temperatureC: 3 }); const next = await analyzeStoredLog(connection.db); analysisId = next.analysis.id;
    await attach(); expect(available(await detail(firstId)).result.conflicts).toEqual([]); expect(available(await detail()).result.priority.status).toBe("Specialist review required");
    expect(available(await detail(firstId)).result.checklist.find((row) => row.id === "maintenance_report")?.status).toBe("missing");
  });
  it("selects effective corrections and preserves old source quotes", async () => {
    const doc = await attach("Equipment ID: REF-01\nReported cause: unclear");
    const firstId = analysisId; await connection.db.insert(t.temperatureReadings).values({ id: "later-normal", chamberId: "CH-1", recordedAt: "2026-03-11T00:00:00+05:30", temperatureC: 3 }); const next = await analyzeStoredLog(connection.db);
    await correctDocument(connection.db, doc.documentId, { requestId: randomUUID(), analysisId: next.analysis.id, expectedCorrectionId: null, reason: "Operator cleared unsupported cause wording", change: { field: "reported_cause", value: null, evidence_quotes: [], supportConfirmed: true } });
    const old = available(await detail(firstId)), current = available(await detail()); expect(old.result.priority.status).toBe("Specialist review required"); expect(current.result.priority.status).toBe("Standard priority"); expect(old.result.conflicts[0].sources[0]).toMatchObject({ type: "document", correctionId: null, quote: { quote: "Reported cause: unclear" } });
  });
  it("withholds a retained inspected passage after the effective correction or availability changes", async () => {
    const doc = await attach("Equipment ID: REF-01\nReported cause: unclear"); const original = await detail();
    const source = available(original).result.conflicts[0].sources[0]; expect(isCurrentTriageSource(original.triage, source)).toBe(true);
    await correctDocument(connection.db, doc.documentId, { requestId: randomUUID(), analysisId, expectedCorrectionId: null, reason: "Cleared unsupported cause after source review", change: { field: "reported_cause", value: null, evidence_quotes: [], supportConfirmed: true } });
    const refreshed = await detail(); expect(isCurrentTriageSource(refreshed.triage, source)).toBe(false);
    expect(isCurrentTriageSource({ status: "unavailable", code: "QA", reason: "Unavailable" }, source)).toBe(false);
    expect(isCurrentTriageSource(refreshed.triage, null)).toBe(false);
  });
  it.each(["claim_prepared", "submitted", "under_review", "decided"] as const)("keeps %s triage read-only and leaves claim/review/history untouched", async (status) => {
    await attach(); await connection.db.insert(t.claims).values({ id: "claim", incidentId: id, policyId: "coldcover-demo-policy", readiness: "Ready for initial review", priority: "Standard priority", triageReasonsJson: [], exposureValueInr: 80000, summaryJson: [], missingEvidenceJson: [], createdAt: stamp });
    await connection.db.insert(t.reviewDecisions).values({ id: "decision", claimId: "claim", reviewerName: "Fictional reviewer", status: "closed", comment: "Preserve", decidedAt: stamp }); await connection.db.update(t.incidents).set({ status }).where(eq(t.incidents.id, id));
    const before = await dump(); const records = await Promise.all([detail(), detail(), api()]); expect(available(records[0] as IncidentDetail).result.priority.status).toBe("Specialist review required"); expect((records[0] as IncidentDetail).documentInput.allowed).toBe(false); expect(await dump()).toEqual(before);
  });
  it("reads edited stored policy contents, not hardcoded authored content", async () => {
    await connection.db.update(t.policies).set({ name: "Fictional edited policy", notes: "QA review note." }); const policy = available(await detail()).criteria.policy;
    expect(policy?.name).toBe("Fictional edited policy"); expect(await html()).toContain("QA review note.");
  });
  it("keeps absent policy missing without adding an unstated readiness gate", async () => {
    await connection.db.delete(t.policies); await attach("Reported cause: compressor fault"); await attach("Stock condition: review required", "stock_inspection_report");
    const triage = available(await detail()); expect(triage.criteria.policy).toBeNull(); expect(triage.result.readiness.status).toBe("Ready for initial review"); expect(triage.result.checklist.find((row) => row.id === "policy_details")?.status).toBe("missing");
  });
  it("does not infer supporting stock mappings from an invoice or inspection batch prose", async () => {
    await connection.db.insert(t.documents).values({ id: "invoice", incidentId: id, docType: "invoice", filename: "invoice.txt", rawText: "Batches A and B, values verified", uploadedAt: stamp }); await attach("Batches mentioned: A, B", "stock_inspection_report");
    expect(available(await detail()).result.checklist.find((row) => row.id === "stock_records")?.status).toBe("missing");
  });
  it.each([0.001, 0.009, 1e-12, 0.1 + 0.2, 1e20])("withholds unsafe/unsupported monetary setting %s", async (value) => {
    await connection.db.update(t.thresholds).set({ highExposureThresholdInr: value }); expect((await detail()).triage).toMatchObject({ status: "unavailable", code: "REVIEW_CRITERIA_UNAVAILABLE" });
  });
  it.each(["missing", "ambiguous"])("withholds triage for %s equipment configuration", async (kind) => {
    if (kind === "missing") await connection.db.delete(t.equipment); else await connection.db.insert(t.equipment).values({ id: "extra", chamberId: "CH-1", equipmentCode: "REF-02", description: "Fictional second unit" });
    expect((await detail()).triage).toMatchObject({ status: "unavailable", code: "REVIEW_CRITERIA_UNAVAILABLE" }); expect(await html()).toContain("Triage unavailable");
  });
  it("withholds malformed stored policy details", async () => {
    await connection.db.update(t.policies).set({ wording: " " }); expect((await detail()).triage).toMatchObject({ status: "unavailable", code: "POLICY_UNVERIFIED" });
  });
  it.each(["unextracted", "foreign-analysis", "altered-original"])("withholds %s report associations without inventing readiness", async (kind) => {
    const doc = await attach();
    if (kind === "unextracted") await connection.db.update(t.documents).set({ extractionSource: null, extractionJson: null }).where(eq(t.documents.id, doc.documentId));
    else if (kind === "foreign-analysis") await connection.db.update(t.documents).set({ extractionJson: extractDocument(raw, doc.documentId, { method: "operator_selected", incidentId: id, analysisId: "unlinked" }) }).where(eq(t.documents.id, doc.documentId));
    else await connection.db.update(t.documents).set({ rawText: "Different report" }).where(eq(t.documents.id, doc.documentId));
    expect((await detail()).triage).toMatchObject({ status: "unavailable", code: "REPORT_ASSOCIATION_UNVERIFIED" }); expect(await html()).not.toContain("Current evidence at last check");
  });
  it("withholds an unsupported saved rule version instead of evaluating under newer rules", async () => {
    const [run] = await connection.db.select().from(t.analysisRuns); const changed = structuredClone(run.snapshotJson); changed.inputs.ruleVersion = "unsupported-v0"; await connection.db.update(t.analysisRuns).set({ snapshotJson: changed }).where(eq(t.analysisRuns.id, analysisId));
    expect((await detail()).triage).toMatchObject({ status: "unavailable", code: "RULE_VERSION_UNSUPPORTED" });
  });
  it.each(["source", "result"])("rejects saved %s inconsistency with a generic no-store error", async (kind) => {
    const [run] = await connection.db.select().from(t.analysisRuns); const changed = structuredClone(run.snapshotJson);
    if (kind === "source") changed.inputs.readings[0].temperatureC = 4; else changed.exposures[0].batches[0].ownerName = "Changed snapshot result";
    await connection.db.update(t.analysisRuns).set({ snapshotJson: changed }).where(eq(t.analysisRuns.id, analysisId)); const before = await dump(), response = await api();
    expect(response.status).toBe(500); expect(response.headers.get("cache-control")).toBe("no-store"); expect(await response.json()).toMatchObject({ error: { code: "INCIDENTS_UNAVAILABLE" } }); expect(await dump()).toEqual(before);
  });
  it("renders source controls, checklist/question links, explicit criteria and escaped source text", async () => {
    await attach(raw + "\nObservation: <script>fictional</script>"); const rendered = await html();
    for (const text of ["Evidence readiness and review priority", "Evidence checklist", "Follow-up questions", "Review criteria and stored policy", "Current high-exposure threshold", "₹1,50,000.00", "Report passage:", "Reading worked-example-reading-033", 'id="batch-evidence-demo-batch-a"', 'id="triage-document-source"', 'href="#triage-check-stock_records"', '&lt;script&gt;fictional&lt;/script&gt;']) expect(rendered).toContain(text);
    expect(rendered).not.toContain("<script>fictional</script>");
  });
  it("leaves every database table unchanged across current/stale/historical/unassigned reads", async () => {
    await attach(); await connection.db.insert(t.temperatureReadings).values({ id: "later-normal", chamberId: "CH-1", recordedAt: "2026-03-11T00:00:00+05:30", temperatureC: 3 }); await analyzeStoredLog(connection.db); await connection.db.update(t.batches).set({ recordedValueInr: 1 }).where(eq(t.batches.id, "demo-batch-a"));
    const before = await dump(); await Promise.all([detail(), detail(analysisId), getIncident(connection.db, "demo-incident-01"), api()]); expect(await dump()).toEqual(before);
  });
});
