import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeStoredLog } from "../analysis/service";
import { getClaim, prepareClaim, previewClaim } from "../claims/service";
import { withDatabase } from "../db/access";
import { openDatabase, type DatabaseConnection } from "../db/client";
import { initializeDatabase } from "../db/initialize";
import * as t from "../db/schema";
import { getResetStatus, runDemoOperation } from "../reset/service";
import { captureSnapshot } from "../reset/snapshot";
import { decisionInputSchema, decisionStatuses, workflowFor, type DecisionInput } from "./contract";
import { reviewHandlers } from "./http";
import { getReviewerIndex, getReviewerPacket, getReviewState, recordDecision } from "./service";
vi.mock("server-only", () => ({}));
let dir: string, connection: DatabaseConnection, claimId: string, incidentId: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "coldcover-review-")); connection = await initializeDatabase(pathToFileURL(join(dir, "qa.db")).href);
  const analysis = await analyzeStoredLog(connection.db); incidentId = analysis.incidents[0].incidentId;
  const preview = await previewClaim(connection.db, incidentId, analysis.analysis!.id);
  claimId = (await prepareClaim(connection.db, incidentId, { requestId: randomUUID(), analysisId: preview.analysisId, policyId: preview.policy.id, expectedSourceToken: preview.sourceToken, evidenceReviewed: true })).claimId;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); connection.close(); rmSync(dir, { recursive: true, force: true }); });
async function input(status: DecisionInput["status"] = "needs_more_info"): Promise<DecisionInput> {
  const state = await getReviewState(connection.db, claimId); if (state.status !== "available") throw new Error("Expected verified review");
  return { requestId: randomUUID(), expectedLatestDecisionId: state.latestDecisionId, expectedRevision: state.history.length, expectedState: state.state, status, reviewerName: "Fictional reviewer A", comment: "Please supply the missing inspection evidence for human review.", packetReviewed: true };
}
const snapshot = () => withDatabase(connection.db, () => connection.db.transaction(captureSnapshot));
const reviewAudits = async () => (await connection.db.select().from(t.auditLog)).filter((row) => row.entity === "claim_review");

