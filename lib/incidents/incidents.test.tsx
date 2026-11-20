import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IncidentIndexView from "../../app/components/incident-index";
import IncidentRecordView from "../../app/incidents/[id]/record";
import { analyzeStoredLog } from "../analysis/service";
import type { DatabaseConnection } from "../db/client";
import { initializeDatabase } from "../db/initialize";
import { getScenario } from "../demo/scenarios/catalog";
import * as t from "../db/schema";
import { incidentHandlers } from "./http";
import { getIncident, listIncidents } from "./service";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const detailRequest = (revision?: string) => new Request(`http://coldcover.test/api/incidents/id${revision === undefined ? "" : `?revision=${encodeURIComponent(revision)}`}`);
describe("Read-only incident browsing and rendered evidence", () => {
  let dir: string, connection: DatabaseConnection;
  beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "coldcover-incidents-")); connection = await initializeDatabase(pathToFileURL(join(dir, "test.db")).href); });
  afterEach(() => { connection?.close(); rmSync(dir, { recursive: true, force: true }); });
  const handlers = () => incidentHandlers(async () => connection.db);
  const analyze = () => analyzeStoredLog(connection.db);
  async function dump() {
    const names = await connection.client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const result: Record<string, unknown> = {};
    for (const { name } of names.rows) result[String(name)] = (await connection.client.execute(`SELECT * FROM "${name}" ORDER BY 1`)).rows;
    return result;
  }
  it("lists the seed as unassigned without inferring ongoing analysis or exposure", async () => {
    const response = await handlers().GET();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.analysis).toMatchObject({ status: "not_analyzed", briefSpikes: [] });
    expect(body.incidents).toHaveLength(1);
    expect(body.incidents[0]).toMatchObject({ id: "demo-incident-01", membership: "unassigned", abnormalStart: null, latestLinkedRevision: null, documentCount: 1, eventCount: 1 });
  });
  it("opens only the seed's original report and event without fabricated interval evidence", async () => {
    const response = await handlers().DETAIL(detailRequest(), "demo-incident-01");
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.evidence).toBeNull(); expect(body.revisions).toEqual([]);
    expect(body.documents[0]).toMatchObject({ id: "demo-maintenance-01", incidentId: "demo-incident-01", extractionSource: null });
    expect(body.events[0].eventType).toBe("document_uploaded");
  });
  it("distinguishes calculated membership from workflow status and leaves seed unassigned", async () => {
    const result = await analyze(), id = result.incidents[0].incidentId;
    await connection.db.update(t.incidents).set({ status: "decided" }).where(eq(t.incidents.id, id));
    const list = await listIncidents(connection.db);
    expect(list.incidents.find((item) => item.id === id)).toMatchObject({ membership: "current", status: "decided", documentCount: 0, eventCount: 2 });
    expect(list.incidents.find((item) => item.id === "demo-incident-01")?.membership).toBe("unassigned");
    const record = await getIncident(connection.db, id);
    expect(record.evidence?.exposure.knownValueSubtotalPaise).toBe(8_000_000);
    expect(record.evidence?.readings).toHaveLength(27);
    expect(record.evidence?.readings[0].id).toBe("worked-example-reading-008");
    expect(record.documents).toEqual([]);
  });
  it("marks the latest candidate stale after inventory changes and retains old snapshot values", async () => {
    const first = await analyze(), id = first.incidents[0].incidentId;
    await connection.db.update(t.batches).set({ recordedValueInr: null }).where(eq(t.batches.id, "demo-batch-b"));
    expect((await listIncidents(connection.db)).analysis.status).toBe("stale");
    const record = await getIncident(connection.db, id);
    expect(record.incident.membership).toBe("stale");
    expect(record.evidence?.exposure).toMatchObject({ knownValueSubtotalInrExact: "80000.00", valuationComplete: true });
    const second = await analyze();
    const after = await listIncidents(connection.db);
    expect(after.incidents.find((item) => item.id === id)?.membership).toBe("historical");
    expect(after.incidents.find((item) => item.id === second.incidents[0].incidentId)?.membership).toBe("current");
    expect((await getIncident(connection.db, second.incidents[0].incidentId)).evidence?.exposure).toMatchObject({ knownValueSubtotalInrExact: "50000.00", valuationComplete: false });
  });
  it("selects historical revisions of a reused incident explicitly, without calling them current", async () => {
    const first = await analyze(), id = first.incidents[0].incidentId;
    await connection.db.insert(t.temperatureReadings).values({ id: "normal-later", chamberId: "CH-1", recordedAt: "2026-03-11T00:00:00+05:30", temperatureC: 3 });
    const next = await analyze(); expect(next.incidents[0].incidentId).toBe(id);
    const latest = await getIncident(connection.db, id);
    expect(latest.revisions.map((item) => item.revision)).toEqual([2, 1]);
    expect(latest.evidence?.revision.membership).toBe("current");
    const older = await getIncident(connection.db, id, first.analysis.id);
    expect(older.incident.membership).toBe("current");
    expect(older.evidence?.revision.membership).toBe("historical");
    expect(older.evidence?.revision.analysisId).toBe(first.analysis.id);
  });
  it("retains removed intervals as history when no new qualified intervals remain", async () => {
    const first = await analyze();
    await connection.db.update(t.temperatureReadings).set({ temperatureC: 3 }); await analyze();
    const data = await listIncidents(connection.db);
    expect(data.incidents.filter((item) => item.membership === "current")).toEqual([]);
    expect(data.incidents.find((item) => item.id === first.incidents[0].incidentId)?.membership).toBe("historical");
  });
  it("does not infer an analysed ongoing interval from an unlinked manually recorded window", async () => {
    await connection.db.insert(t.incidents).values({ id: "manual", chamberId: "CH-1", title: "Manual window", status: "submitted", abnormalStart: "2026-03-10T01:00:00+05:30", abnormalEnd: null, createdAt: "2026-03-10T08:00:00+05:30" });
    const record = await getIncident(connection.db, "manual");
    expect(record.incident.membership).toBe("unassigned"); expect(record.evidence).toBeNull();
  });
  it("reports changed record boundaries separately from immutable snapshot endpoints", async () => {
    const first = await analyze(), id = first.incidents[0].incidentId;
    await connection.db.update(t.incidents).set({ abnormalEnd: null }).where(eq(t.incidents.id, id));
    const record = await getIncident(connection.db, id);
    expect(record.incident.membership).toBe("stale");
    expect(record.evidence?.boundariesMatch).toBe(false);
    expect(record.incident.abnormalEnd).toBeNull(); expect(record.evidence?.interval.end).toBe("2026-03-10T05:40:00+05:30");
  });
  it("excludes other-chamber records and reports valid unknown IDs and unlinked revisions as 404", async () => {
    await connection.db.insert(t.chambers).values({ id: "CH-2", name: "Other", commodity: "potatoes", normalMinC: 2, normalMaxC: 5 });
    await connection.db.insert(t.incidents).values({ id: "other", chamberId: "CH-2", title: "Other record", createdAt: "2026-03-10T08:00:00+05:30" });
    expect((await listIncidents(connection.db)).incidents).toHaveLength(1);
    for (const [id, revision] of [["missing", undefined], ["other", undefined], ["demo-incident-01", "missing"]]) expect((await handlers().DETAIL(detailRequest(revision), id!)).status).toBe(404);
  });
  it.each(["", "../private", "a b", "x".repeat(121), "<script>"])("rejects malformed ID %s before DB initialization", async (id) => {
    const getter = vi.fn(async () => connection.db);
    const response = await incidentHandlers(getter).DETAIL(detailRequest(), id);
    expect(response.status).toBe(400); expect(getter).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects empty, repeated and malformed revision arguments before DB initialization", async () => {
    const getter = vi.fn(async () => connection.db);
    for (const query of ["revision=", "revision=one&revision=two", "revision=..%2Fbad"]) expect((await incidentHandlers(getter).DETAIL(new Request(`http://test/api/incidents/id?${query}`), "demo-incident-01")).status).toBe(400);
    expect(getter).not.toHaveBeenCalled();
  });
  it("preserves all source, analysis, document, claim, review and audit rows across repeated/concurrent reads", async () => {
    const first = await analyze(), id = first.incidents[0].incidentId;
    const [policy] = await connection.db.select().from(t.policies);
    await connection.db.insert(t.claims).values({ id: "protected", incidentId: id, policyId: policy.id, readiness: "Needs more evidence", priority: "Standard priority", triageReasonsJson: [], exposureValueInr: 80000, summaryJson: [], missingEvidenceJson: [], createdAt: "2026-03-10T08:00:00+05:30" });
    await connection.db.insert(t.reviewDecisions).values({ id: "review", claimId: "protected", reviewerName: "Fictional reviewer", status: "closed", comment: "Retain", decidedAt: "2026-03-10T09:00:00+05:30" });
    const before = await dump();
    await Promise.all([listIncidents(connection.db), getIncident(connection.db, id), getIncident(connection.db, "demo-incident-01"), getIncident(connection.db, id, first.analysis.id)]);
    await handlers().GET(); await handlers().DETAIL(detailRequest(), id);
    expect(await dump()).toEqual(before);
  });
  it("sorts event and document instants across offsets and retains opaque operator source references", async () => {
    await connection.db.insert(t.incidentEvents).values({ id: "earlier", incidentId: "demo-incident-01", occurredAt: "2026-03-09T23:30:00Z", eventType: "inspection", description: "Operator note", sourceType: "operator", sourceRef: "unavailable-original" });
    const result = await getIncident(connection.db, "demo-incident-01");
    expect(result.events.map((item) => item.id)).toEqual(["earlier", "demo-document-uploaded-01"]);
    expect(result.events[0].sourceRef).toBe("unavailable-original");
  });
  it("fails closed with generic no-store errors for malformed saved snapshots or database failures", async () => {
    await analyze();
    await connection.client.execute("UPDATE analysis_runs SET snapshot_json='{}'");
    const invalid = await handlers().GET(); expect(invalid.status).toBe(500);
    expect(JSON.stringify(await invalid.json())).not.toContain("snapshot_json");
    const failing = incidentHandlers(async () => { throw new Error("private SQL and path"); });
    for (const response of [await failing.GET(), await failing.DETAIL(detailRequest(), "valid")]) {
      expect(response.status).toBe(500); expect(response.headers.get("cache-control")).toBe("no-store");
      expect(JSON.stringify(await response.json())).not.toContain("private SQL");
    }
  });
  it("does not fabricate current membership when relevant configuration is missing", async () => {
    await analyze(); await connection.db.delete(t.thresholds);
    const response = await handlers().GET(); expect(response.status).toBe(409);
    expect((await response.json()).error.message).toContain("freshness could not be checked");
  });
  it("supports a genuinely empty incident register without creating replacement records", async () => {
    await connection.db.delete(t.documents); await connection.db.delete(t.incidentEvents); await connection.db.delete(t.incidents);
    const before = await dump(), data = await listIncidents(connection.db);
    expect(data.incidents).toEqual([]); expect(data.analysis.status).toBe("not_analyzed");
    expect(renderToStaticMarkup(createElement(IncidentIndexView, { data }))).toContain("No current calculated incidents to display");
    expect(await dump()).toEqual(before);
  });
  it("fails closed for invalid stored event timestamps rather than exposing an unrenderable record", async () => {
    await connection.db.update(t.incidentEvents).set({ occurredAt: "not a timestamp" });
    const response = await handlers().DETAIL(detailRequest(), "demo-incident-01");
    expect(response.status).toBe(500); expect((await response.json()).error.code).toBe("INCIDENTS_UNAVAILABLE");
  });
  it.each(["scenario-29", "scenario-11", "scenario-08", "scenario-18"])("reads and renders actual persisted %s evidence without assigning reports", async (scenarioId) => {
    const fixture = getScenario(scenarioId)!;
    await connection.db.delete(t.temperatureReadings); await connection.db.delete(t.batches);
    await connection.db.insert(t.temperatureReadings).values(fixture.readings);
    await connection.db.insert(t.batches).values(fixture.batches);
    const result = await analyze();
    const before = await dump(), data = await listIncidents(connection.db);
    expect(data.incidents.filter((item) => item.membership === "current")).toHaveLength(fixture.expected.abnormalIntervals.length);
    expect(data.analysis.briefSpikes).toHaveLength(fixture.expected.briefSpikes.length);
    for (const [index, row] of result.incidents.entries()) {
      const record = await getIncident(connection.db, row.incidentId);
      const expected = fixture.expected.abnormalIntervals.find((item) => item.start === record.evidence?.interval.start)!;
      expect(record.evidence?.exposure.knownValueSubtotalInr).toBe(expected.exposureValueInr);
      expect(record.evidence?.interval.end).toBe(expected.end);
      const html = renderToStaticMarkup(createElement(IncidentRecordView, { data: record }));
      expect(html).toContain("Inventory value under investigation");
      if (expected.end === null) expect(html).toContain("Ongoing; last observed");
      if (expected.dataGapUncertainty) { expect(html).toContain("Data-gap uncertainty"); expect(record.evidence?.gaps.length).toBeGreaterThan(0); }
      expect(index).toBeLessThan(fixture.expected.abnormalIntervals.length);
      expect(record.documents).toEqual([]);
    }
    if (scenarioId === "scenario-08") expect(renderToStaticMarkup(createElement(IncidentIndexView, { data }))).toContain("No incident or batch exposure created");
    expect(await dump()).toEqual(before);
  });
  it("renders the unassigned seed and original text without a monetary or ongoing result", async () => {
    const record = await getIncident(connection.db, "demo-incident-01");
    const html = renderToStaticMarkup(createElement(IncidentRecordView, { data: record }));
    expect(html).toContain("Unassigned record"); expect(html).toContain("Not extracted"); expect(html).toContain("FICTIONAL DEMONSTRATION RECORD");
    expect(html).not.toContain("₹80,000"); expect(html).not.toContain("Ongoing; last observed");
    expect(html).toContain('aria-controls="raw-document-0"');
  });
  it("renders current/stale/history groups, real links, original values and escaped document text", async () => {
    const first = await analyze(), id = first.incidents[0].incidentId;
    await connection.db.update(t.batches).set({ recordedValueInr: null }).where(eq(t.batches.id, "demo-batch-b"));
    const staleHtml = renderToStaticMarkup(createElement(IncidentRecordView, { data: await getIncident(connection.db, id) }));
    expect(staleHtml).toContain("Stale candidate"); expect(staleHtml).toContain("₹80,000.00"); expect(staleHtml).toContain("saved snapshot");
    await analyze();
    const index = renderToStaticMarkup(createElement(IncidentIndexView, { data: await listIncidents(connection.db) }));
    expect(index).toContain("Historical incidents"); expect(index).toContain("Current calculated incidents"); expect(index).toContain(`/incidents/${id}`); expect(index).toContain("/incidents/demo-incident-01");
    const historical = renderToStaticMarkup(createElement(IncidentRecordView, { data: await getIncident(connection.db, id) }));
    expect(historical).toContain("Historical revision selected");
    await connection.db.update(t.documents).set({ rawText: "<script>fictional</script>" });
    expect(renderToStaticMarkup(createElement(IncidentRecordView, { data: await getIncident(connection.db, "demo-incident-01") }))).toContain("&lt;script&gt;fictional&lt;/script&gt;");
  });
});
