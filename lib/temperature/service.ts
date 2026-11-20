import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withDatabase } from "../db/access";
import type { Database } from "../db/client";
import { auditLog, chambers, temperatureReadings, thresholds } from "../db/schema";
import { toIstIso } from "../inventory/format";
import { CsvError, type CsvReading } from "./csv";

export function importReadings(db: Database, readings: CsvReading[]) {
  return withDatabase(db, () => db.transaction(async (tx) => {
    const existing = await tx.select({ recordedAt: temperatureReadings.recordedAt }).from(temperatureReadings).where(eq(temperatureReadings.chamberId, "CH-1"));
    const instants = new Set(existing.map((reading) => Date.parse(reading.recordedAt)));
    const conflicts = readings.filter((reading) => instants.has(Date.parse(reading.recordedAt)));
    if (conflicts.length) throw new CsvError(409, "TIMESTAMP_CONFLICT", "No readings imported. Some timestamps already exist in CH-1; existing records were preserved.", conflicts.slice(0, 20).map((reading) => ({ row: reading.row, message: `A reading already exists at ${reading.recordedAt}.` })));
    const importId = randomUUID();
    for (let offset = 0; offset < readings.length; offset += 100) {
      await tx.insert(temperatureReadings).values(readings.slice(offset, offset + 100).map((reading) => ({ id: randomUUID(), chamberId: "CH-1", scenarioId: null, recordedAt: reading.recordedAt, temperatureC: reading.temperatureC })));
    }
    const result = { importId, inserted: readings.length, firstAt: readings[0].recordedAt, lastAt: readings[readings.length - 1].recordedAt };
    await tx.insert(auditLog).values({ id: randomUUID(), actor: "storage_operator", action: "temperature_csv_imported", entity: "temperature_import", entityId: importId, at: toIstIso(new Date().toISOString()), detail: JSON.stringify({ chamberId: "CH-1", ...result }) });
    return result;
  }));
}

export function temperatureOverview(db: Database) {
  return withDatabase(db, async () => {
    const rows = await db.select({ id: temperatureReadings.id, recordedAt: temperatureReadings.recordedAt, temperatureC: temperatureReadings.temperatureC, scenarioId: temperatureReadings.scenarioId }).from(temperatureReadings).where(eq(temperatureReadings.chamberId, "CH-1"));
    rows.sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
    const [chamber] = await db.select().from(chambers).where(eq(chambers.id, "CH-1"));
    const [threshold] = await db.select().from(thresholds).where(eq(thresholds.id, 1));
    if (!chamber || !threshold) throw new Error("Temperature configuration is unavailable.");
    const settings = { normalMinC: chamber.normalMinC, normalMaxC: chamber.normalMaxC, abnormalAboveC: threshold.abnormalAboveC, maxGapMinutes: threshold.maxGapMinutes };
    return { readings: rows, settings, count: rows.length, firstAt: rows[0]?.recordedAt ?? null, lastAt: rows.at(-1)?.recordedAt ?? null, recent: rows.slice(-6).reverse() };
  });
}
export type TemperatureOverview = Awaited<ReturnType<typeof temperatureOverview>>;