describe("Audited immutable packet review", () => {
  it("queue, packet and state reads record no decision and expose saved reasons/value", async () => {
    const before = await snapshot(), queue = await getReviewerIndex(connection.db), detail = await getReviewerPacket(connection.db, claimId);
    expect(queue.entries).toHaveLength(1); expect(queue.entries[0]).toMatchObject({ id: claimId, packetStatus: "verified", readiness: "Needs more evidence", knownValueSubtotalPaise: 8000000, canRecord: true, latestDecision: null }); expect(queue.entries[0].reasons.length).toBeGreaterThan(0);
    expect(JSON.stringify(queue)).not.toContain("rawText"); expect(JSON.stringify(queue)).not.toContain("packetJson");
    expect(detail.review).toMatchObject({ status: "available", history: [], canRecord: true }); expect(await snapshot()).toEqual(before);
  });
  it.each(decisionStatuses)("records explicit %s with one audit, separate from frozen readiness", async (status) => {
    const packetBefore = await getClaim(connection.db, claimId), [frozenBefore] = await connection.db.select().from(t.claimPackets), request = await input(status);
    const receipt = await recordDecision(connection.db, claimId, request);
    expect(receipt).toMatchObject({ reused: false, workflow: workflowFor(status), decision: { id: `decision-${request.requestId}`, status, revision: 1, previousDecisionId: null } }); expect(receipt.decision.decidedAt).toMatch(/\+05:30$/);
    expect(await connection.db.select().from(t.reviewDecisions)).toHaveLength(1); expect(await reviewAudits()).toHaveLength(1);
    expect((await connection.db.select().from(t.incidents).where(eq(t.incidents.id, incidentId)))[0].status).toBe(workflowFor(status));
    expect(await getClaim(connection.db, claimId)).toEqual(packetBefore); expect((await connection.db.select().from(t.claimPackets))[0]).toEqual(frozenBefore);
    const state = await getReviewState(connection.db, claimId); expect(state).toMatchObject({ status: "available", latestDecisionId: receipt.decision.id, canRecord: status !== "closed" });
  });
  it("appends all earlier decisions, closes deliberately, replays before closure guards", async () => {
    const firstInput = await input(), first = await recordDecision(connection.db, claimId, firstInput);
    const second = await recordDecision(connection.db, claimId, { ...await input("referred_to_specialist"), comment: "Please examine the recorded discrepancy." });
    const closing = await input("closed"), third = await recordDecision(connection.db, claimId, closing);
    const before = await snapshot(), state = await getReviewState(connection.db, claimId);
    expect(state.status === "available" && state.history.map((row) => row.id)).toEqual([first.decision.id, second.decision.id, third.decision.id]);
    expect(await recordDecision(connection.db, claimId, firstInput)).toEqual({ ...first, reused: true }); expect(await recordDecision(connection.db, claimId, closing)).toEqual({ ...third, reused: true });
    await expect(recordDecision(connection.db, claimId, { ...closing, requestId: randomUUID() })).rejects.toMatchObject({ code: "REVIEW_CLOSED" }); expect(await snapshot()).toEqual(before);
  });
  it("concurrent exact retries produce one decision/audit", async () => {
    const request = await input(), receipts = await Promise.all([recordDecision(connection.db, claimId, request), recordDecision(connection.db, claimId, request)]);
    expect(receipts.map((row) => row.reused)).toEqual([false, true]); expect(await reviewAudits()).toHaveLength(1);
  });
  it("two reviewers on the same state cannot both append", async () => {
    const first = await input(), second = { ...first, requestId: randomUUID(), reviewerName: "Fictional reviewer B" };
    const results = await Promise.allSettled([recordDecision(connection.db, claimId, first), recordDecision(connection.db, claimId, second)]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1); expect(await connection.db.select().from(t.reviewDecisions)).toHaveLength(1);
    await expect(recordDecision(connection.db, claimId, second)).rejects.toMatchObject({ code: "STALE_REVIEW" });
  });
  it("independent write connections cannot bypass current-state guards", async () => {
    const other = await openDatabase(pathToFileURL(join(dir, "qa.db")).href);
    try {
      await other.client.execute("PRAGMA busy_timeout=20"); const first = await input(), second = { ...first, requestId: randomUUID() };
      const results = await Promise.allSettled([recordDecision(connection.db, claimId, first), recordDecision(other.db, claimId, second)]);
      expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1); expect(await connection.db.select().from(t.reviewDecisions)).toHaveLength(1); expect(await reviewAudits()).toHaveLength(1);
    } finally { other.close(); }
  });
  it("UUID conflict and semantic duplicate do not append", async () => {
    const request = await input(); await recordDecision(connection.db, claimId, request); const before = await snapshot();
    await expect(recordDecision(connection.db, "another-claim", request)).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    await expect(recordDecision(connection.db, claimId, { ...request, comment: "Different comment" })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    await expect(recordDecision(connection.db, claimId, await input())).rejects.toMatchObject({ code: "NO_CHANGE" }); expect(await snapshot()).toEqual(before);
  });
  it("later live criteria, readings and reports do not change packet review inputs", async () => {
    const request = await input(), original = await getClaim(connection.db, claimId);
    await connection.db.update(t.batches).set({ recordedValueInr: null }); await connection.db.update(t.temperatureReadings).set({ temperatureC: 3 }); await connection.db.update(t.policies).set({ notes: "Later fictional review criteria" }); await connection.db.update(t.documents).set({ rawText: "Later live source" }); await analyzeStoredLog(connection.db);
    expect(await recordDecision(connection.db, claimId, request)).toMatchObject({ reused: false }); expect(await getClaim(connection.db, claimId)).toEqual(original);
  });
  it("workflow mismatch withholds new decisions while an exact verified receipt can replay", async () => {
    const request = await input(), receipt = await recordDecision(connection.db, claimId, request);
    await connection.db.update(t.incidents).set({ status: "draft" }).where(eq(t.incidents.id, incidentId));
    expect(await getReviewState(connection.db, claimId)).toMatchObject({ status: "available", canRecord: false }); expect(await recordDecision(connection.db, claimId, request)).toEqual({ ...receipt, reused: true });
    await expect(recordDecision(connection.db, claimId, { ...request, requestId: randomUUID() })).rejects.toMatchObject({ code: "REVIEW_UNAVAILABLE" });
  });
  it("accepts explicitly already-submitted workflow without automatic submission", async () => {
    await connection.db.update(t.incidents).set({ status: "submitted" }).where(eq(t.incidents.id, incidentId));
    expect(await recordDecision(connection.db, claimId, await input())).toMatchObject({ workflow: "under_review" });
  });
  it("rolls back decision, workflow and audit when the final audit insert fails", async () => {
    const request = await input(), before = await snapshot();
    await connection.client.execute("CREATE TRIGGER qa_review_failure BEFORE INSERT ON audit_log WHEN NEW.action='review_decision_recorded' BEGIN SELECT RAISE(ABORT,'qa rollback'); END");
    await expect(recordDecision(connection.db, claimId, request)).rejects.toThrow(); await connection.client.execute("DROP TRIGGER qa_review_failure"); expect(await snapshot()).toEqual(before);
  });
  it.each(["comment", "actor", "packet hash", "revision", "previous decision", "audit time", "missing audit", "missing row", "audit request", "extra audit", "noncanonical audit"])("withholds corrupt %s history and makes no new writes", async (kind) => {
    const request = await input(); await recordDecision(connection.db, claimId, request); const next = await input("referred_to_specialist"), [audit] = await reviewAudits(); const detail = JSON.parse(audit.detail);
    if (kind === "comment") await connection.db.update(t.reviewDecisions).set({ comment: "Changed comment" });
    if (kind === "actor") await connection.db.update(t.auditLog).set({ actor: "different" }).where(eq(t.auditLog.id, audit.id));
    if (kind === "audit time") await connection.db.update(t.auditLog).set({ at: "2026-03-10T00:00:00+05:30" }).where(eq(t.auditLog.id, audit.id));
    if (kind === "missing audit") await connection.db.delete(t.auditLog).where(eq(t.auditLog.id, audit.id));
    if (kind === "missing row") await connection.db.delete(t.reviewDecisions);
    if (kind === "extra audit") await connection.db.insert(t.auditLog).values({ ...audit, id: "unexpected-audit" });
    if (["packet hash", "revision", "previous decision", "audit request"].includes(kind)) {
      if (kind === "packet hash") detail.packetHash = "0".repeat(64); if (kind === "revision") detail.revision = 2; if (kind === "previous decision") detail.request.expectedLatestDecisionId = "foreign"; if (kind === "audit request") detail.request.comment = "Changed canonical intent";
      await connection.db.update(t.auditLog).set({ detail: JSON.stringify(detail) }).where(eq(t.auditLog.id, audit.id));
    }
    if (kind === "noncanonical audit") { detail.request.comment = ` ${detail.request.comment} `; await connection.db.update(t.auditLog).set({ detail: JSON.stringify(detail) }).where(eq(t.auditLog.id, audit.id)); }
    const before = await snapshot(); expect(await getReviewState(connection.db, claimId)).toMatchObject({ status: "unavailable" }); await expect(recordDecision(connection.db, claimId, next)).rejects.toMatchObject({ code: "REVIEW_UNAVAILABLE" }); await expect(recordDecision(connection.db, claimId, request)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
  });
  it("uses revision order for identical timestamps and rejects clock regression", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 10000));
    const first = await recordDecision(connection.db, claimId, await input()), second = await recordDecision(connection.db, claimId, { ...await input("approved_for_assessment"), comment: "Suitable for initial assessment; missing evidence remains recorded." });
    expect(first.decision.decidedAt).toBe(second.decision.decidedAt); expect(second.decision.revision).toBe(2);
    const next = await input("closed"); vi.setSystemTime(new Date(Date.now() - 10000)); await expect(recordDecision(connection.db, claimId, next)).rejects.toMatchObject({ code: "CLOCK_UNAVAILABLE" });
  });
});

