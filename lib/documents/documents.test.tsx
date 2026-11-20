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
import { workedExample } from "../demo/worked-example";
import { getIncident } from "../incidents/service";
import { documentHandler } from "./http";
import { addDocument } from "./service";
import { verifyStoredExtraction } from "./extract";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const request = (body: unknown, type = "application/json") => new Request("http://coldcover.test/api/incidents/any/documents", { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });
describe("Document input persistence, protection and HTTP", () => {
  let dir: string, connection: DatabaseConnection, id: string, analysisId: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "coldcover-documents-"));
    connection = await initializeDatabase(pathToFileURL(join(dir, "test.db")).href);
    const run = await analyzeStoredLog(connection.db); id = run.incidents[0].incidentId; analysisId = run.analysis.id;
  });
  afterEach(() => { connection?.close(); rmSync(dir, { recursive: true, force: true }); });
  const input = (rawText = workedExample.maintenanceReport) => ({ requestId: randomUUID(), analysisId, docType: "maintenance_report" as const, filename: "maintenance.txt", rawText });
  const handler = () => documentHandler(async () => connection.db);
  async function dump() {
    const names = await connection.client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const rows: Record<string, unknown> = {};
    for (const { name } of names.rows) rows[String(name)] = (await connection.client.execute(`SELECT * FROM "${name}" ORDER BY 1`)).rows;
    return rows;
  }
  async function protectWithClaim() {
    const [policy] = await connection.db.select().from(t.policies);
    await connection.db.insert(t.claims).values({ id: "claim-test", incidentId: id, policyId: policy.id, readiness: "Needs more evidence", priority: "Standard priority", triageReasonsJson: [], exposureValueInr: 80000, summaryJson: [], missingEvidenceJson: [], createdAt: "2026-03-10T08:00:00+05:30" });
    await connection.db.insert(t.reviewDecisions).values({ id: "review-test", claimId: "claim-test", reviewerName: "Demo", status: "needs_more_info", comment: "Keep original evidence", decidedAt: "2026-03-10T09:00:00+05:30" });
  }
  it("atomically appends raw text, validated fallback, upload event and association audit; seed and calculations untouched", async () => {
    const raw = ` \r\n${workedExample.maintenanceReport}\r\n\t`, before = await dump();
    const response = await handler()(request(input(raw)), id);
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("no-store");
    const receipt = await response.json(), detail = await getIncident(connection.db, id);
    expect(receipt).toMatchObject({ incidentId: id, analysisId, extractionSource: "fallback", reused: false });
    expect(detail.documents).toHaveLength(1); const doc = detail.documents[0];
    expect(doc.rawText).toBe(raw); expect(doc.extractionSource).toBe("fallback");
    const extraction = verifyStoredExtraction(doc.rawText, doc.id, id, doc.extractionJson)!;
    expect(extraction.association).toEqual({ method: "operator_selected", incidentId: id, analysisId });
    expect(extraction.extraction.inspection_date).toBeNull();
    expect(detail.events.filter((e) => e.sourceRef === doc.id)).toMatchObject([{ eventType: "document_uploaded", sourceType: "document" }]);
    const after = await dump();
    for (const key of Object.keys(before)) if (!["documents", "incident_events", "audit_log"].includes(key)) expect(after[key]).toEqual(before[key]);
    expect((await getIncident(connection.db, "demo-incident-01")).documents[0].id).toBe("demo-maintenance-01");
    const [audit] = await connection.db.select().from(t.auditLog).where(eq(t.auditLog.entityId, doc.id));
    expect(audit.actor).toBe("storage_operator"); expect(JSON.parse(audit.detail)).toMatchObject({ association: "operator_selected", incidentId: id, analysisId, extractionSource: "fallback" });
  });
  it("retries an identical request without writes, including after the record becomes protected", async () => {
    const body = input(), first = await addDocument(connection.db, id, body);
    await connection.db.update(t.incidents).set({ status: "submitted" }).where(eq(t.incidents.id, id));
    const before = await dump(), response = await handler()(request(body), id);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ...first, reused: true });
    expect(await dump()).toEqual(before);
  });
  it("rejects identifier reuse for a changed payload or another incident", async () => {
    const body = input(); await addDocument(connection.db, id, body); const before = await dump();
    for (const [target, patch] of [[id, { rawText: "different" }], [id, { filename: "different.txt" }], [id, { analysisId: "other" }], ["demo-incident-01", {}]] as const) expect((await handler()(request({ ...body, ...patch }), target)).status).toBe(409);
    expect(await dump()).toEqual(before);
  });
  it("rejects duplicate raw text under a new request ID regardless of filename", async () => {
    await addDocument(connection.db, id, input()); const before = await dump();
    const response = await handler()(request({ ...input(), filename: "renamed.txt" }), id);
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("DUPLICATE_DOCUMENT");
    expect(await dump()).toEqual(before);
  });
  it("serializes concurrent identical retries to one document/event/audit", async () => {
    const body = input(); const results = await Promise.all(Array.from({ length: 8 }, () => addDocument(connection.db, id, body)));
    expect(results.filter((r) => !r.reused)).toHaveLength(1);
    expect((await getIncident(connection.db, id)).documents).toHaveLength(1);
    expect((await getIncident(connection.db, id)).events.filter((e) => e.eventType === "document_uploaded")).toHaveLength(1);
    expect(await connection.db.select().from(t.auditLog).where(eq(t.auditLog.entityId, results[0].documentId))).toHaveLength(1);
  });
  it("serializes concurrent distinct duplicate submissions without adding a second copy", async () => {
    const results = await Promise.allSettled([addDocument(connection.db, id, input()), addDocument(connection.db, id, input())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await getIncident(connection.db, id)).documents).toHaveLength(1);
  });
  it.each(["claim_prepared", "submitted", "under_review", "decided"] as const)("protects workflow %s even when latest membership is current", async (status) => {
    await connection.db.update(t.incidents).set({ status }).where(eq(t.incidents.id, id)); const before = await dump();
    expect((await handler()(request(input()), id)).status).toBe(409);
    expect((await getIncident(connection.db, id)).documentInput.allowed).toBe(false); expect(await dump()).toEqual(before);
  });
  it("protects a draft with an existing prepared/reviewed claim", async () => {
    await protectWithClaim(); const before = await dump();
    expect((await handler()(request(input()), id)).status).toBe(409);
    expect((await getIncident(connection.db, id)).documentInput.allowed).toBe(false); expect(await dump()).toEqual(before);
  });
  it("protects stale membership and then the historical replacement without moving attachments", async () => {
    await addDocument(connection.db, id, input());
    await connection.db.update(t.batches).set({ recordedValueInr: 10000 }).where(eq(t.batches.id, "demo-batch-a"));
    const before = await dump(); expect((await handler()(request(input("Observation: another report")), id)).status).toBe(409); expect(await dump()).toEqual(before);
    const next = await analyzeStoredLog(connection.db), after = await dump();
    expect(next.incidents[0].incidentId).not.toBe(id);
    expect((await handler()(request({ ...input("Observation: another report"), analysisId: next.analysis.id }), id)).status).toBe(409);
    expect((await getIncident(connection.db, id)).documents).toHaveLength(1);
    expect((await getIncident(connection.db, next.incidents[0].incidentId)).documents).toEqual([]); expect(await dump()).toEqual(after);
  });
  it("rejects a stale expected revision of a reused current incident and disables older-revision input", async () => {
    await connection.db.insert(t.temperatureReadings).values({ id: "later-normal", chamberId: "CH-1", temperatureC: 3, recordedAt: "2026-03-11T00:00:00+05:30" });
    const next = await analyzeStoredLog(connection.db); expect(next.incidents[0].incidentId).toBe(id);
    const before = await dump(); expect((await handler()(request(input()), id)).status).toBe(409);
    expect((await getIncident(connection.db, id, analysisId)).documentInput.allowed).toBe(false);
    expect((await getIncident(connection.db, id)).documentInput.allowed).toBe(true); expect(await dump()).toEqual(before);
  });
  it("protects unassigned seed and unknown/foreign records", async () => {
    await connection.db.insert(t.chambers).values({ id: "CH-2", name: "Other", commodity: "potatoes", normalMinC: 2, normalMaxC: 5 });
    await connection.db.insert(t.incidents).values({ id: "foreign", chamberId: "CH-2", title: "Other", createdAt: "2026-03-10T08:00:00+05:30" });
    const before = await dump();
    for (const [target, status] of [["demo-incident-01", 409], ["foreign", 404], ["missing", 404]] as const) expect((await handler()(request(input()), target)).status).toBe(status);
    expect(await dump()).toEqual(before);
  });
  it.each(["event", "audit"])("rolls back document and earlier writes when %s insertion fails", async (stage) => {
    const table = stage === "event" ? "incident_events" : "audit_log";
    await connection.client.execute(`CREATE TRIGGER reject_document BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    const before = await dump(), response = await handler()(request(input()), id);
    expect(response.status).toBe(500); expect((await response.json()).error.code).toBe("DOCUMENT_UNCONFIRMED"); expect(await dump()).toEqual(before);
  });
  it("rejects invalid IDs, types, bodies, malformed/oversize encoding before DB initialization", async () => {
    const getDb = vi.fn(async () => connection.db), post = documentHandler(getDb);
    for (const [req, target, status] of [
      [request(input()), "bad id", 400], [request({ ...input(), docType: "other" }), id, 400], [request(input(), "text/plain"), id, 415],
      [new Request("http://test", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }), id, 400],
      [new Request("http://test", { method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array([0xff]) }), id, 400],
      [request({ ...input(), rawText: "x".repeat(300_000) }), id, 413],
    ] as const) { const response = await post(req, target); expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store"); }
    expect(getDb).not.toHaveBeenCalled();
  });
  it("fails closed for invalid configuration without writes", async () => {
    await connection.db.delete(t.thresholds); const before = await dump();
    expect((await handler()(request(input()), id)).status).toBe(409); expect(await dump()).toEqual(before);
  });
  it("accepts partial inspection text without inventing a timestamp or missing facts", async () => {
    const raw = "Inspection date: 10 March 2026\nStock condition: inspector requests additional checks\nBatches mentioned: A, B";
    await addDocument(connection.db, id, { ...input(raw), docType: "stock_inspection_report", filename: "inspection.txt" });
    const record = await getIncident(connection.db, id), doc = record.documents[0];
    expect(verifyStoredExtraction(raw, doc.id, id, doc.extractionJson)?.extraction).toMatchObject({ inspection_date: null, stock_condition: "inspector requests additional checks", batches_mentioned: ["A", "B"], fault_time: null, restart_time: null });
  });
  it("renders exact passages, fallback and missing values, and withholds tampered fields", async () => {
    await addDocument(connection.db, id, input("Equipment ID: REF-02\nObservation: <script>unsafe</script>"));
    const detail = await getIncident(connection.db, id), doc = detail.documents[0];
    const html = renderToStaticMarkup(createElement(IncidentRecordView, { data: detail }));
    for (const text of ["Fallback extraction", "Reported equipment ID", "REF-02", "Not extracted", "Save report and extract", doc.id, "&lt;script&gt;unsafe&lt;/script&gt;", "Original raw text"]) expect(html).toContain(text);
    expect(html).not.toContain("<script>unsafe");
    doc.extractionJson = { madeUp: true };
    const invalid = renderToStaticMarkup(createElement(IncidentRecordView, { data: detail }));
    expect(invalid).toContain("Stored extraction could not be verified"); expect(invalid).not.toContain("Fallback extraction · deterministic");
  });
});
