import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EvidenceTimeline from "../../app/incidents/[id]/timeline";
import { analyzeStoredLog } from "../analysis/service";
import type { DatabaseConnection } from "../db/client";
import { initializeDatabase } from "../db/initialize";
import * as t from "../db/schema";
import { getScenario } from "../demo/scenarios/catalog";
import { addDocument } from "../documents/service";
import { correctDocument } from "../documents/correction-service";
import { getIncident } from "./service";
import { incidentHandlers } from "./http";
import { buildEvidenceTimeline, retainedTimelineItem, timelineRange } from "./timeline";
import type { IncidentDetail } from "./types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const stamp = (time: string) => `2026-03-10T${time}+05:30`;
describe("Timeline clipping geometry", () => {
  it.each([
    { from: -10, to: 110, left: 0, width: 100, outside: null },
    { from: 20, to: 80, left: 20, width: 60, outside: null },
    { from: 120, to: 150, left: 100, width: 0, outside: "after" },
    { from: -50, to: -10, left: 0, width: 0, outside: "before" },
    { from: -20, to: 0, left: 0, width: 0, outside: "before" },
    { from: 100, to: Infinity, left: 100, width: 0, outside: "after" },
  ])("clips $from..$to without inventing an in-window duration", ({ from, to, left, width, outside }) => {
    expect(timelineRange(0, 100, from, to)).toMatchObject({ left, width, outside });
  });
  it("retains empty storage and explicit open-ended/clipped boundaries", () => {
    expect(timelineRange(0, 100, 50, 50)).toMatchObject({ empty: true, width: 0 });
    expect(timelineRange(0, 100, -20, Infinity)).toMatchObject({ before: true, after: true, width: 100 });
  });
  it("rejects invalid numeric geometry", () => {
    expect(() => timelineRange(0, 0, 0, 1)).toThrow(); expect(() => timelineRange(0, 100, 20, 10)).toThrow(); expect(() => timelineRange(0, 100, NaN, Infinity)).toThrow();
  });
});

