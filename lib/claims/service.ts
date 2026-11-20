import "server-only";
import { eq, max } from "drizzle-orm";
import { withDatabase } from "../db/access";
import type { Database } from "../db/client";
import { auditLog, claimPackets, claims, demoBackups, incidents } from "../db/schema";
import { readIncident } from "../incidents/service";
import type { IncidentDetail } from "../incidents/types";
import { toIstIso } from "../inventory/format";
import { digest } from "../reset/snapshot";
import { CLAIM_DISCLAIMER, CLAIM_VERSION, claimIdentifier, claimReceiptSchema, frozenPacketSchema, MAX_PACKET_BYTES, prepareInputSchema, previewSchema, type FrozenPacket } from "./contract";
import { captureSources, readFrozenSources, type ClaimTransaction } from "./sources";

export class ClaimError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = "ClaimError"; }
}
function usable(data: IncidentDetail) {
  if (data.evidence?.revision.membership !== "current" || !data.evidence.boundariesMatch || data.incident.status !== "draft" || data.triage.status !== "available" || data.summary.status !== "available" || !data.triage.criteria.policy) throw new ClaimError(409, "NOT_ELIGIBLE", "Preparation needs a fresh linked draft, verified reports and an available demonstration policy. Refresh evidence and review the selected revision.");
  return { evidence: data.evidence, triage: data.triage, summary: data.summary, policy: data.triage.criteria.policy };
}
function result(data: IncidentDetail) {
  const { evidence, triage, summary, policy } = usable(data);
  return { incident: data.incident, chamber: data.chamber, revisions: data.revisions, evidence, events: data.events, documents: data.documents, corrections: data.documentCorrections, copies: data.documentCopies,
    criteria: { ...triage.criteria, basis: "at_preparation" }, policy, triage: triage.result, summary: { version: summary.version, mode: summary.mode, facts: summary.facts, statements: summary.statements } };
}
const sourceToken = (packet: Pick<FrozenPacket, "incidentId" | "analysisId" | "policyId" | "resetSequence" | "sources">) => digest({ incidentId: packet.incidentId, analysisId: packet.analysisId, policyId: packet.policyId, resetSequence: packet.resetSequence, sources: packet.sources });
async function review(tx: ClaimTransaction, incidentId: string, analysisId: string) {
  const data = await readIncident(tx, incidentId, analysisId);
  const values = usable(data);
  const existing = await tx.select({ id: claims.id }).from(claims).where(eq(claims.incidentId, incidentId));
  if (existing.length) throw new ClaimError(409, "PROTECTED", "This incident already has a prepared claim. Open its saved packet instead.");
  const sources = await captureSources(tx), [latest] = await tx.select({ sequence: max(demoBackups.sequence) }).from(demoBackups);
  const basis = { incidentId, analysisId, policyId: values.policy.id, resetSequence: latest.sequence ?? 0, sources };
  return { data, values, basis, token: sourceToken(basis) };
}
export async function previewClaim(db: Database, rawId: string, rawAnalysis: string) {
  const id = claimIdentifier.parse(rawId), analysisId = claimIdentifier.parse(rawAnalysis);
  return withDatabase(db, () => db.transaction(async (tx) => {
    const { data, values, token } = await review(tx, id, analysisId);
    return previewSchema.parse({ version: CLAIM_VERSION, incidentId: id, analysisId, checkedAt: data.checkedAt, sourceToken: token, policy: values.policy, readiness: values.triage.result.readiness.status, priority: values.triage.result.priority.status,
      knownValueSubtotalPaise: values.evidence.exposure.knownValueSubtotalPaise, valuationComplete: values.evidence.exposure.valuationComplete,
      checklist: values.triage.result.checklist.map(({ id, text, status }) => ({ id, text, status })), documentIds: data.documents.map((doc) => doc.id) });
  }));
}
function projections(data: IncidentDetail) {
  const { triage, summary, evidence } = usable(data);
  return { readiness: triage.result.readiness.status, priority: triage.result.priority.status, triageReasonsJson: [...triage.result.readiness.reasons, ...triage.result.priority.reasons].map((item) => ({ ...item })), exposureValueInr: evidence.exposure.knownValueSubtotalPaise / 100,
    summaryJson: summary.statements.map(({ text, source_ids }) => ({ text, source_ids })), missingEvidenceJson: triage.result.checklist.filter((item) => item.status === "missing").map((item) => ({ ...item })) };
}
async function verifyPacket(row: typeof claimPackets.$inferSelect, claim: typeof claims.$inferSelect) {
  if (Buffer.byteLength(JSON.stringify(row.packetJson), "utf8") > MAX_PACKET_BYTES) throw new Error("Packet too large");
  const packet = frozenPacketSchema.parse(row.packetJson), input = prepareInputSchema.parse(row.requestJson);
  if (digest(packet) !== row.packetHash || packet.claimId !== claim.id || packet.claimId !== row.claimId || packet.claimId !== `claim-${input.requestId}` || packet.incidentId !== claim.incidentId || packet.analysisId !== row.analysisId || packet.analysisId !== input.analysisId || input.requestId !== row.requestId || packet.policyId !== input.policyId || packet.policyId !== claim.policyId || packet.preparedAt !== row.preparedAt || packet.preparedAt !== claim.createdAt || sourceToken(packet) !== packet.sourceToken || packet.sourceToken !== input.expectedSourceToken) throw new Error("Packet metadata mismatch");
  const { data, copySources } = await readFrozenSources(packet), frozen = result(data);
  if (frozen.policy.id !== packet.policyId || (digest(frozen) !== packet.resultHash || digest(packet.resultJson) !== packet.resultHash)) throw new Error("Packet outcomes differ from frozen evidence");
  const expected = projections(data);
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) if (digest(expected[key]) !== digest(claim[key])) throw new Error("Claim projection mismatch");
  return { packet, data, copySources };
}
export async function prepareClaim(db: Database, rawId: string, value: unknown) {
  const id = claimIdentifier.parse(rawId), input = prepareInputSchema.parse(value);
  return withDatabase(db, () => db.transaction(async (tx) => {
    const [saved] = await tx.select().from(claimPackets).where(eq(claimPackets.requestId, input.requestId));
    if (saved) {
      if (digest(prepareInputSchema.parse(saved.requestJson)) !== digest(input)) throw new ClaimError(409, "REQUEST_CONFLICT", "This request identifier belongs to different reviewed evidence.");
      const [claim] = await tx.select().from(claims).where(eq(claims.id, saved.claimId));
      if (!claim || claim.incidentId !== id) throw new ClaimError(409, "REQUEST_CONFLICT", "This request identifier belongs to another incident.");
      await verifyPacket(saved, claim);
      return claimReceiptSchema.parse({ version: CLAIM_VERSION, claimId: claim.id, incidentId: id, analysisId: saved.analysisId, preparedAt: saved.preparedAt, reused: true });
    }
    const { data, values, basis, token } = await review(tx, id, input.analysisId);
    if (values.policy.id !== input.policyId || token !== input.expectedSourceToken) throw new ClaimError(409, "SOURCES_CHANGED", "Evidence or review criteria changed after review. Review the current packet before preparing it.");
    const claimId = `claim-${input.requestId}`, preparedAt = toIstIso(new Date().toISOString());
    const packet = frozenPacketSchema.parse({ version: CLAIM_VERSION, claimId, ...basis, preparedAt, actor: "storage_operator", disclaimer: CLAIM_DISCLAIMER, sourceToken: token, resultJson: JSON.parse(JSON.stringify(result(data))), resultHash: digest(result(data)) });
    if (Buffer.byteLength(JSON.stringify(packet), "utf8") > MAX_PACKET_BYTES) throw new ClaimError(409, "PACKET_LIMIT", "The frozen evidence exceeds the supported packet size.");
    // Verify the detached sources before committing anything; failures roll back all rows.
    const claim = { id: claimId, incidentId: id, policyId: input.policyId, ...projections(data), createdAt: preparedAt };
    const stored = { claimId, requestId: input.requestId, requestJson: input, analysisId: input.analysisId, preparedAt, packetJson: packet, packetHash: digest(packet) };
    await verifyPacket(stored, claim);
    await tx.insert(claims).values(claim);
    await tx.insert(claimPackets).values(stored);
    await tx.update(incidents).set({ status: "claim_prepared" }).where(eq(incidents.id, id));
    await tx.insert(auditLog).values({ id: `claim-prepared-${input.requestId}`, actor: "storage_operator", action: "claim_prepared", entity: "claim", entityId: claimId, at: preparedAt, detail: JSON.stringify({ version: CLAIM_VERSION, incidentId: id, analysisId: input.analysisId, policyId: input.policyId, sourceToken: token, packetHash: stored.packetHash }) });
    return claimReceiptSchema.parse({ version: CLAIM_VERSION, claimId, incidentId: id, analysisId: input.analysisId, preparedAt, reused: false });
  }));
}
export async function getClaim(db: Database, rawId: string) {
  const id = claimIdentifier.parse(rawId);
  return withDatabase(db, () => db.transaction((tx) => readClaim(tx, id)));
}

