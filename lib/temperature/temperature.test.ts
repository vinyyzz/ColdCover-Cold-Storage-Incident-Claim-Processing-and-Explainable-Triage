import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseConnection } from "../db/client";
import { initializeDatabase } from "../db/initialize";
import { auditLog, chambers, temperatureReadings, thresholds } from "../db/schema";
import { CsvError, MAX_CSV_BYTES, parseTemperatureCsv, SAMPLE_CSV } from "./csv";
import { temperatureUploadHandler } from "./http";
import { temperatureOverview } from "./service";
import { GET as sampleDownload } from "../../app/api/temperature/sample/route";

const header = "timestamp,temperature_c\n";
const request = (body: BodyInit, headers: HeadersInit = { "Content-Type": "text/csv" }) => new Request("http://coldcover.test/api/temperature/upload", { method: "POST", headers, body, duplex: "half" } as RequestInit);
const series = (count: number) => header + Array.from({ length: count }, (_, i) => `${new Date(Date.UTC(2026, 2, 11) + i * 60000).toISOString()},3.1`).join("\n");

describe("Temperature CSV validation", () => {
  it("accepts BOM, reordered quoted columns, CRLF, finite signed/decimal/exponent values and normalizes instants", () => {
    expect(parseTemperatureCsv('\uFEFF"temperature_c",timestamp\r\n-1.2,2026-03-10T18:30:00Z\r\n3e0,2026-03-11T00:10:00+05:30\r\n\r\n')).toEqual([
      { row: 2, recordedAt: "2026-03-11T00:00:00+05:30", temperatureC: -1.2 },
      { row: 3, recordedAt: "2026-03-11T00:10:00+05:30", temperatureC: 3 },
    ]);
  });
  it.each([
    ["wrong columns", "time,temperature_c\n2026-03-11T00:00:00Z,3"],
    ["duplicate column", "timestamp,timestamp\n2026-03-11T00:00:00Z,3"],
    ["extra column", "timestamp,temperature_c,owner\n2026-03-11T00:00:00Z,3,a"],
    ["no data", header],
    ["missing cell", header + "2026-03-11T00:00:00Z"],
    ["interior blank row", SAMPLE_CSV.replace("2026-03-11T00:10", "\n2026-03-11T00:10")],
    ["invalid quoting", header + '"2026-03-11T00:00:00Z,3'],
    ["characters after quote", header + '"2026-03-11T00:00:00Z"x,3'],
    ["missing timezone", header + "2026-03-11T00:00:00,3"],
    ["invalid calendar date", header + "2026-02-30T00:00:00Z,3"],
    ["submillisecond precision", header + "2026-03-11T00:00:00.0001Z,3"],
    ["blank temperature", header + "2026-03-11T00:00:00Z,"],
    ["NaN", header + "2026-03-11T00:00:00Z,NaN"],
    ["Infinity", header + "2026-03-11T00:00:00Z,Infinity"],
    ["overflow", header + "2026-03-11T00:00:00Z,1e999"],
    ["hexadecimal", header + "2026-03-11T00:00:00Z,0x10"],
    ["text", header + "2026-03-11T00:00:00Z,3C"],
    ["unsorted instants", header + "2026-03-11T00:10:00Z,3\n2026-03-11T00:00:00Z,3"],
    ["equivalent-offset duplicates", header + "2026-03-10T18:30:00.000Z,3\n2026-03-11T00:00:00+05:30,4"],
  ])("rejects %s", (_name, text) => { expect(() => parseTemperatureCsv(text)).toThrow(CsvError); });
  it("accepts exactly 20,000 readings and rejects 20,001", () => {
    expect(parseTemperatureCsv(series(20_000))).toHaveLength(20_000);
    expect(() => parseTemperatureCsv(series(20_001))).toThrow("at most 20,000");
  });
  it("caps row errors with original CSV line numbers and enforces byte size", () => {
    try { parseTemperatureCsv(header + Array.from({ length: 25 }, () => "bad,NaN").join("\n")); throw new Error("Expected failure"); }
    catch (error) { expect(error).toBeInstanceOf(CsvError); expect((error as CsvError).issues).toHaveLength(20); expect((error as CsvError).issues[0].row).toBe(2); }
    expect(() => parseTemperatureCsv("x".repeat(MAX_CSV_BYTES + 1))).toThrow("2 MiB");
  });
  it("downloads a named CSV that passes validation and follows the seed day", async () => {
    const response = sampleDownload();
    expect(response.headers.get("content-disposition")).toContain('filename="coldcover-temperature-sample.csv"');
    expect(parseTemperatureCsv(await response.text())).toHaveLength(3);
  });
});

