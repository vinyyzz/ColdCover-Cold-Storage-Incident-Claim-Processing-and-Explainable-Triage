import "server-only";
import { createClient } from "@libsql/client/node";
import { eq, getTableColumns, getTableName, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import type { Database } from "../db/client";
import { applyMigrations } from "../db/migrate";
import * as t from "../db/schema";
import { readDocumentCorrections } from "../documents/correction-history";
import { readCopyProvenance } from "../documents/copy-history";
import { readIncident } from "../incidents/service";
import { MAX_PACKET_BYTES, sourceTableSchema, type FrozenPacket } from "./contract";

export type ClaimTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const tables = [t.chambers, t.equipment, t.thresholds, t.policies, t.scenarios, t.batches, t.temperatureReadings, t.incidents, t.analysisRuns, t.analysisIncidentLinks, t.documents, t.incidentEvents, t.documentCorrections, t.documentCopies];
const inventory = tables.map((table) => ({ name: getTableName(table), columns: Object.values(getTableColumns(table)).map((column) => column.name) }));
export function validateSources(sources: FrozenPacket["sources"]) {
  let rows = 0;
  if (sources.length !== inventory.length || sources.some((table, index) => table.name !== inventory[index].name || JSON.stringify(table.columns) !== JSON.stringify(inventory[index].columns) || table.rows.some((row) => row.length !== table.columns.length))) throw new Error("Unsupported frozen source layout");
  for (const table of sources) rows += table.rows.length;
  if (rows > 250_000 || Buffer.byteLength(JSON.stringify(sources), "utf8") > MAX_PACKET_BYTES) throw new Error("Frozen sources exceed supported limits");
}
export async function captureSources(tx: ClaimTransaction): Promise<FrozenPacket["sources"]> {
  let rows = 0, bytes = 0;
  const result: FrozenPacket["sources"] = [];
  for (const table of inventory) {
    const [count] = await tx.all<{ count: number }>(sql`SELECT count(*) AS count FROM ${sql.identifier(table.name)}`);
    rows += count.count;
    if (rows > 250_000) throw new Error("Frozen sources exceed supported limits");
    // The legacy potato workflow excludes batches explicitly assigned to other
    // commodities. Archive that same inventory so frozen reads use the v1 layout.
    const records = await tx.all<Record<string, unknown>>(table.name === "batches"
      ? sql`SELECT b.* FROM batches b LEFT JOIN batch_policy_schedules p ON p.batch_id=b.id WHERE p.schedule_id IS NULL OR p.schedule_id='potato' ORDER BY b.id`
      : sql`SELECT * FROM ${sql.identifier(table.name)} ORDER BY ${sql.identifier(table.columns[0])}`);
    const parsed = sourceTableSchema.parse({ ...table, rows: records.map((row) => table.columns.map((column) => row[column])) });
    bytes += Buffer.byteLength(JSON.stringify(parsed), "utf8");
    if (bytes > MAX_PACKET_BYTES) throw new Error("Frozen sources exceed supported limits");
    result.push(parsed);
  }
  return result;
}
/** Reuse the verified readers against detached, fixed-layout evidence only. No operator DB or seed. */
export async function readFrozenSources(packet: FrozenPacket) {
  validateSources(packet.sources);
  const client = createClient({ url: ":memory:", concurrency: 1 });
  try {
    await client.execute("PRAGMA foreign_keys=ON");
    const db = drizzle(client, { schema: t });
    await applyMigrations(db);
    return await db.transaction(async (tx) => {
      await tx.run(sql`PRAGMA defer_foreign_keys=ON`);
      for (const table of packet.sources) for (let start = 0; start < table.rows.length; start += 50) {
        const rows = table.rows.slice(start, start + 50).map((row) => sql`(${sql.join(row.map((value) => sql`${value}`), sql`,`)})`);
        await tx.run(sql`INSERT INTO ${sql.identifier(table.name)} (${sql.join(table.columns.map((column) => sql.identifier(column)), sql`,`)}) VALUES ${sql.join(rows, sql`,`)}`);
      }
      if ((await tx.all(sql`PRAGMA foreign_key_check`)).length) throw new Error("Invalid frozen source references");
      const data = await readIncident(tx, packet.incidentId, packet.analysisId);
      const copySources: { document: typeof t.documents.$inferSelect; corrections: Awaited<ReturnType<typeof readDocumentCorrections>>; copy: Awaited<ReturnType<typeof readCopyProvenance>> }[] = [];
      const seen = new Set(data.documents.map((doc) => doc.id));
      for (const target of data.documents) {
        let copy = data.documentCopies[target.id];
        while (copy) {
          const sourceId = copy.sourceDocumentId;
          if (seen.has(sourceId)) break;
          seen.add(sourceId);
          const [document] = await tx.select().from(t.documents).where(eq(t.documents.id, sourceId));
          if (!document) throw new Error("Frozen ancestor unavailable");
          const corrections = await readDocumentCorrections(tx, document, null);
          copy = await readCopyProvenance(tx, document);
          copySources.push({ document, corrections, copy });
        }
      }
      return { data, copySources };
    });
  } finally { client.close(); }
}
