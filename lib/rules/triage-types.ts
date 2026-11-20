import type { DocumentCorrectionState } from "../documents/corrections";
import type { EvidenceQuote } from "../documents/contract";
import type { ExposureBatchInput, TemperatureReading, TemperatureRuleSettings } from "./types";

export interface TriageDocumentInput {
  id: string;
  incidentId: string;
  /** Explicit attachment provenance, supplied by the caller, never inferred. */
  associationAnalysisId: string;
  docType: "maintenance_report" | "stock_inspection_report";
  rawText: string;
  extractionSource: "fallback" | null;
  extractionJson: unknown;
  corrections: DocumentCorrectionState;
}
export interface TriageInput {
  incidentId: string;
  selectedAnalysisId: string;
  /** Verified incident membership, including later revisions needed by history. */
  linkedAnalyses: { id: string; revision: number }[];
  intervalId: string;
  equipment: { id: string; code: string };
  settingsId: string;
  settings: TemperatureRuleSettings;
  highExposureThresholdPaise: number;
  readings: readonly TemperatureReading[];
  batches: readonly ExposureBatchInput[];
  documents: readonly TriageDocumentInput[];
  /** Explicit, caller-verified supporting-document to batch associations. */
  stockRecords: readonly { documentId: string; batchIds: string[] }[];
  /** Caller verifies actual policy details; presence does not establish cover. */
  policyId: string | null;
}
export type TriageSource =
  | { type: "document"; id: string; correctionId: string | null; quote?: EvidenceQuote }
  | { type: "reading" | "batch" | "analysis" | "equipment" | "settings" | "policy"; id: string };
export interface TriageReason {
  id: string;
  code: string;
  text: string;
  sources: TriageSource[];
}
export type ChecklistId = "maintenance_report" | "stock_inspection_report" | "batch_valuations" | "stock_records" | "temperature_log_coverage" | "policy_details";
export interface TriageChecklistItem extends TriageReason {
  id: ChecklistId;
  status: "provided" | "missing" | "not_applicable";
  batchIds: string[];
}
export interface TriageQuestion extends TriageReason {
  checklistId: ChecklistId | null;
  conflictId: string | null;
}
export interface TriageResult {
  version: "triage-v1";
  incidentId: string;
  analysisId: string;
  intervalId: string;
  readiness: { status: "Needs more evidence" | "Ready for initial review"; reasons: TriageReason[] };
  priority: { status: "Specialist review required" | "High priority" | "Standard priority"; reasons: TriageReason[] };
  conflicts: TriageReason[];
  checklist: TriageChecklistItem[];
  questions: TriageQuestion[];
}
