import { chartDate } from "../temperature/chart";
import type { IncidentDetail, IncidentNarrative, IncidentTriage, Membership } from "./types";
import type { TriageSource } from "../rules/triage-types";
import type { SummaryFact } from "../summaries/contract";
import { fieldLabels } from "../documents/contract";

export const membershipLabel: Record<Membership, string> = { current: "Current at last check", stale: "Stale candidate", historical: "Historical evidence", unassigned: "Unassigned record" };
export const incidentDate = (value: string) => `${chartDate(Date.parse(value))} IST`;
export const incidentHref = (id: string, revision?: string) => `/incidents/${encodeURIComponent(id)}${revision ? `?revision=${encodeURIComponent(revision)}` : ""}`;

/** Retained client selections must still belong to the refreshed review view. */
export function isCurrentTriageSource(triage: IncidentTriage, source: TriageSource | null) {
  if (triage.status !== "available" || !source) return false;
  const { result } = triage;
  return [...result.readiness.reasons, ...result.priority.reasons, ...result.checklist, ...result.questions].some((row) => row.sources.some((candidate) => JSON.stringify(candidate) === JSON.stringify(source)));
}

export function currentSummaryFact(summary: IncidentNarrative, selected: SummaryFact | null): SummaryFact | null {
  return summary.status === "available" && selected ? summary.facts.find((fact) => JSON.stringify(fact) === JSON.stringify(selected)) ?? null : null;
}

export function isCurrentSummarySource(summary: IncidentNarrative, source: TriageSource | null) {
  return summary.status === "available" && source !== null && summary.facts.some((fact) => fact.sources.some((candidate) => JSON.stringify(candidate) === JSON.stringify(source)));
}

export function evidenceSourceLabel(data: IncidentDetail, source: TriageSource) {
  if (source.type === "document") return `${source.quote ? "Report passage" : "Report"}: ${data.documents.find((doc) => doc.id === source.id)?.filename ?? source.id}${source.quote ? ` · ${fieldLabels[source.quote.field]}` : ""}`;
  if (source.type === "batch") return `Batch ${data.evidence?.exposure.batches.find((batch) => batch.id === source.id)?.batchCode ?? source.id} · saved record`;
  if (source.type === "reading") return `Reading ${source.id}`;
  return source.type === "analysis" ? "Selected analysis evidence" : source.type === "equipment" ? "Current equipment record" : source.type === "policy" ? "Stored demonstration policy" : "Review criteria and saved temperature settings";
}
