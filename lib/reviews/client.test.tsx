import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import ReviewPanel from "../../app/claims/[id]/review";
import ReviewerList from "../../app/reviewer/list";
import { clearPendingDecision, pendingReviewKey, readPendingDecision, requestDecision, savePendingDecision } from "./client";
import { decisionReceiptSchema, reviewerIndexSchema, reviewStateSchema, REVIEW_VERSION, workflowFor, type DecisionInput, type DecisionReceipt } from "./contract";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => vi.restoreAllMocks());
const request: DecisionInput = { requestId: "c8f3f779-5d9a-4331-8d34-99ad7fdc272f", expectedLatestDecisionId: null, expectedRevision: 0, expectedState: "a".repeat(64), status: "needs_more_info", reviewerName: "Fictional reviewer", comment: "Please supply inspection evidence.\nOriginal wording retained.", packetReviewed: true };
const claimId = "claim-example", timestamp = "2026-11-01T18:00:00+05:30";
const receipt: DecisionReceipt = { version: REVIEW_VERSION, requestId: request.requestId, claimId, decision: { id: `decision-${request.requestId}`, claimId, reviewerName: request.reviewerName, status: request.status, comment: request.comment, decidedAt: timestamp, revision: 1, previousDecisionId: null, packetHash: "b".repeat(64) }, workflow: workflowFor(request.status), reused: false };
const state = reviewStateSchema.parse({ version: REVIEW_VERSION, status: "available", claimId, checkedAt: timestamp, packetHash: "b".repeat(64), state: request.expectedState, workflow: "claim_prepared", latestDecisionId: null, history: [], canRecord: true, reason: null });
function storage() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; }

describe("Exact review intent recovery", () => {
  it("retains the exact canonical intent across reload and removes only its own key", () => {
    const one = storage(); expect(readPendingDecision(one, claimId)).toBeNull(); savePendingDecision(one, claimId, request); one.setItem("unrelated", "preserve");
    const reloaded = { getItem: one.getItem }; expect(readPendingDecision(reloaded, claimId)).toEqual(request); expect(one.getItem(pendingReviewKey(claimId))).not.toContain("rawText");
    clearPendingDecision(one, claimId); expect(readPendingDecision(one, claimId)).toBeNull(); expect(one.getItem("unrelated")).toBe("preserve");
  });
  it("rejects invalid, foreign or unretained intents before sending", () => {
    const one = storage(); one.setItem(pendingReviewKey(claimId), "{bad"); expect(() => readPendingDecision(one, claimId)).toThrow();
    one.setItem(pendingReviewKey(claimId), JSON.stringify({ claimId: "foreign", input: request })); expect(() => readPendingDecision(one, claimId)).toThrow();
    expect(() => savePendingDecision({ getItem: () => null, setItem: () => {} }, claimId, request)).toThrow("No decision was sent");
  });
  it("posts a matching receipt with no-store and supports saved replay", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(receipt)), signal = new AbortController().signal;
    expect(await requestDecision(claimId, request, signal, fetcher)).toEqual(receipt); expect(fetcher).toHaveBeenCalledWith(`/api/claims/${claimId}/decision`, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal });
    expect(await requestDecision(claimId, request, signal, async () => Response.json({ ...receipt, reused: true }))).toMatchObject({ reused: true });
  });
  it.each(["network", "html", "unknown409", "wrong_status_code", "missing_fields"])("retains %s outcome as unconfirmed", async (kind) => {
    const fetcher: typeof fetch = async () => { if (kind === "network") throw new Error("Disconnected"); if (kind === "html") return new Response("proxy error", { status: 502 }); if (kind === "unknown409") return Response.json({ error: { code: "REVIEW_UNAVAILABLE", message: "Unverified" } }, { status: 409 }); if (kind === "wrong_status_code") return Response.json({ error: { code: "STALE_REVIEW", message: "Unverified" } }, { status: 500 }); return Response.json({}); };
    await expect(requestDecision(claimId, request, new AbortController().signal, fetcher)).rejects.toMatchObject({ definitive: false });
  });
  it.each(["claim", "request", "decision_id", "reviewer", "comment", "outcome", "previous", "revision", "workflow"])("rejects mismatched %s receipt", async (kind) => {
    const data = structuredClone(receipt);
    if (kind === "claim") data.claimId = "other"; if (kind === "request") data.requestId = "6c9e4cd1-420c-46bf-878a-e247a8429848"; if (kind === "decision_id") data.decision.id = "other"; if (kind === "reviewer") data.decision.reviewerName = "Other reviewer"; if (kind === "comment") data.decision.comment = "Other text"; if (kind === "outcome") data.decision.status = "closed"; if (kind === "previous") data.decision.previousDecisionId = "other"; if (kind === "revision") data.decision.revision = 2; if (kind === "workflow") data.workflow = "decided";
    await expect(requestDecision(claimId, request, new AbortController().signal, async () => Response.json(data))).rejects.toMatchObject({ definitive: false });
  });
  it("recognises an exact definitive stale-state rejection", async () => {
    await expect(requestDecision(claimId, request, new AbortController().signal, async () => Response.json({ error: { code: "STALE_REVIEW", message: "Refresh the review" } }, { status: 409 }))).rejects.toMatchObject({ definitive: true, code: "STALE_REVIEW" });
  });
});

