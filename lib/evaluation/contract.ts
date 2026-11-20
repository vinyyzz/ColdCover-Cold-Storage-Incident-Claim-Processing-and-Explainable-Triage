import { z } from "zod";
import { demonstrationPolicy } from "../demo/policy";
import { extractionSchema } from "../documents/contract";
import { ruleInstantSchema } from "../rules/validation";
import { summaryFactSchema, summarySourceSchema, summaryStatementSchema, validateFallbackStatements } from "../summaries/contract";

export const EVALUATION_VERSION = "scenario-evaluation-v1";
export const evaluationCriteria = { chamberId: "CH-1", equipmentCode: "REF-01", abnormalAboveC: 5, minAbnormalMinutes: 30, maxGapMinutes: 30, highExposureThresholdPaise: 15_000_000 } as const;
const id = z.string().min(1).max(600);
const text = z.string().min(1).max(5000);
const instant = ruleInstantSchema;
const valueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]);
export const comparisonSchema = z.object({ id, label: text, expected: valueSchema, actual: valueSchema, passed: z.boolean() }).strict();
const reasonSchema = z.object({ id, code: id, text, sources: z.array(summarySourceSchema).min(1) }).strict();
const readiness = z.enum(["Needs more evidence", "Ready for initial review"]);
const priority = z.enum(["Specialist review required", "High priority", "Standard priority"]);
const intervalSchema = z.object({
  id, incidentId: id, start: instant, end: instant.nullable(), observedUntil: instant, ongoing: z.boolean(), dataGapUncertainty: z.boolean(),
  presentThroughout: z.array(id), presentPartially: z.array(id), notPresent: z.array(id),
  knownValueSubtotalPaise: z.number().int().nonnegative().safe(), valuationComplete: z.boolean(),
  readiness, priority, reasons: z.array(reasonSchema), questions: z.array(reasonSchema), dateObservations: z.array(reasonSchema),
  checklist: z.array(z.object({ id, status: z.enum(["provided", "missing", "not_applicable"]), text, sources: z.array(summarySourceSchema).min(1) }).strict()),
  documentIds: z.array(id), summary: z.object({ facts: z.array(summaryFactSchema).min(1), statements: z.array(summaryStatementSchema).min(1) }).strict(),
}).strict();
export const scenarioActualSchema = z.object({
  analysisId: id, intervals: z.array(intervalSchema),
  briefSpikes: z.array(z.object({ start: instant, end: instant.nullable(), durationMinutes: z.number().nonnegative() }).strict()),
  dataGaps: z.array(z.object({ start: instant, end: instant }).strict()),
  readings: z.array(z.object({ id, recordedAt: instant, temperatureC: z.number() }).strict()),
  batches: z.array(z.object({ id, batchCode: id, ownerName: text, quantityKg: z.number().positive(), recordedValueInr: z.number().nonnegative().nullable(), enteredAt: instant, exitedAt: instant.nullable() }).strict()),
  documents: z.array(z.object({ id, docType: z.enum(["maintenance_report", "stock_inspection_report"]), intervalIndex: z.number().int().nonnegative(), rawText: text.max(50_000), extraction: extractionSchema, warnings: z.array(text) }).strict()),
}).strict();
export const scenarioResultSchema = z.object({
  id, number: z.number().int().min(1).max(30), name: text, category: id,
  status: z.enum(["passed", "different", "error"]), error: text.nullable(),
  comparisons: z.array(comparisonSchema), actual: scenarioActualSchema.nullable(),
}).strict();
const reportSchema = z.object({
  version: z.literal(EVALUATION_VERSION), checkedAt: instant, mode: z.literal("isolated_fixtures"), persisted: z.literal(false),
  criteria: z.object({ chamberId: z.literal("CH-1"), equipmentCode: z.literal("REF-01"), abnormalAboveC: z.literal(5), minAbnormalMinutes: z.literal(30), maxGapMinutes: z.literal(30), highExposureThresholdPaise: z.literal(15_000_000) }).strict(),
  total: z.literal(30), passed: z.number().int().min(0).max(30), different: z.number().int().min(0).max(30), errors: z.number().int().min(0).max(30),
  results: z.array(scenarioResultSchema).length(30),
}).strict();
export type Comparison = z.infer<typeof comparisonSchema>;
export type ScenarioActual = z.infer<typeof scenarioActualSchema>;
export type ScenarioResult = z.infer<typeof scenarioResultSchema>;
export type EvaluationReport = z.infer<typeof reportSchema>;
export const equalComparison = (a: Comparison["actual"], b: Comparison["expected"]) => JSON.stringify(a) === JSON.stringify(b);

