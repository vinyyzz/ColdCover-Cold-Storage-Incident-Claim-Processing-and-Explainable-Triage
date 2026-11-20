import { scalarFields } from "../documents/contract";
import { verifyStoredExtraction } from "../documents/extract";
import { readTriageDocument } from "../rules/triage-documents";
import { createFallbackSummary, type SummaryEvidence } from "../summaries/fallback";
import type { IncidentDetail, IncidentNarrative } from "./types";

type Context = Pick<IncidentDetail, "checkedAt" | "incident" | "revisions" | "evidence" | "documents" | "documentCorrections" | "triage">;

/** Caller has verified analysis/copy ancestry in its existing read transaction. */
export function readIncidentSummary(context: Context): IncidentNarrative {
  const { evidence, triage } = context;
  if (!evidence || triage.status !== "available") return { status: "unavailable", code: triage.status === "unavailable" ? triage.code : "NO_ASSIGNED_ANALYSIS", reason: triage.status === "unavailable" ? triage.reason : "No verified analysis interval is selected." };
  const { analysisId, revision } = evidence.revision;
  if (triage.result.analysisId !== analysisId || triage.result.intervalId !== evidence.interval.id || triage.result.incidentId !== context.incident.id) throw new Error("Summary and triage evidence differ.");
  const revisions = new Map(context.revisions.map((row) => [row.analysisId, row.revision]));
  const reports: SummaryEvidence["reports"] = [];
  for (const doc of context.documents) {
    if (doc.docType !== "maintenance_report" && doc.docType !== "stock_inspection_report") continue;
    const original = doc.extractionSource === "fallback" ? verifyStoredExtraction(doc.rawText, doc.id, context.incident.id, doc.extractionJson) : null;
    if (!original) throw new Error("Summary report sources could not be verified.");
    const report = readTriageDocument({ id: doc.id, incidentId: doc.incidentId, associationAnalysisId: original.association.analysisId, docType: doc.docType, rawText: doc.rawText, extractionSource: "fallback", extractionJson: original, corrections: context.documentCorrections[doc.id] }, revisions, revision);
    if (revisions.get(original.association.analysisId)! > revision) continue;
    const fields = report.facts?.evidence_quotes.filter((quote) => (scalarFields as readonly string[]).includes(quote.field)) ?? [];
    for (const quote of report.unknownCauseQuotes) if (!fields.some((field) => JSON.stringify(field) === JSON.stringify(quote))) fields.push(quote);
    reports.push({ id: doc.id, docType: doc.docType, correctionId: report.correctionId, fields });
  }
  const content = createFallbackSummary({ analysisId, interval: evidence.interval, exposure: evidence.exposure, settings: evidence.settings, gaps: evidence.gaps, reports, conflicts: triage.result.conflicts, missingItems: triage.result.checklist.filter((item) => item.status === "missing") });
  return { status: "available", checkedAt: context.checkedAt, evidenceMembership: evidence.revision.membership, analysisId, intervalId: evidence.interval.id, ...content };
}
