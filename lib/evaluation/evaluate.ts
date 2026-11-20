import { z } from "zod";
import { demonstrationPolicy } from "../demo/policy";
import { getScenario, scenarioCatalog } from "../demo/scenarios/catalog";
import type { ScenarioExpected, ScenarioFixture } from "../demo/scenarios/types";
import { documentInputSchema, scalarFields } from "../documents/contract";
import { extractDocument, verifyStoredExtraction } from "../documents/extract";
import { analyzeTemperature, calculateBatchExposure, evaluateTriage, type TriageDocumentInput, type TriageReason } from "../rules";
import { inrToPaise } from "../rules/exposure";
import { documentSources, readTriageDocument } from "../rules/triage-documents";
import { ruleInstantSchema } from "../rules/validation";
import { createFallbackSummary } from "../summaries/fallback";
import { EVALUATION_VERSION, equalComparison, evaluationCriteria, parseEvaluationReport, scenarioActualSchema, type Comparison, type EvaluationReport, type ScenarioActual, type ScenarioResult } from "./contract";

type ScenarioSource = Omit<ScenarioFixture, "expected">;
const id = z.string().min(1).max(120);
const sourceSchema = z.object({
  id, number: z.number().int().min(1).max(30), name: z.string().min(1), category: z.string().min(1), description: z.string(),
  readings: z.array(z.object({ id, chamberId: z.literal("CH-1"), scenarioId: id, recordedAt: ruleInstantSchema, temperatureC: z.number() }).strict()).min(1).max(20_000),
  batches: z.array(z.object({ id, batchCode: z.string().min(1), ownerName: z.string().min(1), chamberId: z.literal("CH-1"), quantityKg: z.number().positive(), recordedValueInr: z.number().nonnegative().nullable(), enteredAt: ruleInstantSchema, exitedAt: ruleInstantSchema.nullable() }).strict()),
  documents: z.array(z.object({ id, docType: documentInputSchema.shape.docType, filename: documentInputSchema.shape.filename, rawText: documentInputSchema.shape.rawText, intervalIndex: z.number().int().nonnegative() }).strict()),
}).strict();
const settings = { abnormalAboveC: evaluationCriteria.abnormalAboveC, minAbnormalMinutes: evaluationCriteria.minAbnormalMinutes, maxGapMinutes: evaluationCriteria.maxGapMinutes };

