import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { analysisResponseSchema } from "../analysis/contract";
import { readLatestStoredAnalysis } from "../analysis/service";
import type { AnalysisSnapshot } from "../analysis/types";
import { withDatabase } from "../db/access";
import type { Database } from "../db/client";
import { analysisIncidentLinks, analysisRuns, chambers, claims, documents, incidentEvents, incidents } from "../db/schema";
import { documentInputPolicy } from "../documents/contract";
import { readDocumentCorrections } from "../documents/correction-history";
import { readCopyProvenance } from "../documents/copy-history";
import { toIstIso } from "../inventory/format";
import { ruleInstantSchema } from "../rules/validation";
import type { AnalysisReference, IncidentDetail, IncidentIndex, Membership, RevisionReference } from "./types";
import { readIncidentTriage } from "./triage-service";
import { readIncidentSummary } from "./summary-service";

export const incidentIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/, "Use a valid incident or revision identifier.");
export class IncidentError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = "IncidentError"; }
}
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function readIndex(tx: Transaction) {
  const [chamber] = await tx.select().from(chambers).where(eq(chambers.id, "CH-1"));
  if (!chamber) throw new IncidentError(409, "CONFIGURATION_MISSING", "CH-1 is unavailable. Incident freshness could not be checked.");
  const latest = analysisResponseSchema.parse(await readLatestStoredAnalysis(tx));
  const rows = await tx.select().from(incidents).where(eq(incidents.chamberId, "CH-1")).orderBy(desc(incidents.createdAt), incidents.id);
  for (const row of rows) {
    ruleInstantSchema.parse(row.createdAt);
    if (row.abnormalStart !== null) ruleInstantSchema.parse(row.abnormalStart);
    if (row.abnormalEnd !== null) ruleInstantSchema.parse(row.abnormalEnd);
  }
  const links = await tx.select({ incidentId: analysisIncidentLinks.incidentId, intervalId: analysisIncidentLinks.intervalId, analysisId: analysisRuns.id, revision: analysisRuns.revision, createdAt: analysisRuns.createdAt })
    .from(analysisIncidentLinks).innerJoin(analysisRuns, eq(analysisRuns.id, analysisIncidentLinks.analysisId)).where(eq(analysisRuns.chamberId, "CH-1")).orderBy(desc(analysisRuns.revision));
  const documentCounts = await tx.select({ incidentId: documents.incidentId, count: count() }).from(documents).innerJoin(incidents, eq(incidents.id, documents.incidentId)).where(eq(incidents.chamberId, "CH-1")).groupBy(documents.incidentId);
  const eventCounts = await tx.select({ incidentId: incidentEvents.incidentId, count: count() }).from(incidentEvents).innerJoin(incidents, eq(incidents.id, incidentEvents.incidentId)).where(eq(incidents.chamberId, "CH-1")).groupBy(incidentEvents.incidentId);
  const analysis: AnalysisReference = { status: latest.status, id: latest.analysis?.id ?? null, revision: latest.analysis?.revision ?? null, createdAt: latest.analysis?.createdAt ?? null, briefSpikes: latest.analysis?.temperature.briefSpikes ?? [] };
  const reference = (link: typeof links[number]): RevisionReference => ({ analysisId: link.analysisId, intervalId: link.intervalId, revision: link.revision, createdAt: link.createdAt, membership: link.analysisId === analysis.id && analysis.status !== "not_analyzed" ? analysis.status : "historical" });
  const records = rows.map((row) => {
    const linked = links.filter((link) => link.incidentId === row.id);
    const revision = linked[0] ? reference(linked[0]) : null;
    const membership: Membership = revision?.membership ?? "unassigned";
    return { ...row, membership, latestLinkedRevision: revision, documentCount: documentCounts.find((item) => item.incidentId === row.id)?.count ?? 0, eventCount: eventCounts.find((item) => item.incidentId === row.id)?.count ?? 0 };
  });
  const index: IncidentIndex = { checkedAt: toIstIso(new Date().toISOString()), chamber, analysis, incidents: records };
  return { index, links, reference };
}

export function listIncidents(db: Database): Promise<IncidentIndex> {
  return withDatabase(db, () => db.transaction(async (tx) => (await readIndex(tx)).index));
}

export function getIncident(db: Database, rawId: string, rawRevision?: string): Promise<IncidentDetail> {
  const id = incidentIdSchema.parse(rawId), revisionId = rawRevision === undefined ? undefined : incidentIdSchema.parse(rawRevision);
  return withDatabase(db, () => db.transaction((tx) => readIncident(tx, id, revisionId)));
}

