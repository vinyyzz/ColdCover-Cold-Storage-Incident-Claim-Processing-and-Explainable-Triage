import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeStoredLog } from "../analysis/service";
import { withDatabase } from "../db/access";
import type { DatabaseConnection } from "../db/client";
import { initializeDatabase } from "../db/initialize";
import * as t from "../db/schema";
import { addDocument } from "../documents/service";
import { copyDocument, previewDocumentSource } from "../documents/copy-service";
import { correctDocument } from "../documents/correction-service";
import { getScenario } from "../demo/scenarios/catalog";
import { getIncident } from "../incidents/service";
import { downloadDemoBackup, getResetStatus, runDemoOperation } from "../reset/service";
import { captureSnapshot, digest } from "../reset/snapshot";
import { CLAIM_DISCLAIMER, type PrepareInput } from "./contract";
import { claimHandlers } from "./http";
import { getClaim, prepareClaim, previewClaim } from "./service";
vi.mock("server-only", () => ({}));
let dir: string, connection: DatabaseConnection, incidentId: string, analysisId: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "coldcover-claim-")); connection = await initializeDatabase(pathToFileURL(join(dir, "qa.db")).href);
  const analyzed = await analyzeStoredLog(connection.db); incidentId = analyzed.incidents[0].incidentId; analysisId = analyzed.analysis!.id;
});
afterEach(() => { vi.restoreAllMocks(); connection.close(); rmSync(dir, { recursive: true, force: true }); });
const preview = () => previewClaim(connection.db, incidentId, analysisId);
async function input(): Promise<PrepareInput> { const p = await preview(); return { requestId: randomUUID(), analysisId, policyId: p.policy.id, expectedSourceToken: p.sourceToken, evidenceReviewed: true }; }
async function snapshot() { return withDatabase(connection.db, () => connection.db.transaction(captureSnapshot)); }
async function attach() {
  const source = await previewDocumentSource(connection.db, incidentId, "demo-maintenance-01");
  return copyDocument(connection.db, incidentId, { requestId: randomUUID(), analysisId, sourceDocumentId: source.source.id, expectedSourceFingerprint: source.fingerprint, expectedSourceCorrectionId: null, associationConfirmed: true });
}

