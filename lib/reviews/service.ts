import "server-only";
import { and, desc, eq, lt, max, or, sql } from "drizzle-orm";
import { z } from "zod";
import { claimIdentifier } from "../claims/contract";
import { readClaim, type PreparedClaim } from "../claims/service";
import type { ClaimTransaction } from "../claims/sources";
import { withDatabase } from "../db/access";
import type { Database } from "../db/client";
import { auditLog, claimPackets, claims, demoBackups, incidents, reviewDecisions } from "../db/schema";
import { toIstIso } from "../inventory/format";
import { digest } from "../reset/snapshot";
import { ruleInstantSchema } from "../rules/validation";
import { decisionAuditSchema, decisionInputSchema, decisionReceiptSchema, decisionRecordSchema, incidentWorkflowSchema, legacyDecisionSchema, MAX_REVIEW_HISTORY, REVIEW_VERSION, reviewQuerySchema, reviewerIndexSchema, reviewStateSchema, workflowFor, type DecisionInput, type DecisionRecord, type ReviewState } from "./contract";

export class ReviewError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = "ReviewError"; }
}
type Audit = z.infer<typeof decisionAuditSchema>;
type VerifiedEntry = { decision: DecisionRecord; audit: Audit };
const nowIst = () => toIstIso(new Date().toISOString());
const stateToken = (claimId: string, packetHash: string, workflow: string, resetSequence: number, history: VerifiedEntry[]) => digest({ version: REVIEW_VERSION, claimId, packetHash, workflow, resetSequence, history });
const unavailable = (claimId: string, reason: string, legacyHistory: z.infer<typeof legacyDecisionSchema>[] = []): ReviewState => reviewStateSchema.parse({ version: REVIEW_VERSION, status: "unavailable", claimId, checkedAt: nowIst(), reason, legacyHistory });
const sameRow = (decision: typeof reviewDecisions.$inferSelect, request: DecisionInput) => decision.status === request.status && decision.reviewerName === request.reviewerName && decision.comment === request.comment;

function verifyHistory(rows: typeof reviewDecisions.$inferSelect[], audits: typeof auditLog.$inferSelect[], claimId: string, packetHash: string, preparedAt: string) {
  if (rows.length !== audits.length || rows.length > MAX_REVIEW_HISTORY) throw new Error("Review history membership differs");
  const details = audits.map((row) => {
    const raw: unknown = JSON.parse(row.detail), detail = decisionAuditSchema.parse(raw);
    if (digest(raw) !== digest(detail)) throw new Error("Noncanonical review audit");
    return { row, detail };
  }).sort((a, b) => a.detail.revision - b.detail.revision);
  const history: VerifiedEntry[] = [];
  for (const { row: audit, detail } of details) {
    const input = detail.request, row = rows.find((item) => item.id === `decision-${input.requestId}`), previous = history.at(-1)?.decision;
    if (!row) throw new Error("Decision row unavailable");
    const parsed = legacyDecisionSchema.parse(row);
    const expectedBefore = previous ? workflowFor(previous.status) : detail.beforeWorkflow;
    if (detail.claimId !== claimId || row.claimId !== claimId || detail.packetHash !== packetHash || detail.revision !== history.length + 1 || input.expectedRevision !== history.length || input.expectedLatestDecisionId !== (previous?.id ?? null) || audit.id !== `review-decision-${input.requestId}` || audit.actor !== "demo_reviewer" || audit.action !== "review_decision_recorded" || audit.entity !== "claim_review" || audit.entityId !== claimId || audit.at !== row.decidedAt || parsed.decidedAt !== row.decidedAt || !sameRow(row, input) || detail.beforeWorkflow !== expectedBefore || (!previous && !["claim_prepared", "submitted"].includes(detail.beforeWorkflow)) || previous?.status === "closed" || detail.afterWorkflow !== workflowFor(input.status) || Date.parse(row.decidedAt) < Date.parse(previous?.decidedAt ?? preparedAt) || input.expectedState !== stateToken(claimId, packetHash, detail.beforeWorkflow, detail.resetSequence, history)) throw new Error("Review transition could not be verified");
    history.push({ decision: decisionRecordSchema.parse({ ...row, revision: detail.revision, previousDecisionId: input.expectedLatestDecisionId, packetHash }), audit: detail });
  }
  if (new Set(history.map((entry) => entry.decision.id)).size !== rows.length) throw new Error("Duplicate review history");
  return history;
}

