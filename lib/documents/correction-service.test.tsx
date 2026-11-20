import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IncidentRecordView from "../../app/incidents/[id]/record";
import { analyzeStoredLog } from "../analysis/service";
import { openDatabase, type DatabaseConnection } from "../db/client";
import { initializeDatabase } from "../db/initialize";
import { seedDatabase } from "../db/seed";
import { applyMigrations } from "../db/migrate";
import * as t from "../db/schema";
import { getIncident } from "../incidents/service";
import { correctionHandler } from "./correction-http";
import { correctDocument } from "./correction-service";
import { addDocument } from "./service";
import { extractDocument } from "./extract";
import type { CorrectionInput } from "./corrections";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const raw = "FICTIONAL QA report\nEquipment ID: REF-01\nNotebook says the attended unit was REF-02.\nCause was not established by the technician.\nThe register mentions A and B.";
const line = "Notebook says the attended unit was REF-02.";
const request = (body: unknown, type = "application/json") => new Request("http://coldcover.test/api/documents/doc/extraction", { method: "PATCH", headers: { "content-type": type }, body: JSON.stringify(body) });
describe("Audited immutable operator document corrections", () => {
  let dir: string, connection: DatabaseConnection, incidentId: string, analysisId: string, documentId: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "coldcover-corrections-")); connection = await initializeDatabase(pathToFileURL(join(dir, "test.db")).href);
    const run = await analyzeStoredLog(connection.db); incidentId = run.incidents[0].incidentId; analysisId = run.analysis.id;
    const receipt = await addDocument(connection.db, incidentId, { requestId: randomUUID(), analysisId, docType: "maintenance_report", filename: "notebook.txt", rawText: raw }); documentId = receipt.documentId;
  });
  afterEach(() => { connection?.close(); rmSync(dir, { recursive: true, force: true }); });
  const input = (): CorrectionInput => ({ requestId: randomUUID(), analysisId, expectedCorrectionId: null, reason: "Technician identified the attended unit in the notebook", change: { field: "equipment_id", value: "REF-02", supportConfirmed: true, evidence_quotes: [{ field: "equipment_id", value: "REF-02", source_document_id: documentId, quote: line, start: raw.indexOf(line), end: raw.indexOf(line) + line.length }] } });
  const handler = () => correctionHandler(async () => connection.db);
  async function dump() {
    const names = await connection.client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"), result: Record<string, unknown> = {};
    for (const { name } of names.rows) result[String(name)] = (await connection.client.execute(`SELECT * FROM "${name}" ORDER BY 1`)).rows;
    return result;
  }
  const clear = (previous: string | null): CorrectionInput => ({ ...input(), expectedCorrectionId: previous, reason: "Clear pending further review of conflicting unit references", change: { field: "equipment_id", value: null, supportConfirmed: true, evidence_quotes: [] } });
  it("appends one correction/audit, preserving every original/source/analysis/claim/event row", async () => {
    const before = await dump(), response = await handler()(request(input()), documentId);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const receipt = await response.json(); expect(receipt).toMatchObject({ documentId, analysisId, revision: 1, reused: false });
    const after = await dump(); for (const key of Object.keys(before)) if (!["document_corrections", "audit_log"].includes(key)) expect(after[key]).toEqual(before[key]);
    const detail = await getIncident(connection.db, incidentId), state = detail.documentCorrections[documentId];
    expect(state.selectedCorrectionId).toBe(receipt.correctionId); expect(state.history[0].extraction.equipment_id).toBe("REF-02");
    expect(detail.documents[0].extractionJson?.extraction).toMatchObject({ equipment_id: "REF-01" });
    const audits = await connection.db.select().from(t.auditLog).where(eq(t.auditLog.action, "document_extraction_corrected")); expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].detail)).toMatchObject({ field: "equipment_id", before: "REF-01", after: "REF-02", previousCorrectionId: null, analysisId });
  });
  it("replays the original receipt without writes after later revisions and workflow protection", async () => {
    const body = input(), first = await correctDocument(connection.db, documentId, body);
    await correctDocument(connection.db, documentId, clear(first.correctionId));
    await connection.db.update(t.incidents).set({ status: "submitted" }).where(eq(t.incidents.id, incidentId)); const before = await dump();
    expect(await correctDocument(connection.db, documentId, body)).toEqual({ ...first, reused: true }); expect(await dump()).toEqual(before);
  });
  it("rejects changed payload or document reuse of a submission UUID", async () => {
    const body = input(); await correctDocument(connection.db, documentId, body);
    const other = await addDocument(connection.db, incidentId, { requestId: randomUUID(), analysisId, docType: "maintenance_report", filename: "other.txt", rawText: raw + "\nOther report" });
    const before = await dump();
    for (const [target, patch] of [[documentId, { reason: "different" }], [documentId, { expectedCorrectionId: "other" }], [other.documentId, {}]] as const) expect((await handler()(request({ ...body, ...patch }), target)).status).toBe(409);
    expect(await dump()).toEqual(before);
  });
  it("rejects stale edit bases and no-op clears without appending history", async () => {
    const first = await correctDocument(connection.db, documentId, input()), before = await dump();
    expect((await handler()(request(input()), documentId)).status).toBe(409); expect(await dump()).toEqual(before);
    const next = await correctDocument(connection.db, documentId, clear(first.correctionId)); const after = await dump();
    const response = await handler()(request(clear(next.correctionId)), documentId); expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("NO_CHANGE"); expect(await dump()).toEqual(after);
  });
  it("does not log a no-op caused solely by quote array ordering", async () => {
    const [doc] = await connection.db.select().from(t.documents).where(eq(t.documents.id, documentId));
    const original = extractDocument(doc.rawText, doc.id, { method: "operator_selected", incidentId, analysisId });
    const q = original.extraction.evidence_quotes.find((q) => q.field === "equipment_id")!;
    const body = { ...input(), change: { field: "equipment_id", value: "REF-01", supportConfirmed: true, evidence_quotes: [q] } };
    const before = await dump(); expect((await handler()(request(body), documentId)).status).toBe(409); expect(await dump()).toEqual(before);
  });
  it("serializes eight identical retries to one revision and one audit", async () => {
    const body = input(), receipts = await Promise.all(Array.from({ length: 8 }, () => correctDocument(connection.db, documentId, body)));
    expect(receipts.filter((r) => !r.reused)).toHaveLength(1);
    expect(await connection.db.select().from(t.documentCorrections)).toHaveLength(1);
    expect(await connection.db.select().from(t.auditLog).where(eq(t.auditLog.action, "document_extraction_corrected"))).toHaveLength(1);
  });
  it("allows only one of two different concurrent edits with the same expected base", async () => {
    const receipts = await Promise.allSettled([correctDocument(connection.db, documentId, input()), correctDocument(connection.db, documentId, clear(null))]);
    expect(receipts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await connection.db.select().from(t.documentCorrections)).toHaveLength(1);
  });
  it.each(["claim_prepared", "submitted", "under_review", "decided"] as const)("protects workflow %s", async (status) => {
    await connection.db.update(t.incidents).set({ status }).where(eq(t.incidents.id, incidentId)); const before = await dump();
    expect((await handler()(request(input()), documentId)).status).toBe(409); expect(await dump()).toEqual(before);
  });
  it("protects existing claims/review decisions even when incident status stays draft", async () => {
    const [policy] = await connection.db.select().from(t.policies);
    await connection.db.insert(t.claims).values({ id: "claim", incidentId, policyId: policy.id, readiness: "Needs more evidence", priority: "Standard priority", triageReasonsJson: [], exposureValueInr: 80000, summaryJson: [], missingEvidenceJson: [], createdAt: "2026-03-10T08:00:00+05:30" });
    await connection.db.insert(t.reviewDecisions).values({ id: "review", claimId: "claim", reviewerName: "Demo", status: "needs_more_info", comment: "Preserve evidence", decidedAt: "2026-03-10T09:00:00+05:30" });
    const before = await dump(); expect((await handler()(request(input()), documentId)).status).toBe(409); expect(await dump()).toEqual(before);
  });
  it("protects stale and replaced historical records and keeps their correction history", async () => {
    await correctDocument(connection.db, documentId, input());
    await connection.db.update(t.batches).set({ recordedValueInr: null }).where(eq(t.batches.id, "demo-batch-a")); const before = await dump();
    expect((await handler()(request(clear((await getIncident(connection.db, incidentId)).documentCorrections[documentId].latestCorrectionId)), documentId)).status).toBe(409); expect(await dump()).toEqual(before);
    const next = await analyzeStoredLog(connection.db), after = await dump();
    expect((await handler()(request({ ...input(), analysisId: next.analysis.id }), documentId)).status).toBe(409);
    expect((await getIncident(connection.db, next.incidents[0].incidentId)).documents).toEqual([]); expect(await dump()).toEqual(after);
  });
  it("selects earlier correction snapshots without applying later-analysis annotations", async () => {
    const first = await correctDocument(connection.db, documentId, input());
    await connection.db.insert(t.temperatureReadings).values({ id: "later-normal", chamberId: "CH-1", temperatureC: 3, recordedAt: "2026-03-11T00:00:00+05:30" });
    const run = await analyzeStoredLog(connection.db); expect(run.incidents[0].incidentId).toBe(incidentId);
    const second = await correctDocument(connection.db, documentId, { ...clear(first.correctionId), analysisId: run.analysis.id });
    const old = await getIncident(connection.db, incidentId, analysisId), current = await getIncident(connection.db, incidentId);
    expect(old.documentCorrections[documentId].selectedCorrectionId).toBe(first.correctionId);
    expect(current.documentCorrections[documentId].selectedCorrectionId).toBe(second.correctionId); expect(old.documentInput.allowed).toBe(false);
    const html = renderToStaticMarkup(createElement(IncidentRecordView, { data: old }));
    expect(html).toContain("Operator corrected · revision 1"); expect(html).toContain("later analysis; not applied"); expect(html).toContain("Original fallback extraction · preserved");
    expect(html).not.toContain("Save operator correction");
  });
  it("does not back-apply a document's first correction from a later analysis", async () => {
    await connection.db.insert(t.temperatureReadings).values({ id: "later-normal", chamberId: "CH-1", temperatureC: 3, recordedAt: "2026-03-11T00:00:00+05:30" }); const run = await analyzeStoredLog(connection.db);
    await correctDocument(connection.db, documentId, { ...input(), analysisId: run.analysis.id });
    const old = await getIncident(connection.db, incidentId, analysisId); expect(old.documentCorrections[documentId].selectedCorrectionId).toBeNull();
    expect(renderToStaticMarkup(createElement(IncidentRecordView, { data: old }))).toContain("Fallback extraction · deterministic");
  });
  it("protects seed/unextracted/unsupported/missing and other-chamber sources", async () => {
    expect((await handler()(request(input()), "demo-maintenance-01")).status).toBe(409);
    await connection.db.insert(t.documents).values({ id: "unextracted", incidentId, docType: "maintenance_report", filename: "legacy.txt", rawText: raw, uploadedAt: "2026-03-10T08:00:00+05:30" });
    await connection.db.update(t.documents).set({ docType: "invoice" }).where(eq(t.documents.id, documentId));
    await connection.db.insert(t.chambers).values({ id: "CH-2", name: "Other", commodity: "potatoes", normalMinC: 2, normalMaxC: 5 });
    await connection.db.insert(t.incidents).values({ id: "foreign", chamberId: "CH-2", title: "Other", createdAt: "2026-03-10T08:00:00+05:30" });
    await connection.db.insert(t.documents).values({ id: "foreign-doc", incidentId: "foreign", docType: "other", filename: "other.txt", rawText: raw, uploadedAt: "2026-03-10T08:00:00+05:30" });
    const before = await dump();
    for (const [target, status] of [["unextracted", 409], [documentId, 409], ["missing", 404], ["foreign-doc", 404]] as const) expect((await handler()(request(input()), target)).status).toBe(status);
    expect(await dump()).toEqual(before);
  });
  it.each(["audit", "correction"])("rolls back both correction and audit when %s write fails", async (stage) => {
    const table = stage === "audit" ? "audit_log" : "document_corrections";
    await connection.client.execute(`CREATE TRIGGER qa_fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    const before = await dump(); expect((await handler()(request(input()), documentId)).status).toBe(500); expect(await dump()).toEqual(before);
  });
  it.each(["snapshot", "source", "input", "provenance", "clock"])("fails closed on saved %s corruption without adding writes", async (kind) => {
    await correctDocument(connection.db, documentId, input());
    const [row] = await connection.db.select().from(t.documentCorrections);
    if (kind === "snapshot") await connection.db.update(t.documentCorrections).set({ extractionJson: { ...row.extractionJson, equipment_id: "FAKE" } });
    if (kind === "source") await connection.db.update(t.documents).set({ rawText: raw + "\nChanged original" }).where(eq(t.documents.id, documentId));
    if (kind === "input") await connection.db.update(t.documentCorrections).set({ requestJson: { ...row.requestJson, reason: "" } });
    if (kind === "provenance") await connection.db.update(t.documentCorrections).set({ originalFingerprint: "bad" });
    if (kind === "clock") await connection.db.update(t.documentCorrections).set({ createdAt: "bad" });
    const before = await dump(); expect((await handler()(request(clear(row.id)), documentId)).status).toBe(500); await expect(getIncident(connection.db, incidentId)).rejects.toThrow(); expect(await dump()).toEqual(before);
  });
  it("rejects invalid IDs/contract/encoding/size before opening a database, and source failures without writes", async () => {
    const getDb = vi.fn(async () => connection.db), patch = correctionHandler(getDb);
    for (const [req, id, status] of [[request(input()), "bad id", 400], [request({ ...input(), reason: "" }), documentId, 400], [request(input(), "text/plain"), documentId, 415], [request({ ...input(), reason: "a".repeat(300000) }), documentId, 413], [new Request("http://test", { method: "PATCH", headers: { "content-type": "application/json" }, body: new Uint8Array([0xff]) }), documentId, 400]] as const) expect((await patch(req, id)).status).toBe(status);
    expect(getDb).not.toHaveBeenCalled(); const body = input(); body.change.evidence_quotes[0].source_document_id = "other"; const before = await dump();
    expect((await handler()(request(body), documentId)).status).toBe(400); expect(await dump()).toEqual(before);
  });
  it("upgrades populated previous-schema evidence additively without rewriting originals", async () => {
    const folder = join(dir, "old-migrations"); mkdirSync(join(folder, "meta"), { recursive: true }); const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 2) }));
    for (const name of ["0000_initial_schema.sql", "0001_analysis_revisions.sql"]) writeFileSync(join(folder, name), readFileSync(join("drizzle", name)));
    const legacy = await openDatabase(pathToFileURL(join(dir, "previous.db")).href);
    try {
      await migrate(legacy.db, { migrationsFolder: folder }); await seedDatabase(legacy.db); const run = await analyzeStoredLog(legacy.db);
      await addDocument(legacy.db, run.incidents[0].incidentId, { requestId: randomUUID(), analysisId: run.analysis.id, docType: "maintenance_report", filename: "previous.txt", rawText: raw });
      const names = ["documents", "incident_events", "audit_log", "analysis_runs", "analysis_incident_links", "incidents", "batches"];
      const before = await Promise.all(names.map(async (name) => (await legacy.client.execute(`SELECT * FROM ${name} ORDER BY 1`)).rows));
      await applyMigrations(legacy.db); await applyMigrations(legacy.db);
      expect(await Promise.all(names.map(async (name) => (await legacy.client.execute(`SELECT * FROM ${name} ORDER BY 1`)).rows))).toEqual(before);
      expect(await legacy.db.select().from(t.documentCorrections)).toEqual([]); expect((await legacy.client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    } finally { legacy.close(); }
  });
});