/** Source-only computation: has no oracle, DB, network, clock or saved-incident access. */
export function computeScenario(rawSource: ScenarioSource): ScenarioActual {
  const source = sourceSchema.parse(rawSource);
  if (source.readings.some((reading) => reading.scenarioId !== source.id) || new Set(source.documents.map((doc) => doc.id)).size !== source.documents.length) throw new Error("Fixture source identity differs.");
  const temporal = analyzeTemperature(source.readings, settings);
  const exposures = calculateBatchExposure(temporal.abnormalIntervals, source.batches);
  const analysisId = `evaluation-${source.id}`;
  const documents = source.documents.map((doc) => {
    if (!temporal.abnormalIntervals[doc.intervalIndex]) throw new Error("Fixture report has no explicitly associated qualified interval.");
    const incidentId = `evaluation-${source.id}-${doc.intervalIndex}`;
    const stored = extractDocument(doc.rawText, doc.id, { method: "operator_selected", incidentId, analysisId });
    if (!verifyStoredExtraction(doc.rawText, doc.id, incidentId, stored)) throw new Error("Fixture extraction failed source verification.");
    return { ...doc, incidentId, stored };
  });
  const revisions = new Map([[analysisId, 1]]);
  const intervals = temporal.abnormalIntervals.map((interval, index): ScenarioActual["intervals"][number] => {
    const incidentId = `evaluation-${source.id}-${index}`, exposure = exposures[index];
    const attached: TriageDocumentInput[] = documents.filter((doc) => doc.intervalIndex === index).map((doc) => ({
      id: doc.id, incidentId, associationAnalysisId: analysisId, docType: doc.docType, rawText: doc.rawText, extractionSource: "fallback", extractionJson: doc.stored,
      corrections: { latestCorrectionId: null, selectedCorrectionId: null, history: [] },
    }));
    const triage = evaluateTriage({ incidentId, selectedAnalysisId: analysisId, linkedAnalyses: [{ id: analysisId, revision: 1 }], intervalId: interval.id, equipment: { id: "fixture-equipment-ref-01", code: evaluationCriteria.equipmentCode }, settingsId: "fixture-thresholds", settings, highExposureThresholdPaise: evaluationCriteria.highExposureThresholdPaise, readings: source.readings, batches: source.batches, documents: attached, stockRecords: [], policyId: demonstrationPolicy.id });
    const verified = attached.map((doc) => readTriageDocument(doc, revisions, 1));
    const dateObservations: TriageReason[] = [];
    const intervalFirstDay = interval.start.slice(0, 10), intervalLastDay = (interval.end ?? interval.observedUntil).slice(0, 10);
    for (const doc of verified.filter((doc) => doc.input.docType === "maintenance_report")) for (const field of ["fault_time", "repair_time", "restart_time"] as const) {
      const value = doc.facts?.[field];
      if (value && (value.slice(0, 10) < intervalFirstDay || value.slice(0, 10) > intervalLastDay)) dateObservations.push({ id: `reported-date:${doc.input.id}:${field}`, code: "report_date_difference", text: `The maintenance report states ${field.replaceAll("_", " ")} on ${value.slice(0, 10)} IST; the selected interval observations run from ${intervalFirstDay} to ${intervalLastDay} IST. Clarify which event this report describes. This date observation is not an additional priority rule.`, sources: [...documentSources(doc, field), { type: "analysis", id: analysisId }] });
    }
    const summary = createFallbackSummary({ analysisId, interval, exposure, settings, gaps: temporal.dataGaps.filter((gap) => interval.gapIds.includes(gap.id)), reports: verified.map((doc) => {
      const fields = doc.facts?.evidence_quotes.filter((quote) => (scalarFields as readonly string[]).includes(quote.field)) ?? [];
      for (const quote of doc.unknownCauseQuotes) if (!fields.some((field) => JSON.stringify(field) === JSON.stringify(quote))) fields.push(quote);
      return { id: doc.input.id, docType: doc.input.docType, correctionId: doc.correctionId, fields };
    }), conflicts: triage.conflicts, missingItems: triage.checklist.filter((item) => item.status === "missing") });
    const presence = (classification: string) => exposure.batches.filter((batch) => batch.classification === classification).map((batch) => batch.batchCode).sort();
    return {
      id: interval.id, incidentId, start: interval.start, end: interval.end, observedUntil: interval.observedUntil, ongoing: interval.ongoing, dataGapUncertainty: interval.dataGapUncertainty,
      presentThroughout: presence("present_throughout"), presentPartially: presence("present_partially"), notPresent: presence("not_present"), knownValueSubtotalPaise: exposure.knownValueSubtotalPaise, valuationComplete: exposure.valuationComplete,
      readiness: triage.readiness.status, priority: triage.priority.status, reasons: [...triage.readiness.reasons, ...triage.priority.reasons], questions: triage.questions.map(({ id, code, text, sources }) => ({ id, code, text, sources })),
      checklist: triage.checklist.map(({ id, status, text, sources }) => ({ id, status, text, sources })), dateObservations, documentIds: attached.map((doc) => doc.id), summary: { facts: summary.facts, statements: summary.statements },
    };
  });
  return scenarioActualSchema.parse({ analysisId, intervals, briefSpikes: temporal.briefSpikes.map(({ start, end, durationMinutes }) => ({ start, end, durationMinutes })), dataGaps: temporal.dataGaps.map(({ start, end }) => ({ start, end })), readings: source.readings.map(({ id, recordedAt, temperatureC }) => ({ id, recordedAt, temperatureC })), batches: source.batches.map(({ id, batchCode, ownerName, quantityKg, recordedValueInr, enteredAt, exitedAt }) => ({ id, batchCode, ownerName, quantityKg, recordedValueInr, enteredAt, exitedAt })), documents: documents.map(({ id, docType, intervalIndex, rawText, stored }) => ({ id, docType, intervalIndex, rawText, extraction: stored.extraction, warnings: stored.warnings })) });
}

const normalized = (value: string | null) => value === null ? null : ruleInstantSchema.parse(value);
const reasonCodes: Record<string, string> = { missing_inspection_report: "missing_stock_inspection_report", missing_maintenance_report: "missing_maintenance_report", missing_batch_valuation: "missing_batch_valuations", equipment_id_mismatch: "equipment_mismatch", restart_log_conflict: "restart_log_conflict", cause_unclear: "cause_unclear", ongoing_interval: "ongoing_interval", high_exposure: "high_recorded_exposure" };

