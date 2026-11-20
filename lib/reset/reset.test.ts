import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeStoredLog } from "../analysis/service";
import { withDatabase } from "../db/access";
import { openDatabase, type DatabaseConnection } from "../db/client";
import { initializeDatabase } from "../db/initialize";
import { applyMigrations } from "../db/migrate";
import * as t from "../db/schema";
import * as seed from "../db/seed";
import { addDocument } from "../documents/service";
import { correctDocument } from "../documents/correction-service";
import { copyDocument, previewDocumentSource } from "../documents/copy-service";
import { backupIdSchema, operationInputSchema } from "./contract";
import { resetHandlers } from "./http";
import { downloadDemoBackup, getResetStatus, runDemoOperation } from "./service";
import { captureSnapshot, digest, snapshotCounts } from "./snapshot";

vi.mock("server-only", () => ({}));
let dir: string, connection: DatabaseConnection;
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "coldcover-reset-")); connection = await initializeDatabase(pathToFileURL(join(dir, "qa.db")).href); });
afterEach(() => { vi.restoreAllMocks(); connection?.close(); rmSync(dir, { recursive: true, force: true }); });
const status = () => getResetStatus(connection.db);
const snapshot = () => withDatabase(connection.db, () => connection.db.transaction(captureSnapshot));
const input = async () => ({ requestId: randomUUID(), action: "reset" as const, expectedState: (await status()).state, confirmation: "RESET DEMO" as const });
const restore = async (backupId: string) => ({ requestId: randomUUID(), action: "restore" as const, expectedState: (await status()).state, backupId, confirmation: "RESTORE BACKUP" as const });
async function dump() {
  const names = (await connection.client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows;
  const result: Record<string, unknown> = {};
  for (const { name } of names) result[String(name)] = (await connection.client.execute(`SELECT * FROM "${name}" ORDER BY 1`)).rows;
  return result;
}

async function populateHistory() {
  const first = await analyzeStoredLog(connection.db), incidentId = first.incidents[0].incidentId, analysisId = first.analysis!.id;
  const doc = await addDocument(connection.db, incidentId, { requestId: randomUUID(), analysisId, docType: "maintenance_report", filename: "fictional-note.txt", rawText: "Equipment ID: REF-01\nNotebook identifies REF-02.\nReported cause: compressor fault" });
  const firstQuote = "Notebook identifies REF-02.";
  const correction = await correctDocument(connection.db, doc.documentId, { requestId: randomUUID(), analysisId, expectedCorrectionId: null, reason: "Fictional source review", change: { field: "equipment_id", value: "REF-02", evidence_quotes: [{ field: "equipment_id", value: "REF-02", quote: firstQuote, start: 21, end: 21 + firstQuote.length, source_document_id: doc.documentId }], supportConfirmed: true } });
  await correctDocument(connection.db, doc.documentId, { requestId: randomUUID(), analysisId, expectedCorrectionId: correction.correctionId, reason: "Fictional second source review", change: { field: "equipment_id", value: "REF-01", evidence_quotes: [{ field: "equipment_id", value: "REF-01", quote: "Equipment ID: REF-01", start: 0, end: 20, source_document_id: doc.documentId }], supportConfirmed: true } });
  const source = await previewDocumentSource(connection.db, incidentId, "demo-maintenance-01");
  const copy = await copyDocument(connection.db, incidentId, { requestId: randomUUID(), analysisId, sourceDocumentId: source.source.id, expectedSourceFingerprint: source.fingerprint, expectedSourceCorrectionId: null, associationConfirmed: true });
  await connection.db.insert(t.temperatureReadings).values(Array.from({ length: 5 }, (_, i) => ({ id: `later-${i}`, chamberId: "CH-1", recordedAt: `2026-03-11T00:${String(i * 10).padStart(2, "0")}:00+05:30`, temperatureC: i === 4 ? 3 : 7 })));
  const second = await analyzeStoredLog(connection.db), targetId = second.incidents.find((row) => row.incidentId !== incidentId)!.incidentId;
  const copiedSource = await previewDocumentSource(connection.db, targetId, copy.documentId);
  await copyDocument(connection.db, targetId, { requestId: randomUUID(), analysisId: second.analysis!.id, sourceDocumentId: copy.documentId, expectedSourceFingerprint: copiedSource.fingerprint, expectedSourceCorrectionId: null, associationConfirmed: true });
  await connection.db.insert(t.claims).values({ id: "packet", incidentId, policyId: "coldcover-demo-policy", readiness: "Needs more evidence", priority: "Standard priority", triageReasonsJson: [], exposureValueInr: 80000, summaryJson: [{ text: "Historical fictional packet", source_ids: ["preserve"] }], missingEvidenceJson: [], createdAt: "2026-03-10T08:00:00+05:30" });
  await connection.db.insert(t.reviewDecisions).values({ id: "review", claimId: "packet", reviewerName: "Fictional reviewer", status: "closed", comment: "Preserve exact review", decidedAt: "2026-03-10T08:00:00+05:30" });
  await connection.db.update(t.thresholds).set({ highExposureThresholdInr: 200000 });
  return { incidentId, docId: doc.documentId };
}

describe("Atomic demo archive, reset and restore", () => {
  it("read-only review creates no backups/operations or other writes", async () => {
    const before = await dump(); const one = await status(), two = await status();
    expect(one.state).toBe(two.state); expect(one.backups).toEqual([]); expect(one.counts).toMatchObject({ batches: 3, temperature_readings: 144, analysis_runs: 0 });
    expect(await dump()).toEqual(before);
  });
  it("archives all active rows and deliberately returns to an unanalysed/unextracted worked example", async () => {
    await connection.db.update(t.batches).set({ recordedValueInr: null }); await analyzeStoredLog(connection.db);
    const before = await snapshot(), receipt = await runDemoOperation(connection.db, await input());
    expect(receipt).toMatchObject({ action: "reset", reused: false, restoredFrom: null, beforeCounts: snapshotCounts(before), afterCounts: { batches: 3, temperature_readings: 144, analysis_runs: 0, claims: 0, documents: 1, audit_log: 2 } });
    expect((await downloadDemoBackup(connection.db, receipt.backupId)).snapshot).toEqual(before);
    const [doc] = await connection.db.select().from(t.documents); expect(doc.extractionJson).toBeNull(); expect(doc.extractionSource).toBeNull();
    const [draft] = await connection.db.select().from(t.incidents); expect(draft.abnormalStart).toBeNull(); expect(draft.status).toBe("draft");
    expect(await connection.db.select().from(t.demoBackups)).toHaveLength(1); expect(await connection.db.select().from(t.demoOperations)).toHaveLength(1);
  });
  it("round-trips exact raw history, correction self-references, copy ancestors and prepared packets", async () => {
    await populateHistory(); const before = await snapshot();
    expect(snapshotCounts(before)).toMatchObject({ document_corrections: 2, document_copies: 2, claims: 1, review_decisions: 1, analysis_runs: 2 });
    const reset = await runDemoOperation(connection.db, await input()); const clean = await snapshot();
    const recovered = await runDemoOperation(connection.db, await restore(reset.backupId));
    expect(recovered.restoredFrom).toBe(reset.backupId); expect(recovered.backupId).not.toBe(reset.backupId);
    expect((await downloadDemoBackup(connection.db, recovered.backupId)).snapshot).toEqual(clean);
    const after = await snapshot();
    for (const table of before.tables) {
      const current = after.tables.find((row) => row.name === table.name)!;
      if (table.name === "audit_log") current.rows = current.rows.filter((row) => row[0] !== `demo-operation-${recovered.requestId}`);
      expect(current).toEqual(table);
    }
    expect(await connection.db.select().from(t.demoBackups)).toHaveLength(2); expect(await connection.db.select().from(t.demoOperations)).toHaveLength(2);
    expect((await connection.client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    expect((await connection.client.execute("PRAGMA integrity_check")).rows[0].integrity_check).toBe("ok");
    await seed.seedDatabase(connection.db); expect(await connection.db.select().from(t.documentCorrections)).toHaveLength(2);
  });
  it("replays same UUID/exact payload without writes after later operations and reopen", async () => {
    const request = await input(), receipt = await runDemoOperation(connection.db, request);
    await runDemoOperation(connection.db, await restore(receipt.backupId)); const before = await dump();
    connection.close(); connection = await openDatabase(pathToFileURL(join(dir, "qa.db")).href);
    expect(await runDemoOperation(connection.db, request)).toEqual({ ...receipt, reused: true }); expect(await dump()).toEqual(before);
  });
  it("serializes concurrent same-ID retries into one archive/receipt", async () => {
    const request = await input(); const receipts = await Promise.all([runDemoOperation(connection.db, request), runDemoOperation(connection.db, request)]);
    expect(receipts.map((row) => row.reused).sort()).toEqual([false, true]); expect(receipts[0].backupId).toBe(receipts[1].backupId);
    expect(await connection.db.select().from(t.demoBackups)).toHaveLength(1);
  });
  it("rejects stale confirmations and ABA state even when original domain rows are restored", async () => {
    const request = await input(); await connection.db.update(t.batches).set({ ownerName: "Changed fictional owner" });
    await expect(runDemoOperation(connection.db, request)).rejects.toMatchObject({ code: "STALE_STATE" });
    const pending = await input(), before = await snapshot();
    const first = await runDemoOperation(connection.db, { ...pending, requestId: randomUUID() }), recovered = await runDemoOperation(connection.db, await restore(first.backupId));
    await connection.db.delete(t.auditLog).where(eq(t.auditLog.id, `demo-operation-${recovered.requestId}`));
    expect(await snapshot()).toEqual(before); expect((await status()).state).not.toBe(pending.expectedState);
    await expect(runDemoOperation(connection.db, pending)).rejects.toMatchObject({ code: "STALE_STATE" });
  });
  it("only one of two distinct requests confirmed against the same state may execute", async () => {
    const a = await input(), b = { ...a, requestId: randomUUID() };
    const outcomes = await Promise.allSettled([runDemoOperation(connection.db, a), runDemoOperation(connection.db, b)]);
    expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1); expect(await connection.db.select().from(t.demoBackups)).toHaveLength(1);
  });
  it("detects writes from another connection before reset", async () => {
    const request = await input(), other = await openDatabase(pathToFileURL(join(dir, "qa.db")).href);
    try { await other.db.update(t.batches).set({ recordedValueInr: 99 }); }
    finally { other.close(); }
    await expect(runDemoOperation(connection.db, request)).rejects.toMatchObject({ code: "STALE_STATE" });
  });
  it("allows at most one replacement across concurrent independent connections", async () => {
    const request = await input(), other = await openDatabase(pathToFileURL(join(dir, "qa.db")).href);
    try {
      await other.client.execute("PRAGMA busy_timeout=20");
      const outcomes = await Promise.allSettled([runDemoOperation(connection.db, request), runDemoOperation(other.db, { ...request, requestId: randomUUID() })]);
      expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1);
      expect(await connection.db.select().from(t.demoBackups)).toHaveLength(1);
    } finally { other.close(); }
  });
  it("rolls back backup, deletion and seed on an injected reseed failure", async () => {
    const request = await input(), before = await dump(); vi.spyOn(seed, "insertMissingDemoRecords").mockRejectedValueOnce(new Error("Injected reseed failure"));
    await expect(runDemoOperation(connection.db, request)).rejects.toThrow("Injected reseed failure"); expect(await dump()).toEqual(before);
    expect((await connection.client.execute("PRAGMA foreign_keys")).rows[0].foreign_keys).toBe(1);
    expect((await runDemoOperation(connection.db, request)).reused).toBe(false);
  });
  it("rejects changed UUID payloads without writes", async () => {
    const request = await input(); await runDemoOperation(connection.db, request); const before = await dump();
    await expect(runDemoOperation(connection.db, { ...request, expectedState: "0".repeat(64) })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" }); expect(await dump()).toEqual(before);
  });
  it.each(["hash", "counts", "columns", "foreign-key rows", "schema"])("refuses a corrupt/incompatible %s archive without losing current rows", async (kind) => {
    const receipt = await runDemoOperation(connection.db, await input()), [backup] = await connection.db.select().from(t.demoBackups);
    if (kind === "hash") await connection.db.update(t.demoBackups).set({ snapshotHash: "0".repeat(64) });
    if (kind === "counts") await connection.db.update(t.demoBackups).set({ countsJson: { ...backup.countsJson, documents: 99 } });
    if (kind === "schema") await connection.db.update(t.demoBackups).set({ schemaFingerprint: "0".repeat(64) });
    if (kind === "columns") { const changed = structuredClone(backup.snapshotJson); changed.tables[0].columns[0] = "unexpected"; await connection.db.update(t.demoBackups).set({ snapshotJson: changed, snapshotHash: digest(changed) }); }
    if (kind === "foreign-key rows") { const changed = structuredClone(backup.snapshotJson), docs = changed.tables.find((row) => row.name === "documents")!; docs.rows[0][docs.columns.indexOf("incident_id")] = "foreign"; await connection.db.update(t.demoBackups).set({ snapshotJson: changed, snapshotHash: digest(changed) }); }
    const request = await restore(receipt.backupId), before = await dump();
    await expect(runDemoOperation(connection.db, request)).rejects.toThrow(); expect(await dump()).toEqual(before);
  });
  it("refuses missing archives and corrupted receipts without performing another reset", async () => {
    await expect(runDemoOperation(connection.db, await restore(randomUUID()))).rejects.toMatchObject({ code: "BACKUP_NOT_FOUND" });
    const request = await input(); await runDemoOperation(connection.db, request); await connection.db.update(t.demoOperations).set({ receiptJson: { ...(await connection.db.select().from(t.demoOperations))[0].receiptJson, backupId: randomUUID() } });
    const before = await dump(); await expect(runDemoOperation(connection.db, request)).rejects.toMatchObject({ code: "INVALID_RECEIPT" }); expect(await dump()).toEqual(before);
  });
  it.each(["table", "column", "trigger"])("refuses unrecognised %s structures rather than omitting their data", async (kind) => {
    if (kind === "table") await connection.client.execute("CREATE TABLE extra_data(id TEXT)");
    if (kind === "column") await connection.client.execute("ALTER TABLE batches ADD COLUMN extra_value TEXT");
    if (kind === "trigger") await connection.client.execute("CREATE TRIGGER extra_trigger AFTER UPDATE ON batches BEGIN SELECT 1; END");
    const before = await dump(); await expect(status()).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" }); expect(await dump()).toEqual(before);
  });
  it("refuses disabled foreign-key enforcement", async () => {
    await connection.client.execute("PRAGMA foreign_keys=OFF"); await expect(status()).rejects.toMatchObject({ code: "INVALID_DATABASE" });
  });
  it("refuses snapshots beyond the byte limit without creating an archive", async () => {
    await connection.client.execute("UPDATE documents SET raw_text = printf('%.*c', 33554432, 'x')");
    await expect(status()).rejects.toMatchObject({ code: "BACKUP_LIMIT" }); expect(await connection.db.select().from(t.demoBackups)).toEqual([]);
  });
  it("pages immutable backup metadata without loading snapshot blobs", async () => {
    const seedReceipt = await runDemoOperation(connection.db, await input()), [saved] = await connection.db.select().from(t.demoBackups);
    for (let n = 2; n <= 22; n++) await connection.db.insert(t.demoBackups).values({ ...saved, id: randomUUID(), sequence: n });
    const first = await status(), second = await getResetStatus(connection.db, first.nextCursor!);
    expect(first.backups.map((row) => row.sequence)).toEqual(Array.from({ length: 20 }, (_, i) => 22 - i));
    expect(second.backups.map((row) => row.sequence)).toEqual([2, 1]); expect(second.backups.at(-1)?.id).toBe(seedReceipt.backupId);
    expect(second.nextCursor).toBeNull(); expect(first.state).toBe(second.state);
  });
  it("upgrades a populated five-migration DB without changing source rows", async () => {
    const folder = join(dir, "legacy"); mkdirSync(join(folder, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")); writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 5) }));
    for (const entry of journal.entries.slice(0, 5)) writeFileSync(join(folder, `${entry.tag}.sql`), readFileSync(`drizzle/${entry.tag}.sql`));
    const legacy = await openDatabase(pathToFileURL(join(dir, "legacy.db")).href);
    try { await migrate(legacy.db, { migrationsFolder: folder }); await seed.seedDatabase(legacy.db); const before = await legacy.db.select().from(t.documents); await applyMigrations(legacy.db); await applyMigrations(legacy.db); expect(await legacy.db.select().from(t.documents)).toEqual(before); expect(await legacy.db.select().from(t.demoBackups)).toEqual([]); }
    finally { legacy.close(); }
  });
});

describe("Reset HTTP contracts and read-only downloads", () => {
  it.each([{}, { action: "reset" }, { requestId: "bad" }, { confirmation: "reset demo" }])("requires complete exact operation confirmation", (value) => { expect(operationInputSchema.safeParse(value).success).toBe(false); });
  it("validates inputs before DB initialization and rejects cross-origin mutation", async () => {
    const getter = vi.fn(async () => connection.db), handler = resetHandlers(getter), good = JSON.stringify(await input());
    const cases: [string | Uint8Array, string, number, Record<string, string>?][] = [["{}", "application/json", 400], ["{", "application/json", 400], [good, "text/plain", 415], [" ".repeat(4097), "application/json", 413], [new Uint8Array([255]), "application/json", 400], [good, "application/json", 403, { Origin: "https://foreign.test" }], [good, "application/json", 403, { "Sec-Fetch-Site": "cross-site" }]];
    for (const [body, type, status, extra] of cases) expect((await handler.POST(new Request("http://test/api/admin/reset", { method: "POST", body: typeof body === "string" ? body : new Uint8Array(body), headers: { "Content-Type": type, ...extra } }))).status).toBe(status);
    expect(getter).not.toHaveBeenCalled();
    expect((await handler.GET(new Request("http://test/api/admin/reset?before=0"))).status).toBe(400);
    expect((await handler.GET(new Request("http://test/api/admin/reset?before=2&before=1"))).status).toBe(400);
    expect((await handler.DOWNLOAD("bad")).status).toBe(400); expect(getter).not.toHaveBeenCalled();
  });
  it("provides no-store review/receipt/download and generic failures", async () => {
    const handler = resetHandlers(async () => connection.db), review = await handler.GET(new Request("http://test/api/admin/reset"));
    expect(review.headers.get("cache-control")).toBe("no-store");
    const response = await handler.POST(new Request("http://test/api/admin/reset", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://test" }, body: JSON.stringify(await input()) }));
    expect(response.status).toBe(200); const receipt = await response.json();
    const before = await dump(), download = await handler.DOWNLOAD(receipt.backupId); expect(download.status).toBe(200); expect(download.headers.get("content-disposition")).toContain(receipt.backupId); expect(download.headers.get("cache-control")).toBe("no-store"); expect(await dump()).toEqual(before);
    expect((await handler.DOWNLOAD(randomUUID())).status).toBe(404); expect(backupIdSchema.safeParse(receipt.backupId).success).toBe(true);
    const failed = await resetHandlers(async () => { throw new Error("private path"); }).GET(new Request("http://test/api/admin/reset")); expect(failed.status).toBe(500); expect(await failed.text()).not.toContain("private path");
  });
  it("accepts the actual incoming loopback Host when NextURL normalises the URL to localhost", async () => {
    const handler = resetHandlers(async () => connection.db), request = await input();
    const response = await handler.POST(new Request("http://localhost:3100/api/admin/reset", { method: "POST", headers: { "Content-Type": "application/json", Host: "127.0.0.1:3100", Origin: "http://127.0.0.1:3100" }, body: JSON.stringify(request) }));
    expect(response.status).toBe(200);
    const rejected = await handler.POST(new Request("http://localhost:3100/api/admin/reset", { method: "POST", headers: { "Content-Type": "application/json", Host: "127.0.0.1:3100", Origin: "http://localhost:3100" }, body: JSON.stringify(request) }));
    expect(rejected.status).toBe(403); expect(await connection.db.select().from(t.demoOperations)).toHaveLength(1);
  });
});