describe("Legacy, reset and queue boundaries", () => {
  async function legacy(id = "legacy") { await connection.db.insert(t.claims).values({ id, incidentId: "demo-incident-01", policyId: "coldcover-demo-policy", readiness: "Needs more evidence", priority: "Standard priority", triageReasonsJson: [], exposureValueInr: 80000, summaryJson: [], missingEvidenceJson: [], createdAt: "2026-03-10T08:00:00+05:30" }); }
  it("preserves legacy claims/reviews as explicitly unverified read-only records", async () => {
    await legacy(); await connection.db.insert(t.reviewDecisions).values({ id: "earlier", claimId: "legacy", reviewerName: "Fictional earlier reviewer", status: "closed", comment: "Earlier original comment", decidedAt: "2026-03-10T09:00:00+05:30" });
    const before = await snapshot(); expect(await getReviewState(connection.db, "legacy")).toMatchObject({ status: "unavailable", legacyHistory: [{ id: "earlier", comment: "Earlier original comment" }] });
    await expect(recordDecision(connection.db, "legacy", await input())).rejects.toMatchObject({ code: "REVIEW_UNAVAILABLE" }); expect(await snapshot()).toEqual(before);
  });
  it("does not invent transitions for unaudited reviews attached to a modern packet", async () => {
    const request = await input(); await connection.db.insert(t.reviewDecisions).values({ id: "earlier", claimId, reviewerName: "Fictional earlier reviewer", status: "needs_more_info", comment: "Existing original", decidedAt: "2026-03-10T09:00:00+05:30" });
    expect(await getReviewState(connection.db, claimId)).toMatchObject({ status: "unavailable" }); await expect(recordDecision(connection.db, claimId, request)).rejects.toMatchObject({ code: "REVIEW_UNAVAILABLE" });
  });
  it("corrupt packets withhold queue calculations and decisions", async () => {
    const request = await input(); await connection.db.update(t.claimPackets).set({ packetHash: "0".repeat(64) });
    expect((await getReviewerIndex(connection.db)).entries[0]).toMatchObject({ packetStatus: "unavailable", readiness: null, priority: null, knownValueSubtotalPaise: null, canRecord: false }); await expect(recordDecision(connection.db, claimId, request)).rejects.toThrow();
  });
  it("pages20 compact records by actual preparation instant then ID", async () => {
    for (let i = 0; i < 22; i++) { const id = `legacy-${String(i).padStart(2, "0")}`; await legacy(id); await connection.db.update(t.claims).set({ createdAt: i % 2 === 0 ? "2026-03-10T08:00:00+05:30" : "2026-03-10T02:30:00Z" }).where(eq(t.claims.id, id)); }
    const first = await getReviewerIndex(connection.db), second = await getReviewerIndex(connection.db, { after: first.nextCursor });
    expect(first.entries).toHaveLength(20); expect(second.entries).toHaveLength(3); expect(second.nextCursor).toBeNull();
    expect([...first.entries, ...second.entries].map((row) => row.id)).toEqual([claimId, ...Array.from({ length: 22 }, (_, i) => `legacy-${String(21 - i).padStart(2, "0")}`)]);
    await expect(getReviewerIndex(connection.db, { after: "missing" })).rejects.toMatchObject({ code: "PAGE_NOT_FOUND" });
  });
  it("reset/restore preserves complete review history/receipts and rejects ABA stale inputs", async () => {
    const request = await input(), receipt = await recordDecision(connection.db, claimId, request), stale = await input("referred_to_specialist");
    const reviews = await connection.db.select().from(t.reviewDecisions), audits = await reviewAudits(), packets = await connection.db.select().from(t.claimPackets);
    const reset = await runDemoOperation(connection.db, { requestId: randomUUID(), action: "reset", expectedState: (await getResetStatus(connection.db)).state, confirmation: "RESET DEMO" });
    await runDemoOperation(connection.db, { requestId: randomUUID(), action: "restore", expectedState: (await getResetStatus(connection.db)).state, backupId: reset.backupId, confirmation: "RESTORE BACKUP" });
    expect(await connection.db.select().from(t.reviewDecisions)).toEqual(reviews); expect(await reviewAudits()).toEqual(audits); expect(await connection.db.select().from(t.claimPackets)).toEqual(packets);
    expect(await recordDecision(connection.db, claimId, request)).toEqual({ ...receipt, reused: true }); await expect(recordDecision(connection.db, claimId, stale)).rejects.toMatchObject({ code: "STALE_REVIEW" });
    expect(await recordDecision(connection.db, claimId, { ...await input("referred_to_specialist"), comment: "Further fictional evidence review." })).toMatchObject({ decision: { revision: 2 } });
  });
  it("a reviewer write invalidates previously confirmed reset state", async () => {
    const state = await getResetStatus(connection.db); await recordDecision(connection.db, claimId, await input());
    await expect(runDemoOperation(connection.db, { requestId: randomUUID(), action: "reset", expectedState: state.state, confirmation: "RESET DEMO" })).rejects.toMatchObject({ code: "STALE_STATE" });
  });
});

