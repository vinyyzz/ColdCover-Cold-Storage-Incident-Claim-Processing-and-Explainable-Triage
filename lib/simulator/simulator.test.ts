import { afterEach, describe, expect, it, vi } from "vitest";
import * as catalog from "../demo/scenarios/catalog";
import { simulatorControls, simulatorPreviewSchema, simulatorSettings } from "./types";
import { simulatorPreviewResponse } from "./http";
import { POST } from "../../app/api/simulator/[scenarioId]/route";

const labels = ["Normal operation", "Prolonged temperature rise", "Missing readings", "Conflicting report", "Brief spike", "Ongoing failure", "Late-arriving batch", "Early-departing batch"];
const getPreview = async (id: string) => simulatorPreviewSchema.parse(await simulatorPreviewResponse(id).json());
afterEach(() => vi.restoreAllMocks());

describe("Isolated simulator source previews", () => {
  it("offers exactly the eight specified controls with unique canonical sources", () => {
    expect(simulatorControls.map((item) => item.label)).toEqual(labels);
    expect(new Set(simulatorControls.map((item) => item.id)).size).toBe(8);
    expect(simulatorControls.map((item) => catalog.getScenario(item.id)?.number)).toEqual([1, 4, 11, 14, 8, 18, 22, 21]);
  });
  it.each(simulatorControls)("loads $label as a validated source copy with no oracle or calculated results", async (control) => {
    const response = simulatorPreviewResponse(control.id);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const raw = await response.json(), preview = simulatorPreviewSchema.parse(raw), source = catalog.getScenario(control.id)!;
    expect(preview).toMatchObject({ id: control.id, label: control.label, mode: "preview", persisted: false, settings: simulatorSettings });
    expect(preview.readings).toHaveLength(source.readings.length);
    expect(preview.readings.map((row) => row.temperatureC)).toEqual(source.readings.map((row) => row.temperatureC));
    expect(preview.batches.map((batch) => batch.id)).toEqual(source.batches.map((batch) => batch.id));
    expect(preview.documents.map((document) => document.rawText)).toEqual(source.documents.map((document) => document.rawText));
    for (const key of ["expected", "abnormalIntervals", "readiness", "priority", "exposureValueInr", "claims", "incidentId"]) expect(raw).not.toHaveProperty(key);
    expect(raw.documents.every((document: Record<string, unknown>) => !("intervalIndex" in document))).toBe(true);
  });
  it("does not mutate the canonical catalogue when consumers edit returned readings/batches/documents/settings", async () => {
    const before = structuredClone(catalog.scenarioCatalog);
    const preview = await getPreview("worked-example");
    preview.readings[0].temperatureC = 99; preview.batches[0].ownerName = "Changed fictional preview owner";
    preview.documents[0].rawText = "Edited preview"; Object.assign(preview.settings, { abnormalAboveC: 99 });
    expect(catalog.scenarioCatalog).toEqual(before);
    const next = await getPreview("worked-example");
    expect(next.readings[0].temperatureC).not.toBe(99); expect(next.settings.abnormalAboveC).toBe(5);
    expect(next.documents[0].rawText).toBe(before.find((item) => item.id === "worked-example")!.documents[0].rawText);
  });
  it("preserves source differences for stock timing and unprocessed conflicting reports", async () => {
    const late = await getPreview("scenario-22"), early = await getPreview("scenario-21"), conflict = await getPreview("scenario-14");
    expect(late.batches.find((batch) => batch.batchCode === "B")?.enteredAt).toBe("2026-03-10T05:40:00+05:30");
    expect(early.batches.find((batch) => batch.batchCode === "B")?.exitedAt).toBe("2026-03-10T01:20:00+05:30");
    expect(conflict.documents.some((document) => document.rawText.includes("2026-03-10T04:00:00+05:30"))).toBe(true);
  });
  it.each([null, "", "x".repeat(81)])("rejects malformed ID %s before catalogue access", (id) => {
    const spy = vi.spyOn(catalog, "getScenario");
    expect(simulatorPreviewResponse(id).status).toBe(400); expect(spy).not.toHaveBeenCalled();
  });
  it.each(["unknown", "scenario-30", "../scenario-01"])("rejects unavailable control %s", async (id) => {
    const response = simulatorPreviewResponse(id);
    expect(response.status).toBe(404); expect((await response.json()).error.code).toBe("NOT_FOUND");
  });
  it("handles a missing/broken source without leaking internal details or exposing fixture expectations", async () => {
    vi.spyOn(catalog, "getScenario").mockImplementation(() => { throw new Error("private fixture details"); });
    const response = simulatorPreviewResponse("scenario-01");
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("private fixture details");
  });
  it("loads through the async route params and ignores mutation-like request-body fields", async () => {
    const before = structuredClone(catalog.scenarioCatalog);
    const response = await POST(new Request("http://coldcover.test/api/simulator/scenario-01", { method: "POST", body: JSON.stringify({ reset: true, temperatureC: 99, expected: {} }) }), { params: Promise.resolve({ scenarioId: "scenario-01" }) });
    expect(response.status).toBe(200); expect((await response.json()).persisted).toBe(false);
    expect(catalog.scenarioCatalog).toEqual(before);
  });
  it("rejects persisted or oracle-bearing payloads at the client validation boundary", async () => {
    const preview = await getPreview("scenario-01");
    expect(simulatorPreviewSchema.safeParse({ ...preview, persisted: true }).success).toBe(false);
    expect(simulatorPreviewSchema.safeParse({ ...preview, expected: { priority: "High priority" } }).success).toBe(false);
    expect(simulatorPreviewSchema.safeParse({ ...preview, readings: [{ ...preview.readings[0], temperatureC: NaN }] }).success).toBe(false);
    expect(simulatorPreviewSchema.safeParse({ ...preview, settings: { ...preview.settings, normalMinC: 99 } }).success).toBe(false);
    expect(simulatorPreviewSchema.safeParse({ ...preview, readings: [preview.readings[1], preview.readings[0]] }).success).toBe(false);
    expect(simulatorPreviewSchema.safeParse({ ...preview, readings: [{ ...preview.readings[0], scenarioId: "other" }] }).success).toBe(false);
  });
});