/** Existing caller transaction owns all reads; no nested queue. */
async function readReview(tx: ClaimTransaction, packet: PreparedClaim) {
  const id = packet.claim.id;
  const rows = await tx.select().from(reviewDecisions).where(eq(reviewDecisions.claimId, id)).limit(MAX_REVIEW_HISTORY + 1);
  const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entity, "claim_review"), eq(auditLog.entityId, id))).limit(MAX_REVIEW_HISTORY + 1);
  const [incident] = await tx.select().from(incidents).where(eq(incidents.id, packet.claim.incidentId));
  if (!incident || incident.chamberId !== "CH-1") return { state: unavailable(id, "The CH-1 incident association could not be verified. Review details and new decisions are withheld."), history: [] as VerifiedEntry[] };
  if (packet.status === "legacy") {
    const legacy = z.array(legacyDecisionSchema).max(MAX_REVIEW_HISTORY).safeParse(rows);
    return { state: unavailable(id, "This earlier claim has no verified immutable packet. Earlier review records are shown as recorded; new decisions are unavailable.", legacy.success ? legacy.data.sort((a, b) => Date.parse(a.decidedAt) - Date.parse(b.decidedAt) || a.id.localeCompare(b.id)) : []), history: [] as VerifiedEntry[] };
  }
  const [stored] = await tx.select({ hash: claimPackets.packetHash }).from(claimPackets).where(eq(claimPackets.claimId, id));
  if (!stored) throw new Error("Verified packet disappeared");
  let history: VerifiedEntry[];
  try { history = verifyHistory(rows, audits, id, stored.hash, packet.preparedAt); }
  catch { return { state: unavailable(id, "Review history could not be verified. Its records are preserved and new decisions are withheld."), history: [] as VerifiedEntry[] }; }
  const related = await tx.select({ id: claims.id }).from(claims).where(eq(claims.incidentId, packet.claim.incidentId));
  if (!incident || incident.chamberId !== "CH-1" || related.length !== 1 || !incidentWorkflowSchema.safeParse(incident.status).success) return { state: unavailable(id, "The current incident association could not be verified. New decisions are withheld."), history };
  const [generation] = await tx.select({ sequence: max(demoBackups.sequence) }).from(demoBackups);
  const sequence = generation.sequence ?? 0, latest = history.at(-1)?.decision;
  let reason: string | null = null;
  if (latest ? incident.status !== workflowFor(latest.status) : !["claim_prepared", "submitted"].includes(incident.status)) reason = "The current incident workflow differs from the verified review history. New decisions are withheld.";
  else if (latest?.status === "closed") reason = "This review is closed. Its history and frozen packet remain available.";
  else if (history.length >= MAX_REVIEW_HISTORY) reason = "The supported review history limit has been reached. Existing decisions remain available.";
  const state = reviewStateSchema.parse({ version: REVIEW_VERSION, status: "available", claimId: id, checkedAt: nowIst(), packetHash: stored.hash, state: stateToken(id, stored.hash, incident.status, sequence, history), workflow: incident.status, latestDecisionId: latest?.id ?? null, history: history.map((item) => item.decision), canRecord: reason === null, reason });
  return { state, history, sequence };
}

export async function getReviewerPacket(db: Database, rawId: string) {
  const id = claimIdentifier.parse(rawId);
  return withDatabase(db, () => db.transaction(async (tx) => {
    const packet = await readClaim(tx, id);
    return { packet, review: (await readReview(tx, packet)).state };
  }));
}
export async function getReviewState(db: Database, rawId: string) { return (await getReviewerPacket(db, rawId)).review; }

export async function recordDecision(db: Database, rawId: string, value: unknown) {
  const id = claimIdentifier.parse(rawId), input = decisionInputSchema.parse(value), decisionId = `decision-${input.requestId}`;
  return withDatabase(db, () => db.transaction(async (tx) => {
    const [saved] = await tx.select().from(reviewDecisions).where(eq(reviewDecisions.id, decisionId));
    const [savedAudit] = await tx.select().from(auditLog).where(eq(auditLog.id, `review-decision-${input.requestId}`));
    if (saved || savedAudit) {
      if (!saved || !savedAudit) throw new ReviewError(409, "REVIEW_UNAVAILABLE", "The saved decision receipt could not be verified. No new decision was recorded.");
      let detail: Audit;
      try { detail = decisionAuditSchema.parse(JSON.parse(savedAudit.detail)); } catch { throw new ReviewError(409, "REVIEW_UNAVAILABLE", "The saved decision receipt could not be verified."); }
      if (saved.claimId !== id || detail.claimId !== id || digest(detail.request) !== digest(input)) throw new ReviewError(409, "REQUEST_CONFLICT", "This request identifier belongs to a different decision. Review the current history before starting another request.");
      const packet = await readClaim(tx, id), { history } = await readReview(tx, packet);
      const existing = history.find((entry) => entry.decision.id === decisionId);
      if (!existing) throw new ReviewError(409, "REVIEW_UNAVAILABLE", "The saved decision and its history could not be verified.");
      return decisionReceiptSchema.parse({ version: REVIEW_VERSION, requestId: input.requestId, claimId: id, decision: existing.decision, workflow: existing.audit.afterWorkflow, reused: true });
    }
    const packet = await readClaim(tx, id), { state, history, sequence } = await readReview(tx, packet);
    if (packet.status !== "available" || state.status !== "available") throw new ReviewError(409, "REVIEW_UNAVAILABLE", state.status === "unavailable" ? state.reason : "A verified immutable packet is required before review.");
    if (history.at(-1)?.decision.status === "closed") throw new ReviewError(409, "REVIEW_CLOSED", "This review has been closed. Open its recorded history instead.");
    if (!state.canRecord) throw new ReviewError(409, "REVIEW_UNAVAILABLE", state.reason!);
    if (input.expectedState !== state.state || input.expectedLatestDecisionId !== state.latestDecisionId || input.expectedRevision !== history.length) throw new ReviewError(409, "STALE_REVIEW", "The review state changed after you opened it. Refresh the review and check the latest decision before continuing.");
    const previous = history.at(-1)?.decision;
    if (previous && sameRow(previous, input)) throw new ReviewError(409, "NO_CHANGE", "That status, reviewer and comment already match the latest decision. The existing record is preserved.");
    const decidedAt = nowIst();
    if (Date.parse(decidedAt) < Date.parse(previous?.decidedAt ?? packet.preparedAt)) throw new ReviewError(409, "CLOCK_UNAVAILABLE", "The current time precedes the saved history. No decision was recorded.");
    const workflow = workflowFor(input.status), revision = history.length + 1;
    const decision = decisionRecordSchema.parse({ id: decisionId, claimId: id, reviewerName: input.reviewerName, status: input.status, comment: input.comment, decidedAt, revision, previousDecisionId: state.latestDecisionId, packetHash: state.packetHash });
    const detail = decisionAuditSchema.parse({ version: REVIEW_VERSION, claimId: id, packetHash: state.packetHash, revision, resetSequence: sequence, beforeWorkflow: state.workflow, afterWorkflow: workflow, request: input });
    await tx.insert(reviewDecisions).values({ id: decisionId, claimId: id, reviewerName: input.reviewerName, status: input.status, comment: input.comment, decidedAt });
    await tx.update(incidents).set({ status: workflow }).where(eq(incidents.id, packet.claim.incidentId));
    await tx.insert(auditLog).values({ id: `review-decision-${input.requestId}`, actor: "demo_reviewer", action: "review_decision_recorded", entity: "claim_review", entityId: id, at: decidedAt, detail: JSON.stringify(detail) });
    return decisionReceiptSchema.parse({ version: REVIEW_VERSION, requestId: input.requestId, claimId: id, decision, workflow, reused: false });
  }));
}