/** Unqueued reader for a caller-owned transaction. */
export async function readIncident(tx: Transaction, id: string, revisionId?: string): Promise<IncidentDetail> {
    const { index, links, reference } = await readIndex(tx);
    const incident = index.incidents.find((item) => item.id === id);
    if (!incident) throw new IncidentError(404, "NOT_FOUND", "That incident is not available in CH-1.");
    const revisions = links.filter((item) => item.incidentId === id).map(reference);
    const selected = revisionId === undefined ? revisions[0] : revisions.find((item) => item.analysisId === revisionId);
    if (revisionId !== undefined && !selected) throw new IncidentError(404, "REVISION_NOT_FOUND", "That revision is not linked to this incident.");
    let evidence: IncidentDetail["evidence"] = null;
    let snapshot: AnalysisSnapshot | null = null, sourceFingerprint = "";
    if (selected) {
      const [run] = await tx.select().from(analysisRuns).where(and(eq(analysisRuns.id, selected.analysisId), eq(analysisRuns.chamberId, "CH-1")));
      if (!run) throw new Error("Linked revision unavailable");
      const parsed = analysisResponseSchema.parse({ status: selected.membership === "current" ? "current" : "stale", mode: "stored_log", reused: true, claimPacketsUpdated: false, analysis: { id: run.id, revision: run.revision, sourceFingerprint: run.sourceFingerprint, createdAt: run.createdAt, ...run.snapshotJson }, incidents: links.filter((link) => link.analysisId === run.id).map((link) => ({ intervalId: link.intervalId, incidentId: link.incidentId, status: index.incidents.find((row) => row.id === link.incidentId)?.status })) });
      if (parsed.status === "not_analyzed") throw new Error("Linked revision has no evidence");
      snapshot = parsed.analysis; sourceFingerprint = run.sourceFingerprint;
      const interval = parsed.analysis.temperature.abnormalIntervals.find((item) => item.id === selected.intervalId);
      const exposure = parsed.analysis.exposures.find((item) => item.intervalId === selected.intervalId);
      if (!interval || !exposure) throw new Error("Linked interval unavailable");
      const gaps = parsed.analysis.temperature.dataGaps.filter((item) => interval.gapIds.includes(item.id));
      const extraIds = new Set(gaps.flatMap((gap) => [gap.leftReadingId, gap.rightReadingId]));
      const start = Date.parse(interval.start), end = Date.parse(interval.end ?? interval.observedUntil);
      const readings = parsed.analysis.inputs.readings.filter((reading) => extraIds.has(reading.id) || (Date.parse(reading.recordedAt) >= start && Date.parse(reading.recordedAt) <= end));
      evidence = { revision: selected, interval, exposure, readings, gaps, settings: parsed.analysis.inputs.settings, boundariesMatch: incident.abnormalStart === interval.start && incident.abnormalEnd === interval.end };
    }
    const events = await tx.select().from(incidentEvents).where(eq(incidentEvents.incidentId, id));
    events.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id));
    const sourceDocuments = await tx.select().from(documents).where(eq(documents.incidentId, id));
    events.forEach((event) => ruleInstantSchema.parse(event.occurredAt));
    sourceDocuments.forEach((document) => ruleInstantSchema.parse(document.uploadedAt));
    sourceDocuments.sort((a, b) => Date.parse(a.uploadedAt) - Date.parse(b.uploadedAt) || a.id.localeCompare(b.id));
    const documentCorrections: IncidentDetail["documentCorrections"] = {};
    const documentCopies: IncidentDetail["documentCopies"] = {};
    for (const doc of sourceDocuments) {
      documentCorrections[doc.id] = await readDocumentCorrections(tx, doc, selected?.revision ?? null);
      documentCopies[doc.id] = await readCopyProvenance(tx, doc);
    }
    const [claim] = await tx.select({ id: claims.id }).from(claims).where(eq(claims.incidentId, id)).limit(1);
    const documentInput = documentInputPolicy(selected?.membership === "current", incident.status === "draft", !!claim);
    const triage: IncidentDetail["triage"] = selected && snapshot ? await readIncidentTriage(tx, { checkedAt: index.checkedAt, incident, revisions, documents: sourceDocuments, documentCorrections, selected, snapshot, sourceFingerprint }) : { status: "unavailable", code: "NO_ASSIGNED_ANALYSIS", reason: "This record has no assigned analysis interval. Triage is not inferred from its documents or workflow status." };
    const context = { checkedAt: index.checkedAt, incident, revisions, evidence, documents: sourceDocuments, documentCorrections, triage };
    const summary = readIncidentSummary(context);
    let timeline: IncidentDetail["timeline"] = { status: "unavailable", reason: summary.status === "unavailable" ? summary.reason : "No verified interval is selected." };
    if (summary.status === "available" && evidence && snapshot) {
      const start = Date.parse(evidence.interval.start), end = Date.parse(evidence.interval.end ?? evidence.interval.observedUntil);
      const padding = Math.max(30 * 60000, (end - start) / 10), supporting = new Set(evidence.readings.map((row) => row.id));
      const intervals = snapshot.temperature.abnormalIntervals.map((row) => {
        const link = links.find((item) => item.analysisId === summary.analysisId && item.intervalId === row.id);
        if (!link) throw new Error("Timeline interval membership unavailable");
        return { incidentId: link.incidentId, intervalId: row.id, start: row.start, end: row.end, observedUntil: row.observedUntil };
      });
      timeline = { status: "available", version: "timeline-v1", analysisId: summary.analysisId, intervalId: summary.intervalId, intervals, readings: snapshot.inputs.readings.filter((row) => supporting.has(row.id) || (Date.parse(row.recordedAt) >= start - padding && Date.parse(row.recordedAt) <= end + padding)) };
    }
    return { ...context, chamber: index.chamber, analysis: index.analysis, events, documentInput, documentCopies, summary, timeline };

}
