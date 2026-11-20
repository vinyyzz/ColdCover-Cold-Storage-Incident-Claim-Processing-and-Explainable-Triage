import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeStoredLog } from "../analysis/service";
import { prepareClaim, previewClaim } from "../claims/service";
import { withDatabase } from "../db/access";
import type { DatabaseConnection } from "../db/client";
import { initializeDatabase } from "../db/initialize";
import * as t from "../db/schema";
import { getScenario } from "../demo/scenarios/catalog";
import { addDocument } from "../documents/service";
import { copyDocument, previewDocumentSource } from "../documents/copy-service";
import { correctDocument } from "../documents/correction-service";
import { getReviewState, recordDecision } from "../reviews/service";
import { captureSnapshot } from "../reset/snapshot";
import { getResetStatus, runDemoOperation } from "../reset/service";
import { CLAIM_DISCLAIMER } from "../claims/contract";
import { getClaimReport } from "./service";
import { reportHandler } from "./http";
vi.mock("server-only", () => ({}));
let dir: string, connection: DatabaseConnection, incidentId: string, analysisId: string;
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "coldcover-report-")); connection = await initializeDatabase(pathToFileURL(join(dir, "qa.db")).href); const a = await analyzeStoredLog(connection.db); incidentId = a.incidents[0].incidentId; analysisId = a.analysis!.id; });
afterEach(() => { vi.restoreAllMocks(); connection.close(); rmSync(dir, { recursive: true, force: true }); });
async function prepare(id = incidentId, analysis = analysisId) { const p = await previewClaim(connection.db, id, analysis); return (await prepareClaim(connection.db, id, { requestId: randomUUID(), analysisId: analysis, policyId: p.policy.id, expectedSourceToken: p.sourceToken, evidenceReviewed: true })).claimId; }
const snapshot = () => withDatabase(connection.db, () => connection.db.transaction(captureSnapshot));
async function decide(claimId: string, status = "needs_more_info", comment = "Please supply inspection evidence for fictional review.") { const s = await getReviewState(connection.db, claimId); if (s.status !== "available") throw new Error("Expected available state"); return recordDecision(connection.db, claimId, { requestId: randomUUID(), expectedLatestDecisionId: s.latestDecisionId, expectedRevision: s.history.length, expectedState: s.state, status, reviewerName: "Fictional reviewer", comment, packetReviewed: true }); }
function anchors(html: string) { const ids = [...html.matchAll(/(?:^|\s)id="([^"]+)"/g)].map((m) => m[1]), links = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]); expect(new Set(ids).size).toBe(ids.length); expect(links.every((id) => ids.includes(id))).toBe(true); }

describe("Read-only complete report", () => {
  it("renders worked values/sources/disclaimer and an explicitly absent review without writes", async () => {
    const id = await prepare(), before = await snapshot(), report = await getClaimReport(connection.db, id);
    for (const text of [CLAIM_DISCLAIMER, "Inventory value under investigation", "₹80,000.00", "Needs more evidence", "No review decision was recorded", "Demonstration policy", "Rule-based fallback", "not present", "Original sources", "Exact saved observations"]) expect(report.html).toContain(text === "Original sources" ? "Original documents and provenance" : text);
    expect(report.html).not.toContain("<script"); expect(report.html).not.toContain("<iframe"); anchors(report.html); expect(await snapshot()).toEqual(before);
  });
  it("includes copied originals/provenance and effective correction sources without losing original facts", async () => {
    const source = await previewDocumentSource(connection.db, incidentId, "demo-maintenance-01"); await copyDocument(connection.db, incidentId, { requestId: randomUUID(), analysisId, sourceDocumentId: source.source.id, expectedSourceFingerprint: source.fingerprint, expectedSourceCorrectionId: null, associationConfirmed: true });
    const rawText = "Equipment ID: REF-01\nEquipment annotation: REF-02", doc = await addDocument(connection.db, incidentId, { requestId: randomUUID(), analysisId, docType: "maintenance_report", filename: "correction.txt", rawText }); const quote = "Equipment annotation: REF-02";
    await correctDocument(connection.db, doc.documentId, { requestId: randomUUID(), analysisId, expectedCorrectionId: null, reason: "Literal equipment annotation review", change: { field: "equipment_id", value: "REF-02", supportConfirmed: true, evidence_quotes: [{ field: "equipment_id", value: "REF-02", quote, start: 21, end: 21 + quote.length, source_document_id: doc.documentId }] } });
    const report = await getClaimReport(connection.db, await prepare()); for (const text of ["Explicit report copy", "frozen copy ancestor", "Original fallback fields retained separately", "effective operator correction 1", "Exact UTF-16 characters 21-", "Equipment annotation: REF-02", "Literal equipment annotation review", "REF-01"]) expect(report.html).toContain(text); anchors(report.html);
  });
  it("escapes raw originals, source values, filenames, names and comments", async () => {
    await addDocument(connection.db, incidentId, { requestId: randomUUID(), analysisId, docType: "maintenance_report", filename: "<unsafe>&report.txt", rawText: "Equipment ID: REF-01\nReported cause: <script>alert(1)</script>\n<svg onload=alert(2)>" });
    const id = await prepare(); await decide(id, "closed", "<img src=x onerror=alert(3)>"); const report = await getClaimReport(connection.db, id);
    expect(report.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;"); expect(report.html).toContain("&lt;unsafe&gt;&amp;report.txt"); expect(report.html).toContain("&lt;img src=x onerror=alert(3)&gt;"); expect(report.html).not.toContain("<script"); expect(report.html).not.toContain("<img"); expect(report.html).not.toContain("<svg onload"); anchors(report.html);
  });
  it("pins a preview to the reviewed state, excludes check clocks and detects later decisions", async () => {
    const id = await prepare(), first = await getClaimReport(connection.db, id); expect((await getClaimReport(connection.db, id, { expected: first.state })).state).toBe(first.state);
    await decide(id); await expect(getClaimReport(connection.db, id, { expected: first.state })).rejects.toMatchObject({ code: "REPORT_CHANGED" }); const next = await getClaimReport(connection.db, id); expect(next.html).toContain("Please supply inspection evidence"); expect(next.state).not.toBe(first.state); expect(next.html).toContain("Needs more evidence");
  });
  it("does not substitute later live reports/criteria/inventory/readings into reports", async () => {
    const id = await prepare(), before = await getClaimReport(connection.db, id);
    await connection.db.update(t.policies).set({ notes: "Changed live policy only" }); await connection.db.update(t.batches).set({ recordedValueInr: null }); await connection.db.update(t.temperatureReadings).set({ temperatureC: 3 }); await connection.db.update(t.documents).set({ rawText: "Changed current source" }); await analyzeStoredLog(connection.db);
    const after = await getClaimReport(connection.db, id, { expected: before.state }); expect(after.state).toBe(before.state); expect(after.html).toContain("₹80,000.00"); expect(after.html).not.toContain("Changed live policy only");
  });
  it.each(["legacy", "packet", "history", "workflow"])("withholds %s sources instead of generating a misleading report", async (kind) => {
    const id = await prepare(); if (kind === "legacy") await connection.db.delete(t.claimPackets); if (kind === "packet") await connection.db.update(t.claimPackets).set({ packetHash: "0".repeat(64) }); if (kind === "history") { await decide(id); await connection.db.update(t.reviewDecisions).set({ comment: "Corrupt comment" }); } if (kind === "workflow") await connection.db.update(t.incidents).set({ status: "draft" }).where(eq(t.incidents.id, incidentId));
    const before = await snapshot(); await expect(getClaimReport(connection.db, id)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
  });
  it("keeps >1000 observations without thinning and labels gaps between chart panels", async () => {
    await connection.db.delete(t.temperatureReadings); const start = Date.parse("2026-03-10T00:00:00+05:30");
    await connection.db.insert(t.temperatureReadings).values(Array.from({ length: 1102 }, (_, i) => ({ id: `dense-${i}`, chamberId: "CH-1", recordedAt: new Date(start + (i + (i >= 1000 ? 40 : 0)) * 60000).toISOString(), temperatureC: i === 1101 ? 3 : 7 })));
    const a = await analyzeStoredLog(connection.db), id = await prepare(a.incidents[0].incidentId, a.analysis!.id), report = await getClaimReport(connection.db, id);
    expect(report.html.match(/data-reading-id=/g)).toHaveLength(1102); expect(report.html).toContain("Saved temperature chart 2 of 2"); expect(report.html).toContain("Gap between chart panels"); expect(report.html).toContain('id="reading-1102"'); expect(report.html).not.toContain("NaN"); expect(report.html).not.toContain("Infinity"); anchors(report.html);
  });
  it("preserves tiny fractional recorded quantities instead of rounding them to zero", async () => {
    await connection.db.update(t.batches).set({ quantityKg: 1e-30 }); const a = await analyzeStoredLog(connection.db); const report = await getClaimReport(connection.db, await prepare(a.incidents[0].incidentId, a.analysis!.id)); expect(report.html).toContain("1e-30 kg");
  });
  it("reset/restore invalidates a preview token while retaining report facts/history", async () => {
    const id = await prepare(); await decide(id); const first = await getClaimReport(connection.db, id);
    const reset = await runDemoOperation(connection.db, { requestId: randomUUID(), action: "reset", expectedState: (await getResetStatus(connection.db)).state, confirmation: "RESET DEMO" }); await runDemoOperation(connection.db, { requestId: randomUUID(), action: "restore", expectedState: (await getResetStatus(connection.db)).state, backupId: reset.backupId, confirmation: "RESTORE BACKUP" });
    await expect(getClaimReport(connection.db, id, { expected: first.state })).rejects.toMatchObject({ code: "REPORT_CHANGED" }); expect((await getClaimReport(connection.db, id)).html).toContain("Please supply inspection evidence");
  });
});

describe("Authored packet reports", () => {
  it.each(Array.from({ length: 30 }, (_, i) => i + 1))("renders source-complete authored case %i", async (number) => {
    const source = getScenario(number === 4 ? "worked-example" : `scenario-${String(number).padStart(2, "0")}`)!;
    await connection.db.delete(t.temperatureReadings); await connection.db.delete(t.batches); await connection.db.insert(t.temperatureReadings).values(source.readings); await connection.db.insert(t.batches).values(source.batches);
    const a = await analyzeStoredLog(connection.db); const ordered = a.analysis!.temperature.abnormalIntervals.map((interval) => a.incidents.find((row) => row.intervalId === interval.id)!);
    for (const [i, link] of ordered.entries()) for (const doc of source.documents.filter((doc) => doc.intervalIndex === i)) await addDocument(connection.db, link.incidentId, { requestId: randomUUID(), analysisId: a.analysis!.id, docType: doc.docType, filename: doc.filename, rawText: doc.rawText });
    for (const link of ordered) { const id = await prepare(link.incidentId, a.analysis!.id), report = await getClaimReport(connection.db, id); expect(report.html).toContain(CLAIM_DISCLAIMER); expect(report.html).not.toContain("undefined"); expect(report.html).not.toContain("NaN"); anchors(report.html); }
    expect(ordered).toHaveLength(source.expected.abnormalIntervals.length);
  });
});

describe("Report HTTP contract", () => {
  it("validates IDs/strict queries before database access", async () => {
    const getDb = vi.fn(async () => connection.db), h = reportHandler(getDb);
    expect((await h(new Request("http://localhost/report"), "bad/id")).status).toBe(400);
    for (const query of ["download=0", "expected=bad", "bad=1", "download=1&download=1"]) expect((await h(new Request(`http://localhost/report?${query}`), "claim")).status).toBe(400);
    expect(getDb).not.toHaveBeenCalled();
  });
  it("serves inline/attachment HTML with no-store/CSP/nosniff/state and clean failures", async () => {
    const id = await prepare(), h = reportHandler(async () => connection.db), inline = await h(new Request("http://localhost/report"), id), state = inline.headers.get("x-coldcover-report-state")!;
    expect(inline.status).toBe(200); expect(inline.headers.get("cache-control")).toBe("no-store"); expect(inline.headers.get("content-security-policy")).toContain("default-src 'none'"); expect(inline.headers.get("x-content-type-options")).toBe("nosniff");
    const attachment = await h(new Request(`http://localhost/report?download=1&expected=${state}`), id); expect(attachment.headers.get("content-disposition")).toBe(`attachment; filename="coldcover-${id}-report.html"`); expect(attachment.headers.get("content-type")).toContain("text/html");
    await decide(id); const stale = await h(new Request(`http://localhost/report?download=1&expected=${state}`), id); expect(stale.status).toBe(409); expect(stale.headers.has("content-disposition")).toBe(false); expect((await h(new Request("http://localhost/report"), "missing")).status).toBe(404);
  });
});