export async function getReviewerIndex(db: Database, value: unknown = {}) {
  const query = reviewQuerySchema.parse(value);
  return withDatabase(db, () => db.transaction(async (tx) => {
    let cursor: { id: string; createdAt: string } | undefined;
    if (query.after) {
      [cursor] = await tx.select({ id: claims.id, createdAt: claims.createdAt }).from(claims).innerJoin(incidents, eq(incidents.id, claims.incidentId)).where(and(eq(claims.id, query.after), eq(incidents.chamberId, "CH-1")));
      if (!cursor || !ruleInstantSchema.safeParse(cursor.createdAt).success) throw new ReviewError(404, "PAGE_NOT_FOUND", "That reviewer page is unavailable. Open the newest claims.");
    }
    const older = cursor ? or(sql`julianday(${claims.createdAt}) < julianday(${cursor.createdAt})`, and(sql`julianday(${claims.createdAt}) = julianday(${cursor.createdAt})`, lt(claims.id, cursor.id))) : undefined;
    const rows = await tx.select({ id: claims.id, createdAt: claims.createdAt, title: incidents.title, workflow: incidents.status }).from(claims).innerJoin(incidents, eq(incidents.id, claims.incidentId)).where(and(eq(incidents.chamberId, "CH-1"), older)).orderBy(desc(sql`julianday(${claims.createdAt})`), desc(claims.id)).limit(21);
    const entries: z.infer<typeof reviewerIndexSchema>["entries"] = [];
    for (const row of rows.slice(0, 20)) {
      const base = { id: row.id, title: row.title, preparedAt: row.createdAt, workflow: row.workflow, readiness: null, priority: null, knownValueSubtotalPaise: null, valuationComplete: null, reasons: [], latestDecision: null, canRecord: false };
      try {
        const packet = await readClaim(tx, row.id), review = (await readReview(tx, packet)).state;
        if (packet.status === "legacy") { entries.push({ ...base, packetStatus: "legacy", reason: packet.reason }); continue; }
        if (!packet.data.evidence || packet.data.triage.status !== "available") throw new Error("Verified packet criteria unavailable");
        entries.push({ ...base, title: packet.data.incident.title, packetStatus: "verified", readiness: packet.claim.readiness, priority: packet.claim.priority, knownValueSubtotalPaise: packet.data.evidence.exposure.knownValueSubtotalPaise, valuationComplete: packet.data.evidence.exposure.valuationComplete, reasons: [...packet.data.triage.result.readiness.reasons, ...packet.data.triage.result.priority.reasons].map((item) => item.text), latestDecision: review.status === "available" ? review.history.at(-1)?.status ?? null : null, canRecord: review.status === "available" && review.canRecord, reason: review.reason });
      } catch { entries.push({ ...base, packetStatus: "unavailable", reason: "The prepared evidence could not be verified. Its calculated details and review controls are withheld." }); }
    }
    return reviewerIndexSchema.parse({ version: REVIEW_VERSION, checkedAt: nowIst(), entries, nextCursor: rows.length > 20 ? rows[19].id : null });
  }));
}
