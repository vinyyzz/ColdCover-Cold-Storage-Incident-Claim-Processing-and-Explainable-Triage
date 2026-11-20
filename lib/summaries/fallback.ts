import { formatPaise } from "../analysis/contract";
import { fieldLabels, type EvidenceQuote } from "../documents/contract";
import type { AbnormalInterval, DataGap, IntervalBatchExposure, TemperatureRuleSettings } from "../rules";
import type { TriageChecklistItem, TriageReason, TriageSource } from "../rules/triage-types";
import { chartDate } from "../temperature/chart";
import { summaryFactSchema, validateFallbackStatements, type FallbackSummary, type SummaryFact } from "./contract";

export interface SummaryEvidence {
  analysisId: string;
  interval: AbnormalInterval;
  settings: TemperatureRuleSettings;
  exposure: IntervalBatchExposure;
  gaps: DataGap[];
  reports: { id: string; docType: "maintenance_report" | "stock_inspection_report"; correctionId: string | null; fields: EvidenceQuote[] }[];
  conflicts: TriageReason[];
  missingItems: TriageChecklistItem[];
}

const date = (value: string) => `${chartDate(Date.parse(value))} IST`;
const sourceReviewOnly = /\b(?:spoil(?:ed|age)?|loss(?:es)?|payout|pay(?:ment|able)?|compensat(?:ion|e)|entitle(?:d|ment)|insurer|insurance|claim|cover(?:ed|age)?)\b/i;

/** Structured, verified facts only: no raw reports, DB, provider, or clock. */
export function createFallbackSummary(input: SummaryEvidence): FallbackSummary {
  const { interval, exposure } = input;
  if (exposure.intervalId !== interval.id || exposure.start !== interval.start || exposure.end !== interval.end) throw new Error("Summary interval and inventory evidence differ.");
  const facts: SummaryFact[] = [];
  const analysis: TriageSource = { type: "analysis", id: input.analysisId };
  const add = (source_id: string, kind: SummaryFact["kind"], text: string, sources: TriageSource[]) => facts.push(summaryFactSchema.parse({ source_id, kind, text, sources }));
  const observed = interval.ongoing
    ? `starts at ${date(interval.start)} and has no recorded recovery by the last observation at ${date(interval.observedUntil)}`
    : `runs from ${date(interval.start)} to the first recorded normal observation at ${date(interval.end!)}`;
  add("interval", "interval", `The selected saved temperature evidence records an above-${input.settings.abnormalAboveC} °C interval that ${observed}.${interval.dataGapUncertainty ? " Gaps leave continuity and interval boundaries uncertain." : ""}`, [analysis, { type: "reading", id: interval.startReadingId }, { type: "reading", id: interval.endReadingId ?? interval.lastAbnormalReadingId }]);
  const exposed = exposure.batches.filter((batch) => batch.classification !== "not_present");
  add("inventory", "inventory", `${exposed.length} supplied ${exposed.length === 1 ? "batch overlaps" : "batches overlap"} this interval. Inventory value under investigation: ${formatPaise(exposure.knownValueSubtotalPaise)} (known recorded subtotal).${exposure.valuationComplete ? "" : ` Recorded values are missing for ${exposure.missingValuationBatchIds.length} overlapping supplied ${exposure.missingValuationBatchIds.length === 1 ? "batch" : "batches"}; the subtotal is incomplete.`} Partial overlaps include the full recorded value.`, [analysis, ...exposed.map((batch): TriageSource => ({ type: "batch", id: batch.id }))]);
  for (const batch of exposure.batches) {
    const presence = batch.classification === "not_present" ? "not present" : batch.classification === "present_partially" ? "present partially" : "present throughout";
    const value = batch.classification === "not_present" ? "" : batch.recordedValuePaise === null ? " Recorded inventory value is missing." : ` Recorded inventory value: ${formatPaise(batch.recordedValuePaise)}.`;
    add(`batch:${batch.id}`, "batch", `Batch ${batch.batchCode}: ${presence} according to recorded storage. ${batch.reason}${value}`, [analysis, { type: "batch", id: batch.id }]);
  }
  for (const gap of input.gaps) add(`gap:${gap.id}`, "gap", `Readings are missing between ${date(gap.start)} and ${date(gap.end)}. Endpoint observations do not establish continuous conditions; clarify the gap.`, [analysis, { type: "reading", id: gap.leftReadingId }, { type: "reading", id: gap.rightReadingId }]);
  for (const report of input.reports) {
    const label = report.docType === "maintenance_report" ? "Maintenance report" : "Stock inspection report";
    if (!report.fields.length) add(`report:${report.id}:presence`, "report", `An explicitly associated ${label.toLowerCase()} is supplied. No supported summary field is available; inspect the original wording.`, [{ type: "document", id: report.id, correctionId: report.correctionId }]);
    for (const [index, quote] of report.fields.entries()) {
      const wording = sourceReviewOnly.test(quote.quote)
        ? `${label} — ${fieldLabels[quote.field].toLowerCase()}: inspect the original passage for human review; its wording is not repeated in this summary.`
        : `${label} — ${fieldLabels[quote.field].toLowerCase()} (unverified reported wording): “${quote.quote}”`;
      add(`report:${report.id}:${quote.field}:${index}`, "report", wording, [{ type: "document", id: report.id, correctionId: report.correctionId, quote }]);
    }
  }
  for (const conflict of input.conflicts) add(`conflict:${conflict.id}`, "conflict", `Clarification needed: ${conflict.text}`, conflict.sources);
  for (const item of input.missingItems) {
    if (item.status !== "missing") throw new Error("Summary missing items must come from the missing checklist.");
    add(`missing:${item.id}`, "missing", item.id === "stock_inspection_report" ? "A stock inspection report is needed to assess the condition of the stock; temperature evidence alone does not establish its condition." : item.text, item.sources);
  }
  const statements = validateFallbackStatements(facts.map((fact) => ({ text: fact.text, source_ids: [fact.source_id] })), facts);
  return structuredClone({ version: "fallback-summary-v1", mode: "fallback", facts, statements });
}
