import { z } from "zod";
import { decisionInputSchema, decisionReceiptSchema, pendingDecisionSchema, workflowFor, type DecisionInput } from "./contract";
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }).strict() }).strict();
export class DecisionFailure extends Error {
  constructor(message: string, public readonly definitive: boolean, public readonly code = "REVIEW_UNCONFIRMED") { super(message); }
}
export const pendingReviewKey = (claimId: string) => `coldcover-review-v1:${claimId}`;
type IntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function readPendingDecision(storage: Pick<Storage, "getItem">, claimId: string) {
  const value = storage.getItem(pendingReviewKey(claimId)); if (value === null) return null;
  const pending = pendingDecisionSchema.parse(JSON.parse(value));
  if (pending.claimId !== claimId) throw new Error("The retained review belongs to another packet.");
  return pending.input;
}
export function savePendingDecision(storage: Pick<Storage, "getItem" | "setItem">, claimId: string, value: DecisionInput) {
  const input = decisionInputSchema.parse(value);
  storage.setItem(pendingReviewKey(claimId), JSON.stringify({ claimId, input }));
  if (JSON.stringify(readPendingDecision(storage, claimId)) !== JSON.stringify(input)) throw new Error("The review request could not be retained safely. No decision was sent.");
}
export function clearPendingDecision(storage: Pick<IntentStorage, "removeItem">, claimId: string) { storage.removeItem(pendingReviewKey(claimId)); }
const definitiveCodes: Record<string, number> = { INVALID_REVIEW: 400, ORIGIN_REJECTED: 403, CONTENT_TYPE: 415, BODY_TOO_LARGE: 413, REQUEST_CONFLICT: 409, STALE_REVIEW: 409, REVIEW_CLOSED: 409, NO_CHANGE: 409, CLOCK_UNAVAILABLE: 409, NOT_FOUND: 404 };
export async function requestDecision(claimId: string, value: DecisionInput, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const input = decisionInputSchema.parse(value);
  let response: Response;
  try { response = await fetcher(`/api/claims/${encodeURIComponent(claimId)}/decision`, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal }); }
  catch { throw new DecisionFailure("The decision could not be confirmed. Keep the saved request and retry it explicitly.", false); }
  let data: unknown;
  try { data = await response.json(); } catch { throw new DecisionFailure("The response could not be verified. Retry the same saved review request.", false); }
  if (!response.ok) {
    const error = errorSchema.safeParse(data);
    if (error.success && definitiveCodes[error.data.error.code] === response.status) throw new DecisionFailure(error.data.error.message, true, error.data.error.code);
    throw new DecisionFailure("The decision result is not confirmed. Retry the same saved request to check its outcome.", false);
  }
  const receipt = decisionReceiptSchema.safeParse(data);
  if (!receipt.success || receipt.data.claimId !== claimId || receipt.data.requestId !== input.requestId || receipt.data.decision.id !== `decision-${input.requestId}` || receipt.data.decision.claimId !== claimId || receipt.data.decision.previousDecisionId !== input.expectedLatestDecisionId || receipt.data.decision.revision !== input.expectedRevision + 1 || receipt.data.decision.status !== input.status || receipt.data.decision.reviewerName !== input.reviewerName || receipt.data.decision.comment !== input.comment || receipt.data.workflow !== workflowFor(input.status)) throw new DecisionFailure("The returned decision does not match the saved request. Retry that same request to confirm its outcome.", false);
  return receipt.data;
}
