import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { withDatabase } from "../db/access";
import { auditLog, batchPolicySchedules, batches, documents, incidents, policyCasePackets, policyCaseReviews, temperatureReadings } from "../db/schema";
import { demonstrationPolicy } from "../demo/policy";
import { toIstIso } from "../inventory/format";
import { digest } from "../reset/snapshot";
import { parseTemperatureCsv } from "../temperature/csv";
import { analyzeSchedules, MAX_CASE_READINGS, type ScheduledBatch } from "./analysis";
import { catalogue, evidenceLabels, extensions, policyIds, scheduleIds, schedules } from "./catalogue";
import { assignmentSchema, caseDraftSchema, caseIdSchema, evidenceInput, outcomes, prepareSchema, reviewInputSchema, type CaseDraft } from "./contract";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
const now = () => toIstIso(new Date().toISOString());
export class PolicyCaseError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function invalid(message: string): never { throw new PolicyCaseError(422, message); }

export function policyCaseInputs(db: Database) {
  return withDatabase(db, () => db.transaction(async (tx) => ({
    batches: await tx.select({ id: batches.id, batchCode: batches.batchCode, scheduleId: batchPolicySchedules.scheduleId })
      .from(batches).leftJoin(batchPolicySchedules, eq(batches.id, batchPolicySchedules.batchId))
      .where(eq(batches.chamberId, "CH-1")).orderBy(asc(batches.batchCode)),
    incidents: await tx.select({ id: incidents.id, title: incidents.title }).from(incidents)
      .where(eq(incidents.chamberId, "CH-1")).orderBy(desc(incidents.createdAt)).limit(50),
  })));
}
export type CaseInputs = Awaited<ReturnType<typeof policyCaseInputs>>;

export function assignSchedule(db: Database, value: unknown) {
  const input = assignmentSchema.parse(value);
  return withDatabase(db, () => db.transaction(async (tx) => {
    const [batch] = await tx.select({ id: batches.id }).from(batches).where(and(eq(batches.id, input.batchId), eq(batches.chamberId, "CH-1")));
    if (!batch) throw new PolicyCaseError(404, "That batch is unavailable.");
    const [old] = await tx.select().from(batchPolicySchedules).where(eq(batchPolicySchedules.batchId, batch.id));
    const previous = old?.scheduleId ?? null;
    if (input.scheduleId === previous) return { scheduleId: previous };
    if (input.expectedScheduleId !== previous) throw new PolicyCaseError(409, "The assignment changed. Reload the inventory and review it again.");
    const at = now();
    if (input.scheduleId === null) await tx.delete(batchPolicySchedules).where(eq(batchPolicySchedules.batchId, batch.id));
    else await tx.insert(batchPolicySchedules).values({ batchId: batch.id, scheduleId: input.scheduleId, assignedAt: at })
      .onConflictDoUpdate({ target: batchPolicySchedules.batchId, set: { scheduleId: input.scheduleId, assignedAt: at } });
    await tx.insert(auditLog).values({ id: randomUUID(), at, actor: "storage_operator", action: "batch_schedule_assigned", entity: "batch", entityId: batch.id, detail: JSON.stringify({ previous, scheduleId: input.scheduleId }) });
    return { scheduleId: input.scheduleId };
  }));
}

