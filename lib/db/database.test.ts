import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseConnection } from "./client";
import { databaseFilePath } from "./config";
import { initializeDatabase } from "./initialize";
import { applyMigrations } from "./migrate";
import { seedDatabase } from "./seed";
import * as tables from "./schema";

describe("SQLite persistence and demo initialization", () => {
  let directory: string;
  let url: string;
  let connection: DatabaseConnection;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "coldcover-db-test-"));
    url = pathToFileURL(join(directory, "nested", "test.db")).href;
    connection = await openDatabase(url);
    await applyMigrations(connection.db);
  });

  afterEach(() => {
    connection?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("migrates a fresh file to 24 application tables and enables foreign keys", async () => {
    const result = await connection.client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name");
    expect(result.rows.map((row) => row.name)).toEqual([
      "ai_result_cache", "analysis_incident_links", "analysis_runs", "audit_log", "batch_policy_schedules", "batches", "chambers", "claim_packets", "claims", "demo_backups", "demo_operations", "document_copies", "document_corrections", "documents", "equipment",
      "incident_events", "incidents", "policies", "policy_case_packets", "policy_case_reviews", "review_decisions", "scenarios",
      "temperature_readings", "thresholds",
    ]);
    const foreignKeys = await connection.client.execute("PRAGMA foreign_keys");
    expect(foreignKeys.rows[0].foreign_keys).toBe(1);
  });

  it("applies migrations repeatedly without duplicating migration history or data", async () => {
    await seedDatabase(connection.db);
    await applyMigrations(connection.db);
    const history = await connection.client.execute("SELECT count(*) AS count FROM __drizzle_migrations");
    expect(history.rows[0].count).toBe(8);
    expect(await connection.db.select().from(tables.batches)).toHaveLength(3);
  });

  it("upgrades a populated original-schema database without changing operator evidence", async () => {
    const folder = join(directory, "legacy-migrations");
    mkdirSync(join(folder, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));
    writeFileSync(join(folder, "0000_initial_schema.sql"), readFileSync("drizzle/0000_initial_schema.sql"));
    const legacy = await openDatabase(pathToFileURL(join(directory, "legacy.db")).href);
    try {
      await migrate(legacy.db, { migrationsFolder: folder });
      await seedDatabase(legacy.db);
      await legacy.db.update(tables.documents).set({ rawText: "Operator-maintained fictional report" });
      await legacy.db.update(tables.batches).set({ recordedValueInr: null }).where(eq(tables.batches.id, "demo-batch-a"));
      const documents = await legacy.db.select().from(tables.documents);
      const batches = await legacy.db.select().from(tables.batches);
      const events = await legacy.db.select().from(tables.incidentEvents);
      const audits = await legacy.db.select().from(tables.auditLog);
      await applyMigrations(legacy.db);
      await applyMigrations(legacy.db);
      expect(await legacy.db.select().from(tables.documents)).toEqual(documents);
      expect(await legacy.db.select().from(tables.batches)).toEqual(batches);
      expect(await legacy.db.select().from(tables.incidentEvents)).toEqual(events);
      expect(await legacy.db.select().from(tables.auditLog)).toEqual(audits);
      expect(await legacy.db.select().from(tables.analysisRuns)).toEqual([]);
      expect(await legacy.db.select().from(tables.analysisIncidentLinks)).toEqual([]);
      expect((await legacy.client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    } finally { legacy.close(); }
  });

  it("persists the worked-example facts without pretending analysis or extraction ran", async () => {
    await seedDatabase(connection.db);
    const batches = await connection.db.select().from(tables.batches).orderBy(tables.batches.batchCode);
    expect(batches.map((batch) => [batch.batchCode, batch.recordedValueInr])).toEqual([["A", 50000], ["B", 30000], ["C", 20000]]);
    expect(batches[0].enteredAt).toBe("2026-03-09T18:00:00+05:30");
    expect(batches[2].enteredAt).toBe("2026-03-10T06:00:00+05:30");
    const readings = await connection.db.select().from(tables.temperatureReadings).orderBy(tables.temperatureReadings.recordedAt);
    expect(readings).toHaveLength(144);
    expect(readings[8].recordedAt).toBe("2026-03-10T01:20:00+05:30");
    expect(readings[8].temperatureC).toBeGreaterThan(5);
    expect(readings[33].temperatureC).toBeGreaterThan(5);
    expect(readings[34].recordedAt).toBe("2026-03-10T05:40:00+05:30");
    expect(readings[34].temperatureC).toBeLessThanOrEqual(5);
    const [incident] = await connection.db.select().from(tables.incidents);
    expect(incident).toMatchObject({ status: "draft", abnormalStart: null, abnormalEnd: null });
    const documents = await connection.db.select().from(tables.documents);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ docType: "maintenance_report", extractionJson: null, extractionSource: null });
    expect(documents[0].rawText).toContain("Refrigeration restarted at 05:10");
    expect(await connection.db.select().from(tables.claims)).toHaveLength(0);
    expect(await connection.db.select().from(tables.reviewDecisions)).toHaveLength(0);
    const [scenario] = await connection.db.select().from(tables.scenarios).where(eq(tables.scenarios.id, "worked-example"));
    expect(scenario.expectedJson).toMatchObject({ exposureValueInr: 80000, readiness: "Needs more evidence", priority: "Standard priority" });
    const [policy] = await connection.db.select().from(tables.policies);
    expect(policy.demonstrationLabel).toBe("Demonstration policy — not an insurer's actual wording.");
    expect(policy.wording).toContain("machinery breakdown cover being in force");
    const [thresholds] = await connection.db.select().from(tables.thresholds);
    expect(thresholds).toMatchObject({ abnormalAboveC: 5, minAbnormalMinutes: 30, maxGapMinutes: 30, expectedIntervalMinutes: 10, highExposureThresholdInr: 150000 });
  });

  it("seeds twice without duplicates and preserves edits plus operator-added records", async () => {
    await seedDatabase(connection.db);
    await connection.db.update(tables.batches).set({ recordedValueInr: 51000 }).where(eq(tables.batches.id, "demo-batch-a"));
    await connection.db.update(tables.thresholds).set({ highExposureThresholdInr: 200000 });
    await connection.db.update(tables.documents).set({ rawText: "Operator-corrected fictional report" });
    await connection.db.update(tables.scenarios).set({ expectedJson: { operatorNote: "Preserve edited metadata" } }).where(eq(tables.scenarios.id, "worked-example"));
    await connection.db.insert(tables.batches).values({ id: "operator-batch", batchCode: "D", ownerName: "Fictional operator record", chamberId: "CH-1", quantityKg: 50, recordedValueInr: null, enteredAt: "2026-03-10T08:00:00+05:30" });
    await seedDatabase(connection.db);
    const batches = await connection.db.select().from(tables.batches).orderBy(tables.batches.batchCode);
    expect(batches).toHaveLength(4);
    expect(batches[0].recordedValueInr).toBe(51000);
    expect(batches[3].recordedValueInr).toBeNull();
    expect((await connection.db.select().from(tables.thresholds))[0].highExposureThresholdInr).toBe(200000);
    expect((await connection.db.select().from(tables.documents))[0].rawText).toBe("Operator-corrected fictional report");
    expect(await connection.db.select().from(tables.temperatureReadings)).toHaveLength(144);
    expect(await connection.db.select().from(tables.scenarios)).toHaveLength(30);
    const [scenario] = await connection.db.select().from(tables.scenarios).where(eq(tables.scenarios.id, "worked-example"));
    expect(scenario.expectedJson).toEqual({ operatorNote: "Preserve edited metadata" });
    for (const table of [tables.policies, tables.auditLog, tables.incidentEvents]) {
      expect(await connection.db.select().from(table)).toHaveLength(1);
    }
  });

  it("persists edits across close/reopen and non-destructive lazy initialization", async () => {
    await seedDatabase(connection.db);
    await connection.db.update(tables.batches).set({ ownerName: "Updated fictional owner" }).where(eq(tables.batches.id, "demo-batch-a"));
    connection.close();
    connection = await initializeDatabase(url);
    const [batch] = await connection.db.select().from(tables.batches).where(eq(tables.batches.id, "demo-batch-a"));
    expect(batch.ownerName).toBe("Updated fictional owner");
    expect(await connection.db.select().from(tables.batches)).toHaveLength(3);
  });

  it("rejects orphan records and protects records still referenced by evidence", async () => {
    await expect(connection.db.insert(tables.equipment).values({ id: "orphan", chamberId: "missing", equipmentCode: "REF-X", description: "Invalid orphan" })).rejects.toThrow();
    await seedDatabase(connection.db);
    await expect(connection.db.delete(tables.chambers).where(eq(tables.chambers.id, "CH-1"))).rejects.toThrow();
    expect(await connection.db.select().from(tables.chambers)).toHaveLength(1);
  });

  it("enforces quantity, value, date order, enum, singleton, and duplicate-reading constraints", async () => {
    await seedDatabase(connection.db);
    const valid = { id: "new", batchCode: "NEW", chamberId: "CH-1", ownerName: "Fictional test owner", quantityKg: 10, recordedValueInr: 0, enteredAt: "2026-03-10T08:00:00+05:30" };
    await expect(connection.db.insert(tables.batches).values({ ...valid, quantityKg: 0 })).rejects.toThrow();
    await expect(connection.db.insert(tables.batches).values({ ...valid, recordedValueInr: -1 })).rejects.toThrow();
    await expect(connection.db.insert(tables.batches).values({ ...valid, exitedAt: "2026-03-10T07:00:00+05:30" })).rejects.toThrow();
    await connection.db.insert(tables.batches).values(valid);
    await expect(connection.client.execute("UPDATE incidents SET status='invalid' WHERE id='demo-incident-01'")).rejects.toThrow();
    await expect(connection.db.insert(tables.thresholds).values({ id: 2 })).rejects.toThrow();
    await expect(connection.db.insert(tables.temperatureReadings).values({ id: "duplicate-time", chamberId: "CH-1", recordedAt: "2026-03-10T01:20:00+05:30", temperatureC: 4 })).rejects.toThrow();
  });

  it("rolls back the entire seed on an unexpected natural-key conflict", async () => {
    await connection.db.insert(tables.chambers).values({ id: "CH-1", name: "Existing chamber", commodity: "potatoes", normalMinC: 2, normalMaxC: 5 });
    await connection.db.insert(tables.batches).values({ id: "existing-a", batchCode: "A", ownerName: "Preserved owner", chamberId: "CH-1", quantityKg: 1, recordedValueInr: null, enteredAt: "2026-03-09T18:00:00+05:30" });
    await expect(seedDatabase(connection.db)).rejects.toThrow();
    expect(await connection.db.select().from(tables.equipment)).toHaveLength(0);
    expect(await connection.db.select().from(tables.thresholds)).toHaveLength(0);
    expect(await connection.db.select().from(tables.policies)).toHaveLength(0);
    expect(await connection.db.select().from(tables.scenarios)).toHaveLength(0);
    expect((await connection.db.select().from(tables.batches))[0].ownerName).toBe("Preserved owner");
  });

  it("limits current configuration to persistent local SQLite files", () => {
    expect(databaseFilePath("file:./data/test.db")).toBe(join(process.cwd(), "data", "test.db"));
    expect(databaseFilePath(url)).toBe(join(directory, "nested", "test.db"));
    for (const invalid of ["", "file:", "file::memory:", "libsql://unconfigured.example", "postgres://unconfigured.example"]) {
      expect(() => databaseFilePath(invalid)).toThrow("local SQLite file");
    }
  });
});
