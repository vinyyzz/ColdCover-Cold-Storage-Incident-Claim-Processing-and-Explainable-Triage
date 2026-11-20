import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { withDatabase } from "../db/access";
import type { Database } from "../db/client";
import { analysisIncidentLinks, analysisRuns, auditLog, batchPolicySchedules, batches, chambers, incidentEvents, incidents, temperatureReadings, thresholds } from "../db/schema";
import { toIstIso } from "../inventory/format";
import { analyzeTemperature, calculateBatchExposure, type AbnormalInterval, type IntervalBatchExposure } from "../rules";
import { AnalysisError, type AnalysisInputs, type AnalysisSnapshot } from "./types";

// Bump whenever persisted rule semantics change; do not reuse an older result.
export const RULE_VERSION = "temperature-exposure-v1";
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Pick<Database, "select" | "all">;

async function sourceInputs(db: Reader): Promise<AnalysisInputs> {
  const [chamber] = await db.select({ id: chambers.id }).from(chambers).where(eq(chambers.id, "CH-1"));
  const [settings] = await db.select({ abnormalAboveC: thresholds.abnormalAboveC, minAbnormalMinutes: thresholds.minAbnormalMinutes, maxGapMinutes: thresholds.maxGapMinutes }).from(thresholds).where(eq(thresholds.id, 1));
  if (!chamber || !settings) throw new AnalysisError(409, "CONFIGURATION_MISSING", "CH-1 and its analysis settings are required. No analysis was saved.");
  const readings = await db.select({ id: temperatureReadings.id, recordedAt: temperatureReadings.recordedAt, temperatureC: temperatureReadings.temperatureC }).from(temperatureReadings).where(eq(temperatureReadings.chamberId, "CH-1"));
  readings.sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || a.id.localeCompare(b.id));
  const batchFields = { id: batches.id, batchCode: batches.batchCode, ownerName: batches.ownerName, quantityKg: batches.quantityKg, recordedValueInr: batches.recordedValueInr, enteredAt: batches.enteredAt, exitedAt: batches.exitedAt };
  // Older source databases used by migration fixtures have no assignment table.
  const [assignmentTable] = await db.all(sql`SELECT 1 FROM sqlite_master WHERE type='table' AND name='batch_policy_schedules'`);
  const inventory = assignmentTable
    ? await db.select(batchFields).from(batches).leftJoin(batchPolicySchedules, eq(batches.id, batchPolicySchedules.batchId))
      .where(and(eq(batches.chamberId, "CH-1"), or(isNull(batchPolicySchedules.scheduleId), eq(batchPolicySchedules.scheduleId, "potato")))).orderBy(batches.id)
    : await db.select(batchFields).from(batches).where(eq(batches.chamberId, "CH-1")).orderBy(batches.id);
  return { chamberId: "CH-1", ruleVersion: RULE_VERSION, settings, readings, batches: inventory };
}

async function latestRun(db: Reader) {
  const [run] = await db.select().from(analysisRuns).where(eq(analysisRuns.chamberId, "CH-1")).orderBy(desc(analysisRuns.revision)).limit(1);
  return run;
}

async function linkedIncidents(db: Reader, analysisId: string) {
  return db.select({ intervalId: analysisIncidentLinks.intervalId, incidentId: incidents.id, status: incidents.status, abnormalStart: incidents.abnormalStart, abnormalEnd: incidents.abnormalEnd, chamberId: incidents.chamberId, evidenceFingerprint: analysisIncidentLinks.evidenceFingerprint })
    .from(analysisIncidentLinks).innerJoin(incidents, eq(incidents.id, analysisIncidentLinks.incidentId)).where(eq(analysisIncidentLinks.analysisId, analysisId)).orderBy(analysisIncidentLinks.intervalId);
}

async function responseFor(db: Reader, run: typeof analysisRuns.$inferSelect, status: "current" | "stale", reused: boolean) {
  const links = await linkedIncidents(db, run.id);
  return {
    status, reused, mode: "stored_log" as const, claimPacketsUpdated: false as const,
    analysis: { id: run.id, revision: run.revision, sourceFingerprint: run.sourceFingerprint, createdAt: run.createdAt, ...run.snapshotJson },
    // Explicit revision membership; standalone historical/seed drafts are not
    // silently interpreted as current calculated incidents.
    incidents: links.map(({ intervalId, incidentId, status }) => ({ intervalId, incidentId, status })),
  };
}

async function membershipMatches(db: Reader, run: typeof analysisRuns.$inferSelect) {
  const links = await linkedIncidents(db, run.id);
  const intervals = run.snapshotJson.temperature.abnormalIntervals;
  return links.length === intervals.length && intervals.every((interval) => links.some((link) => link.intervalId === interval.id && link.chamberId === "CH-1" && link.abnormalStart === interval.start && link.abnormalEnd === interval.end));
}

function intervalEvidence(snapshot: AnalysisSnapshot, interval: AbnormalInterval, exposure: IntervalBatchExposure) {
  const boundaryIds = new Set<string>();
  for (const gap of snapshot.temperature.dataGaps) {
    if (interval.gapIds.includes(gap.id)) { boundaryIds.add(gap.leftReadingId); boundaryIds.add(gap.rightReadingId); }
  }
  const start = Date.parse(interval.start), end = Date.parse(interval.end ?? interval.observedUntil);
  const readings = snapshot.inputs.readings.filter((reading) => boundaryIds.has(reading.id) || (Date.parse(reading.recordedAt) >= start && Date.parse(reading.recordedAt) <= end));
  return fingerprint({ ruleVersion: snapshot.inputs.ruleVersion, settings: snapshot.inputs.settings, interval, exposure, readings });
}