async function readCaseEvidence(tx: Tx, draft: CaseDraft) {
  const policy = catalogue[draft.policyId];
  const goods = policy.group === "goods";
  if (goods && (draft.batchIds.length === 0 || draft.targets.length)) invalid("Select batches assigned to this stock policy.");
  if (!goods && (draft.batchIds.length || draft.extensions.length || draft.readings.source !== "none")) invalid("An operator case uses facility or equipment evidence.");
  if (!goods && draft.targets.length === 0) invalid("Identify at least one facility asset or equipment unit.");
  if (!goods && draft.targets.some((target) => (draft.policyId === "machinery") !== (target.type === "equipment"))) invalid("Choose target types that match the selected operator policy.");
  const records = goods ? await tx.select({ batch: batches, scheduleId: batchPolicySchedules.scheduleId }).from(batches)
    .leftJoin(batchPolicySchedules, eq(batches.id, batchPolicySchedules.batchId))
    .where(and(eq(batches.chamberId, "CH-1"), inArray(batches.id, draft.batchIds))).orderBy(asc(batches.id)) : [];
  if (records.length !== draft.batchIds.length) invalid("A selected batch is unavailable.");
  const selected: ScheduledBatch[] = records.map(({ batch, scheduleId }) => {
    const parsed = z.enum(scheduleIds).safeParse(scheduleId ?? "potato");
    if (!parsed.success || schedules[parsed.data].policyId !== draft.policyId) return invalid("Assign each selected batch to a schedule for this policy in Inventory.");
    return { ...batch, scheduleId: parsed.data };
  });
  for (const extension of draft.extensions) {
    const candidate = extensions[extension];
    if (candidate.policyId !== draft.policyId || (candidate.schedule && !selected.some((batch) => batch.scheduleId === candidate.schedule))) invalid("A selected extension does not match the batches and policy.");
  }

  let linkedIncident: { id: string; title: string } | null = null;
  const evidence: (z.infer<typeof evidenceInput> & { id: string; origin: string })[] = draft.evidence.map((record, index) => ({
    ...record, id: `case-record-${index + 1}`, origin: "Operator-supplied record text",
  }));
  if (draft.incidentId) {
    const [source] = await tx.select({ id: incidents.id, title: incidents.title }).from(incidents)
      .where(and(eq(incidents.id, draft.incidentId), eq(incidents.chamberId, "CH-1")));
    if (!source) return invalid("The linked incident is unavailable.");
    linkedIncident = source;
    const originals = await tx.select().from(documents).where(eq(documents.incidentId, source.id)).orderBy(asc(documents.id)).limit(25);
    if (originals.length > 24) invalid("The linked incident has too many reports for one case.");
    for (const record of originals) {
      if (record.docType !== "maintenance_report" && record.docType !== "stock_inspection_report") continue;
      evidence.push({ kind: record.docType === "maintenance_report" ? "breakdown" : "inspection", title: record.filename, text: record.rawText, id: `incident-document:${record.id}`, origin: `Original report from incident ${source.id} · saved source ${record.id}` });
    }
  }
  const source = draft.readings;
  const readings = source.source === "none" ? []
    : source.source === "csv" ? parseTemperatureCsv(source.csv).map((row) => ({ id: `csv-row-${row.row}`, recordedAt: row.recordedAt, temperatureC: row.temperatureC }))
      : await tx.select({ id: temperatureReadings.id, recordedAt: temperatureReadings.recordedAt, temperatureC: temperatureReadings.temperatureC })
        .from(temperatureReadings).where(and(eq(temperatureReadings.chamberId, "CH-1"),
          sql`julianday(${temperatureReadings.recordedAt}) >= julianday(${source.from})`,
          sql`julianday(${temperatureReadings.recordedAt}) <= julianday(${source.to})`))
        .orderBy(sql`julianday(${temperatureReadings.recordedAt})`, temperatureReadings.id).limit(MAX_CASE_READINGS + 1);
  if (readings.length > MAX_CASE_READINGS) invalid("Choose no more than 2,000 temperature readings per case.");
  const analysis = goods ? analyzeSchedules(readings, selected) : [];
  const checklist: { kind: string; label: string; sources: string[] }[] = [...policy.required, ...draft.extensions].map((kind) => ({
    kind, label: evidenceLabels[kind],
    sources: [...evidence.filter((record) => record.kind === kind).map((record) => record.id),
      ...(kind === "inventory" && selected.every((batch) => batch.recordedValueInr !== null) ? selected.map((batch) => batch.batchCode) : [])],
  }));
  if (goods) {
    const first = readings[0], last = readings.at(-1);
    const complete = !!first && !!last && readings.length >= 2 && analysis.every(({ gaps, schedule }) => {
      if (gaps.length) return false;
      if (source.source !== "stored") return true;
      const gapLimit = schedule.maxGapMinutes * 60_000;
      return Date.parse(first.recordedAt) - Date.parse(source.from) <= gapLimit &&
        Date.parse(source.to) - Date.parse(last.recordedAt) <= gapLimit;
    });
    checklist.push({ kind: "temperature", label: "Temperature observations without identified gaps", sources: complete ? [first.id, last.id] : [] });
  }
  const trigger = policy.triggers.includes(draft.event);
  const snapshot = {
    version: "policy-case-v1" as const, title: draft.title, policyId: draft.policyId,
    policy, demonstrationLabel: demonstrationPolicy.label,
    event: draft.event, trigger, linkedIncident, targets: draft.targets, batches: selected,
    extensions: draft.extensions.map((id) => ({ id, name: extensions[id].name })),
    readings, readingSource: source.source, readingWindow: source.source === "stored" ? { from: source.from, to: source.to } : null, analysis, checklist, evidence,
    readiness: trigger && selected.every((batch) => batch.recordedValueInr !== null) && checklist.every((entry) => entry.sources.length > 0) ? "Ready for human review" : "Needs more evidence",
  };
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 2 * 1024 * 1024) invalid("Narrow the readings or selected batches to keep this case within 2 MiB.");
  return snapshot;
}