describe("Verified timeline read model and preparation", () => {
  let dir: string, connection: DatabaseConnection, id: string, analysisId: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "coldcover-timeline-")); connection = await initializeDatabase(pathToFileURL(join(dir, "qa.db")).href);
    const run = await analyzeStoredLog(connection.db); id = run.incidents[0].incidentId; analysisId = run.analysis.id;
  });
  afterEach(() => { connection?.close(); rmSync(dir, { recursive: true, force: true }); });
  const detail = (revision?: string) => getIncident(connection.db, id, revision);
  const attach = (rawText: string, docType: "maintenance_report" | "stock_inspection_report" = "maintenance_report") => addDocument(connection.db, id, { requestId: randomUUID(), analysisId, docType, filename: `${docType}.txt`, rawText });
  const html = (data: IncidentDetail) => renderToStaticMarkup(createElement(EvidenceTimeline, { data, onSource: vi.fn(), onOriginal: vi.fn() }));
  async function dump() {
    const names = await connection.client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"), result: Record<string, unknown> = {};
    for (const { name } of names.rows) result[String(name)] = (await connection.client.execute(`SELECT * FROM "${name}" ORDER BY 1`)).rows;
    return result;
  }
  it("returns selected snapshot context and linked intervals through no-store detail API", async () => {
    const response = await incidentHandlers(async () => connection.db).DETAIL(new Request("http://test/api/incidents/id"), id), data: IncidentDetail = await response.json();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(data.timeline).toMatchObject({ status: "available", version: "timeline-v1", analysisId, intervalId: data.evidence?.interval.id });
    const model = buildEvidenceTimeline(data)!; expect(model.readings.length).toBeGreaterThan(data.evidence!.readings.length); expect(model.items.filter((item) => item.kind === "report")).toEqual([]);
    expect(html(data)).toContain("No verified report passages"); expect(html(data)).toContain("Batch C"); expect(html(data)).toContain("Not present");
  });
  it("separates explicit reported times, passages and actual upload time", async () => {
    await attach(`Reported fault: compressor fault\nRepair completed: ${stamp("03:00:00")}\nRefrigeration restarted: ${stamp("04:00:00")}`);
    const data = await detail(), model = buildEvidenceTimeline(data)!, reports = model.items.filter((item) => item.kind === "report"), timed = reports.filter((item) => item.at);
    expect(timed.map((item) => item.at)).toEqual([stamp("03:00:00"), stamp("04:00:00")]);
    expect(reports.find((item) => item.source.type === "document" && item.source.quote?.field === "reported_fault")?.at).toBeNull();
    expect(model.items.find((item) => item.kind === "attachment")?.at).toBe(data.documents[0].uploadedAt);
    expect(html(data)).toContain("Inspect uploads outside chart window"); expect(html(data)).toContain("not verified equipment operations");
  });
  it("does not manufacture timestamp markers from date-only inspection evidence", async () => {
    await attach("Inspection date: 10 March 2026\nStock condition: separate assessment required", "stock_inspection_report");
    expect(buildEvidenceTimeline(await detail())!.items.filter((item) => item.kind === "report" && item.at)).toEqual([]);
  });
  it("uses exact original quote/context and detaches its report source", async () => {
    await attach("All times IST, +05:30\nRefrigeration restarted at 04:00 on 10 March 2026."); const data = await detail(), before = structuredClone(data), model = buildEvidenceTimeline(data)!;
    const source = model.items.find((item) => item.kind === "report")!.source;
    expect(source).toMatchObject({ type: "document", quote: { value: stamp("04:00:00"), time_zone_context: { quote: "All times IST, +05:30" } } }); source.id = "changed"; expect(data).toEqual(before);
  });
  it("does not retain a cleared reported marker or its old correction version", async () => {
    const raw = `Refrigeration restarted: ${stamp("04:00:00")}`, doc = await attach(raw), original = buildEvidenceTimeline(await detail())!.items.find((item) => item.kind === "report")!;
    await correctDocument(connection.db, doc.documentId, { requestId: randomUUID(), analysisId, expectedCorrectionId: null, reason: "Fictional marker source review", change: { field: "restart_time", value: null, evidence_quotes: [], supportConfirmed: true } });
    const items = buildEvidenceTimeline(await detail())!.items; expect(retainedTimelineItem(items, original)).toBeNull(); expect(items.some((item) => item.kind === "report" && item.at)).toBe(false); expect(retainedTimelineItem(items, null)).toBeNull();
  });
  it("keeps old effective reports and excludes future reports when selecting history", async () => {
    await attach(`Refrigeration restarted: ${stamp("04:00:00")}`); const oldId = analysisId;
    await connection.db.insert(t.temperatureReadings).values({ id: "later-normal", chamberId: "CH-1", recordedAt: "2026-03-11T00:00:00+05:30", temperatureC: 3 }); const run = await analyzeStoredLog(connection.db); analysisId = run.analysis.id;
    const future = await attach(`Repair completed: ${stamp("03:00:00")}`), old = await detail(oldId), model = buildEvidenceTimeline(old)!;
    expect(old.evidence?.revision.membership).toBe("historical"); expect(model.items.some((item) => item.source.id === future.documentId)).toBe(false); expect(html(old)).toContain("Historical evidence");
  });
  it("keeps immutable snapshot data after live stock changes make evidence stale", async () => {
    await connection.db.update(t.batches).set({ enteredAt: stamp("08:00:00") }).where(eq(t.batches.id, "demo-batch-a"));
    const data = await detail(); expect(data.evidence?.revision.membership).toBe("stale"); expect(data.evidence?.exposure.batches[0].classification).toBe("present_throughout"); expect(html(data)).toContain("Stale candidate");
  });
  it("navigates multiple interval memberships without transferring documents", async () => {
    const fixture = getScenario("scenario-29")!; await connection.db.delete(t.temperatureReadings); await connection.db.insert(t.temperatureReadings).values(fixture.readings.map((row) => ({ ...row, chamberId: "CH-1" })));
    const run = await analyzeStoredLog(connection.db); analysisId = run.analysis.id; id = run.incidents[0].incidentId; await attach(`Refrigeration restarted: ${stamp("04:00:00")}`);
    const first = await detail(), second = await getIncident(connection.db, run.incidents[1].incidentId, analysisId);
    expect(first.timeline.status === "available" && first.timeline.intervals.map((row) => row.incidentId)).toEqual(run.incidents.map((row) => row.incidentId));
    expect(html(first)).toContain(`revision=${analysisId}#evidence-timeline`); expect(buildEvidenceTimeline(second)!.items.filter((item) => item.kind === "report")).toEqual([]);
  });
  it("pages exact readings without thinning and refuses unordered input", async () => {
    const data = await detail(); if (data.timeline.status !== "available") throw new Error("Missing timeline");
    data.timeline.readings = Array.from({ length: 1001 }, (_, i) => ({ id: `sample-${i}`, recordedAt: new Date(Date.parse(stamp("00:00:00")) + i * 60000).toISOString(), temperatureC: 6 }));
    const first = buildEvidenceTimeline(data)!, last = buildEvidenceTimeline(data, 1)!; expect(first.readings).toHaveLength(1000); expect(last.readings).toHaveLength(1); expect(last.readings[0].id).toBe("sample-1000"); expect(buildEvidenceTimeline(data, 900)!.page).toBe(1);
    expect(first.end).toBe(Date.parse(first.readings.at(-1)!.recordedAt)); expect(last.start).toBe(Date.parse(last.readings[0].recordedAt));
    data.timeline.readings.reverse(); expect(() => buildEvidenceTimeline(data)).toThrow();
  });
  it("breaks the trace at gaps and handles large finite temperature values", async () => {
    const data = await detail(); if (data.timeline.status !== "available") throw new Error("Missing timeline");
    data.timeline.readings = [{ id: "a", recordedAt: stamp("01:00:00"), temperatureC: -Number.MAX_VALUE }, { id: "b", recordedAt: stamp("02:00:00"), temperatureC: Number.MAX_VALUE }];
    const model = buildEvidenceTimeline(data)!; expect(model.segments).toHaveLength(2); expect(model.gaps).toHaveLength(1); expect(model.segments.flat().every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  });
  it("withholds unassigned/unverified evidence rather than plotting unverified passages", async () => {
    const seed = await getIncident(connection.db, "demo-incident-01"); expect(buildEvidenceTimeline(seed)).toBeNull(); expect(html(seed)).toContain("Timeline unavailable");
    await connection.db.update(t.policies).set({ wording: " " }); expect(buildEvidenceTimeline(await detail())).toBeNull();
  });
  it("renders accessible interval, batch, reading and source controls with escaped text", async () => {
    await attach("Reported fault: <script>fictional</script>"); const output = html(await detail());
    for (const text of ["Timeline intervals", "Select interval 1", "Select batch C", "Timeline evidence inspector", "Inspect an exact saved reading", "&lt;script&gt;fictional&lt;/script&gt;", "Document uploads"]) expect(output).toContain(text);
    expect(output).not.toContain("<script>fictional</script>");
    expect(output).toMatch(/<title[^>]*>Saved temperature trace in °C; dashed threshold 5 °C[^<]*<\/title>/);
  });
  it("preserves every table across concurrent timeline reads", async () => {
    await attach(`Refrigeration restarted: ${stamp("04:00:00")}`); const before = await dump();
    await Promise.all([detail(), detail(), getIncident(connection.db, "demo-incident-01")]); expect(await dump()).toEqual(before);
  });
});
