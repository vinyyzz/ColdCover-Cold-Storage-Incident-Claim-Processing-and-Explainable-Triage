import "server-only";
import { randomUUID } from "node:crypto";
import { desc, eq, lt, max } from "drizzle-orm";
import type { Database } from "../db/client";
import { withDatabase } from "../db/access";
import { auditLog, demoBackups, demoOperations } from "../db/schema";
import { insertMissingDemoRecords } from "../db/seed";
import { toIstIso } from "../inventory/format";
import { backupIdSchema, countsSchema, operationInputSchema, receiptSchema, RESET_VERSION, resetStatusSchema, statusQuerySchema, type OperationReceipt, type ResetSnapshot } from "./contract";
import { ResetError } from "./errors";
import { captureSnapshot, digest, priorSchemaFingerprints, replaceRows, snapshotCounts, validateSnapshot } from "./snapshot";

export async function getResetStatus(db: Database, before?: number) {
  const query = statusQuerySchema.parse({ before });
  return withDatabase(db, () => db.transaction(async (tx) => {
    const snapshot = await captureSnapshot(tx);
    const [latest] = await tx.select({ sequence: max(demoBackups.sequence) }).from(demoBackups);
    const rows = await tx.select({ id: demoBackups.id, sequence: demoBackups.sequence, action: demoBackups.action, createdAt: demoBackups.createdAt, counts: demoBackups.countsJson, schema: demoBackups.schemaFingerprint }).from(demoBackups).where(query.before === undefined ? undefined : lt(demoBackups.sequence, query.before)).orderBy(desc(demoBackups.sequence)).limit(21);
    const page = rows.slice(0, 20), priorSchemas = Object.values(await priorSchemaFingerprints(tx));
    return resetStatusSchema.parse({ version: RESET_VERSION, checkedAt: toIstIso(new Date().toISOString()), state: digest({ snapshot: digest(snapshot), sequence: latest.sequence ?? 0 }), counts: snapshotCounts(snapshot), backups: page.map(({ schema, ...row }) => ({ ...row, compatible: schema === snapshot.schemaFingerprint || priorSchemas.includes(schema) })), nextCursor: rows.length > 20 ? page.at(-1)!.sequence : null });
  }));
}