describe("Review presentation and response guards", () => {
  it("SSR has no automatic decision, selected outcome or editable form before retained intent is checked", () => {
    const html = renderToStaticMarkup(createElement(ReviewPanel, { state })); expect(html).toContain("Choose an outcome"); expect(html).toContain("disabled"); expect(html).toContain("Fictional reviewer name"); expect(html).toContain("I reviewed the frozen packet"); expect(html).not.toContain("Record review decision</button><button");
  });
  it("closed history is attributed/escaped and has no new-decision form", () => {
    const closed = reviewStateSchema.parse({ ...state, workflow: "decided", latestDecisionId: receipt.decision.id, history: [{ ...receipt.decision, status: "closed", comment: "<script>example</script>" }], canRecord: false, reason: "This review is closed." });
    const html = renderToStaticMarkup(createElement(ReviewPanel, { state: closed })); expect(html).toContain("Closed"); expect(html).toContain("&lt;script&gt;example&lt;/script&gt;"); expect(html).toContain("Reviewer comment"); expect(html).not.toContain("<form");
  });
  it("legacy history is explicitly read-only and separately labelled", () => {
    const legacy = reviewStateSchema.parse({ version: REVIEW_VERSION, status: "unavailable", claimId, checkedAt: timestamp, reason: "Earlier packet provenance unavailable.", legacyHistory: [{ id: "earlier", claimId, reviewerName: "Fictional earlier reviewer", status: "closed", comment: "Earlier original", decidedAt: timestamp }] });
    const html = renderToStaticMarkup(createElement(ReviewPanel, { state: legacy })); expect(html).toContain("earlier record"); expect(html).toContain("Earlier original"); expect(html).not.toContain("latest recorded"); expect(html).not.toContain("<form");
  });
  it("rejects inconsistent history identity, revision, latest and closure DTOs", () => {
    for (const bad of [{ ...state, latestDecisionId: "missing" }, { ...state, history: [{ ...receipt.decision, claimId: "foreign" }] }, { ...state, history: [{ ...receipt.decision, revision: 2 }] }, { ...state, latestDecisionId: receipt.decision.id, history: [{ ...receipt.decision, status: "closed" }] }, { ...state, workflow: "draft" }]) expect(reviewStateSchema.safeParse(bad).success).toBe(false);
    expect(decisionReceiptSchema.safeParse({ ...receipt, decision: {} }).success).toBe(false);
  });
  it("queue is compact, per-packet and handles empty/legacy/invalid calculations", () => {
    const empty = reviewerIndexSchema.parse({ version: REVIEW_VERSION, checkedAt: timestamp, entries: [], nextCursor: null }); expect(renderToStaticMarkup(createElement(ReviewerList, { data: empty }))).toContain("No prepared claims yet");
    const row = { id: claimId, title: "Fictional packet", preparedAt: timestamp, workflow: "claim_prepared", packetStatus: "verified", readiness: "Needs more evidence", priority: "Standard priority", knownValueSubtotalPaise: 8000000, valuationComplete: false, reasons: ["Inspection evidence is missing."], latestDecision: null, canRecord: true, reason: null };
    const data = reviewerIndexSchema.parse({ ...empty, entries: [row] }); const html = renderToStaticMarkup(createElement(ReviewerList, { data })); expect(html).toContain("₹80,000.00"); expect(html).toContain("incomplete valuation"); expect(html).toContain("Inspection evidence is missing"); expect(html).toContain("no combined total");
    expect(reviewerIndexSchema.safeParse({ ...empty, entries: [{ ...row, packetStatus: "legacy" }] }).success).toBe(false);
  });
});
