import { workedExample } from "../worked-example";
import type { ExpectedInterval, ScenarioBatch, ScenarioDocument, ScenarioReading } from "./types";

export function at(minute: number) {
  const hour = String(Math.floor(minute / 60)).padStart(2, "0");
  return `2026-03-10T${hour}:${String(minute % 60).padStart(2, "0")}:00+05:30`;
}

export function batchesWith(changes: Partial<Record<"A" | "B" | "C", Partial<ScenarioBatch>>> = {}): ScenarioBatch[] {
  return workedExample.batches.map((batch) => ({ ...batch, ...changes[batch.batchCode as "A" | "B" | "C"] }));
}

export function readingsFor(id: string, windows: { start: number; end: number | null }[], missing: number[] = [], extraTimes: number[] = [], noise = false): ScenarioReading[] {
  const times = [...new Set([...Array.from({ length: 144 }, (_, i) => i * 10), ...extraTimes])].sort((a, b) => a - b);
  return times.filter((minute) => !missing.includes(minute)).map((minute, index) => ({
    id: `${id}-reading-${String(minute).padStart(4, "0")}`,
    chamberId: "CH-1",
    scenarioId: id,
    recordedAt: at(minute),
    temperatureC: windows.some((w) => minute >= w.start && (w.end === null || minute < w.end))
      ? [6.1, 6.5, 7, 6.7][index % 4]
      : (noise ? [2.6, 3.4, 2.9, 3.2, 5] : [3, 3.1, 2.9, 3.2])[index % (noise ? 5 : 4)],
  }));
}

// These defaults are an authored oracle, not results derived from the readings.
export function expectedInterval(start = 80, end: number | null = 340, overrides: Partial<ExpectedInterval> = {}): ExpectedInterval {
  return {
    start: at(start), end: end === null ? null : at(end),
    presentThroughout: ["A", "B"], presentPartially: [], notPresent: ["C"],
    exposureValueInr: 80000, valuationComplete: true,
    readiness: "Ready for initial review", priority: "Standard priority",
    dataGapUncertainty: false, keyReasons: ["resolved_without_detected_conflict"],
    ...overrides,
  };
}

interface ReportOptions {
  equipmentId?: string;
  cause?: string;
  restart?: string | null;
  repair?: string | null;
  fault?: string;
  inspection?: boolean;
  maintenance?: boolean;
  messy?: boolean;
  intervalIndex?: number;
  inspectionAt?: string;
  batchCodes?: string[];
}

export function reportsFor(id: string, options: ReportOptions = {}): ScenarioDocument[] {
  const intervalIndex = options.intervalIndex ?? 0;
  const equipment = options.equipmentId ?? "REF-01";
  const cause = options.cause ?? "compressor fault";
  const fault = options.fault ?? at(70);
  const restart = options.restart === undefined ? at(310) : options.restart;
  const repair = options.repair === undefined ? at(300) : options.repair;
  const documents: ScenarioDocument[] = [];
  if (options.maintenance !== false) {
    documents.push({
      id: `${id}-maintenance-${intervalIndex}`,
      filename: `fictional-maintenance-${intervalIndex}.txt`,
      docType: "maintenance_report", intervalIndex,
      rawText: `FICTIONAL DEMONSTRATION RECORD — ${options.messy ? "SERVICE LOG // handwritten transcription" : "Maintenance report"}
Chamber: CH-1. ${options.messy ? "Unit / asset" : "Equipment ID"}: ${equipment}.
All timestamps have the explicit IST offset +05:30.
Fault reported: ${fault}. Reported cause: ${cause}.
${repair === null ? "Repairs were not complete when this note was prepared." : `Repair completed: ${repair}.`}
${restart === null ? "Refrigeration had not restarted when this note was prepared; no restart time is reported." : `Refrigeration restarted: ${restart}.`}

The operator asked the fictional service technician to examine the equipment following the reported interruption. The cause above is the cause stated in this record; this note makes no additional inference about missing observations. Retain the temperature log and verify the equipment identifier and dates against the chamber records. A period of cooling may follow a restart.

This service note concerns equipment only. It does not inspect the potatoes, verify inventory valuations, determine deterioration, or promise an insurance outcome. Please refer questions about stock condition to the separate inspection record and arrange further human assessment where needed. Prepared for the ColdCover fictional demonstration.`,
    });
  }
  if (options.inspection !== false) {
    documents.push({
      id: `${id}-inspection-${intervalIndex}`,
      filename: `fictional-inspection-${intervalIndex}.txt`,
      docType: "stock_inspection_report", intervalIndex,
      rawText: `FICTIONAL DEMONSTRATION RECORD — Stock inspection report
Chamber CH-1; commodity: potatoes; inspection date: ${options.inspectionAt ?? (restart === null ? at(1430) : at(480))}.
${options.messy ? "Batch refs (copied from register)" : "The register references batches"}: ${(options.batchCodes ?? ["A", "B", "C"]).join(options.messy ? " / " : ", ")}; this list does not establish presence during the temperature interval.

The fictional inspector reviewed the accessible storage area and recorded that a separate assessment is needed to establish the condition of the stock. This report contains observations only; it does not declare any batch deteriorated. Inventory quantity, entry and exit times, and recorded values should be taken from the batch register and checked against supporting stock records.

Review this note with the temperature log and equipment report. Any difference between records should be clarified with the operator without assigning blame. This inspection does not calculate compensation, make a coverage decision, or determine payment. All people, goods, times and observations in this document are fictional demonstration material. Prepared by Demo Stock Inspector for human review.`,
    });
  }
  return documents;
}