export type CaseSnapshot = Awaited<ReturnType<typeof readCaseEvidence>>;
function verifyPacket(row: typeof policyCasePackets.$inferSelect) {
  // The hash binds the stored immutable snapshot, even when the live catalogue
  // changes. Basic shape/metadata checks precede reuse of the stored document.
  const meta = z.object({ version: z.literal("policy-case-v1"), policyId: z.enum(policyIds), title: z.string() }).safeParse(row.snapshot);
  if (!meta.success || row.policyId !== meta.data.policyId || row.title !== meta.data.title || digest(row.snapshot) !== row.packetHash) {
    throw new PolicyCaseError(409, "This saved packet could not be verified.");
  }
  return { id: row.id, preparedAt: row.preparedAt, packetHash: row.packetHash, snapshot: row.snapshot as CaseSnapshot };
}
export type VerifiedPacket = ReturnType<typeof verifyPacket>;
export type CaseReview = typeof policyCaseReviews.$inferSelect;
export function previewCase(db: Database, value: unknown) {
  const draft = caseDraftSchema.parse(value);
  return withDatabase(db, () => db.transaction(async (tx) => {
    const snapshot = await readCaseEvidence(tx, draft);
    return { snapshot, hash: digest(snapshot) };
  }));
}
export function prepareCase(db: Database, value: unknown) {
  const input = prepareSchema.parse(value);
  const requestHash = digest(input);
  return withDatabase(db, () => db.transaction(async (tx) => {
    const [previous] = await tx.select().from(policyCasePackets).where(eq(policyCasePackets.id, input.id));
    if (previous) {
      if (previous.requestHash !== requestHash) throw new PolicyCaseError(409, "That request belongs to a different packet.");
      return verifyPacket(previous);
    }
    const snapshot = await readCaseEvidence(tx, input.draft);
    const packetHash = digest(snapshot);
    if (packetHash !== input.expectedHash) throw new PolicyCaseError(409, "Evidence changed after preview. Review a new preview.");
    const preparedAt = now();
    const [row] = await tx.insert(policyCasePackets).values({ id: input.id, preparedAt, policyId: snapshot.policyId, title: snapshot.title, packetHash, requestHash, snapshot }).returning();
    await tx.insert(auditLog).values({ id: randomUUID(), at: preparedAt, actor: "storage_operator", action: "policy_case_prepared", entity: "policy_case", entityId: row.id, detail: JSON.stringify({ packetHash, policyId: row.policyId }) });
    return verifyPacket(row);
  }));
}
async function readPacket(tx: Tx, id: string) {
  const [row] = await tx.select().from(policyCasePackets).where(eq(policyCasePackets.id, id));
  if (!row) throw new PolicyCaseError(404, "That evidence packet is unavailable.");
  return verifyPacket(row);
}
async function readVerifiedReviews(tx: Tx, packet: VerifiedPacket) {
  const reviews = await tx.select().from(policyCaseReviews).where(eq(policyCaseReviews.caseId, packet.id)).orderBy(policyCaseReviews.revision);
  const audit = await tx.select().from(auditLog).where(and(eq(auditLog.entity, "policy_case"), eq(auditLog.entityId, packet.id), eq(auditLog.action, "policy_case_reviewed")));
  const byId = new Map(audit.map((entry) => [entry.id, entry]));
  if (reviews.length > 200 || reviews.length !== audit.length || reviews.some((review, i) => {
    const entry = byId.get(`policy-case-review-${review.id}`);
    return review.revision !== i + 1 || !outcomes.some((value) => value === review.decision) ||
      (i < reviews.length - 1 && review.decision === "Closed") || !entry || entry.at !== review.recordedAt ||
      entry.actor !== "demo_reviewer" || entry.detail !== JSON.stringify({ packetHash: packet.packetHash, review });
  })) throw new PolicyCaseError(409, "This packet's review history could not be verified.");
  return reviews;
}
export function getCase(db: Database, value: unknown) {
  const id = caseIdSchema.parse(value);
  return withDatabase(db, () => db.transaction(async (tx) => {
    const packet = await readPacket(tx, id);
    return { packet, reviews: await readVerifiedReviews(tx, packet) };
  }));
}
export function listPolicyCases(db: Database, before?: string) {
  return withDatabase(db, () => db.transaction(async (tx) => {
    const cutoff = before ? await readPacket(tx, caseIdSchema.parse(before)) : null;
    const rows = await tx.select({ id: policyCasePackets.id, policyId: policyCasePackets.policyId, title: policyCasePackets.title, preparedAt: policyCasePackets.preparedAt })
      .from(policyCasePackets).where(cutoff ? sql`(${policyCasePackets.preparedAt}, ${policyCasePackets.id}) < (${cutoff.preparedAt}, ${cutoff.id})` : undefined)
      .orderBy(desc(policyCasePackets.preparedAt), desc(policyCasePackets.id)).limit(21);
    return { entries: rows.slice(0, 20), next: rows.length > 20 ? rows[19].id : null };
  }));
}
export function appendPolicyCaseReview(db: Database, value: unknown, body: unknown) {
  const id = caseIdSchema.parse(value), input = reviewInputSchema.parse(body);
  return withDatabase(db, () => db.transaction(async (tx) => {
    const packet = await readPacket(tx, id);
    if (packet.packetHash !== input.expectedHash) throw new PolicyCaseError(409, "The reviewed snapshot changed.");
    const reviews = await readVerifiedReviews(tx, packet);
    const [previous] = await tx.select().from(policyCaseReviews).where(eq(policyCaseReviews.id, input.id));
    if (previous) {
      if (previous.caseId !== id || previous.revision !== input.expectedRevision + 1 || previous.decision !== input.decision ||
        previous.reviewer !== input.reviewer || previous.comment !== input.comment) throw new PolicyCaseError(409, "That request belongs to a different review.");
      return previous;
    }
    const latest = reviews.at(-1);
    if ((latest?.revision ?? 0) !== input.expectedRevision || latest?.decision === outcomes[3]) throw new PolicyCaseError(409, "Review history changed or the case is closed. Reload the packet.");
    const recordedAt = now();
    const [review] = await tx.insert(policyCaseReviews).values({ id: input.id, caseId: id, revision: input.expectedRevision + 1, recordedAt, decision: input.decision, reviewer: input.reviewer, comment: input.comment }).returning();
    await tx.insert(auditLog).values({ id: `policy-case-review-${review.id}`, at: recordedAt, actor: "demo_reviewer", action: "policy_case_reviewed", entity: "policy_case", entityId: id, detail: JSON.stringify({ packetHash: packet.packetHash, review }) });
    return review;
  }));
}
