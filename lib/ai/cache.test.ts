import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDatabase } from "../db/access";
import { openDatabase, type DatabaseConnection } from "../db/client";
import { initializeDatabase } from "../db/initialize";
import { applyMigrations } from "../db/migrate";
import { seedDatabase } from "../db/seed";
import * as t from "../db/schema";
import { createDatabaseAiCache } from "./cache";
import { fallbackOutput } from "./contract";
import { extractionInput, questionsInput, summaryInput } from "./fixtures.test-support";
import { cacheIdentity, runAiTask, type AiAdapter } from "./runner";

vi.mock("server-only", () => ({}));
describe("Disposable database AI cache", () => {
  let dir: string, connection: DatabaseConnection;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "coldcover-ai-cache-"));
    connection = await initializeDatabase(pathToFileURL(join(dir, "cache.db")).href);
  });
  afterEach(() => { connection?.close(); rmSync(dir, { recursive: true, force: true }); });
  async function domainRows(conn = connection) {
    const names = await conn.client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('ai_result_cache','demo_backups','demo_operations','__drizzle_migrations') ORDER BY name");
    const rows: Record<string, unknown> = {};
    for (const { name } of names.rows) rows[String(name)] = (await conn.client.execute(`SELECT * FROM "${name}" ORDER BY 1`)).rows;
    return rows;
  }
  it("persists validated results for all three tasks and reuses them after reopening", async () => {
    const cache = createDatabaseAiCache(connection.db);
    for (const input of [extractionInput(), summaryInput(), questionsInput()]) {
      const mock: AiAdapter = { revision: "mock", generate: vi.fn(async () => fallbackOutput(input).output) };
      expect(await runAiTask(input, { adapter: mock, cache })).toMatchObject({ mode: "ai", cache: "miss", attempts: 1 });
      expect(await runAiTask(input, { adapter: mock, cache })).toMatchObject({ mode: "ai", cache: "hit", attempts: 0 });
      expect(mock.generate).toHaveBeenCalledTimes(1);
    }
    connection.close(); connection = await openDatabase(pathToFileURL(join(dir, "cache.db")).href);
    const input = extractionInput(), mock: AiAdapter = { revision: "mock", generate: vi.fn() };
    expect(await runAiTask(input, { adapter: mock, cache: createDatabaseAiCache(connection.db) })).toMatchObject({ mode: "ai", cache: "hit", ...fallbackOutput(input) });
    expect(mock.generate).not.toHaveBeenCalled(); expect(await connection.db.select().from(t.aiResultCache)).toHaveLength(3);
    const [row] = await connection.db.select().from(t.aiResultCache);
    expect(row.createdAt).toMatch(/\+05:30$/); expect(Object.keys(row)).not.toContain("rawText");
  });
  it("does not overwrite any of the 21 domain tables, including prepared packets/reviews", async () => {
    await connection.db.insert(t.claims).values({ id: "claim", incidentId: "demo-incident-01", policyId: "coldcover-demo-policy", readiness: "Needs more evidence", priority: "Standard priority", triageReasonsJson: [], exposureValueInr: 80000, summaryJson: [{ text: "Immutable prior packet", source_ids: ["prior"] }], missingEvidenceJson: [], createdAt: "2026-03-10T08:00:00+05:30" });
    await connection.db.insert(t.reviewDecisions).values({ id: "review", claimId: "claim", reviewerName: "Fictional reviewer", status: "closed", comment: "Keep intact", decidedAt: "2026-03-10T08:00:00+05:30" });
    const before = await domainRows(), input = summaryInput(), cache = createDatabaseAiCache(connection.db);
    await runAiTask(input, { cache, adapter: { revision: "mock", async generate() { return fallbackOutput(input).output; } } });
    expect(await domainRows()).toEqual(before); expect(Object.keys(before)).toHaveLength(21);
  });
  it.each(["metadata", "citation", "JSON", "timestamp"])("rejects corrupt %s cache rows and repairs them with supported output", async (kind) => {
    const input = summaryInput(), cache = createDatabaseAiCache(connection.db), identity = cacheIdentity(input, "mock");
    await cache.put(identity, fallbackOutput(input).output);
    if (kind === "metadata") await connection.db.update(t.aiResultCache).set({ inputFingerprint: "0".repeat(64) });
    if (kind === "citation") await connection.db.update(t.aiResultCache).set({ outputJson: [{ text: "Unsupported", source_ids: ["foreign"] }] });
    if (kind === "JSON") await connection.client.execute("UPDATE ai_result_cache SET output_json = '{'");
    if (kind === "timestamp") await connection.db.update(t.aiResultCache).set({ createdAt: "invalid" });
    const mock: AiAdapter = { revision: "mock", generate: vi.fn(async () => fallbackOutput(input).output) };
    expect(await runAiTask(input, { cache, adapter: mock })).toMatchObject({ mode: "ai", attempts: 1 });
    expect(mock.generate).toHaveBeenCalledTimes(1);
    expect(await cache.get(identity)).toEqual(fallbackOutput(input).output);
  });
  it("does not hold the connection queue across adapter calls", async () => {
    const input = summaryInput(), cache = createDatabaseAiCache(connection.db);
    const result = await runAiTask(input, { cache, timeoutMs: 1000, adapter: { revision: "mock", async generate() {
      const rows = await withDatabase(connection.db, () => connection.db.select().from(t.batches));
      expect(rows).toHaveLength(3); return fallbackOutput(input).output;
    } } });
    expect(result.mode).toBe("ai");
  });
  it("shares one in-flight request across cache getters for the same connection", async () => {
    const input = summaryInput(), mock: AiAdapter = { revision: "mock", generate: vi.fn(async () => fallbackOutput(input).output) };
    const [first, second] = await Promise.all([
      runAiTask(input, { adapter: mock, cache: createDatabaseAiCache(connection.db) }),
      runAiTask(input, { adapter: mock, cache: createDatabaseAiCache(connection.db) }),
    ]);
    expect(first.output).toEqual(second.output); expect(mock.generate).toHaveBeenCalledTimes(1);
    expect(await connection.db.select().from(t.aiResultCache)).toHaveLength(1);
  });
  it("rejects malformed cache identities/output before writing", async () => {
    const cache = createDatabaseAiCache(connection.db), identity = cacheIdentity(summaryInput(), "mock");
    await expect(cache.put({ ...identity, key: "bad" }, [])).rejects.toThrow();
    await expect(cache.put(identity, [{ text: "Unsupported", source_ids: [] }])).rejects.toThrow();
    expect(await connection.db.select().from(t.aiResultCache)).toEqual([]);
  });
  it("upgrades a populated four-migration database, preserving every domain row and migration idempotency", async () => {
    const folder = join(dir, "legacy-migrations"); mkdirSync(join(folder, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 4) }));
    for (const entry of journal.entries.slice(0, 4)) writeFileSync(join(folder, `${entry.tag}.sql`), readFileSync(`drizzle/${entry.tag}.sql`));
    const legacy = await openDatabase(pathToFileURL(join(dir, "legacy.db")).href);
    try {
      await migrate(legacy.db, { migrationsFolder: folder }); await seedDatabase(legacy.db);
      await legacy.db.update(t.documents).set({ rawText: "Preserve operator text during additive cache upgrade" });
      await legacy.db.update(t.batches).set({ recordedValueInr: null }).where(eq(t.batches.id, "demo-batch-a"));
      const before = await domainRows(legacy); await applyMigrations(legacy.db); await applyMigrations(legacy.db);
      expect(await domainRows(legacy)).toEqual({ ...before, claim_packets: [], batch_policy_schedules: [], policy_case_packets: [], policy_case_reviews: [] }); expect(await legacy.db.select().from(t.aiResultCache)).toEqual([]);
      expect((await legacy.client.execute("SELECT count(*) AS count FROM __drizzle_migrations")).rows[0].count).toBe(8);
      expect((await legacy.client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
      expect((await legacy.client.execute("PRAGMA integrity_check")).rows[0].integrity_check).toBe("ok");
    } finally { legacy.close(); }
  });
});