/** Oracles enter only here, after actual results have already been computed. */
export function compareScenario(actual: ScenarioActual, expected: ScenarioExpected): Comparison[] {
  const checks: Comparison[] = [];
  const check = (id: string, label: string, wanted: Comparison["expected"], observed: Comparison["actual"]) => checks.push({ id, label, expected: wanted, actual: observed, passed: equalComparison(wanted, observed) });
  check("interval-count", "Qualified interval count", expected.abnormalIntervals.length, actual.intervals.length);
  check("spikes", "Brief spikes: start / end / minutes", expected.briefSpikes.map((spike) => `${normalized(spike.start)} / ${normalized(spike.end) ?? "ongoing"} / ${spike.durationMinutes}`), actual.briefSpikes.map((spike) => `${spike.start} / ${spike.end ?? "ongoing"} / ${spike.durationMinutes}`));
  check("gaps", "Data gaps: start / end", expected.dataGaps.map((gap) => `${normalized(gap.start)} / ${normalized(gap.end)}`), actual.dataGaps.map((gap) => `${gap.start} / ${gap.end}`));
  for (const [index, oracle] of expected.abnormalIntervals.entries()) {
    const interval = actual.intervals[index], prefix = `interval-${index}`;
    if (!interval) { check(prefix, `Interval ${index + 1} exists`, true, false); continue; }
    const label = (name: string) => `Interval ${index + 1}: ${name}`;
    check(`${prefix}-start`, label("start"), normalized(oracle.start), interval.start);
    check(`${prefix}-end`, label("first normal observation / ongoing"), normalized(oracle.end), interval.end);
    for (const property of ["presentThroughout", "presentPartially", "notPresent"] as const) check(`${prefix}-${property}`, label(property === "presentThroughout" ? "batches present throughout" : property === "presentPartially" ? "batches present partially" : "batches not present"), [...oracle[property]].sort(), interval[property]);
    const paise = inrToPaise(oracle.exposureValueInr); if (paise === undefined) throw new Error("Invalid oracle monetary value.");
    check(`${prefix}-knownValueSubtotalPaise`, label("known inventory subtotal"), paise, interval.knownValueSubtotalPaise);
    for (const property of ["valuationComplete", "dataGapUncertainty", "readiness", "priority"] as const) check(`${prefix}-${property}`, label(property === "valuationComplete" ? "recorded valuations complete" : property === "dataGapUncertainty" ? "gap uncertainty" : property), oracle[property], interval[property]);
    const codes = new Set([...interval.reasons, ...interval.dateObservations].map((reason) => reason.code));
    for (const reason of oracle.keyReasons) {
      const present = reason === "data_gap_uncertainty" ? interval.dataGapUncertainty : reason === "resolved_without_detected_conflict" ? !interval.ongoing && interval.priority === "Standard priority" : reason === "report_date_difference" ? codes.has(reason) : reasonCodes[reason] ? codes.has(reasonCodes[reason]) : false;
      check(`${prefix}-reason-${reason}`, label(`required observation: ${reason.replaceAll("_", " ")}`), true, present);
    }
  }
  return checks;
}

export function evaluateFixture(fixture: ScenarioFixture): ScenarioResult {
  const { expected, ...source } = structuredClone(fixture);
  try {
    const actual = computeScenario(source), comparisons = compareScenario(actual, expected);
    return { id: source.id, number: source.number, name: source.name, category: source.category, status: comparisons.every((check) => check.passed) ? "passed" : "different", error: null, actual, comparisons };
  } catch { return { id: source.id, number: source.number, name: source.name, category: source.category, status: "error", error: "The fixture could not be evaluated from its source records. No calculated outcome is available for this case.", actual: null, comparisons: [] }; }
}

export function runAllScenarios(checkedAt: string): EvaluationReport {
  const results = scenarioCatalog.map(({ id }) => { const fixture = getScenario(id); if (!fixture) throw new Error("Missing catalogue fixture"); return evaluateFixture(fixture); });
  return parseEvaluationReport({ version: EVALUATION_VERSION, checkedAt, mode: "isolated_fixtures", persisted: false, criteria: evaluationCriteria, total: 30, passed: results.filter((row) => row.status === "passed").length, different: results.filter((row) => row.status === "different").length, errors: results.filter((row) => row.status === "error").length, results });
}
