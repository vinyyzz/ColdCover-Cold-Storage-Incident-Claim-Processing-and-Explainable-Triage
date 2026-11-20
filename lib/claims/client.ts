import { z } from "zod";
import { claimReceiptSchema, pendingPreparationSchema, previewSchema, type PrepareInput } from "./contract";
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export class PreparationFailure extends Error {
  constructor(message: string, public readonly definitive: boolean) { super(message); }
}
export function loadPending(value: string | null, incidentId: string) {
  if (value === null) return null;
  const parsed = pendingPreparationSchema.parse(JSON.parse(value));
  if (parsed.incidentId !== incidentId) throw new Error("Saved request belongs to another incident.");
  return parsed.input;
}
export function savePending(storage: Pick<Storage, "getItem" | "setItem">, key: string, incidentId: string, input: PrepareInput) {
  storage.setItem(key, JSON.stringify({ incidentId, input }));
  if (JSON.stringify(loadPending(storage.getItem(key), incidentId)) !== JSON.stringify(input)) throw new Error("The request could not be retained safely. No preparation was sent.");
}
const definitiveCodes: Record<string, number> = { INVALID_REQUEST: 400, NOT_ELIGIBLE: 409, PROTECTED: 409, SOURCES_CHANGED: 409, REQUEST_CONFLICT: 409, NOT_FOUND: 404, REVISION_NOT_FOUND: 404, ORIGIN_REJECTED: 403, CONTENT_TYPE: 415, BODY_TOO_LARGE: 413, PACKET_LIMIT: 409 };
export async function requestPreview(id: string, revision: string, signal: AbortSignal) {
  const response = await fetch(`/api/incidents/${encodeURIComponent(id)}/claim?revision=${encodeURIComponent(revision)}`, { cache: "no-store", signal });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(errorSchema.safeParse(value).data?.error.message ?? "Packet review is unavailable. Refresh evidence before reviewing again.");
  const preview = previewSchema.parse(value);
  if (preview.incidentId !== id || preview.analysisId !== revision) throw new Error("The review does not match the selected incident revision.");
  return preview;
}
export async function requestPreparation(id: string, input: PrepareInput) {
  let response: Response;
  try { response = await fetch(`/api/incidents/${encodeURIComponent(id)}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), cache: "no-store" }); }
  catch { throw new PreparationFailure("Preparation could not be confirmed. Retry this same saved request.", false); }
  let value: unknown;
  try { value = await response.json(); } catch { throw new PreparationFailure("The response could not be verified. Retry this same saved request.", false); }
  if (!response.ok) {
    const error = errorSchema.safeParse(value).data?.error;
    throw new PreparationFailure(error?.message ?? "Preparation could not be confirmed. Retry this same saved request.", !!error && definitiveCodes[error.code] === response.status);
  }
  const receipt = claimReceiptSchema.safeParse(value);
  if (!receipt.success || receipt.data.claimId !== `claim-${input.requestId}` || receipt.data.incidentId !== id || receipt.data.analysisId !== input.analysisId) throw new PreparationFailure("The response does not match this request. Retry this same saved request.", false);
  return receipt.data;
}
