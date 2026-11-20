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
import { initializeDatabase } from "../db/initialize";
import { openDatabase, type DatabaseConnection } from "../db/client";
import { seedDatabase } from "../db/seed";
import { applyMigrations } from "../db/migrate";
import * as t from "../db/schema";
import { getScenario } from "../demo/scenarios/catalog";
import { getIncident } from "../incidents/service";
import { copyInputSchema, reportSourceHref, type CopyInput } from "./copy-contract";
import { copyHandlers } from "./copy-http";
import { copyDocument, listDocumentSources, previewDocumentSource } from "./copy-service";
import { readCopyProvenance } from "./copy-history";
import { addDocument } from "./service";
import { correctDocument } from "./correction-service";
import { applyCorrection, type CorrectionInput } from "./corrections";
import { originalDocumentFingerprint } from "./correction-history";
import { verifyStoredExtraction } from "./extract";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const req = (body: unknown, type = "application/json") => new Request("http://coldcover.test/copies", { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });
const listReq = (query = "") => new Request(`http://coldcover.test/sources${query}`);
describe("Explicit report copying with immutable provenance", () => {
  let dir: string, connection: DatabaseConnection, targetId: string, analysisId: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "coldcover-copy-")); connection = await initializeDatabase(pathToFileURL(join(dir, "test.db")).href);
    const result = await analyzeStoredLog(connection.db); targetId = result.incidents[0].incidentId; analysisId = result.analysis.id;
  });
  afterEach(() => { connection?.close(); rmSync(dir, { recursive: true, force: true }); });
  const handlers = () => copyHandlers(async () => connection.db);
  async function input(sourceId = "demo-maintenance-01"): Promise<CopyInput> {
    const preview = await previewDocumentSource(connection.db, targetId, sourceId);
    return { requestId: randomUUID(), analysisId, sourceDocumentId: sourceId, expectedSourceFingerprint: preview.fingerprint, expectedSourceCorrectionId: preview.latestCorrectionId, associationConfirmed: true };
  }
  async function dump(db = connection) {
    const names = await db.client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"), rows: Record<string, unknown> = {};
    for (const { name } of names.rows) rows[String(name)] = (await db.client.execute(`SELECT * FROM "${name}" ORDER BY 1`)).rows;
    return rows;
  }
  async function twoCurrentRecords() {
    const fixture = getScenario("scenario-29");
    if (!fixture) throw new Error("Required multi-interval fixture unavailable");
    await connection.db.delete(t.temperatureReadings); await connection.db.insert(t.temperatureReadings).values(fixture.readings);
    const run = await analyzeStoredLog(connection.db); analysisId = run.analysis.id; targetId = run.incidents[1].incidentId;
    return run.incidents[0].incidentId;
  }
  const text = "FICTIONAL notebook\nEquipment ID: REF-01\nThe attended unit is REF-02 according to the notebook.";
  async function correctedSource() {
    const sourceIncident = await twoCurrentRecords();
    const doc = await addDocument(connection.db, sourceIncident, { requestId: randomUUID(), analysisId, filename: "notebook.txt", docType: "maintenance_report", rawText: text });
    const quote = "The attended unit is REF-02 according to the notebook.";
    const body: CorrectionInput = { requestId: randomUUID(), analysisId, expectedCorrectionId: null, reason: "Review the explicitly attended asset", change: { field: "equipment_id", value: "REF-02", supportConfirmed: true, evidence_quotes: [{ field: "equipment_id", value: "REF-02", source_document_id: doc.documentId, quote, start: text.indexOf(quote), end: text.indexOf(quote) + quote.length }] } };
    const correction = await correctDocument(connection.db, doc.documentId, body);
    return { doc, correction, sourceIncident };
  }
  it("lists metadata without raw snapshots, previews a chosen source and never mutates either record", async () => {
    const before = await dump(), list = await handlers().LIST(listReq(), targetId); expect(list.status).toBe(200); expect(list.headers.get("cache-control")).toBe("no-store");
    const data = await list.json(); expect(data.sources[0]).toMatchObject({ id: "demo-maintenance-01", incidentId: "demo-incident-01" }); expect(JSON.stringify(data)).not.toMatch(/rawText|extractionJson|evidence_quotes/);
    const response = await handlers().PREVIEW(targetId, "demo-maintenance-01"); expect(response.status).toBe(200);
    const preview = await response.json(); expect(preview).toMatchObject({ targetIncidentId: targetId, latestCorrectionId: null, correctionRevision: 0, sourceIsCopy: false }); expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/); expect(preview.source.rawText).toContain("FICTIONAL"); expect(await dump()).toEqual(before);
  });
  it("copies the unassigned seed exactly with fresh source IDs and atomic event/provenance/audit; original stays unextracted", async () => {
    const body = await input(), before = await dump(), original = (await getIncident(connection.db, "demo-incident-01")).documents[0];
    const response = await handlers().POST(req(body), targetId); expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("no-store"); const receipt = await response.json();
    const detail = await getIncident(connection.db, targetId), copy = detail.documents[0]; expect(copy.rawText).toBe(original.rawText); expect(copy.filename).toBe(original.filename); expect(copy.extractionSource).toBe("fallback");
    const parsed = verifyStoredExtraction(copy.rawText, copy.id, targetId, copy.extractionJson)!; expect(parsed.extraction.equipment_id).toBe("REF-01"); expect(parsed.extraction.inspection_date).toBeNull(); expect(parsed.extraction.evidence_quotes.every((q) => q.source_document_id === copy.id)).toBe(true);
    expect(detail.documentCopies[copy.id]).toMatchObject({ sourceDocumentId: original.id, sourceIncidentId: original.incidentId, sourceFingerprint: body.expectedSourceFingerprint, sourceCorrectionId: null, sourceCorrectionRevision: 0, targetAnalysisId: analysisId }); expect(detail.events.filter((e) => e.sourceRef === copy.id)).toHaveLength(1);
    expect((await getIncident(connection.db, "demo-incident-01")).documents[0]).toEqual(original); expect(receipt.sourceDocumentId).toBe(original.id);
    const after = await dump(); for (const key of Object.keys(before)) if (!["documents", "document_copies", "incident_events", "audit_log"].includes(key)) expect(after[key]).toEqual(before[key]);
    const audits = await connection.db.select().from(t.auditLog).where(eq(t.auditLog.action, "document_copied")); expect(audits).toHaveLength(1); expect(JSON.parse(audits[0].detail).copiedFrom).toMatchObject({ sourceDocumentId: original.id, sourceFingerprint: body.expectedSourceFingerprint });
  });
  it("preserves whitespace/CRLF/emoji and copies protected source records without editing their evidence", async () => {
    const rawText = "  📋 Fictional inspection\r\nStock condition: inspector requests checks.\r\n\t";
    await connection.db.update(t.incidents).set({ status: "submitted" }).where(eq(t.incidents.id, "demo-incident-01"));
    await connection.db.insert(t.documents).values({ id: "raw-source", incidentId: "demo-incident-01", docType: "stock_inspection_report", filename: "inspection.txt", rawText, uploadedAt: "2026-03-10T08:00:00+05:30" });
    const sourceBefore = await getIncident(connection.db, "demo-incident-01"); await copyDocument(connection.db, targetId, await input("raw-source"));
    expect((await getIncident(connection.db, targetId)).documents[0].rawText).toBe(rawText); expect(await getIncident(connection.db, "demo-incident-01")).toMatchObject({ documents: sourceBefore.documents, events: sourceBefore.events, incident: sourceBefore.incident });
  });
  it("requires the reviewed raw fingerprint and current correction version before writing", async () => {
    const body = await input(); await connection.db.update(t.documents).set({ rawText: "New source text" }).where(eq(t.documents.id, body.sourceDocumentId)); const before = await dump();
    const response = await handlers().POST(req(body), targetId); expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("SOURCE_CHANGED"); expect(await dump()).toEqual(before);
  });
  it("copies original text instead of operator corrections and freezes the reviewed correction version", async () => {
    const { doc, correction } = await correctedSource(); const body = await input(doc.documentId), receipt = await copyDocument(connection.db, targetId, body);
    let detail = await getIncident(connection.db, targetId); expect(detail.documents[0].extractionJson?.extraction).toMatchObject({ equipment_id: "REF-01" }); expect(detail.documentCorrections[receipt.documentId].history).toEqual([]); expect(detail.documentCopies[receipt.documentId]?.sourceCorrectionId).toBe(correction.correctionId);
    await correctDocument(connection.db, doc.documentId, { requestId: randomUUID(), analysisId, expectedCorrectionId: correction.correctionId, reason: "Clear pending source review", change: { field: "equipment_id", value: null, evidence_quotes: [], supportConfirmed: true } });
    const before = await dump(); expect((await handlers().POST(req({ ...body, requestId: randomUUID() }), targetId)).status).toBe(409); expect(await dump()).toEqual(before);
    expect(await copyDocument(connection.db, targetId, body)).toEqual({ ...receipt, reused: true }); detail = await getIncident(connection.db, targetId); expect(detail.documentCopies[receipt.documentId]?.sourceCorrectionRevision).toBe(1);
  });
  it("replays identically with no writes after target protection, and rejects changed UUID payloads", async () => {
    const body = await input(), first = await copyDocument(connection.db, targetId, body); await connection.db.update(t.incidents).set({ status: "decided" }).where(eq(t.incidents.id, targetId)); const before = await dump();
    const response = await handlers().POST(req(body), targetId); expect(response.status).toBe(200); expect(await response.json()).toEqual({ ...first, reused: true });
    expect((await handlers().POST(req({ ...body, expectedSourceFingerprint: "0".repeat(64) }), targetId)).status).toBe(409); expect(await dump()).toEqual(before);
  });
  it("does not reuse submission IDs between paste and copy operations", async () => {
    const body = await input(), first = await copyDocument(connection.db, targetId, body);
    const source = (await getIncident(connection.db, "demo-incident-01")).documents[0]; const before = await dump();
    await expect(addDocument(connection.db, targetId, { requestId: body.requestId, analysisId, filename: source.filename, docType: source.docType, rawText: source.rawText })).rejects.toMatchObject({ status: 409 }); expect(await dump()).toEqual(before);
    const { doc } = await correctedSource(), targetOriginal = await addDocument(connection.db, targetId, { requestId: randomUUID(), analysisId, filename: "own.txt", docType: "maintenance_report", rawText: "Own report" });
    const incoming = await input(doc.documentId); incoming.requestId = targetOriginal.documentId.slice("document-".length); const after = await dump(); expect((await handlers().POST(req(incoming), targetId)).status).toBe(409); expect(await dump()).toEqual(after); expect(first.reused).toBe(false);
  });
  it("rejects exact duplicate text even from another source document or a newly pasted report", async () => {
    const body = await input(); await copyDocument(connection.db, targetId, body); const before = await dump();
    expect((await handlers().POST(req({ ...body, requestId: randomUUID() }), targetId)).status).toBe(409); expect(await dump()).toEqual(before);
  });
  it("serializes eight identical retries to one document/provenance/event/audit", async () => {
    const body = await input(), results = await Promise.all(Array.from({ length: 8 }, () => copyDocument(connection.db, targetId, body))); expect(results.filter((r) => !r.reused)).toHaveLength(1);
    expect(await connection.db.select().from(t.documentCopies)).toHaveLength(1); expect((await getIncident(connection.db, targetId)).documents).toHaveLength(1); expect(await connection.db.select().from(t.auditLog).where(eq(t.auditLog.action, "document_copied"))).toHaveLength(1);
  });
  it("serializes distinct competing duplicates and rejects same-incident self copying", async () => {
    const a = await input(), b = await input(), receipts = await Promise.allSettled([copyDocument(connection.db, targetId, a), copyDocument(connection.db, targetId, b)]); expect(receipts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const doc = (await getIncident(connection.db, targetId)).documents[0], before = await dump(); expect((await handlers().PREVIEW(targetId, doc.id)).status).toBe(409); expect((await handlers().POST(req({ ...a, requestId: randomUUID(), sourceDocumentId: doc.id }), targetId)).status).toBe(409); expect(await dump()).toEqual(before);
  });
  it.each(["draft", "claim_prepared", "submitted", "under_review", "decided"] as const)("requires a fresh target with no claim (%s)", async (status) => {
    const body = await input(); await connection.db.update(t.incidents).set({ status }).where(eq(t.incidents.id, targetId));
    if (status === "draft") {
      const [policy] = await connection.db.select().from(t.policies); await connection.db.insert(t.claims).values({ id: "claim", incidentId: targetId, policyId: policy.id, readiness: "Needs more evidence", priority: "Standard priority", triageReasonsJson: [], exposureValueInr: 80000, summaryJson: [], missingEvidenceJson: [], createdAt: "2026-03-10T08:00:00+05:30" }); await connection.db.insert(t.reviewDecisions).values({ id: "review", claimId: "claim", reviewerName: "Demo", status: "needs_more_info", comment: "Preserve history", decidedAt: "2026-03-10T09:00:00+05:30" });
    }
    const before = await dump(); expect((await handlers().POST(req(body), targetId)).status).toBe(409); expect(await dump()).toEqual(before);
  });
  it("protects stale, historical, unassigned and outdated analysis targets", async () => {
    const body = await input(); await connection.db.update(t.batches).set({ recordedValueInr: null }).where(eq(t.batches.id, "demo-batch-b")); const before = await dump(); expect((await handlers().POST(req(body), targetId)).status).toBe(409); expect(await dump()).toEqual(before);
    const run = await analyzeStoredLog(connection.db), after = await dump(); expect((await handlers().POST(req({ ...body, analysisId: run.analysis.id }), targetId)).status).toBe(409); expect((await handlers().POST(req(body), run.incidents[0].incidentId)).status).toBe(409); expect((await handlers().POST(req(body), "demo-incident-01")).status).toBe(409); expect(await dump()).toEqual(after);
  });
  it("disables copy UI on an older selection of a reused current incident", async () => {
    await connection.db.insert(t.temperatureReadings).values({ id: "later", chamberId: "CH-1", recordedAt: "2026-03-11T00:00:00+05:30", temperatureC: 3 }); const run = await analyzeStoredLog(connection.db); expect(run.incidents[0].incidentId).toBe(targetId);
    const old = await getIncident(connection.db, targetId, analysisId); expect(renderToStaticMarkup(createElement(IncidentRecordView, { data: old }))).not.toContain("Browse existing reports");
    expect(renderToStaticMarkup(createElement(IncidentRecordView, { data: await getIncident(connection.db, targetId) }))).toContain("Browse existing reports");
  });
  it("paginates stable metadata and excludes same-record, foreign and unsupported documents", async () => {
    await connection.db.insert(t.documents).values(Array.from({ length: 25 }, (_, n) => ({ id: `catalogue-${String(n).padStart(2, "0")}`, incidentId: "demo-incident-01", docType: "maintenance_report" as const, filename: `note-${n}.txt`, rawText: "Source report", uploadedAt: "2026-03-10T08:00:00+05:30" })));
    await connection.db.insert(t.documents).values({ id: "same", incidentId: targetId, docType: "maintenance_report", filename: "same.txt", rawText: "Same", uploadedAt: "2026-03-10T08:00:00+05:30" }); await connection.db.insert(t.documents).values({ id: "unsupported", incidentId: "demo-incident-01", docType: "invoice", filename: "invoice.txt", rawText: "Invoice", uploadedAt: "2026-03-10T08:00:00+05:30" });
    await connection.db.insert(t.chambers).values({ id: "CH-2", name: "Other", commodity: "potatoes", normalMinC: 2, normalMaxC: 5 }); await connection.db.insert(t.incidents).values({ id: "foreign", chamberId: "CH-2", title: "Other", createdAt: "2026-03-10T08:00:00+05:30" }); await connection.db.insert(t.documents).values({ id: "foreign-report", incidentId: "foreign", docType: "maintenance_report", filename: "foreign.txt", rawText: "Other source", uploadedAt: "2026-03-10T08:00:00+05:30" });
    const before = await dump(), first = await listDocumentSources(connection.db, targetId), second = await listDocumentSources(connection.db, targetId, first.nextCursor!); expect(first.sources).toHaveLength(20); expect(second.sources).toHaveLength(6); expect(second.nextCursor).toBeNull(); expect(new Set([...first.sources, ...second.sources].map((s) => s.id)).size).toBe(26); expect((await listDocumentSources(connection.db, targetId, "zzzz")).sources).toEqual([]);
    for (const id of ["foreign-report", "unsupported", "missing"]) expect((await handlers().PREVIEW(targetId, id)).status).toBe(404); expect((await handlers().LIST(listReq(), "foreign")).status).toBe(404); expect(await dump()).toEqual(before);
  });
  it.each(["documents", "incident_events", "audit_log", "document_copies"])("rolls back the entire copy when %s insertion fails", async (table) => {
    const body = await input(); await connection.client.execute(`CREATE TRIGGER qa_fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'QA failure'); END`); const before = await dump(); expect((await handlers().POST(req(body), targetId)).status).toBe(500); expect(await dump()).toEqual(before);
  });
  it("validates inputs/queries before opening a database and rejects oversized/invalid JSON", async () => {
    const body = await input(), getDb = vi.fn(async () => connection.db), h = copyHandlers(getDb);
    for (const [r, id, status] of [[req(body), "bad id", 400], [req({ ...body, associationConfirmed: false }), targetId, 400], [req({ ...body, expectedSourceFingerprint: "bad" }), targetId, 400], [req(body, "text/plain"), targetId, 415], [req({ ...body, padding: "x".repeat(300000) }), targetId, 413], [new Request("http://test", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }), targetId, 400]] as const) expect((await h.POST(r, id)).status).toBe(status);
    expect((await h.LIST(listReq("?after=a&after=b"), targetId)).status).toBe(400); expect((await h.LIST(listReq("?unknown=x"), targetId)).status).toBe(400); expect((await h.PREVIEW(targetId, "bad id")).status).toBe(400); expect(getDb).not.toHaveBeenCalled();
    expect(copyInputSchema.safeParse({ ...body, extra: true }).success).toBe(false);
  });
  it("does not copy unverified source extraction or invalid raw text", async () => {
    const body = await input(); await connection.db.update(t.documents).set({ extractionSource: "fallback", extractionJson: { invented: true } }).where(eq(t.documents.id, body.sourceDocumentId)); const before = await dump(); expect((await handlers().POST(req(body), targetId)).status).toBe(409); expect((await handlers().PREVIEW(targetId, body.sourceDocumentId)).status).toBe(409); expect(await dump()).toEqual(before);
  });
  it("tracks immediate parents on copies of copies and rejects broken ancestry for reads and corrections", async () => {
    const first = await copyDocument(connection.db, targetId, await input());
    await connection.db.update(t.batches).set({ recordedValueInr: null }).where(eq(t.batches.id, "demo-batch-b")); const next = await analyzeStoredLog(connection.db); targetId = next.incidents[0].incidentId; analysisId = next.analysis.id;
    const body = await input(first.documentId), second = await copyDocument(connection.db, targetId, body); const detail = await getIncident(connection.db, targetId); expect(detail.documentCopies[second.documentId]?.sourceDocumentId).toBe(first.documentId); expect((await previewDocumentSource(connection.db, "demo-incident-01", second.documentId)).sourceIsCopy).toBe(true);
    await connection.db.update(t.documents).set({ rawText: "Changed ancestor" }).where(eq(t.documents.id, "demo-maintenance-01")); const before = await dump(); await expect(getIncident(connection.db, targetId)).rejects.toThrow();
    await expect(correctDocument(connection.db, second.documentId, { requestId: randomUUID(), analysisId, expectedCorrectionId: null, reason: "Clear unsupported fact", change: { field: "equipment_id", value: null, evidence_quotes: [], supportConfirmed: true } })).rejects.toThrow(); expect(await dump()).toEqual(before);
  });
  it.each(["snapshot", "request", "version", "clock", "fingerprint"])("fails closed on corrupted frozen %s metadata", async (kind) => {
    const { doc } = await correctedSource(), receipt = await copyDocument(connection.db, targetId, await input(doc.documentId)); const [row] = await connection.db.select().from(t.documentCopies);
    if (kind === "snapshot") await connection.db.update(t.documentCopies).set({ sourceSnapshotJson: { ...row.sourceSnapshotJson, rawText: "Fabricated" } });
    if (kind === "request") await connection.db.update(t.documentCopies).set({ requestJson: { ...row.requestJson, associationConfirmed: false } as unknown as CopyInput });
    if (kind === "version") await connection.db.update(t.documentCopies).set({ sourceCorrectionRevision: 99 });
    if (kind === "clock") await connection.db.update(t.documentCopies).set({ createdAt: "bad" });
    if (kind === "fingerprint") await connection.db.update(t.documentCopies).set({ requestJson: { ...row.requestJson, expectedSourceFingerprint: "0".repeat(64) } });
    const before = await dump(); const [target] = await connection.db.select().from(t.documents).where(eq(t.documents.id, receipt.documentId)); await expect(readCopyProvenance(connection.db, target)).rejects.toThrow(); await expect(getIncident(connection.db, targetId)).rejects.toThrow(); expect(await dump()).toEqual(before);
  });
  it("renders frozen origin, original inspection links and escaped raw text without a provider", async () => {
    await connection.db.insert(t.documents).values({ id: "unsafe-source", incidentId: "demo-incident-01", docType: "maintenance_report", filename: "unsafe-note.txt", rawText: "Observation: <script>alert(1)</script>", uploadedAt: "2026-03-10T08:00:00+05:30" });
    const body = await input("unsafe-source"), receipt = await copyDocument(connection.db, targetId, body), detail = await getIncident(connection.db, targetId); const html = renderToStaticMarkup(createElement(IncidentRecordView, { data: detail }));
    expect(html).not.toContain("<script>alert(1)</script>"); expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Copied report · original preserved"); expect(html).toContain(reportSourceHref("demo-incident-01", "unsafe-source")); expect(html).toContain(`source-document-${receipt.documentId}`); expect(html).toContain("Original text was copied with independent fallback extraction"); expect(html).toContain("Fallback extraction · deterministic");
  });
  it("upgrades a populated correction-schema database without rewriting evidence or corrections", async () => {
    const folder = join(dir, "previous-migrations"); mkdirSync(join(folder, "meta"), { recursive: true }); const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")); writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 3) }));
    for (const name of ["0000_initial_schema.sql", "0001_analysis_revisions.sql", "0002_document_corrections.sql"]) writeFileSync(join(folder, name), readFileSync(join("drizzle", name)));
    const legacy = await openDatabase(pathToFileURL(join(dir, "previous.db")).href);
    try {
      await migrate(legacy.db, { migrationsFolder: folder }); await seedDatabase(legacy.db); const run = await analyzeStoredLog(legacy.db), id = run.incidents[0].incidentId;
      const uploaded = await addDocument(legacy.db, id, { requestId: randomUUID(), analysisId: run.analysis.id, filename: "legacy.txt", docType: "maintenance_report", rawText: text });
      const [doc] = await legacy.db.select().from(t.documents).where(eq(t.documents.id, uploaded.documentId)), baseline = verifyStoredExtraction(doc.rawText, doc.id, id, doc.extractionJson)!;
      const correction: CorrectionInput = { requestId: randomUUID(), analysisId: run.analysis.id, expectedCorrectionId: null, reason: "Preserve prior correction", change: { field: "equipment_id", value: null, evidence_quotes: [], supportConfirmed: true } };
      await legacy.db.insert(t.documentCorrections).values({ id: `correction-${correction.requestId}`, documentId: doc.id, revision: 1, previousCorrectionId: null, analysisId: run.analysis.id, originalFingerprint: originalDocumentFingerprint(doc), requestJson: correction, extractionJson: applyCorrection(doc.rawText, doc.id, baseline.extraction, correction), actor: "storage_operator", createdAt: "2026-10-28T13:00:00+05:30" });
      const before = await dump(legacy); await applyMigrations(legacy.db); await applyMigrations(legacy.db); const after = await dump(legacy); for (const key of Object.keys(before)) if (key !== "__drizzle_migrations") expect(after[key]).toEqual(before[key]); expect(await legacy.db.select().from(t.documentCopies)).toEqual([]); expect((await getIncident(legacy.db, id)).documentCorrections[doc.id].history).toHaveLength(1); expect((await legacy.client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    } finally { legacy.close(); }
  });
});