async function createIncident(tx: Transaction, snapshot: AnalysisSnapshot, interval: AbnormalInterval, at: string) {
  const id = randomUUID();
  await tx.insert(incidents).values({ id, chamberId: "CH-1", title: `Temperature investigation from ${interval.start}`, abnormalStart: interval.start, abnormalEnd: interval.end, createdAt: at });
  const events: (typeof incidentEvents.$inferInsert)[] = [{
    id: randomUUID(), incidentId: id, occurredAt: interval.start, eventType: "abnormal_start",
    description: "First recorded above-threshold observation in this qualified investigation interval.", sourceType: "temperature_reading", sourceRef: interval.startReadingId,
  }];
  if (interval.end !== null && interval.endReadingId !== null) events.push({
    id: randomUUID(), incidentId: id, occurredAt: interval.end, eventType: "abnormal_end",
    description: "First subsequent recorded normal observation; this does not establish stock condition.", sourceType: "temperature_reading", sourceRef: interval.endReadingId,
  });
  for (const gap of snapshot.temperature.dataGaps) {
    if (interval.gapIds.includes(gap.id)) events.push({
      id: randomUUID(), incidentId: id, occurredAt: gap.start, eventType: "data_gap",
      description: `Readings missing between ${gap.start} and ${gap.end}; the true start/end may differ.`, sourceType: "temperature_gap", sourceRef: gap.id,
    });
  }
  for (let offset = 0; offset < events.length; offset += 100) await tx.insert(incidentEvents).values(events.slice(offset, offset + 100));
  return id;
}

export function analyzeStoredLog(db: Database) {
  return withDatabase(db, () => db.transaction(async (tx) => {
    const inputs = await sourceInputs(tx);
    if (inputs.readings.length === 0) throw new AnalysisError(409, "NO_READINGS", "Import temperature readings before running analysis. No analysis was saved.");
    const sourceFingerprint = fingerprint(inputs);
    const previous = await latestRun(tx);
    if (previous?.sourceFingerprint === sourceFingerprint && await membershipMatches(tx, previous)) return responseFor(tx, previous, "current", true);

    const temperature = analyzeTemperature(inputs.readings, inputs.settings);
    const exposures = calculateBatchExposure(temperature.abnormalIntervals, inputs.batches);
    const previousLinks = previous ? await linkedIncidents(tx, previous.id) : [];
    const id = randomUUID(), at = toIstIso(new Date().toISOString());
    const snapshot: AnalysisSnapshot = { inputs, temperature, exposures, reconciliation: { previousAnalysisId: previous?.id ?? null, createdIncidentIds: [], reusedIncidentIds: [], retainedPreviousIncidentIds: [] } };
    const run = { id, chamberId: "CH-1", revision: (previous?.revision ?? 0) + 1, sourceFingerprint, snapshotJson: snapshot, createdAt: at };
    const { createdIncidentIds, reusedIncidentIds } = snapshot.reconciliation;
    const links: (typeof analysisIncidentLinks.$inferInsert)[] = [];
    for (const [index, interval] of temperature.abnormalIntervals.entries()) {
      const evidenceFingerprint = intervalEvidence(snapshot, interval, exposures[index]);
      const existing = previousLinks.find((link) => link.evidenceFingerprint === evidenceFingerprint && link.chamberId === "CH-1" && link.abnormalStart === interval.start && link.abnormalEnd === interval.end);
      const incidentId = existing?.incidentId ?? await createIncident(tx, snapshot, interval, at);
      (existing ? reusedIncidentIds : createdIncidentIds).push(incidentId);
      links.push({ id: randomUUID(), analysisId: id, intervalId: interval.id, incidentId, evidenceFingerprint });
    }
    const retainedPreviousIncidentIds = previousLinks.map((link) => link.incidentId).filter((incidentId) => !reusedIncidentIds.includes(incidentId));
    snapshot.reconciliation.retainedPreviousIncidentIds = retainedPreviousIncidentIds;
    await tx.insert(analysisRuns).values(run);
    for (let offset = 0; offset < links.length; offset += 100) await tx.insert(analysisIncidentLinks).values(links.slice(offset, offset + 100));
    await tx.insert(auditLog).values({
      id: randomUUID(), actor: "storage_operator", action: "stored_log_analyzed", entity: "analysis", entityId: id, at,
      detail: JSON.stringify({ chamberId: "CH-1", revision: run.revision, sourceFingerprint, previousAnalysisId: previous?.id ?? null, createdIncidentIds, reusedIncidentIds, retainedPreviousIncidentIds, briefSpikes: temperature.briefSpikes.length, dataGaps: temperature.dataGaps.length }),
    });
    return responseFor(tx, run, "current", false);
  }));
}

// The caller owns serialization/transaction. Shared by read models that need
// freshness and related evidence from the same consistent database snapshot.
export async function readLatestStoredAnalysis(db: Reader) {
  const run = await latestRun(db);
  if (!run) return { status: "not_analyzed" as const, analysis: null, incidents: [] };
  const current = run.sourceFingerprint === fingerprint(await sourceInputs(db)) && await membershipMatches(db, run);
  return responseFor(db, run, current ? "current" : "stale", true);
}

export function latestStoredAnalysis(db: Database) {
  return withDatabase(db, () => db.transaction((tx) => readLatestStoredAnalysis(tx)));
}
