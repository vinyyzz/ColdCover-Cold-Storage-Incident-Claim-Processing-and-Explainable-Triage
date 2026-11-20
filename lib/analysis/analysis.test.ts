import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DatabaseConnection } from "../db/client";
import { initializeDatabase } from "../db/initialize";
import * as t from "../db/schema";
import { seedDatabase } from "../db/seed";
import { scenarioCatalog } from "../demo/scenarios/catalog";
import { analysisHandlers } from "./http";
import { analysisResponseSchema } from "./contract";
import { analyzeStoredLog } from "./service";

type Result = Awaited<ReturnType<typeof analyzeStoredLog>>;
const post = (body?: unknown) => new Request("http://coldcover.test/api/analyze", { method: "POST", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });

describe("Stored-log analysis API, revisions and evidence protection", () => {
  let directory: string, url: string;
  let connection: DatabaseConnection;
  let handlers: ReturnType<typeof analysisHandlers>;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "coldcover-analysis-"));
    url = pathToFileURL(join(directory, "test.db")).href;
    connection = await initializeDatabase(url);
    handlers = analysisHandlers(async () => connection.db);
  });
  afterEach(() => { connection?.close(); rmSync(directory, { recursive: true, force: true }); });
  async function analyze() {
    const response = await handlers.POST(post());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result: unknown = await response.json();
    expect(analysisResponseSchema.safeParse(result).success).toBe(true);
    return result as Result;
  }
  async function counts() {
    const result: Record<string, number> = {};
    for (const name of ["analysis_runs", "analysis_incident_links", "incidents", "incident_events", "audit_log", "documents", "claims", "review_decisions"]) {
      const rows = await connection.client.execute(`SELECT count(*) AS n FROM ${name}`);
      result[name] = Number(rows.rows[0].n);
    }
    return result;
  }

  it("reads an explicit unanalysed state without creating incidents or snapshots", async () => {
    const before = await counts();
    const response = await handlers.GET();
    expect(await response.json()).toEqual({ status: "not_analyzed", analysis: null, incidents: [] });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await counts()).toEqual(before);
  });

  it("persists calculated worked-example evidence without assigning its seeded report or reading oracles", async () => {
    await connection.db.update(t.scenarios).set({ expectedJson: { exposureValueInr: 999, abnormalIntervals: [] } });
    const originalDocuments = await connection.db.select().from(t.documents);
    const result = await analyze();
    expect(result).toMatchObject({ status: "current", reused: false, mode: "stored_log", claimPacketsUpdated: false, analysis: { revision: 1 } });
    expect(result.analysis.temperature.abnormalIntervals).toHaveLength(1);
    expect(result.analysis.temperature.abnormalIntervals[0]).toMatchObject({ start: "2026-03-10T01:20:00+05:30", end: "2026-03-10T05:40:00+05:30", durationMinutes: 260 });
    expect(result.analysis.exposures[0]).toMatchObject({ knownValueSubtotalPaise: 8_000_000, knownValueSubtotalInrExact: "80000.00", valuationComplete: true });
    expect(result.analysis.exposures[0].batches.map((batch) => [batch.batchCode, batch.classification])).toEqual([["A", "present_throughout"], ["B", "present_throughout"], ["C", "not_present"]]);
    expect(result.analysis.inputs.readings).toHaveLength(144);
    expect(result.analysis.inputs).not.toHaveProperty("expected");
    expect(result.incidents[0].incidentId).not.toBe("demo-incident-01");
    expect(await connection.db.select().from(t.documents)).toEqual(originalDocuments);
    expect((await connection.db.select().from(t.incidents).where(eq(t.incidents.id, "demo-incident-01")))[0].abnormalStart).toBeNull();
    const events = await connection.db.select().from(t.incidentEvents).where(eq(t.incidentEvents.incidentId, result.incidents[0].incidentId));
    expect(events.map((event) => [event.eventType, event.sourceRef]).sort()).toEqual([["abnormal_end", "worked-example-reading-034"], ["abnormal_start", "worked-example-reading-008"]]);
    const audit = (await connection.db.select().from(t.auditLog).where(eq(t.auditLog.entityId, result.analysis.id)))[0];
    expect(audit).toMatchObject({ action: "stored_log_analyzed", actor: "storage_operator" });
    expect(JSON.parse(audit.detail)).toMatchObject({ createdIncidentIds: [result.incidents[0].incidentId], previousAnalysisId: null });
    expect(await counts()).toMatchObject({ analysis_runs: 1, analysis_incident_links: 1, incidents: 2, incident_events: 3, audit_log: 2, claims: 0, review_decisions: 0 });
  });

  it("reuses an unchanged revision without duplicating incidents, events or audit records", async () => {
    const first = await analyze(), before = await counts();
    const second = await (await handlers.POST(post({}))).json();
    expect(second).toEqual({ ...first, reused: true });
    expect(await (await handlers.GET()).json()).toEqual(second);
    expect(await counts()).toEqual(before);
  });

  it("serializes concurrent requests on one connection into one committed revision", async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => handlers.POST(post())));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const results: Result[] = await Promise.all(responses.map((response) => response.json()));
    expect(new Set(results.map((result) => result.analysis.id)).size).toBe(1);
    expect(results.filter((result) => !result.reused)).toHaveLength(1);
    expect(await counts()).toMatchObject({ analysis_runs: 1, incidents: 2, audit_log: 2 });
  });

  it("handles a competing connection without duplicate revisions and permits a safe retry", async () => {
    const other = await openDatabase(url);
    try {
      // The native SQLite busy wait blocks this worker's event loop; keep the
      // deliberate competing-writer failure bounded, then exercise retry.
      await other.client.execute("PRAGMA busy_timeout = 50");
      await connection.client.execute("PRAGMA busy_timeout = 50");
      const otherHandlers = analysisHandlers(async () => other.db);
      const responses = await Promise.all([handlers.POST(post()), otherHandlers.POST(post())]);
      expect(responses.every((response) => [200, 409].includes(response.status))).toBe(true);
      expect(responses.some((response) => response.status === 200)).toBe(true);
      const repeat = await analyze();
      expect(repeat.reused).toBe(true);
      expect(await counts()).toMatchObject({ analysis_runs: 1, incidents: 2, audit_log: 2 });
    } finally { other.close(); }
  });

  it("marks changed inventory stale and retains documents, a decided claim, reviewer and operator events", async () => {
    const first = await analyze(), incidentId = first.incidents[0].incidentId;
    const at = "2026-03-10T10:00:00+05:30";
    await connection.db.update(t.incidents).set({ status: "decided", title: "Operator title" }).where(eq(t.incidents.id, incidentId));
    await connection.db.insert(t.documents).values({ id: "operator-document", incidentId, docType: "other", filename: "note.txt", rawText: "Fictional operator note", uploadedAt: at });
    await connection.db.insert(t.incidentEvents).values({ id: "operator-event", incidentId, occurredAt: at, eventType: "inspection", description: "Recorded operator observation", sourceType: "document", sourceRef: "operator-document" });
    const [policy] = await connection.db.select().from(t.policies);
    await connection.db.insert(t.claims).values({ id: "protected-claim", incidentId, policyId: policy.id, readiness: "Needs more evidence", priority: "Standard priority", triageReasonsJson: [], exposureValueInr: 80000, summaryJson: [], missingEvidenceJson: [], createdAt: at });
    await connection.db.insert(t.reviewDecisions).values({ id: "protected-review", claimId: "protected-claim", reviewerName: "Fictional reviewer", status: "closed", comment: "Fictional review", decidedAt: at });
    const protectedRows = { documents: await connection.db.select().from(t.documents), claims: await connection.db.select().from(t.claims), reviews: await connection.db.select().from(t.reviewDecisions), events: await connection.db.select().from(t.incidentEvents).where(eq(t.incidentEvents.incidentId, incidentId)), incident: await connection.db.select().from(t.incidents).where(eq(t.incidents.id, incidentId)) };
    await connection.db.update(t.batches).set({ recordedValueInr: null }).where(eq(t.batches.id, "demo-batch-b"));
    expect((await (await handlers.GET()).json()).status).toBe("stale");
    const next = await analyze();
    expect(next.analysis.revision).toBe(2);
    expect(next.analysis.exposures[0]).toMatchObject({ knownValueSubtotalInrExact: "50000.00", valuationComplete: false, missingValuationBatchIds: ["demo-batch-b"] });
    expect(next.incidents[0].incidentId).not.toBe(incidentId);
    expect(next.analysis.reconciliation).toMatchObject({ previousAnalysisId: first.analysis.id, retainedPreviousIncidentIds: [incidentId], reusedIncidentIds: [] });
    expect({ documents: await connection.db.select().from(t.documents), claims: await connection.db.select().from(t.claims), reviews: await connection.db.select().from(t.reviewDecisions), events: await connection.db.select().from(t.incidentEvents).where(eq(t.incidentEvents.incidentId, incidentId)), incident: await connection.db.select().from(t.incidents).where(eq(t.incidents.id, incidentId)) }).toEqual(protectedRows);
    expect((await connection.db.select().from(t.analysisRuns).where(eq(t.analysisRuns.id, first.analysis.id)))[0].snapshotJson.exposures[0].knownValueSubtotalInrExact).toBe("80000.00");
  });

  it("versions a changed supporting value even when interval endpoints stay the same", async () => {
    const first = await analyze();
    await connection.db.update(t.temperatureReadings).set({ temperatureC: 9 }).where(eq(t.temperatureReadings.id, "worked-example-reading-009"));
    const next = await analyze();
    expect(next.analysis.temperature).toEqual(first.analysis.temperature);
    expect(next.incidents[0].incidentId).not.toBe(first.incidents[0].incidentId);
    expect(first.analysis.inputs.readings[9].temperatureC).not.toBe(9);
    expect(next.analysis.inputs.readings[9].temperatureC).toBe(9);
  });

  it("reuses unchanged incident evidence when unrelated normal readings are appended", async () => {
    const first = await analyze();
    await connection.db.insert(t.temperatureReadings).values({ id: "new-normal", chamberId: "CH-1", recordedAt: "2026-03-11T00:00:00+05:30", temperatureC: 3 });
    const next = await analyze();
    expect(next.analysis.revision).toBe(2);
    expect(next.incidents).toEqual(first.incidents);
    expect(next.analysis.reconciliation).toMatchObject({ createdIncidentIds: [], reusedIncidentIds: [first.incidents[0].incidentId], retainedPreviousIncidentIds: [] });
    expect(await counts()).toMatchObject({ analysis_runs: 2, incidents: 2, incident_events: 3, audit_log: 3 });
  });

  it("uses persisted rule settings and detects relevant settings changes", async () => {
    const first = await analyze();
    await connection.db.update(t.thresholds).set({ abnormalAboveC: 6 });
    expect((await (await handlers.GET()).json()).status).toBe("stale");
    const next = await analyze();
    expect(next.analysis.inputs.settings.abnormalAboveC).toBe(6);
    expect(next.incidents[0].incidentId).not.toBe(first.incidents[0].incidentId);
    await connection.db.update(t.thresholds).set({ highExposureThresholdInr: 200000, expectedIntervalMinutes: 20 });
    expect((await (await handlers.GET()).json()).status).toBe("current");
    expect((await analyze()).analysis.id).toBe(next.analysis.id);
  });

  it("retains removed intervals as historical and creates a zero-incident normal revision", async () => {
    const first = await analyze();
    await connection.db.update(t.temperatureReadings).set({ temperatureC: 3 });
    const next = await analyze();
    expect(next.incidents).toEqual([]);
    expect(next.analysis.temperature.abnormalIntervals).toEqual([]);
    expect(next.analysis.exposures).toEqual([]);
    expect(next.analysis.reconciliation.retainedPreviousIncidentIds).toEqual([first.incidents[0].incidentId]);
    expect(await counts()).toMatchObject({ analysis_runs: 2, incidents: 2, incident_events: 3 });
  });

  it("versions ongoing observation growth and recovery without inventing an end or changing history", async () => {
    await connection.db.delete(t.temperatureReadings);
    await connection.db.insert(t.temperatureReadings).values([
      { id: "ongoing-start", chamberId: "CH-1", recordedAt: "2026-03-10T01:00:00+05:30", temperatureC: 6 },
      { id: "ongoing-last", chamberId: "CH-1", recordedAt: "2026-03-10T01:30:00+05:30", temperatureC: 7 },
    ]);
    const first = await analyze();
    expect(first.analysis.temperature.abnormalIntervals[0]).toMatchObject({ ongoing: true, end: null, observedUntil: "2026-03-10T01:30:00+05:30" });
    const initialEvents = await connection.db.select().from(t.incidentEvents).where(eq(t.incidentEvents.incidentId, first.incidents[0].incidentId));
    expect(initialEvents.map((event) => event.eventType)).toEqual(["abnormal_start"]);
    await connection.db.insert(t.temperatureReadings).values({ id: "ongoing-growth", chamberId: "CH-1", recordedAt: "2026-03-10T01:40:00+05:30", temperatureC: 7 });
    const grown = await analyze();
    expect(grown.incidents[0].incidentId).not.toBe(first.incidents[0].incidentId);
    expect(grown.analysis.temperature.abnormalIntervals[0].end).toBeNull();
    await connection.db.insert(t.temperatureReadings).values({ id: "recovery", chamberId: "CH-1", recordedAt: "2026-03-10T01:50:00+05:30", temperatureC: 3 });
    const resolved = await analyze();
    expect(resolved.analysis.temperature.abnormalIntervals[0]).toMatchObject({ end: "2026-03-10T01:50:00+05:30", ongoing: false });
    expect(new Set([first, grown, resolved].map((result) => result.incidents[0].incidentId)).size).toBe(3);
    expect(await connection.db.select().from(t.incidentEvents).where(eq(t.incidentEvents.incidentId, first.incidents[0].incidentId))).toEqual(initialEvents);
  });

  it("does not reactivate an older revision when a source state returns", async () => {
    const first = await analyze();
    await connection.db.update(t.batches).set({ recordedValueInr: 51000 }).where(eq(t.batches.id, "demo-batch-a"));
    await analyze();
    await connection.db.update(t.batches).set({ recordedValueInr: 50000 }).where(eq(t.batches.id, "demo-batch-a"));
    const third = await analyze();
    expect(third.analysis.revision).toBe(3);
    expect(third.analysis.id).not.toBe(first.analysis.id);
    expect(third.analysis.sourceFingerprint).toBe(first.analysis.sourceFingerprint);
    expect(third.incidents[0].incidentId).not.toBe(first.incidents[0].incidentId);
  });

  it("does not present externally changed incident boundaries as matching analysis", async () => {
    const first = await analyze();
    await connection.db.update(t.incidents).set({ abnormalEnd: null }).where(eq(t.incidents.id, first.incidents[0].incidentId));
    expect((await (await handlers.GET()).json()).status).toBe("stale");
    const next = await analyze();
    expect(next.analysis.revision).toBe(2);
    expect(next.incidents[0].incidentId).not.toBe(first.incidents[0].incidentId);
  });

  it("keeps status/title changes without rewriting protected incidents on unchanged analysis", async () => {
    const first = await analyze();
    await connection.db.update(t.incidents).set({ status: "submitted", title: "Operator title" }).where(eq(t.incidents.id, first.incidents[0].incidentId));
    const repeat = await analyze();
    expect(repeat.reused).toBe(true);
    expect(repeat.incidents[0].status).toBe("submitted");
    expect((await connection.db.select().from(t.incidents).where(eq(t.incidents.id, first.incidents[0].incidentId)))[0].title).toBe("Operator title");
  });

  it("rejects an empty stored log without creating an analysis", async () => {
    await connection.db.delete(t.temperatureReadings);
    const before = await counts();
    const response = await handlers.POST(post());
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("NO_READINGS");
    expect(await counts()).toEqual(before);
  });

  it.each([
    ["fractional duration", async (db: DatabaseConnection) => { await db.db.update(t.thresholds).set({ minAbnormalMinutes: 0.5 }); }],
    ["invalid calendar reading", async (db: DatabaseConnection) => { await db.db.update(t.temperatureReadings).set({ recordedAt: "2026-02-30T01:20:00+05:30" }).where(eq(t.temperatureReadings.id, "worked-example-reading-008")); }],
    ["equivalent duplicate instant", async (db: DatabaseConnection) => { await db.db.insert(t.temperatureReadings).values({ id: "alias", chamberId: "CH-1", recordedAt: "2026-03-09T19:50:00Z", temperatureC: 6 }); }],
    ["fractional paise", async (db: DatabaseConnection) => { await db.db.update(t.batches).set({ recordedValueInr: 1.001 }); }],
  ])("rejects invalid stored inputs: %s, without changing an earlier snapshot", async (_name, corrupt) => {
    const first = await analyze(), before = await counts();
    await corrupt(connection);
    const response = await handlers.POST(post());
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("INVALID_STORED_DATA");
    expect(await counts()).toEqual(before);
    const latest = await (await handlers.GET()).json();
    expect(latest.status).toBe("stale");
    expect(latest.analysis.id).toBe(first.analysis.id);
  });

  it("rejects exact-subtotal overflow before persisting a partial analysis", async () => {
    await connection.db.update(t.batches).set({ recordedValueInr: 60_000_000_000_000 });
    const before = await counts();
    const response = await handlers.POST(post());
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("VALUE_OVERFLOW");
    expect(await counts()).toEqual(before);
  });

  it("reports missing configuration explicitly without writes", async () => {
    await connection.db.delete(t.thresholds);
    const before = await counts();
    const response = await handlers.POST(post());
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("CONFIGURATION_MISSING");
    expect(await counts()).toEqual(before);
  });

  it.each(["audit_log", "analysis_incident_links"])("rolls back snapshots, new incidents and events if %s fails", async (table) => {
    const before = await counts();
    await connection.client.execute(`CREATE TRIGGER reject_analysis BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'private database error'); END`);
    const response = await handlers.POST(post());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private database error");
    expect(await counts()).toEqual(before);
    await connection.client.execute("DROP TRIGGER reject_analysis");
    expect((await analyze()).analysis.revision).toBe(1);
  });

  it("selects only CH-1 records and orders source timestamps by instant rather than text", async () => {
    await connection.db.insert(t.chambers).values({ id: "CH-2", name: "Other", commodity: "potatoes", normalMinC: 2, normalMaxC: 5 });
    await connection.db.insert(t.batches).values({ id: "other-stock", chamberId: "CH-2", batchCode: "OTHER", ownerName: "Other fictional owner", quantityKg: 1, recordedValueInr: 999999, enteredAt: "2026-03-10T00:00:00+05:30" });
    await connection.db.insert(t.temperatureReadings).values({ id: "other-reading", chamberId: "CH-2", recordedAt: "not a date", temperatureC: 100 });
    await connection.db.update(t.temperatureReadings).set({ recordedAt: "2026-03-09T19:50:00Z" }).where(eq(t.temperatureReadings.id, "worked-example-reading-008"));
    const result = await analyze();
    expect(result.analysis.inputs.readings).toHaveLength(144);
    expect(result.analysis.inputs.batches).toHaveLength(3);
    expect(result.analysis.temperature.abnormalIntervals[0].start).toBe("2026-03-10T01:20:00+05:30");
    expect(result.analysis.exposures[0].knownValueSubtotalInrExact).toBe("80000.00");
  });

  it("survives close/reopen and non-destructive reseeding with unchanged identifiers", async () => {
    const first = await analyze();
    await seedDatabase(connection.db);
    connection.close();
    connection = await initializeDatabase(url);
    expect((await analyze()).analysis.id).toBe(first.analysis.id);
    expect(await counts()).toMatchObject({ analysis_runs: 1, incidents: 2, incident_events: 3, audit_log: 2 });
    await expect(connection.db.delete(t.incidents).where(eq(t.incidents.id, first.incidents[0].incidentId))).rejects.toThrow();
    await expect(connection.db.delete(t.analysisRuns)).rejects.toThrow();
  });

  it.each([
    ["malformed JSON", "{", "application/json", 400],
    ["scenario override", '{"scenarioId":"scenario-01"}', "application/json", 400],
    ["readings override", '{"readings":[]}', "application/json", 400],
    ["array", "[]", "application/json", 400],
    ["null", "null", "application/json", 400],
    ["content type", "{}", "text/plain", 415],
    ["oversized body", " ".repeat(1025), "application/json", 413],
  ])("rejects %s before initializing the database", async (_name, body, contentType, status) => {
    const getter = vi.fn(async () => connection.db);
    const response = await analysisHandlers(getter).POST(new Request("http://coldcover.test/api/analyze", { method: "POST", headers: { "Content-Type": contentType }, body }));
    expect(response.status).toBe(status);
    expect(getter).not.toHaveBeenCalled();
  });

  it("returns generic no-store errors when database initialization fails", async () => {
    const failing = analysisHandlers(async () => { throw new Error("private path and SQL"); });
    for (const response of [await failing.POST(post()), await failing.GET()]) {
      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(JSON.stringify(await response.json())).not.toContain("private path");
    }
  });

  // Replace only disposable test source rows. The simulator remains read-only;
  // authored documents/expectations are never inputs to the analysis service.
  it.each(scenarioCatalog)("persists independent temporal/exposure oracle $number: $name", async (fixture) => {
    await connection.db.delete(t.temperatureReadings);
    await connection.db.delete(t.batches);
    await connection.db.insert(t.temperatureReadings).values(fixture.readings);
    if (fixture.batches.length) await connection.db.insert(t.batches).values(fixture.batches);
    const result = await analyze();
    expect(result.analysis.temperature.abnormalIntervals.map(({ start, end, dataGapUncertainty }) => ({ start, end, dataGapUncertainty }))).toEqual(fixture.expected.abnormalIntervals.map(({ start, end, dataGapUncertainty }) => ({ start, end, dataGapUncertainty })));
    expect(result.analysis.temperature.briefSpikes.map(({ start, end, durationMinutes }) => ({ start, end, durationMinutes }))).toEqual(fixture.expected.briefSpikes);
    expect(result.analysis.temperature.dataGaps.map(({ start, end }) => ({ start, end }))).toEqual(fixture.expected.dataGaps);
    expect(result.incidents).toHaveLength(fixture.expected.abnormalIntervals.length);
    expect(await counts()).toMatchObject({ analysis_runs: 1, analysis_incident_links: fixture.expected.abnormalIntervals.length, incidents: 1 + fixture.expected.abnormalIntervals.length });
    expect(result.analysis.exposures).toHaveLength(fixture.expected.abnormalIntervals.length);
    for (const [index, exposure] of result.analysis.exposures.entries()) {
      const expected = fixture.expected.abnormalIntervals[index];
      expect(exposure.knownValueSubtotalInr).toBe(expected.exposureValueInr);
      expect(exposure.valuationComplete).toBe(expected.valuationComplete);
      for (const [classification, key] of [["present_throughout", "presentThroughout"], ["present_partially", "presentPartially"], ["not_present", "notPresent"]] as const) expect(exposure.batches.filter((batch) => batch.classification === classification).map((batch) => batch.batchCode).sort()).toEqual([...expected[key]].sort());
      const incident = (await connection.db.select().from(t.incidents).where(eq(t.incidents.id, result.incidents.find((item) => item.intervalId === exposure.intervalId)!.incidentId)))[0];
      expect(incident).toMatchObject({ abnormalStart: expected.start, abnormalEnd: expected.end, status: "draft" });
      const events = await connection.db.select().from(t.incidentEvents).where(eq(t.incidentEvents.incidentId, incident.id));
      expect(events.filter((event) => event.eventType === "abnormal_end")).toHaveLength(expected.end === null ? 0 : 1);
      expect(events.filter((event) => event.eventType === "data_gap").map((event) => event.sourceRef).sort()).toEqual(result.analysis.temperature.abnormalIntervals[index].gapIds.toSorted());
    }
    expect((await analyze()).analysis.id).toBe(result.analysis.id);
    expect(await connection.db.select().from(t.claims)).toHaveLength(0);
    expect(await connection.db.select().from(t.reviewDecisions)).toHaveLength(0);
    expect(await connection.db.select().from(t.documents)).toHaveLength(1);
  });
});
