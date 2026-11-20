import { workedExample, workedExampleReadings } from "../worked-example";
import { at, batchesWith, expectedInterval as outcome, readingsFor, reportsFor } from "./builders";
import type { ScenarioCategory, ScenarioExpected, ScenarioFixture } from "./types";

type Definition = Pick<ScenarioFixture, "number" | "name" | "category"> & Partial<Pick<ScenarioFixture, "id" | "description" | "batches" | "readings" | "documents">> & {
  windows?: { start: number; end: number | null }[];
  missing?: number[];
  extraTimes?: number[];
  noise?: boolean;
  expected: ScenarioExpected;
};

const rise = [{ start: 80, end: 340 }];
const noIncident = (): ScenarioExpected => ({ abnormalIntervals: [], briefSpikes: [], dataGaps: [] });
const expected = (abnormalIntervals: ScenarioExpected["abnormalIntervals"], extras: Partial<ScenarioExpected> = {}): ScenarioExpected => ({ abnormalIntervals, briefSpikes: [], dataGaps: [], ...extras });

function fixture(definition: Definition): ScenarioFixture {
  const id = definition.id ?? `scenario-${String(definition.number).padStart(2, "0")}`;
  return {
    number: definition.number, id, name: definition.name, category: definition.category,
    description: definition.description ?? definition.name,
    batches: definition.batches ?? batchesWith(),
    readings: definition.readings ?? readingsFor(id, definition.windows ?? rise, definition.missing, definition.extraTimes, definition.noise),
    documents: definition.documents ?? (definition.expected.abnormalIntervals.length ? reportsFor(id) : []),
    expected: definition.expected,
  };
}

