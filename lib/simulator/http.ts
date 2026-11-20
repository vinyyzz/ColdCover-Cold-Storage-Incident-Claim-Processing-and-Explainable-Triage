import { z } from "zod";
import { getScenario } from "../demo/scenarios/catalog";
import { simulatorControls, simulatorPreviewSchema, simulatorSettings } from "./types";

// This module has no DB dependency. Preview selection never activates/resets a
// persisted dataset, writes audits, runs analysis or returns fixture oracles.
export function simulatorPreviewResponse(id: unknown) {
  const parsed = z.string().min(1).max(80).safeParse(id);
  if (!parsed.success) return Response.json({ error: { code: "INVALID_SCENARIO", message: "Choose a valid simulator scenario." } }, { status: 400 });
  const control = simulatorControls.find((item) => item.id === parsed.data);
  if (!control) return Response.json({ error: { code: "NOT_FOUND", message: "This simulator preview is not available." } }, { status: 404 });
  try {
    const source = getScenario(control.id);
    if (!source) throw new Error("Missing source fixture");
    const preview = simulatorPreviewSchema.parse({
      mode: "preview", persisted: false, id: source.id, label: control.label, name: source.name, description: source.description,
      settings: { ...simulatorSettings },
      readings: source.readings.map(({ id, recordedAt, temperatureC, scenarioId }) => ({ id, recordedAt, temperatureC, scenarioId })),
      batches: source.batches.map(({ id, batchCode, ownerName, quantityKg, recordedValueInr, enteredAt, exitedAt }) => ({ id, batchCode, ownerName, quantityKg, recordedValueInr, enteredAt, exitedAt })),
      documents: source.documents.map(({ id, docType, filename, rawText }) => ({ id, docType, filename, rawText })),
    });
    return Response.json(preview, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: { code: "PREVIEW_UNAVAILABLE", message: "This preview could not be loaded. Try again." } }, { status: 500 });
  }
}
