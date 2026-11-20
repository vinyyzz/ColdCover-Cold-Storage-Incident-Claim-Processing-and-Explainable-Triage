import type { chambers, documents, incidentEvents, incidents } from "../db/schema";
import type { AbnormalInterval, BriefSpike, DataGap, IntervalBatchExposure, TemperatureReading, TemperatureRuleSettings } from "../rules";
import type { DocumentCorrectionState } from "../documents/corrections";
import type { CopyProvenance } from "../documents/copy-contract";
import type { TriageResult } from "../rules/triage-types";
import type { FallbackSummary } from "../summaries/contract";

export type IncidentNarrative = { status: "unavailable"; code: string; reason: string } | (FallbackSummary & {
  status: "available"; checkedAt: string; evidenceMembership: Exclude<Membership, "unassigned">; analysisId: string; intervalId: string;
});

export type IncidentTimeline = { status: "unavailable"; reason: string } | {
  status: "available"; version: "timeline-v1"; analysisId: string; intervalId: string;
  readings: TemperatureReading[];
  intervals: { incidentId: string; intervalId: string; start: string; end: string | null; observedUntil: string }[];
};

export interface ReviewPolicy {
  id: string; name: string; machineryBreakdownCoverRequired: boolean;
  recordsRequiredText: string; notes: string; wording: string; demonstrationLabel: string;
}
export type IncidentTriage = { status: "unavailable"; code: string; reason: string } | {
  status: "available";
  checkedAt: string;
  evidenceMembership: Exclude<Membership, "unassigned">;
  criteria: {
    basis: "current_records"; settingsId: string; highExposureThresholdPaise: number;
    equipment: { id: string; code: string }; policy: ReviewPolicy | null;
  };
  result: TriageResult;
};

export type Membership = "current" | "stale" | "historical" | "unassigned";
export interface RevisionReference {
  analysisId: string;
  revision: number;
  createdAt: string;
  intervalId: string;
  membership: Exclude<Membership, "unassigned">;
}
export interface IncidentSummary extends IncidentRecord {
  membership: Membership;
  latestLinkedRevision: RevisionReference | null;
  documentCount: number;
  eventCount: number;
}
type IncidentRecord = typeof incidents.$inferSelect;
export interface AnalysisReference {
  status: "not_analyzed" | "current" | "stale";
  id: string | null;
  revision: number | null;
  createdAt: string | null;
  briefSpikes: BriefSpike[];
}
export interface IncidentIndex {
  checkedAt: string;
  chamber: typeof chambers.$inferSelect;
  analysis: AnalysisReference;
  incidents: IncidentSummary[];
}
export interface IncidentDetail {
  checkedAt: string;
  chamber: typeof chambers.$inferSelect;
  analysis: AnalysisReference;
  incident: IncidentSummary;
  revisions: RevisionReference[];
  evidence: {
    revision: RevisionReference;
    interval: AbnormalInterval;
    exposure: IntervalBatchExposure;
    readings: TemperatureReading[];
    gaps: DataGap[];
    settings: TemperatureRuleSettings;
    boundariesMatch: boolean;
  } | null;
  events: (typeof incidentEvents.$inferSelect)[];
  documents: (typeof documents.$inferSelect)[];
  documentCorrections: Record<string, DocumentCorrectionState>;
  documentCopies: Record<string, CopyProvenance | null>;
  documentInput: { allowed: boolean; reason: string | null };
  triage: IncidentTriage;
  summary: IncidentNarrative;
  timeline: IncidentTimeline;
}
