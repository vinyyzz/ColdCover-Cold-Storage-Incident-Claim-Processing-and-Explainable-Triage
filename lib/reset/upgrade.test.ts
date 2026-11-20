import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, expect, it, vi } from "vitest";
import { openDatabase, type DatabaseConnection } from "../db/client";
import { applyMigrations } from "../db/migrate";
import { seedDatabase } from "../db/seed";
import * as t from "../db/schema";
import { countsSchema, snapshotSchema, type ResetSnapshot } from "./contract";
import { downloadDemoBackup, getResetStatus, runDemoOperation } from "./service";
import { digest, legacySchemaFingerprint } from "./snapshot";
vi.mock("server-only", () => ({}));
let dir: string, conn: DatabaseConnection;
afterEach(() => { conn?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
async function oldFixture() {
  dir = mkdtempSync(join(tmpdir(), "coldcover-reset-upgrade-")); const folder = join(dir, "old-migrations"); mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")); const entries = journal.entries.slice(0, 6);
  writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) writeFileSync(join(folder, `${entry.tag}.sql`), readFileSync(`drizzle/${entry.tag}.sql`));
  conn = await openDatabase(pathToFileURL(join(dir, "old.db")).href); await migrate(conn.db, { migrationsFolder: folder }); await seedDatabase(conn.db);
  await conn.db.insert(t.claims).values({ id: "legacy", incidentId: "demo-incident-01", policyId: "coldcover-demo-policy", readiness: "Needs more evidence", priority: "Standard priority", triageReasonsJson: [], exposureValueInr: 80000, summaryJson: [], missingEvidenceJson: [], createdAt: "2026-03-10T08:00:00+05:30" });
  const objects = await conn.db.all(sql`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`), migrations = await conn.db.all(sql`SELECT hash,created_at FROM __drizzle_migrations ORDER BY id`);
  const schemaFingerprint = digest({ objects, migrations }), names = ["chambers", "equipment", "thresholds", "policies", "scenarios", "batches", "temperature_readings", "incidents", "analysis_runs", "analysis_incident_links", "documents", "incident_events", "claims", "review_decisions", "audit_log", "document_corrections", "document_copies", "ai_result_cache"];
  const tables: ResetSnapshot["tables"] = [];
  for (const name of names) {
    const columns = (await conn.db.all<{ name: string }>(sql`PRAGMA table_info(${sql.identifier(name)})`)).map((row) => row.name);
    const records = await conn.db.all<Record<string, string | number | null>>(sql`SELECT * FROM ${sql.identifier(name)} ORDER BY ${sql.identifier(columns[0])}`);
    tables.push({ name, columns, rows: records.map((row) => columns.map((column) => row[column])) });
  }
  const snapshot = snapshotSchema.parse({ version: "demo-reset-v1", schemaFingerprint, tables }), counts = Object.fromEntries(tables.map((table) => [table.name, table.rows.length]));
  const backupId = randomUUID(), requestId = randomUUID(), createdAt = "2026-03-10T09:00:00+05:30";
  const input = { requestId, action: "reset" as const, expectedState: digest({ snapshot: digest(snapshot), sequence: 0 }), confirmation: "RESET DEMO" as const };
  const receipt = { version: "demo-reset-v1" as const, requestId, action: "reset" as const, backupId, restoredFrom: null, createdAt, beforeCounts: counts, afterCounts: counts, reused: false };
  await conn.db.insert(t.demoBackups).values({ id: backupId, sequence: 1, action: "reset", createdAt, schemaFingerprint, snapshotHash: digest(snapshot), snapshotJson: snapshot, countsJson: counts });
  // Raw old receipts really omit the newly added count key.
  await conn.db.run(sql`INSERT INTO demo_operations VALUES (${requestId},'reset',${backupId},NULL,${JSON.stringify(input)},${JSON.stringify(receipt)},${createdAt})`);
  return { snapshot, counts, backupId, input, receipt, schemaFingerprint };
}
it("upgrades exact v1 archives without rewriting JSON/receipts, verifies download and restores legacy claims", async () => {
  const old = await oldFixture(); const beforeBackup = await conn.db.select().from(t.demoBackups), beforeReceipt = await conn.db.all(sql`SELECT receipt_json FROM demo_operations`);
  await applyMigrations(conn.db); expect(await legacySchemaFingerprint(conn.db)).toBe(old.schemaFingerprint);
  const status = await getResetStatus(conn.db); expect(status.backups[0].compatible).toBe(true); expect(status.backups[0].counts.claim_packets).toBe(0);
  const download = await downloadDemoBackup(conn.db, old.backupId); expect(download.snapshot).toEqual(old.snapshot); expect(digest(download.snapshot)).toBe(digest(old.snapshot)); expect(download.counts).toEqual(old.counts);
  expect(await runDemoOperation(conn.db, old.input)).toMatchObject({ reused: true, beforeCounts: { claim_packets: 0 } });
  await conn.db.update(t.documents).set({ rawText: "Changed current fictional data" });
  const restored = await runDemoOperation(conn.db, { requestId: randomUUID(), action: "restore", expectedState: (await getResetStatus(conn.db)).state, backupId: old.backupId, confirmation: "RESTORE BACKUP" });
  expect(restored.afterCounts.claims).toBe(1); expect(await conn.db.select().from(t.claimPackets)).toEqual([]);
  expect((await conn.db.select().from(t.demoBackups))[0]).toEqual(beforeBackup[0]); expect((await conn.db.all(sql`SELECT receipt_json FROM demo_operations WHERE request_id=${old.input.requestId}`))[0]).toEqual(beforeReceipt[0]);
  expect((await conn.db.select().from(t.documents))[0].rawText).not.toBe("Changed current fictional data");
  expect(await conn.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
});
it("normalises exact old counts while rejecting omissions, extras and unknown archive layouts", () => {
  const names = ["chambers", "equipment", "thresholds", "policies", "scenarios", "batches", "temperature_readings", "incidents", "analysis_runs", "analysis_incident_links", "documents", "incident_events", "claims", "review_decisions", "audit_log", "document_corrections", "document_copies", "ai_result_cache"];
  const counts = Object.fromEntries(names.map((name) => [name, 0])); expect(countsSchema.parse(counts).claim_packets).toBe(0);
  expect(countsSchema.safeParse({ ...counts, extra: 0 }).success).toBe(false); delete counts.chambers; expect(countsSchema.safeParse(counts).success).toBe(false);
});

it("restores an exact pre-policy-case v2 archive and preserves its original payload", async () => {
  const { backupId } = await oldFixture();
  const folder = join(dir, "old-migrations");
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  const entries = journal.entries.slice(0, 7);
  writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  const last = entries.at(-1).tag;
  writeFileSync(join(folder, `${last}.sql`), readFileSync(`drizzle/${last}.sql`));
  await migrate(conn.db, { migrationsFolder: folder });
  const first = await downloadDemoBackup(conn.db, backupId);
  const objects = await conn.db.all(sql`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`);
  const migrations = await conn.db.all(sql`SELECT hash,created_at FROM __drizzle_migrations ORDER BY id`);
  const schemaFingerprint = digest({ objects, migrations });
  const snapshot = snapshotSchema.parse({ version: "demo-reset-v2", schemaFingerprint, tables: [...first.snapshot.tables, { name: "claim_packets",
    columns: (await conn.db.all<{name: string}>(sql`PRAGMA table_info(claim_packets)`)).map((column) => column.name), rows: [] }] });
  const counts = { ...first.counts, claim_packets: 0 };
  const id = randomUUID();
  await conn.db.insert(t.demoBackups).values({ id, sequence: 2, action: "reset", createdAt: "2026-03-10T10:00:00+05:30", schemaFingerprint, snapshotHash: digest(snapshot), snapshotJson: snapshot, countsJson: counts });
  await applyMigrations(conn.db);
  await conn.db.insert(t.batchPolicySchedules).values({ batchId: "demo-batch-a", scheduleId: "apple", assignedAt: "2026-03-10T10:00:00+05:30" });
  const status = await getResetStatus(conn.db);
  expect(status.backups.find((backup) => backup.id === id)?.compatible).toBe(true);
  await runDemoOperation(conn.db, { requestId: randomUUID(), action: "restore", expectedState: status.state, backupId: id, confirmation: "RESTORE BACKUP" });
  expect(await conn.db.select().from(t.batchPolicySchedules)).toEqual([]);
  expect(await downloadDemoBackup(conn.db, id)).toMatchObject({ snapshot, counts });
});