/** Validate totals/comparisons/support, never calculate rule outcomes in the client. */
export function parseEvaluationReport(value: unknown): EvaluationReport {
  const report = reportSchema.parse(value);
  if (new Set(report.results.map((row) => row.id)).size !== 30 || report.results.some((row, index) => row.number !== index + 1 || row.id !== (row.number === 4 ? "worked-example" : `scenario-${String(row.number).padStart(2, "0")}`))) throw new Error("Evaluation catalogue membership differs.");
  for (const row of report.results) {
    if (row.status === "error") {
      if (!row.error || row.actual !== null || row.comparisons.length) throw new Error("Failed evaluation cannot present calculated outcomes.");
      continue;
    }
    if (row.error !== null || !row.actual || !row.comparisons.length || new Set(row.comparisons.map((check) => check.id)).size !== row.comparisons.length || row.comparisons.some((check) => check.passed !== equalComparison(check.actual, check.expected)) || (row.status === "passed") !== row.comparisons.every((check) => check.passed)) throw new Error("Evaluation status differs from its comparisons.");
    if ([row.actual.documents, row.actual.readings, row.actual.batches].some((records) => new Set(records.map((record) => record.id)).size !== records.length)) throw new Error("Duplicate evaluation source identity.");
    for (const doc of row.actual.documents) for (const quote of doc.extraction.evidence_quotes) {
      const exact = (p: { start: number; end: number; quote: string }) => p.end > p.start && p.end <= doc.rawText.length && doc.rawText.slice(p.start, p.end) === p.quote;
      if (quote.source_document_id !== doc.id || !exact(quote) || (quote.time_zone_context && !exact(quote.time_zone_context))) throw new Error("Evaluation extraction passage differs.");
    }
    if (row.actual.documents.some((doc) => !row.actual!.intervals[doc.intervalIndex]?.documentIds.includes(doc.id))) throw new Error("Unassigned evaluation document.");
    for (const [index, interval] of row.actual.intervals.entries()) {
      validateFallbackStatements(interval.summary.statements, interval.summary.facts);
      if (interval.ongoing !== (interval.end === null) || Date.parse(interval.observedUntil) < Date.parse(interval.start)) throw new Error("Invalid interval envelope.");
      const documents = row.actual.documents.filter((doc) => interval.documentIds.includes(doc.id));
      if (documents.length !== interval.documentIds.length || documents.some((doc) => doc.intervalIndex !== index)) throw new Error("Evaluation report membership differs.");
      const codes = [...interval.presentThroughout, ...interval.presentPartially, ...interval.notPresent];
      if (new Set(codes).size !== row.actual.batches.length || codes.length !== row.actual.batches.length || codes.some((code) => !row.actual!.batches.some((batch) => batch.batchCode === code))) throw new Error("Evaluation batch partition differs.");
      for (const source of [...interval.summary.facts.flatMap((fact) => fact.sources), ...interval.reasons.flatMap((reason) => reason.sources), ...interval.dateObservations.flatMap((reason) => reason.sources), ...interval.questions.flatMap((reason) => reason.sources), ...interval.checklist.flatMap((item) => item.sources)]) {
        if (source.type === "reading" && !row.actual.readings.some((reading) => reading.id === source.id)) throw new Error("Evaluation reading source is absent.");
        if (source.type === "analysis" && source.id !== row.actual.analysisId) throw new Error("Evaluation analysis source differs.");
        if (source.type === "batch" && !row.actual.batches.some((batch) => batch.id === source.id)) throw new Error("Evaluation batch source is absent.");
        if ((source.type === "settings" && source.id !== "fixture-thresholds") || (source.type === "equipment" && source.id !== "fixture-equipment-ref-01") || (source.type === "policy" && source.id !== demonstrationPolicy.id)) throw new Error("Evaluation criterion source differs.");
        if (source.type === "document") {
          const doc = documents.find((doc) => doc.id === source.id);
          if (!doc || source.correctionId !== null) throw new Error("Evaluation document source differs.");
          if (source.quote) {
            const exact = (p: { start: number; end: number; quote: string }) => p.end > p.start && p.end <= doc.rawText.length && doc.rawText.slice(p.start, p.end) === p.quote;
            if (source.quote.source_document_id !== doc.id || !exact(source.quote) || (source.quote.time_zone_context && !exact(source.quote.time_zone_context))) throw new Error("Evaluation source passage differs.");
          }
        }
      }
    }
  }
  for (const [key, status] of [["passed", "passed"], ["different", "different"], ["errors", "error"]] as const) if (report[key] !== report.results.filter((row) => row.status === status).length) throw new Error("Evaluation totals differ.");
  return report;
}
