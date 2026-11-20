import "server-only";
import { createHash } from "node:crypto";
import { getTableColumns, getTableName, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import * as t from "../db/schema";
import { MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_ROWS, SNAPSHOT_VERSION, countsSchema, snapshotSchema, snapshotTableSchema, type ResetSnapshot } from "./contract";
import { ResetError } from "./errors";

export type ResetTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Pick<Database, "all">;
export const dataTables = [t.chambers, t.equipment, t.thresholds, t.policies, t.scenarios, t.batches, t.temperatureReadings, t.incidents, t.analysisRuns, t.analysisIncidentLinks, t.documents, t.incidentEvents, t.claims, t.reviewDecisions, t.auditLog, t.documentCorrections, t.documentCopies, t.aiResultCache, t.claimPackets, t.batchPolicySchedules, t.policyCasePackets, t.policyCaseReviews] as const;
const inventory = dataTables.map((table) => ({ name: getTableName(table), columns: Object.values(getTableColumns(table)).map((column) => column.name) }));
const managedInventory = [...inventory, ...[t.demoBackups, t.demoOperations].map((table) => ({ name: getTableName(table), columns: Object.values(getTableColumns(table)).map((column) => column.name) }))];
const allNames = [...inventory.map((table) => table.name), "demo_backups", "demo_operations", "__drizzle_migrations"].sort();
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
export const snapshotCounts = (snapshot: ResetSnapshot) => countsSchema.parse(Object.fromEntries(snapshot.tables.map((table) => [table.name, table.rows.length])));

export async function schemaFingerprint(db: Reader) {
  const objects = await db.all<{ type: string; name: string; tbl_name: string; sql: string | null }>(sql`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`);
  if (JSON.stringify(objects.filter((row) => row.type === "table").map((row) => row.name).sort()) !== JSON.stringify(allNames) || objects.some((row) => row.type === "trigger" || row.type === "view")) throw new ResetError(409, "UNSUPPORTED_SCHEMA", "This database contains unrecognised structures. Its data has not been replaced.");
  for (const table of managedInventory) {
    const columns = await db.all<{ name: string }>(sql`PRAGMA table_info(${sql.identifier(table.name)})`);
    if (JSON.stringify(columns.map((column) => column.name)) !== JSON.stringify(table.columns)) throw new ResetError(409, "UNSUPPORTED_SCHEMA", "The database columns have changed. Reset and restore are unavailable until compatibility is reviewed.");
  }
  const migrations = await db.all(sql`SELECT hash,created_at FROM __drizzle_migrations ORDER BY id`);
  return digest({ objects, migrations });
}
/** Only exact layouts preceding the append-only migrations are compatible. */
export async function priorSchemaFingerprints(db: Reader) {
  const objects = await db.all<{ type: string; name: string; tbl_name: string; sql: string | null }>(sql`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`);
  const migrations = await db.all(sql`SELECT hash,created_at FROM __drizzle_migrations ORDER BY id`);
  if (migrations.length !== 8) return { "demo-reset-v1": null, "demo-reset-v2": null };
  const newNames = new Set<string>(inventory.slice(19).map((table) => table.name));
  const v2Objects = objects.filter((row) => !newNames.has(row.tbl_name));
  return {
    "demo-reset-v1": digest({ objects: v2Objects.filter((row) => row.tbl_name !== "claim_packets"), migrations: migrations.slice(0, 6) }),
    "demo-reset-v2": digest({ objects: v2Objects, migrations: migrations.slice(0, 7) }),
  };
}
export async function legacySchemaFingerprint(db: Reader) {
  return (await priorSchemaFingerprints(db))["demo-reset-v1"];
}
export async function checkIntegrity(db: Reader) {
  const fk = await db.all<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`);
  const integrity = await db.all<{ quick_check: string }>(sql`PRAGMA quick_check`);
  if (fk[0]?.foreign_keys !== 1 || integrity.length !== 1 || integrity[0].quick_check !== "ok" || (await db.all(sql`PRAGMA foreign_key_check`)).length) throw new ResetError(409, "INVALID_DATABASE", "The database references could not be verified. Its data has not been replaced.");
}

export async function captureSnapshot(db: Reader): Promise<ResetSnapshot> {
  await checkIntegrity(db);
  const fingerprint = await schemaFingerprint(db);
  let count = 0;
  // Count before loading so excessive state is rejected without a huge read.
  for (const table of inventory) {
    const [row] = await db.all<{ count: number }>(sql`SELECT count(*) AS count FROM ${sql.identifier(table.name)}`);
    count += row.count;
  }
  if (!Number.isSafeInteger(count) || count > MAX_SNAPSHOT_ROWS) throw new ResetError(409, "BACKUP_LIMIT", "The workspace exceeds the supported backup size. Its data has not been replaced.");
  const tables: ResetSnapshot["tables"] = [];
  let bytes = 0;
  for (const table of inventory) {
    const records = await db.all<Record<string, unknown>>(sql`SELECT * FROM ${sql.identifier(table.name)} ORDER BY ${sql.identifier(table.columns[0])}`);
    const rows = records.map((row) => table.columns.map((column) => row[column]));
    const parsed = snapshotTableSchema.parse({ ...table, rows });
    bytes += Buffer.byteLength(JSON.stringify(parsed), "utf8");
    if (bytes > MAX_SNAPSHOT_BYTES) throw new ResetError(409, "BACKUP_LIMIT", "The workspace exceeds the supported backup size. Its data has not been replaced.");
    tables.push(parsed);
  }
  const snapshot = snapshotSchema.parse({ version: SNAPSHOT_VERSION, schemaFingerprint: fingerprint, tables });
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_BYTES) throw new ResetError(409, "BACKUP_LIMIT", "The workspace exceeds the supported backup size. Its data has not been replaced.");
  return snapshot;
}

export function validateSnapshot(value: unknown, expectedSchema: string, expectedHash: string, expectedCounts: Record<string, number>) {
  const snapshot = snapshotSchema.parse(value);
  if (snapshot.schemaFingerprint !== expectedSchema || digest(snapshot) !== expectedHash || digest(snapshotCounts(snapshot)) !== digest(countsSchema.parse(expectedCounts)) || snapshot.tables.some((table, index) => table.name !== inventory[index].name || JSON.stringify(table.columns) !== JSON.stringify(inventory[index].columns) || table.rows.some((row) => row.length !== table.columns.length)) || Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_BYTES || snapshot.tables.reduce((sum, table) => sum + table.rows.length, 0) > MAX_SNAPSHOT_ROWS) throw new ResetError(409, "INVALID_BACKUP", "That backup could not be verified. Current data has not been replaced.");
  return snapshot;
}

export async function replaceRows(tx: ResetTransaction, snapshot?: ResetSnapshot) {
  // Installed libSQL/Drizzle uses a write/BEGIN IMMEDIATE transaction. Defer
  // references until all rows are replaced; enforcement stays enabled.
  await tx.run(sql`PRAGMA defer_foreign_keys = ON`);
  for (const table of [...inventory].reverse()) await tx.run(sql`DELETE FROM ${sql.identifier(table.name)}`);
  if (snapshot) for (const table of snapshot.tables) {
    for (let start = 0; start < table.rows.length; start += 50) {
      const rows = table.rows.slice(start, start + 50).map((row) => sql`(${sql.join(row.map((value) => sql`${value}`), sql`,`)})`);
      await tx.run(sql`INSERT INTO ${sql.identifier(table.name)} (${sql.join(table.columns.map((name) => sql.identifier(name)), sql`,`)}) VALUES ${sql.join(rows, sql`,`)}`);
    }
  }
}