export async function runDemoOperation(db: Database, value: unknown): Promise<OperationReceipt> {
  const input = operationInputSchema.parse(value);
  // The installed Drizzle libSQL session calls client.transaction(), whose
  // pinned local implementation defaults to write/BEGIN IMMEDIATE. Its config
  // parameter is ignored; concurrency tests protect this dependency.
  return withDatabase(db, () => db.transaction(async (tx) => {
    const [existing] = await tx.select().from(demoOperations).where(eq(demoOperations.requestId, input.requestId));
    if (existing) {
      const savedInput = operationInputSchema.parse(existing.requestJson), receipt = receiptSchema.parse(existing.receiptJson);
      if (digest(savedInput) !== digest(input)) throw new ResetError(409, "REQUEST_CONFLICT", "This request identifier already belongs to a different operation. Review the current workspace before starting another one.");
      const [archive] = await tx.select({ sequence: demoBackups.sequence, snapshotHash: demoBackups.snapshotHash, counts: demoBackups.countsJson, action: demoBackups.action, createdAt: demoBackups.createdAt }).from(demoBackups).where(eq(demoBackups.id, receipt.backupId));
      if (!archive || digest(receipt.beforeCounts) !== digest(countsSchema.parse(archive.counts)) || input.expectedState !== digest({ snapshot: archive.snapshotHash, sequence: archive.sequence - 1 }) || archive.action !== input.action || archive.createdAt !== receipt.createdAt || receipt.requestId !== input.requestId || receipt.action !== input.action || existing.action !== input.action || receipt.backupId !== existing.backupId || receipt.restoredFrom !== existing.restoredFrom || receipt.createdAt !== existing.createdAt || receipt.reused || (input.action === "restore" && receipt.restoredFrom !== input.backupId)) throw new ResetError(409, "INVALID_RECEIPT", "The saved operation receipt could not be verified. No new operation was performed.");
      return { ...receipt, reused: true };
    }
    const before = await captureSnapshot(tx), beforeCounts = countsSchema.parse(snapshotCounts(before));
    const [latest] = await tx.select({ sequence: max(demoBackups.sequence) }).from(demoBackups);
    const sequence = latest.sequence ?? 0;
    if (input.expectedState !== digest({ snapshot: digest(before), sequence })) throw new ResetError(409, "STALE_STATE", "The workspace changed after review. Refresh the counts and confirm the current state before continuing.");
    let restored: ResetSnapshot | undefined;
    if (input.action === "restore") {
      const [backup] = await tx.select().from(demoBackups).where(eq(demoBackups.id, input.backupId));
      if (!backup) throw new ResetError(404, "BACKUP_NOT_FOUND", "That backup is not available. Current data has not been replaced.");
      const priorSchemas = await priorSchemaFingerprints(tx);
      if (backup.schemaFingerprint !== before.schemaFingerprint && !Object.values(priorSchemas).includes(backup.schemaFingerprint)) throw new ResetError(409, "INCOMPATIBLE_BACKUP", "That backup uses a different database structure. Current data has not been replaced.");
      try { restored = validateSnapshot(backup.snapshotJson, backup.schemaFingerprint, backup.snapshotHash, countsSchema.parse(backup.countsJson)); }
      catch { throw new ResetError(409, "INVALID_BACKUP", "That backup could not be verified. Current data has not been replaced."); }
      if ((restored.version === "demo-reset-v3" ? before.schemaFingerprint : priorSchemas[restored.version]) !== backup.schemaFingerprint) throw new ResetError(409, "INVALID_BACKUP", "The archive format differs from its verified structure.");
    }
    const backupId = randomUUID(), createdAt = toIstIso(new Date().toISOString());
    if (!Number.isSafeInteger(sequence + 1)) throw new ResetError(409, "BACKUP_LIMIT", "The backup sequence exceeds its supported range. Current data has not been replaced.");
    await tx.insert(demoBackups).values({ id: backupId, sequence: sequence + 1, action: input.action, createdAt, schemaFingerprint: before.schemaFingerprint, snapshotHash: digest(before), snapshotJson: before, countsJson: beforeCounts });
    await replaceRows(tx, restored);
    if (input.action === "reset") await insertMissingDemoRecords(tx);
    await tx.insert(auditLog).values({ id: `demo-operation-${input.requestId}`, actor: "storage_operator", action: input.action === "reset" ? "demo_reset" : "demo_restored", entity: "demo_operation", entityId: input.requestId, at: createdAt, detail: JSON.stringify({ version: RESET_VERSION, backupId, restoredFrom: input.action === "restore" ? input.backupId : null, beforeCounts, confirmation: input.confirmation }) });
    const after = await captureSnapshot(tx);
    const receipt = receiptSchema.parse({ version: RESET_VERSION, requestId: input.requestId, action: input.action, backupId, restoredFrom: input.action === "restore" ? input.backupId : null, createdAt, beforeCounts, afterCounts: snapshotCounts(after), reused: false });
    await tx.insert(demoOperations).values({ requestId: input.requestId, action: input.action, backupId, restoredFrom: receipt.restoredFrom, requestJson: input, receiptJson: receipt, createdAt });
    return receipt;
  }));
}

export async function downloadDemoBackup(db: Database, value: unknown) {
  const id = backupIdSchema.parse(value);
  return withDatabase(db, () => db.transaction(async (tx) => {
    const [row] = await tx.select().from(demoBackups).where(eq(demoBackups.id, id));
    if (!row) throw new ResetError(404, "BACKUP_NOT_FOUND", "That backup is not available.");
    try {
      const snapshot = validateSnapshot(row.snapshotJson, row.schemaFingerprint, row.snapshotHash, countsSchema.parse(row.countsJson));
      return { version: RESET_VERSION, id: row.id, createdAt: row.createdAt, snapshotHash: row.snapshotHash, counts: row.countsJson, snapshot };
    } catch { throw new ResetError(409, "INVALID_BACKUP", "That backup could not be verified. No data was changed."); }
  }));
}