/** Unqueued, verified immutable-packet reader for caller-owned transactions. */
export async function readClaim(tx: ClaimTransaction, id: string) {
    const [claim] = await tx.select().from(claims).where(eq(claims.id, id));
    if (!claim) throw new ClaimError(404, "NOT_FOUND", "That prepared claim is unavailable.");
    const [row] = await tx.select().from(claimPackets).where(eq(claimPackets.claimId, id));
    if (!row) return { status: "legacy" as const, claim, reason: "This earlier claim has no versioned source snapshot. Its source provenance cannot be reconstructed." };
    const { packet, data, copySources } = await verifyPacket(row, claim);
    const frozenData = { ...data, checkedAt: packet.preparedAt,
      documentInput: { allowed: false, reason: "This packet is immutable. Open the current workspace separately." },
      triage: data.triage.status === "available" ? { ...data.triage, checkedAt: packet.preparedAt, criteria: { ...data.triage.criteria, basis: "at_preparation" as const } } : data.triage,
      summary: data.summary.status === "available" ? { ...data.summary, checkedAt: packet.preparedAt } : data.summary,
    };
    return { status: "available" as const, claim, version: packet.version, preparedAt: packet.preparedAt, disclaimer: packet.disclaimer, data: frozenData, copySources };
}
export type PreparedClaim = Awaited<ReturnType<typeof getClaim>>;
export async function listIncidentClaims(db: Database, rawId: string) {
  const id = claimIdentifier.parse(rawId);
  return withDatabase(db, () => db.select({ id: claims.id, createdAt: claims.createdAt }).from(claims).where(eq(claims.incidentId, id)));
}
