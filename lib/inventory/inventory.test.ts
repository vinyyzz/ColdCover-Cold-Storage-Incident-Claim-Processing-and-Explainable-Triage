import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeDatabase } from "../db/initialize";
import type { DatabaseConnection } from "../db/client";
import { auditLog, batches } from "../db/schema";
import { batchHandlers } from "./http";
import { formatInr, stockPresence, toIstInput } from "./format";

const base = { batchCode: "NEW", ownerName: "Fictional Test Owner", quantityKg: 25.5, recordedValueInr: 1250.25, enteredAt: "2026-03-10T03:00:00+05:30", exitedAt: null };
const request = (method: string, body: unknown) => new Request("http://coldcover.test/api/batches", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const lookupRequest = (at?: string) => new Request(`http://coldcover.test/api/batches${at === undefined ? "" : `?at=${encodeURIComponent(at)}`}`);

describe("Inventory API and persistence", () => {
  let directory: string;
  let connection: DatabaseConnection;
  let handlers: ReturnType<typeof batchHandlers>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "coldcover-inventory-"));
    connection = await initializeDatabase(pathToFileURL(join(directory, "test.db")).href);
    handlers = batchHandlers(async () => connection.db);
  });
  afterEach(() => { connection?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });

  it("lists stored records and looks up the worked-example stock at an equivalent UTC time", async () => {
    const response = await handlers.GET(lookupRequest("2026-03-09T21:30:00Z"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(result.at).toBe("2026-03-10T03:00:00+05:30");
    expect(result.batches.map((batch: { batchCode: string }) => batch.batchCode)).toEqual(["A", "B", "C"]);
    expect(result.presentBatchIds).toEqual(["demo-batch-a", "demo-batch-b"]);
  });

  it("creates normalized records, distinguishes zero from missing value, and audits the write", async () => {
    const response = await handlers.POST(request("POST", { ...base, batchCode: " new ", ownerName: " Fictional Test Owner ", recordedValueInr: 0, enteredAt: "2026-03-10T00:30:00Z" }));
    expect(response.status).toBe(201);
    const { batch } = await response.json();
    expect(batch).toMatchObject({ batchCode: "NEW", ownerName: "Fictional Test Owner", quantityKg: 25.5, recordedValueInr: 0, enteredAt: "2026-03-10T06:00:00+05:30", exitedAt: null, chamberId: "CH-1" });
    const [audit] = await connection.db.select().from(auditLog).where(eq(auditLog.entityId, batch.id));
    expect(audit.action).toBe("batch_created");
    expect(audit.at).toMatch(/\+05:30$/);
    expect(JSON.parse(audit.detail).after.recordedValueInr).toBe(0);
    const { batchCode: unusedCode, recordedValueInr: unusedValue, exitedAt: unusedExit, ...minimal } = base;
    void unusedCode; void unusedValue; void unusedExit;
    const missing = await handlers.POST(request("POST", { ...minimal, batchCode: "UNKNOWN" }));
    expect((await missing.json()).batch).toMatchObject({ recordedValueInr: null, exitedAt: null });
  });

  it("patches only supplied fields and audits before/after while allowing explicit null clearing", async () => {
    const created = await (await handlers.POST(request("POST", { ...base, exitedAt: "2026-03-10T04:00:00+05:30" }))).json();
    const response = await handlers.PATCH(request("PATCH", { ownerName: "Changed Fictional Owner" }), created.batch.id);
    expect(response.status).toBe(200);
    expect((await response.json()).batch).toMatchObject({ ownerName: "Changed Fictional Owner", quantityKg: 25.5, recordedValueInr: 1250.25, exitedAt: "2026-03-10T04:00:00+05:30" });
    const cleared = await handlers.PATCH(request("PATCH", { recordedValueInr: null, exitedAt: null }), created.batch.id);
    expect((await cleared.json()).batch).toMatchObject({ recordedValueInr: null, exitedAt: null });
    const audits = await connection.db.select().from(auditLog).where(eq(auditLog.entityId, created.batch.id));
    expect(audits).toHaveLength(3);
    expect(audits.some((row) => JSON.parse(row.detail).before?.ownerName === "Fictional Test Owner" && JSON.parse(row.detail).after?.ownerName === "Changed Fictional Owner")).toBe(true);
  });

  it("validates exit order against the stored entry when a PATCH supplies only one date", async () => {
    const { batch } = await (await handlers.POST(request("POST", { ...base, exitedAt: "2026-03-10T04:00:00+05:30" }))).json();
    const response = await handlers.PATCH(request("PATCH", { enteredAt: "2026-03-10T05:00:00+05:30" }), batch.id);
    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.exitedAt).toBeDefined();
    const [stored] = await connection.db.select().from(batches).where(eq(batches.id, batch.id));
    expect(stored.enteredAt).toBe(base.enteredAt);
    expect(await connection.db.select().from(auditLog).where(eq(auditLog.entityId, batch.id))).toHaveLength(1);
  });

  it("rejects duplicate codes on create and edit without adding audit entries", async () => {
    expect((await handlers.POST(request("POST", { ...base, batchCode: "a" }))).status).toBe(409);
    expect((await handlers.PATCH(request("PATCH", { batchCode: "A" }), "demo-batch-b")).status).toBe(409);
    expect(await connection.db.select().from(auditLog)).toHaveLength(1);
    expect((await connection.db.select().from(batches).where(eq(batches.id, "demo-batch-b")))[0].batchCode).toBe("B");
  });

  it.each([
    ["empty code", { batchCode: "  " }], ["empty owner", { ownerName: "" }],
    ["zero quantity", { quantityKg: 0 }], ["negative quantity", { quantityKg: -1 }],
    ["numeric string", { quantityKg: "25" }], ["negative value", { recordedValueInr: -1 }],
    ["fractional paise", { recordedValueInr: 1.001 }], ["unsafe value", { recordedValueInr: Number.MAX_SAFE_INTEGER }],
    ["missing timezone", { enteredAt: "2026-03-10T03:00:00" }],
    ["invalid calendar date", { enteredAt: "2026-02-30T03:00:00+05:30" }],
    ["exit before entry", { exitedAt: "2026-03-10T02:00:00+05:30" }],
    ["unknown chamber override", { chamberId: "CH-2" }],
  ])("rejects %s with structured errors and no mutation", async (_name, changes) => {
    const response = await handlers.POST(request("POST", { ...base, ...changes }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    expect(await connection.db.select().from(batches)).toHaveLength(3);
    expect(await connection.db.select().from(auditLog)).toHaveLength(1);
  });

  it("returns explicit errors for malformed JSON, empty patches, missing IDs, and invalid lookup times", async () => {
    const malformed = await handlers.POST(new Request("http://coldcover.test/api/batches", { method: "POST", body: "{" }));
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("INVALID_JSON");
    expect((await handlers.PATCH(request("PATCH", {}), "demo-batch-a")).status).toBe(400);
    expect((await handlers.PATCH(request("PATCH", { ownerName: "Fictional owner" }), "missing")).status).toBe(404);
    expect((await handlers.GET(lookupRequest("invalid"))).status).toBe(400);
  });

  it("includes exact entry and excludes exact exit, across offsets and millisecond storage precision", async () => {
    const { batch } = await (await handlers.POST(request("POST", { ...base, enteredAt: "2026-03-10T03:00:00.123+05:30", exitedAt: "2026-03-10T04:00:00+05:30" }))).json();
    const atEntry = await (await handlers.GET(lookupRequest("2026-03-09T21:30:00.123Z"))).json();
    const before = await (await handlers.GET(lookupRequest("2026-03-10T03:00:00.122+05:30"))).json();
    const atExit = await (await handlers.GET(lookupRequest("2026-03-10T04:00:00+05:30"))).json();
    expect(atEntry.presentBatchIds).toContain(batch.id);
    expect(before.presentBatchIds).not.toContain(batch.id);
    expect(atExit.presentBatchIds).not.toContain(batch.id);
    expect(toIstInput(batch.enteredAt)).toBe("2026-03-10T03:00:00.123");
  });

  it("serializes concurrent reads/writes and recovers after a duplicate request", async () => {
    const responses = await Promise.all([handlers.POST(request("POST", base)), handlers.GET(lookupRequest()), handlers.POST(request("POST", base))]);
    expect(responses.map((response) => response.status)).toEqual([201, 200, 409]);
    expect((await handlers.GET(lookupRequest())).status).toBe(200);
    expect(await connection.db.select().from(batches).where(eq(batches.batchCode, "NEW"))).toHaveLength(1);
  });

  it("rolls back a batch when the paired audit write fails and hides internal SQL details", async () => {
    await connection.client.execute("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log WHEN NEW.action='batch_created' BEGIN SELECT RAISE(ABORT, 'private fixture detail'); END");
    const response = await handlers.POST(request("POST", base));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("private fixture detail");
    expect(text).not.toContain("INSERT");
    expect(await connection.db.select().from(batches).where(eq(batches.batchCode, "NEW"))).toHaveLength(0);
  });
});

describe("Inventory display and lookup helpers", () => {
  it("formats Indian currency without treating missing values as zero", () => {
    expect(formatInr(150000)).toBe("₹1,50,000");
    expect(formatInr(0)).toBe("₹0");
    expect(formatInr(1250.25)).toBe("₹1,250.25");
  });
  it("uses half-open storage and rejects invalid lookup instants", () => {
    const batch = { enteredAt: base.enteredAt, exitedAt: "2026-03-10T04:00:00+05:30" };
    expect(stockPresence(batch, base.enteredAt)).toBe("present");
    expect(stockPresence(batch, batch.exitedAt)).toBe("departed");
    expect(stockPresence(batch, "2026-03-10T02:59:59+05:30")).toBe("not_entered");
    expect(() => stockPresence(batch, "invalid")).toThrow();
  });
});
