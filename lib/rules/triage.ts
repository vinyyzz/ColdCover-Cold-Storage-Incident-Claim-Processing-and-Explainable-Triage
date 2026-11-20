import { z } from "zod";
import { documentInputSchema } from "../documents/contract";
import { calculateBatchExposure } from "./exposure";
import { analyzeTemperature } from "./temperature";
import { ruleInstantSchema } from "./validation";
import { documentSources, readTriageDocument } from "./triage-documents";
import type { ChecklistId, TriageChecklistItem, TriageInput, TriageQuestion, TriageReason, TriageResult, TriageSource } from "./triage-types";

const identifier = z.string().min(1).max(120).refine((s) => s.trim().length > 0);
const contextSchema = z.object({
  incidentId: identifier, selectedAnalysisId: identifier, intervalId: z.string().min(1).max(300),
  linkedAnalyses: z.array(z.object({ id: identifier, revision: z.number().int().positive().safe() }).strict()).min(1),
  equipment: z.object({ id: identifier, code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/) }).strict(),
  settingsId: identifier, highExposureThresholdPaise: z.number().int().nonnegative().safe(),
  documents: z.array(z.object({
    id: identifier, incidentId: identifier, associationAnalysisId: identifier,
    docType: z.enum(["maintenance_report", "stock_inspection_report"]), rawText: documentInputSchema.shape.rawText,
    extractionSource: z.literal("fallback").nullable(), extractionJson: z.unknown(),
    // Full history validation is performed by the shared pure verifier below.
    corrections: z.object({ latestCorrectionId: identifier.nullable(), selectedCorrectionId: identifier.nullable(), history: z.array(z.unknown()) }),
  })),
  stockRecords: z.array(z.object({ documentId: identifier, batchIds: z.array(identifier).min(1) }).strict()),
  policyId: identifier.nullable(),
});

/**
 * Unpersisted, deterministic triage of one explicitly selected investigation.
 * Callers supply same-chamber verified snapshots/membership and supporting IDs.
 * No association inference, wall-clock use, loss/payment or coverage decisions.
 */
