import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { withDatabase } from "../db/access";
import { auditLog, batchPolicySchedules, batches } from "../db/schema";
import { toIstIso } from "./format";
import { batchIdSchema, batchInputSchema, batchPatchSchema, type BatchInput } from "./validation";

export class InventoryError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function listBatches(db: Database) {
  return withDatabase(db, () => db.select().from(batches).where(eq(batches.chamberId, "CH-1")).orderBy(asc(batches.batchCode)));
}

export function createBatch(db: Database, input: unknown) {
  const { scheduleId, ...values } = batchInputSchema.parse(input);
  return withDatabase(db, () => db.transaction(async (tx) => {
    const [batch] = await tx.insert(batches).values({ ...values, id: randomUUID(), chamberId: "CH-1" }).returning();
    const at = toIstIso(new Date().toISOString());
    if (scheduleId) await tx.insert(batchPolicySchedules).values({ batchId: batch.id, scheduleId, assignedAt: at });
    await tx.insert(auditLog).values({ id: randomUUID(), actor: "storage_operator", action: "batch_created", entity: "batch", entityId: batch.id, at, detail: JSON.stringify({ after: batch, ...(scheduleId ? { scheduleId } : {}) }) });
    return batch;
  }));
}

export function updateBatch(db: Database, id: string, input: unknown) {
  batchIdSchema.parse(id);
  const patch = batchPatchSchema.parse(input);
  return withDatabase(db, () => db.transaction(async (tx) => {
    const [before] = await tx.select().from(batches).where(and(eq(batches.id, id), eq(batches.chamberId, "CH-1")));
    if (!before) throw new InventoryError(404, "NOT_FOUND", "This batch could not be found.");
    const editable: BatchInput = { batchCode: before.batchCode, ownerName: before.ownerName, quantityKg: before.quantityKg, recordedValueInr: before.recordedValueInr, enteredAt: before.enteredAt, exitedAt: before.exitedAt };
    const values = batchInputSchema.parse({ ...editable, ...patch });
    const [after] = await tx.update(batches).set(values).where(eq(batches.id, id)).returning();
    await tx.insert(auditLog).values({ id: randomUUID(), actor: "storage_operator", action: "batch_updated", entity: "batch", entityId: id, at: toIstIso(new Date().toISOString()), detail: JSON.stringify({ before, after }) });
    return after;
  }));
}
