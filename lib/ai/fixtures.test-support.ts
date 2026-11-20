import { getScenario } from "../demo/scenarios/catalog";
import { analyzeTemperature, calculateBatchExposure } from "../rules";
import { createFallbackSummary } from "../summaries/fallback";
import { parseAiInput, type AiInput } from "./contract";

export const scope = { incidentId: "incident", analysisId: "analysis", intervalId: "interval", sourceVersion: "verified-source-and-copy-version-1" };
export const rawText = "All times IST\nEquipment ID: REF-01\nReported fault: compressor fault\nRefrigeration restarted: 04:00 on 10 March 2026";
export function extractionInput(raw = rawText) {
  return parseAiInput({ task: "extraction", scope, document: { id: "report", docType: "maintenance_report", correctionId: null, rawText: raw } });
}
export function summaryInput(): Extract<AiInput, { task: "summary" }> {
  const scenario = getScenario("worked-example")!, settings = { abnormalAboveC: 5, minAbnormalMinutes: 30, maxGapMinutes: 30 };
  const interval = analyzeTemperature(scenario.readings, settings).abnormalIntervals[0];
  const [exposure] = calculateBatchExposure([interval], scenario.batches);
  const { facts } = createFallbackSummary({ analysisId: scope.analysisId, interval, exposure, settings, gaps: [], reports: [], conflicts: [], missingItems: [] });
  const references = [...new Map(facts.flatMap((fact) => fact.sources).filter((source) => source.type !== "document").map((source) => [JSON.stringify(source), source])).values()];
  return parseAiInput({ task: "summary", scope: { ...scope, intervalId: interval.id }, facts, documents: [], references }) as Extract<AiInput, { task: "summary" }>;
}
export function questionsInput(): Extract<AiInput, { task: "questions" }> {
  return parseAiInput({ task: "questions", scope, documents: [], references: [{ type: "analysis", id: "analysis" }], items: [
    { id: "stock_inspection_report", kind: "missing", text: "A stock inspection report is missing.", question: "Could you supply a stock inspection report for this incident?", sources: [{ type: "analysis", id: "analysis" }] },
    { id: "restart-conflict", kind: "conflict", text: "Later readings remain high after the reported restart.", question: "Could you clarify the reported restart and subsequent temperature readings?", sources: [{ type: "analysis", id: "analysis" }] },
  ] }) as Extract<AiInput, { task: "questions" }>;
}