export function evaluateTriage(input: TriageInput): TriageResult {
  const context = contextSchema.parse(input);
  const revisions = new Map(context.linkedAnalyses.map((row) => [row.id, row.revision]));
  if (revisions.size !== context.linkedAnalyses.length || new Set(revisions.values()).size !== revisions.size) throw new Error("Linked analysis IDs and revisions must be unique.");
  const selectedRevision = revisions.get(context.selectedAnalysisId);
  if (selectedRevision === undefined) throw new Error("Selected analysis is not linked to this incident.");
  const temporal = analyzeTemperature(input.readings, input.settings);
  const interval = temporal.abnormalIntervals.find((row) => row.id === context.intervalId);
  if (!interval) throw new Error("Select a qualified interval from the supplied temperature evidence, not a spike or draft.");
  const [exposure] = calculateBatchExposure([interval], input.batches);
  const batchIds = new Set(exposure.batches.map((row) => row.id));
  const ids = new Set<string>();
  const documents = input.documents.map((doc) => {
    if (ids.has(doc.id) || doc.incidentId !== context.incidentId) throw new Error("Reports need unique IDs and an explicit association to this incident.");
    ids.add(doc.id);
    return readTriageDocument(doc, revisions, selectedRevision);
  }).filter((doc) => revisions.get(doc.input.associationAnalysisId)! <= selectedRevision);
  const supportingIds = new Set<string>();
  for (const record of context.stockRecords) {
    if (ids.has(record.documentId) || supportingIds.has(record.documentId) || new Set(record.batchIds).size !== record.batchIds.length || record.batchIds.some((id) => !batchIds.has(id))) throw new Error("Supporting records need unique document IDs and explicit known batch associations.");
    supportingIds.add(record.documentId);
  }
  const analysis: TriageSource = { type: "analysis", id: context.selectedAnalysisId };
  const settings: TriageSource = { type: "settings", id: context.settingsId };
  const equipment: TriageSource = { type: "equipment", id: context.equipment.id };
  const reading = (id: string): TriageSource => ({ type: "reading", id });
  const batch = (id: string): TriageSource => ({ type: "batch", id });
  const maintenance = documents.filter((doc) => doc.input.docType === "maintenance_report");
  const inspection = documents.filter((doc) => doc.input.docType === "stock_inspection_report");
  const exposed = exposure.batches.filter((row) => row.classification !== "not_present");
  const exposedIds = exposed.map((row) => row.id);
  const lastHigh = input.readings.find((row) => row.id === interval.lastAbnormalReadingId)!;
  const conflicts: TriageReason[] = [];
  const questions: TriageQuestion[] = [];
  const reason = (id: string, code: string, text: string, sources: TriageSource[]): TriageReason => ({ id, code, text, sources });
  const question = (id: string, code: string, text: string, sources: TriageSource[], checklistId: ChecklistId | null = null, conflictId: string | null = null) => questions.push({ ...reason(id, code, text, sources), checklistId, conflictId });

  for (const doc of maintenance) {
    const facts = doc.facts;
    if (facts?.equipment_id && facts.equipment_id.toUpperCase() !== context.equipment.code.toUpperCase()) {
      const id = `equipment-mismatch:${doc.input.id}`;
      conflicts.push(reason(id, "equipment_mismatch", `Report identifies equipment ${facts.equipment_id}; the chamber equipment record identifies ${context.equipment.code}. Clarify which equipment this report describes.`, [...documentSources(doc, "equipment_id"), equipment]));
      question(`question:${id}`, "equipment_mismatch", "Could you confirm which equipment the maintenance report describes?", [...documentSources(doc, "equipment_id"), equipment], null, id);
    }
    if (facts?.restart_time && Date.parse(lastHigh.recordedAt) - Date.parse(facts.restart_time) > 60 * 60000) {
      const id = `restart-conflict:${doc.input.id}`;
      const caveat = interval.dataGapUncertainty ? " Missing readings leave continuity uncertain." : "";
      conflicts.push(reason(id, "restart_log_conflict", `Report states refrigeration resumed at ${facts.restart_time}, but a reading remains above ${input.settings.abnormalAboveC} °C at ${interval.ongoing ? "the last observed high sample, " : ""}${ruleInstantSchema.parse(lastHigh.recordedAt)}.${caveat} The chamber may take time to cool after a restart; clarify with the operator.`, [...documentSources(doc, "restart_time"), reading(lastHigh.id), settings, analysis]));
      question(`question:${id}`, "restart_log_conflict", "Could you clarify the reported restart and subsequent above-threshold readings, including any cooling period?", [...documentSources(doc, "restart_time"), reading(lastHigh.id)], null, id);
    }
    if (doc.unknownCauseQuotes.length) {
      const id = `unclear-cause:${doc.input.id}`;
      const sources: TriageSource[] = doc.unknownCauseQuotes.map((quote) => ({ type: "document", id: doc.input.id, correctionId: doc.correctionId, quote: structuredClone(quote) }));
      conflicts.push(reason(id, "cause_unclear", "The maintenance report explicitly describes the cause as unclear or unknown; specialist review is required.", sources));
      question(`question:${id}`, "cause_unclear", "Could you provide further service findings to clarify the reported cause?", sources, null, id);
    }
  }

  const checklist: TriageChecklistItem[] = [];
  const item = (id: ChecklistId, status: TriageChecklistItem["status"], text: string, sources: TriageSource[], missingQuestion: string, affected: string[] = []) => {
    const entry = { ...reason(id, id, text, sources), id, status, batchIds: affected };
    checklist.push(entry);
    if (status === "missing") question(`missing:${id}`, `missing_${id}`, missingQuestion, sources, id);
    return entry;
  };
  const maintenanceItem = item("maintenance_report", maintenance.length ? "provided" : "missing", maintenance.length ? "An explicitly associated maintenance report is provided; presence does not verify its findings." : "No maintenance report is supplied for this investigation.", maintenance.length ? maintenance.flatMap((doc) => documentSources(doc)) : [analysis], "Could you provide the maintenance report for this investigation?");
  const inspectionItem = item("stock_inspection_report", inspection.length ? "provided" : "missing", inspection.length ? "An explicitly associated stock inspection report is provided; stock condition still requires human assessment." : "No stock inspection report is supplied for this investigation.", inspection.length ? inspection.flatMap((doc) => documentSources(doc)) : [analysis], "Could you provide a stock inspection report for this investigation?");
  const valuationItem = item("batch_valuations", exposed.length === 0 ? "not_applicable" : exposure.valuationComplete ? "provided" : "missing", exposed.length === 0 ? "No supplied batch has a positive overlap with this interval." : exposure.valuationComplete ? "Every overlapping supplied batch has a recorded value, including any known zero." : "Recorded values are missing for one or more overlapping batches; the known subtotal is incomplete.", exposure.missingValuationBatchIds.length ? exposure.missingValuationBatchIds.map(batch) : exposed.length ? exposedIds.map(batch) : [analysis], "Could you provide the missing recorded valuations for the referenced overlapping batches?", exposure.missingValuationBatchIds.length ? [...exposure.missingValuationBatchIds] : exposedIds);
  const uncovered = exposedIds.filter((id) => !context.stockRecords.some((record) => record.batchIds.includes(id)));
  const stockSources: TriageSource[] = context.stockRecords.filter((record) => record.batchIds.some((id) => exposedIds.includes(id))).map((record) => ({ type: "document", id: record.documentId, correctionId: null }));
  item("stock_records", exposed.length === 0 ? "not_applicable" : uncovered.length ? "missing" : "provided", exposed.length === 0 ? "No exposed supplied batch requires supporting stock records for this interval." : uncovered.length ? "Supporting invoices or stock records are not explicitly associated with every exposed batch." : "Supporting records are explicitly associated with all exposed supplied batches; their contents still require review.", [...stockSources, ...uncovered.map(batch)].length ? [...stockSources, ...uncovered.map(batch)] : [analysis], "Could you provide invoices or stock records for the referenced exposed batches?", uncovered.length ? uncovered : exposedIds);
  const gaps = temporal.dataGaps.filter((gap) => interval.gapIds.includes(gap.id));
  item("temperature_log_coverage", gaps.length ? "missing" : "provided", gaps.length ? "Missing readings inside or adjacent to this interval leave its coverage unresolved; endpoint observations do not prove continuity." : "No over-limit gap was detected inside or adjacent to this interval in the supplied log.", gaps.length ? gaps.flatMap((gap) => [reading(gap.leftReadingId), reading(gap.rightReadingId)]) : [reading(interval.startReadingId), reading(interval.endReadingId ?? interval.lastAbnormalReadingId), settings], "Could you supply the missing readings or explain the gaps at the referenced observations?");
  item("policy_details", context.policyId ? "provided" : "missing", context.policyId ? "Demonstration policy details were supplied for review; this is not a coverage decision." : "No demonstration policy details were supplied for review.", context.policyId ? [{ type: "policy", id: context.policyId }] : [analysis], "Could you provide the demonstration policy details and record requirements?");

  if (maintenance.length && !maintenance.some((doc) => doc.facts?.equipment_id)) question("clarify:equipment", "equipment_not_reported", "Could you confirm the equipment identifier in the maintenance evidence?", maintenance.flatMap((doc) => documentSources(doc)));
  if (maintenance.length && !maintenance.some((doc) => doc.facts?.reported_cause || doc.unknownCauseQuotes.length)) question("clarify:cause", "cause_not_reported", "Could you provide a source-supported cause or confirm that it remains unknown?", maintenance.flatMap((doc) => documentSources(doc)));
  const repairs = maintenance.filter((doc) => doc.facts?.repair_time);
  const restarts = maintenance.filter((doc) => doc.facts?.restart_time);
  if (repairs.length && restarts.length === 0) question("clarify:restart", "restart_not_reported", "Repair completion does not establish a restart. Could you provide the reported refrigeration restart time?", repairs.flatMap((doc) => documentSources(doc, "repair_time")));
  if (new Set(restarts.map((doc) => doc.facts!.restart_time)).size > 1) question("clarify:restart-differences", "different_restart_times", "The associated reports state different restart times. Could you clarify which restart each report describes?", restarts.flatMap((doc) => documentSources(doc, "restart_time")));

  const readinessMissing = [maintenanceItem, inspectionItem, valuationItem].filter((row) => row.status === "missing");
  const readiness: TriageResult["readiness"] = {
    status: readinessMissing.length ? "Needs more evidence" : "Ready for initial review",
    reasons: readinessMissing.length ? readinessMissing.map((row) => reason(`readiness:${row.id}`, `missing_${row.id}`, row.text, row.sources)) : [reason("readiness:required-items", "required_readiness_items_provided", "Maintenance and inspection reports are supplied, with recorded values for all exposed supplied batches. Initial review does not establish stock condition, policy cover or payment.", [analysis, ...maintenance.flatMap((doc) => documentSources(doc)), ...inspection.flatMap((doc) => documentSources(doc)), ...exposedIds.map(batch)])],
  };
  const highReasons: TriageReason[] = [];
  if (interval.ongoing) highReasons.push(reason("priority:ongoing", "ongoing_interval", "The supplied log ends while the qualified interval remains abnormal; no recovery is recorded.", [reading(interval.lastAbnormalReadingId), analysis]));
  if (exposure.knownValueSubtotalPaise > context.highExposureThresholdPaise) highReasons.push(reason("priority:exposure", "high_recorded_exposure", `The known recorded inventory subtotal exceeds the configured high-exposure threshold.${exposure.valuationComplete ? "" : " Missing valuations mean the full subtotal remains incomplete."}`, [...exposedIds.map(batch), settings, analysis]));
  const priority: TriageResult["priority"] = conflicts.length ? { status: "Specialist review required", reasons: conflicts } : highReasons.length ? { status: "High priority", reasons: highReasons } : { status: "Standard priority", reasons: [reason("priority:standard", "no_configured_priority_trigger", "The interval is resolved and no configured specialist or high-priority trigger was found in the supplied evidence. Missing facts or valuations still require clarification; this does not establish consistency or completeness.", [analysis, settings, reading(interval.endReadingId!)])] };
  // Detach output sources from caller-owned objects, including nested quotes.
  return structuredClone({ version: "triage-v1", incidentId: context.incidentId, analysisId: context.selectedAnalysisId, intervalId: interval.id, readiness, priority, conflicts, checklist, questions });
}