describe("Immutable prepared evidence", () => {
  it("reviews without writes and keeps Needs more evidence separate from checklist", async () => {
    const before = await snapshot(), p = await preview();
    expect(p).toMatchObject({ readiness: "Needs more evidence", knownValueSubtotalPaise: 8000000, valuationComplete: true, documentIds: [] });
    expect(p.checklist).toHaveLength(6); expect(await snapshot()).toEqual(before);
  });
  it("prepares exactly one packet, freezes recorded evidence, protects edits and records one audit", async () => {
    await attach(); const request = await input(), receipt = await prepareClaim(connection.db, incidentId, request);
    expect(receipt).toMatchObject({ claimId: `claim-${request.requestId}`, reused: false, analysisId });
    const saved = await getClaim(connection.db, receipt.claimId);
    expect(saved.status).toBe("available");
    if (saved.status !== "available") throw new Error("Expected frozen packet");
    expect(saved.disclaimer).toBe(CLAIM_DISCLAIMER); expect(saved.copySources).toHaveLength(1);
    expect(saved.data.triage.status).toBe("available"); expect(saved.data.evidence!.exposure.knownValueSubtotalPaise).toBe(8000000);
    expect(saved.claim.readiness).toBe("Needs more evidence"); expect(saved.data.documents).toHaveLength(1);
    const live = await getIncident(connection.db, incidentId); expect(live.incident.status).toBe("claim_prepared"); expect(live.documentInput.allowed).toBe(false);
    expect(await connection.db.select().from(t.claimPackets)).toHaveLength(1); expect(await connection.db.select().from(t.reviewDecisions)).toHaveLength(0);
    expect((await connection.db.select().from(t.auditLog)).filter((row) => row.action === "claim_prepared")).toHaveLength(1);
    await expect(addDocument(connection.db, incidentId, { requestId: randomUUID(), analysisId, docType: "maintenance_report", filename: "later.txt", rawText: "Equipment ID: REF-01" })).rejects.toThrow();
  });
  it("exact concurrent retries and later protected retries reuse the original receipt", async () => {
    const request = await input(), receipts = await Promise.all([prepareClaim(connection.db, incidentId, request), prepareClaim(connection.db, incidentId, request)]);
    expect(receipts.map((item) => item.reused)).toEqual([false, true]);
    await connection.db.update(t.policies).set({ wording: "Later fictional policy wording" });
    expect(await prepareClaim(connection.db, incidentId, request)).toMatchObject({ reused: true, claimId: receipts[0].claimId });
    await expect(prepareClaim(connection.db, incidentId, { ...request, policyId: "different" })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  });
  it.each(["policy", "equipment", "threshold", "inventory", "report", "reset_generation"])("rejects changed %s after review with no claim writes", async (change) => {
    const request = await input();
    if (change === "policy") await connection.db.update(t.policies).set({ notes: "Changed review notes" });
    if (change === "equipment") await connection.db.update(t.equipment).set({ description: "Changed description" });
    if (change === "threshold") await connection.db.update(t.thresholds).set({ highExposureThresholdInr: 200000 });
    if (change === "inventory") await connection.db.update(t.batches).set({ recordedValueInr: null });
    if (change === "report") await addDocument(connection.db, incidentId, { requestId: randomUUID(), analysisId, docType: "maintenance_report", filename: "later.txt", rawText: "Equipment ID: REF-01" });
    if (change === "reset_generation") {
      const state = await getResetStatus(connection.db);
      await runDemoOperation(connection.db, { requestId: randomUUID(), action: "reset", expectedState: state.state, confirmation: "RESET DEMO" });
      const next = await getResetStatus(connection.db);
      await runDemoOperation(connection.db, { requestId: randomUUID(), action: "restore", expectedState: next.state, backupId: next.backups[0].id, confirmation: "RESTORE BACKUP" });
    }
    await expect(prepareClaim(connection.db, incidentId, request)).rejects.toThrow();
    expect(await connection.db.select().from(t.claims)).toHaveLength(0); expect(await connection.db.select().from(t.claimPackets)).toHaveLength(0);
  });
  it("rolls back claim, packet, incident status and audit together when an insert fails", async () => {
    const request = await input(), before = await snapshot();
    await connection.client.execute("CREATE TRIGGER qa_claim_failure BEFORE INSERT ON claim_packets BEGIN SELECT RAISE(ABORT,'qa rollback'); END");
    await expect(prepareClaim(connection.db, incidentId, request)).rejects.toThrow();
    await connection.client.execute("DROP TRIGGER qa_claim_failure");
    expect(await snapshot()).toEqual(before);
  });
  it("stays frozen after live reports, history, source readings, policy and inventory change", async () => {
    await attach(); const receipt = await prepareClaim(connection.db, incidentId, await input()), before = await getClaim(connection.db, receipt.claimId);
    await connection.db.update(t.documents).set({ rawText: "Changed original", extractionJson: null });
    await connection.db.update(t.temperatureReadings).set({ temperatureC: 2 });
    await connection.db.update(t.policies).set({ wording: "Changed current policy" });
    await connection.db.update(t.batches).set({ recordedValueInr: null });
    const after = await getClaim(connection.db, receipt.claimId);
    // Read-time timestamps are not packet evidence; all frozen outcomes/sources stay the same.
    if (before.status !== "available" || after.status !== "available") throw new Error("Expected prepared packet");
    expect(after.claim).toEqual(before.claim); expect(after.data.documents).toEqual(before.data.documents); expect(after.data.evidence).toEqual(before.data.evidence); expect(after.data.triage.status === "available" && after.data.triage.criteria).toEqual(before.data.triage.status === "available" && before.data.triage.criteria);
  });
  it.each(["checksum", "outcome", "source", "projection", "layout", "request"])("fails closed for corrupt %s", async (change) => {
    const receipt = await prepareClaim(connection.db, incidentId, await input()), [row] = await connection.db.select().from(t.claimPackets);
    if (change === "projection") await connection.db.update(t.claims).set({ readiness: "Ready for initial review" });
    else if (change === "request") await connection.db.update(t.claimPackets).set({ requestJson: { ...row.requestJson, policyId: "different" } });
    else {
      const packet = structuredClone(row.packetJson);
      if (change === "checksum") packet.disclaimer = "changed" as typeof packet.disclaimer;
      if (change === "outcome") packet.resultHash = "0".repeat(64);
      if (change === "source") { const table = packet.sources.find((table) => table.name === "documents")!; table.rows[0][table.columns.indexOf("raw_text")] = "Changed original"; }
      if (change === "layout") packet.sources[0].columns[0] = "unknown_column";
      await connection.db.update(t.claimPackets).set({ packetJson: packet, packetHash: change === "checksum" ? row.packetHash : digest(packet) });
    }
    await expect(getClaim(connection.db, receipt.claimId)).rejects.toThrow();
  });
  it("keeps legacy claims unchanged and labels missing source provenance", async () => {
    await connection.db.insert(t.claims).values({ id: "legacy", incidentId, policyId: "coldcover-demo-policy", readiness: "Needs more evidence", priority: "Standard priority", triageReasonsJson: [], exposureValueInr: 80, summaryJson: [], missingEvidenceJson: [], createdAt: "2026-03-10T08:00:00+05:30" });
    const before = await snapshot(); expect(await getClaim(connection.db, "legacy")).toMatchObject({ status: "legacy" });
    await expect(preview()).rejects.toMatchObject({ code: "PROTECTED" }); expect(await snapshot()).toEqual(before);
  });
  it("reset archives and restore recovers the complete immutable packet unchanged", async () => {
    await attach(); const receipt = await prepareClaim(connection.db, incidentId, await input()), [packet] = await connection.db.select().from(t.claimPackets);
    const status = await getResetStatus(connection.db);
    const reset = await runDemoOperation(connection.db, { requestId: randomUUID(), action: "reset", expectedState: status.state, confirmation: "RESET DEMO" });
    expect(await connection.db.select().from(t.claimPackets)).toHaveLength(0);
    const download = await downloadDemoBackup(connection.db, reset.backupId); expect(download.snapshot.version).toBe("demo-reset-v3"); expect(download.counts.claim_packets).toBe(1);
    await runDemoOperation(connection.db, { requestId: randomUUID(), action: "restore", expectedState: (await getResetStatus(connection.db)).state, backupId: reset.backupId, confirmation: "RESTORE BACKUP" });
    expect(await connection.db.select().from(t.claimPackets)).toEqual([packet]); expect(await getClaim(connection.db, receipt.claimId)).toMatchObject({ status: "available" });
  });
});

describe("Preparation eligibility and HTTP boundary", () => {
  it.each(["unassigned", "stale", "historical", "missing_policy", "unextracted", "protected"])("rejects %s selections", async (kind) => {
    let id = incidentId; const revision = analysisId;
    if (kind === "unassigned") id = "demo-incident-01";
    if (kind === "stale") await connection.db.update(t.batches).set({ recordedValueInr: null });
    if (kind === "historical") { await connection.db.update(t.batches).set({ recordedValueInr: 5 }); await analyzeStoredLog(connection.db); }
    if (kind === "missing_policy") await connection.db.delete(t.policies);
    if (kind === "protected") await connection.db.update(t.incidents).set({ status: "submitted" }).where(eq(t.incidents.id, incidentId));
    if (kind === "unextracted") await connection.db.insert(t.documents).values({ id: "legacy-unextracted", incidentId, docType: "maintenance_report", filename: "old.txt", rawText: "Equipment ID: REF-01", extractionSource: null, extractionJson: null, uploadedAt: "2026-03-10T09:00:00+05:30" });
    const before = await snapshot(); await expect(previewClaim(connection.db, id, revision)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
  });
  it("retains effective correction state and its Specialist result", async () => {
    const doc = await addDocument(connection.db, incidentId, { requestId: randomUUID(), analysisId, docType: "maintenance_report", filename: "corrected.txt", rawText: "Equipment ID: REF-01\nEquipment annotation: REF-02" });
    const quote = "Equipment annotation: REF-02";
    const correction = await correctDocument(connection.db, doc.documentId, { requestId: randomUUID(), analysisId, expectedCorrectionId: null, reason: "Review literal equipment annotation", change: { field: "equipment_id", value: "REF-02", supportConfirmed: true, evidence_quotes: [{ field: "equipment_id", value: "REF-02", quote, start: 21, end: 21 + quote.length, source_document_id: doc.documentId }] } });
    const p = await input(), saved = await prepareClaim(connection.db, incidentId, p), packet = await getClaim(connection.db, saved.claimId);
    if (packet.status !== "available") throw new Error("Expected prepared packet");
    expect(packet.data.documentCorrections[doc.documentId].selectedCorrectionId).toBe(correction.correctionId);
    expect(packet.claim.priority).toBe("Specialist review required");
  });
  it("rejects corrupt copied originals after a preview", async () => {
    await attach(); const p = await input(); await connection.db.update(t.documents).set({ rawText: "Changed original" }).where(eq(t.documents.id, "demo-maintenance-01"));
    await expect(prepareClaim(connection.db, incidentId, p)).rejects.toThrow(); expect(await connection.db.select().from(t.claims)).toEqual([]);
  });
  it("validates IDs, JSON, size, origin and query before opening a database", async () => {
    const getDb = vi.fn(async () => connection.db), h = claimHandlers(getDb), base = "http://localhost/api/incidents/x/claim";
    expect((await h.DETAIL("invalid/id")).status).toBe(400);
    expect((await h.PREVIEW(new Request(base), incidentId)).status).toBe(400);
    expect((await h.PREVIEW(new Request(`${base}?revision=x&revision=y`), incidentId)).status).toBe(400);
    const post = (body: string, headers: Record<string, string> = { "Content-Type": "application/json" }) => h.PREPARE(new Request(base, { method: "POST", body, headers }), incidentId);
    expect((await post("{}")).status).toBe(400); expect((await post("{bad")).status).toBe(400); expect((await post("x", { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post("x".repeat(4097))).status).toBe(413); expect((await post("{}", { "Content-Type": "application/json", Origin: "https://foreign.example" })).status).toBe(403);
    expect(getDb).not.toHaveBeenCalled();
  });
  it("HTTP returns 201/replayed 200, no-store, frozen detail and clean 404", async () => {
    const h = claimHandlers(async () => connection.db), p = await input();
    const post = () => h.PREPARE(new Request("http://localhost/api/incidents/x/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) }), incidentId);
    const response = await post(); expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("no-store");
    const receipt = await response.json(); expect((await post()).status).toBe(200); expect((await h.DETAIL(receipt.claimId)).status).toBe(200); expect((await h.DETAIL("missing")).status).toBe(404);
  });
});


describe("Prepared fixture outcomes", () => {
  it.each(Array.from({ length: 30 }, (_, i) => i + 1))("freezes independent authored case %i", async (number) => {
    const scenario = getScenario(number === 4 ? "worked-example" : `scenario-${String(number).padStart(2, "0")}`)!;
    await connection.db.delete(t.temperatureReadings); await connection.db.delete(t.batches);
    await connection.db.insert(t.temperatureReadings).values(scenario.readings); await connection.db.insert(t.batches).values(scenario.batches);
    const analysis = await analyzeStoredLog(connection.db);
    expect(analysis.incidents.length).toBe(scenario.expected.abnormalIntervals.length);
    const orderedLinks = analysis.analysis!.temperature.abnormalIntervals.map((interval) => analysis.incidents.find((link) => link.intervalId === interval.id)!);
    for (const [index, link] of orderedLinks.entries()) {
      const selectedAnalysis = analysis.analysis!.id;
      for (const doc of scenario.documents.filter((doc) => doc.intervalIndex === index)) await addDocument(connection.db, link.incidentId, { requestId: randomUUID(), analysisId: selectedAnalysis, docType: doc.docType, filename: doc.filename, rawText: doc.rawText });
    }
    for (const [index, link] of orderedLinks.entries()) {
      const p = await previewClaim(connection.db, link.incidentId, analysis.analysis!.id), expected = scenario.expected.abnormalIntervals[index];
      expect(p).toMatchObject({ readiness: expected.readiness, priority: expected.priority, knownValueSubtotalPaise: expected.exposureValueInr * 100, valuationComplete: expected.valuationComplete });
      const receipt = await prepareClaim(connection.db, link.incidentId, { requestId: randomUUID(), analysisId: p.analysisId, policyId: p.policy.id, expectedSourceToken: p.sourceToken, evidenceReviewed: true });
      const saved = await getClaim(connection.db, receipt.claimId);
      if (saved.status !== "available") throw new Error("Expected versioned packet");
      expect(saved.data.evidence!.interval.dataGapUncertainty).toBe(expected.dataGapUncertainty);
      expect(saved.data.evidence!.interval.end).toBe(expected.end);
      expect(saved.data.documentInput.allowed).toBe(false);
      expect(saved.data.triage.status === "available" && saved.data.triage.criteria.basis).toBe("at_preparation");
    }
    expect(await connection.db.select().from(t.claimPackets)).toHaveLength(analysis.incidents.length);
  });
});