describe("Temperature upload API and atomic persistence", () => {
  let directory: string, connection: DatabaseConnection;
  let upload: ReturnType<typeof temperatureUploadHandler>;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "coldcover-temperature-"));
    connection = await initializeDatabase(pathToFileURL(join(directory, "test.db")).href);
    upload = temperatureUploadHandler(async () => connection.db);
  });
  afterEach(() => { connection.close(); rmSync(directory, { recursive: true, force: true }); });
  const counts = async (db: DatabaseConnection["db"]) => ({ readings: (await db.select().from(temperatureReadings)).length, audits: (await db.select().from(auditLog)).length });
  it("appends with null scenario and one audit; repeated upload rejects without changing anything", async () => {
    const response = await upload(request(SAMPLE_CSV));
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result).toMatchObject({ inserted: 3, firstAt: "2026-03-11T00:00:00+05:30", lastAt: "2026-03-11T00:20:00+05:30" });
    const audits = await connection.db.select().from(auditLog).where(eq(auditLog.entityId, result.importId));
    expect(audits).toHaveLength(1); expect(JSON.parse(audits[0].detail).inserted).toBe(3);
    expect(await counts(connection.db)).toEqual({ readings: 147, audits: 2 });
    expect((await temperatureOverview(connection.db)).recent[0]).toMatchObject({ scenarioId: null, temperatureC: 3.2 });
    const again = await upload(request(SAMPLE_CSV));
    expect(again.status).toBe(409); expect((await again.json()).error.issues[0].row).toBe(2);
    expect(await counts(connection.db)).toEqual({ readings: 147, audits: 2 });
  });
  it("rejects a mixed new/existing file atomically, including legacy .000 timestamp aliases", async () => {
    const [seed] = await connection.db.select().from(temperatureReadings).limit(1);
    await connection.db.update(temperatureReadings).set({ recordedAt: new Date(seed.recordedAt).toISOString() }).where(eq(temperatureReadings.id, seed.id));
    const response = await upload(request(header + `${seed.recordedAt},99\n2026-03-12T00:00:00Z,3`));
    expect(response.status).toBe(409);
    expect(await counts(connection.db)).toEqual({ readings: 144, audits: 1 });
    expect((await connection.db.select().from(temperatureReadings).where(eq(temperatureReadings.id, seed.id)))[0].temperatureC).toBe(seed.temperatureC);
  });
  it("validates every row before touching the database", async () => {
    const getDb = vi.fn(async () => connection.db);
    const response = await temperatureUploadHandler(getDb)(request(SAMPLE_CSV + "2026-03-12T00:00:00Z,NaN\n"));
    expect(response.status).toBe(400); expect(getDb).not.toHaveBeenCalled();
    expect((await response.json()).error.issues[0].row).toBe(5);
  });
  it("rejects unsupported content type and invalid UTF-8 without DB access", async () => {
    const getDb = vi.fn(async () => connection.db), handler = temperatureUploadHandler(getDb);
    expect((await handler(request(SAMPLE_CSV, { "Content-Type": "application/json" }))).status).toBe(415);
    const response = await handler(request(new Uint8Array([0xc3, 0x28])));
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe("INVALID_ENCODING");
    expect(getDb).not.toHaveBeenCalled();
  });
  it("enforces streamed byte size even with a misleading Content-Length", async () => {
    const getDb = vi.fn(async () => connection.db);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_CSV_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
    const response = await temperatureUploadHandler(getDb)(request(stream, { "Content-Type": "text/csv", "Content-Length": "1" }));
    expect(response.status).toBe(413); expect(getDb).not.toHaveBeenCalled();
  });
  it("chunks large inserts while retaining all rows and one audit", async () => {
    const response = await upload(request(series(205)));
    expect(response.status).toBe(201); expect((await response.json()).inserted).toBe(205);
    expect(await counts(connection.db)).toEqual({ readings: 349, audits: 2 });
  });
  it("rolls back all chunks when the audit insert fails and hides database details", async () => {
    await connection.db.run(sql`CREATE TRIGGER reject_temperature_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'temperature_csv_imported' BEGIN SELECT RAISE(ABORT, 'private audit failure'); END`);
    const response = await upload(request(series(205)));
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("private audit failure");
    expect(await counts(connection.db)).toEqual({ readings: 144, audits: 1 });
  });
  it("loads chart readings in instant order with database configuration and exact values", async () => {
    await connection.db.update(chambers).set({ normalMinC: 1, normalMaxC: 4 }).where(eq(chambers.id, "CH-1"));
    await connection.db.update(thresholds).set({ abnormalAboveC: 4.5, maxGapMinutes: 25 }).where(eq(thresholds.id, 1));
    await upload(request(SAMPLE_CSV));
    const overview = await temperatureOverview(connection.db);
    expect(overview.settings).toEqual({ normalMinC: 1, normalMaxC: 4, abnormalAboveC: 4.5, maxGapMinutes: 25 });
    expect(overview.readings).toHaveLength(147); expect(overview.readings[146]).toMatchObject({ scenarioId: null, temperatureC: 3.2 });
    expect(overview.readings.every((row, i, all) => i === 0 || Date.parse(all[i - 1].recordedAt) < Date.parse(row.recordedAt))).toBe(true);
  });
  it("returns an explicit empty chart dataset without inventing records", async () => {
    await connection.db.delete(temperatureReadings);
    expect(await temperatureOverview(connection.db)).toMatchObject({ readings: [], recent: [], count: 0, firstAt: null, lastAt: null });
  });
  it("serializes overlapping duplicate imports so only one succeeds", async () => {
    const responses = await Promise.all([upload(request(SAMPLE_CSV)), upload(request(SAMPLE_CSV))]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await counts(connection.db)).toEqual({ readings: 147, audits: 2 });
  });
});