describe("Review HTTP validation", () => {
  it("rejects invalid identifiers, queries, input, origin, encoding and sizes before DB access", async () => {
    const getDb = vi.fn(async () => connection.db), h = reviewHandlers(getDb), url = "http://localhost/api/claims/x/decision";
    const post = (body: string | Uint8Array, headers: Record<string, string> = { "Content-Type": "application/json" }) => h.POST(new Request(url, { method: "POST", body: body as BodyInit, headers }), claimId);
    expect((await h.STATE("invalid/id")).status).toBe(400); expect((await h.INDEX(new Request("http://localhost/api/claims?bad=x"))).status).toBe(400); expect((await h.INDEX(new Request("http://localhost/api/claims?after=x&after=y"))).status).toBe(400);
    expect((await post("{}")).status).toBe(400); expect((await post("{bad")).status).toBe(400); expect((await post("{}", { "Content-Type": "text/plain" })).status).toBe(415); expect((await post("x".repeat(16385))).status).toBe(413); expect((await post(new Uint8Array([255]))).status).toBe(400);
    expect((await post("{}", { "Content-Type": "application/json", Origin: "https://foreign.example" })).status).toBe(403); expect(getDb).not.toHaveBeenCalled();
  });
  it("returns201, exact replay200, no-store, readable state/index and404", async () => {
    const h = reviewHandlers(async () => connection.db), request = await input(); const post = () => h.POST(new Request("http://localhost/api/claims/x/decision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }), claimId);
    const response = await post(); expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("no-store"); expect((await post()).status).toBe(200);
    expect((await (await h.STATE(claimId)).json()).history).toHaveLength(1); expect((await h.INDEX(new Request("http://localhost/api/claims"))).status).toBe(200); expect((await h.STATE("missing")).status).toBe(404);
  });
  it.each(["blank name", "blank comment", "too long", "unconfirmed", "unsupported status", "control character", "foreign previous", "extra value"])("strict input rejects %s", async (kind) => {
    const request: Record<string, unknown> = { ...await input() };
    if (kind === "blank name") request.reviewerName = " "; if (kind === "blank comment") request.comment = "\n\t"; if (kind === "too long") request.comment = "x".repeat(2001); if (kind === "unconfirmed") request.packetReviewed = false; if (kind === "unsupported status") request.status = "paid"; if (kind === "control character") request.comment = "abc\u0000def"; if (kind === "foreign previous") request.expectedLatestDecisionId = "foreign"; if (kind === "extra value") request.value = 100;
    expect(decisionInputSchema.safeParse(request).success).toBe(false);
  });
});