export function createScenarioCatalog(): ScenarioFixture[] {
  return [
    fixture({ number: 1, name: "Normal operation", category: "normal", windows: [], expected: noIncident() }),
    fixture({ number: 2, name: "Normal operation with minor noise", category: "normal", windows: [], noise: true, expected: noIncident() }),
    fixture({ number: 3, name: "Normal operation with stock movements", category: "normal", windows: [], batches: batchesWith({ A: { exitedAt: at(180) }, B: { enteredAt: at(240), exitedAt: at(600) } }).slice(0, 2), expected: noIncident() }),
    fixture({ number: 4, id: workedExample.scenarioId, name: "Worked example: prolonged temperature rise", category: "standard_incident", description: "01:20–05:40 IST; A and B present, C arrives later; inspection missing.", readings: workedExampleReadings(), documents: [{ id: workedExample.documentId, filename: "fictional-maintenance-REF-01.txt", docType: "maintenance_report", intervalIndex: 0, rawText: workedExample.maintenanceReport }], expected: expected([outcome(80, 340, { readiness: "Needs more evidence", keyReasons: ["missing_inspection_report"] })]) }),
    fixture({ number: 5, name: "Single-batch incident", category: "standard_incident", batches: batchesWith().slice(0, 1), documents: reportsFor("scenario-05", { batchCodes: ["A"] }), expected: expected([outcome(80, 340, { presentThroughout: ["A"], notPresent: [], exposureValueInr: 50000 })]) }),
    fixture({ number: 6, name: "All documents consistent; restart exactly 60 minutes before recovery", category: "standard_incident", documents: reportsFor("scenario-06", { restart: at(280), repair: at(270), messy: true }), expected: expected([outcome()]) }),
    fixture({ number: 7, name: "Three batches, one early departure; exposure exactly ₹1,50,000", category: "standard_incident", batches: batchesWith({ B: { exitedAt: at(180) }, C: { enteredAt: "2026-03-09T21:00:00+05:30", recordedValueInr: 70000 } }), expected: expected([outcome(80, 340, { presentThroughout: ["A", "C"], presentPartially: ["B"], notPresent: [], exposureValueInr: 150000 })]) }),
    fixture({ number: 8, name: "Fifteen-minute brief spike", category: "brief_spike", windows: [{ start: 80, end: 95 }], extraTimes: [95], expected: expected([], { briefSpikes: [{ start: at(80), end: at(95), durationMinutes: 15 }] }) }),
    fixture({ number: 9, name: "Twenty-minute brief spike", category: "brief_spike", windows: [{ start: 80, end: 100 }], expected: expected([], { briefSpikes: [{ start: at(80), end: at(100), durationMinutes: 20 }] }) }),
    fixture({ number: 10, name: "Two separate brief spikes", category: "brief_spike", windows: [{ start: 80, end: 100 }, { start: 160, end: 180 }], expected: expected([], { briefSpikes: [{ start: at(80), end: at(100), durationMinutes: 20 }, { start: at(160), end: at(180), durationMinutes: 20 }] }) }),
    fixture({ number: 11, name: "Missing readings inside the investigation window", category: "missing_readings", missing: [170, 180, 190], expected: expected([outcome(80, 340, { dataGapUncertainty: true, keyReasons: ["data_gap_uncertainty"] })], { dataGaps: [{ start: at(160), end: at(200) }] }) }),
    fixture({ number: 12, name: "Missing readings adjacent to the observed start", category: "missing_readings", missing: [50, 60, 70], expected: expected([outcome(80, 340, { dataGapUncertainty: true, keyReasons: ["data_gap_uncertainty"] })], { dataGaps: [{ start: at(40), end: at(80) }] }) }),
    fixture({ number: 13, name: "Missing readings at the observed end", category: "missing_readings", missing: [330, 340, 350], expected: expected([outcome(80, 360, { dataGapUncertainty: true, keyReasons: ["data_gap_uncertainty"] })], { dataGaps: [{ start: at(320), end: at(360) }] }) }),
    fixture({ number: 14, name: "Reported 04:00 restart conflicts with the log", category: "conflicting_evidence", documents: reportsFor("scenario-14", { restart: at(240), repair: at(230), messy: true }), expected: expected([outcome(80, 340, { priority: "Specialist review required", keyReasons: ["restart_log_conflict"] })]) }),
    fixture({ number: 15, name: "Wrong equipment identifier overrides high exposure", category: "conflicting_evidence", batches: batchesWith({ A: { recordedValueInr: 100000 }, B: { recordedValueInr: 60000 } }), documents: reportsFor("scenario-15", { equipmentId: "REF-99" }), expected: expected([outcome(80, 340, { exposureValueInr: 160000, priority: "Specialist review required", keyReasons: ["equipment_id_mismatch"] })]) }),
    fixture({ number: 16, name: "Report explicitly states cause is unknown", category: "conflicting_evidence", documents: reportsFor("scenario-16", { cause: "unknown", messy: true }), expected: expected([outcome(80, 340, { priority: "Specialist review required", keyReasons: ["cause_unclear"] })]) }),
    fixture({ number: 17, name: "Report and restart dated a day before the log", category: "conflicting_evidence", documents: reportsFor("scenario-17", { fault: "2026-03-09T01:10:00+05:30", repair: "2026-03-09T05:00:00+05:30", restart: "2026-03-09T05:10:00+05:30" }), expected: expected([outcome(80, 340, { priority: "Specialist review required", keyReasons: ["report_date_difference", "restart_log_conflict"] })]) }),
    fixture({ number: 18, name: "Ongoing failure at end of data", category: "ongoing", windows: [{ start: 1080, end: null }], batches: batchesWith({ C: { enteredAt: at(1430) } }), documents: reportsFor("scenario-18", { fault: at(1070), repair: null, restart: null }), expected: expected([outcome(1080, null, { presentThroughout: ["A", "B"], presentPartially: ["C"], notPresent: [], exposureValueInr: 100000, priority: "High priority", keyReasons: ["ongoing_interval"] })]) }),
    fixture({ number: 19, name: "Ongoing failure with inspection missing", category: "ongoing", windows: [{ start: 1080, end: null }], documents: reportsFor("scenario-19", { fault: at(1070), repair: null, restart: null, inspection: false }), expected: expected([outcome(1080, null, { presentThroughout: ["A", "B", "C"], notPresent: [], exposureValueInr: 100000, readiness: "Needs more evidence", priority: "High priority", keyReasons: ["ongoing_interval", "missing_inspection_report"] })]) }),
    fixture({ number: 20, name: "Ongoing failure with both reports present", category: "ongoing", windows: [{ start: 1080, end: null }], documents: reportsFor("scenario-20", { fault: at(1070), repair: null, restart: null, messy: true }), expected: expected([outcome(1080, null, { presentThroughout: ["A", "B", "C"], notPresent: [], exposureValueInr: 100000, priority: "High priority", keyReasons: ["ongoing_interval"] })]) }),
    fixture({ number: 21, name: "Batch departs exactly at interval start", category: "stock_timing", batches: batchesWith({ B: { exitedAt: at(80) } }), expected: expected([outcome(80, 340, { presentThroughout: ["A"], notPresent: ["B", "C"], exposureValueInr: 50000 })]) }),
    fixture({ number: 22, name: "Batch enters exactly at interval end", category: "stock_timing", batches: batchesWith({ B: { enteredAt: at(340) } }), expected: expected([outcome(80, 340, { presentThroughout: ["A"], notPresent: ["B", "C"], exposureValueInr: 50000 })]) }),
    fixture({ number: 23, name: "Batch enters during the interval", category: "stock_timing", batches: batchesWith({ B: { enteredAt: at(160) } }), expected: expected([outcome(80, 340, { presentThroughout: ["A"], presentPartially: ["B"] })]) }),
    fixture({ number: 24, name: "Inspection report missing", category: "missing_evidence", documents: reportsFor("scenario-24", { inspection: false }), expected: expected([outcome(80, 340, { readiness: "Needs more evidence", keyReasons: ["missing_inspection_report"] })]) }),
    fixture({ number: 25, name: "Maintenance report missing", category: "missing_evidence", documents: reportsFor("scenario-25", { maintenance: false }), expected: expected([outcome(80, 340, { readiness: "Needs more evidence", keyReasons: ["missing_maintenance_report"] })]) }),
    fixture({ number: 26, name: "Exposed batch valuation missing", category: "missing_evidence", batches: batchesWith({ B: { recordedValueInr: null } }), expected: expected([outcome(80, 340, { exposureValueInr: 50000, valuationComplete: false, readiness: "Needs more evidence", keyReasons: ["missing_batch_valuation"] })]) }),
    fixture({ number: 27, name: "Exposure above the priority threshold", category: "high_exposure", batches: batchesWith({ A: { recordedValueInr: 100000 }, B: { recordedValueInr: 60000 } }), expected: expected([outcome(80, 340, { exposureValueInr: 160000, priority: "High priority", keyReasons: ["high_exposure"] })]) }),
    fixture({ number: 28, name: "Exposure just below the priority threshold", category: "high_exposure", batches: batchesWith({ A: { recordedValueInr: 100000 }, B: { recordedValueInr: 49999 } }), expected: expected([outcome(80, 340, { exposureValueInr: 149999 })]) }),
    fixture({ number: 29, name: "Two separate incidents in one day", category: "multiple_events", windows: [{ start: 80, end: 160 }, { start: 600, end: 720 }], documents: [...reportsFor("scenario-29", { repair: at(130), restart: at(140) }), ...reportsFor("scenario-29", { intervalIndex: 1, fault: at(590), repair: at(690), restart: at(700), inspectionAt: at(780) })], expected: expected([outcome(80, 160), outcome(600, 720, { presentThroughout: ["A", "B", "C"], notPresent: [], exposureValueInr: 100000 })]) }),
    fixture({ number: 30, name: "Exactly 30 minutes qualifies; 29 minutes stays a spike", category: "boundary", windows: [{ start: 80, end: 110 }, { start: 160, end: 189 }], extraTimes: [189], missing: [50, 60], documents: reportsFor("scenario-30", { fault: at(70), repair: at(90), restart: at(100) }), expected: expected([outcome(80, 110)], { briefSpikes: [{ start: at(160), end: at(189), durationMinutes: 29 }] }) }),
  ];
}

export const scenarioCatalog: readonly ScenarioFixture[] = createScenarioCatalog();

export function getScenario(id: string): ScenarioFixture | undefined {
  const scenario = scenarioCatalog.find((item) => item.id === id);
  return scenario ? structuredClone(scenario) : undefined;
}

export const categoryLabels: Record<ScenarioCategory, string> = {
  normal: "Normal", standard_incident: "Standard incident", brief_spike: "Brief spike",
  missing_readings: "Missing readings", conflicting_evidence: "Conflicting evidence", ongoing: "Ongoing",
  stock_timing: "Timing of stock", missing_evidence: "Missing evidence", high_exposure: "High exposure",
  multiple_events: "Multiple events", boundary: "Boundary",
};
