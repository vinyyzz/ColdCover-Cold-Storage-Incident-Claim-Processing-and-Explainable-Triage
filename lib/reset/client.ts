import { operationErrorSchema, operationInputSchema, receiptSchema, resetStatusSchema, type OperationInput, type OperationReceipt, type ResetStatus } from "./contract";

export const PENDING_OPERATION_KEY = "coldcover-demo-operation-v1";
type IntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function readPendingOperation(storage: IntentStorage): OperationInput | null {
  const text = storage.getItem(PENDING_OPERATION_KEY);
  return text === null ? null : operationInputSchema.parse(JSON.parse(text));
}
export function savePendingOperation(storage: IntentStorage, input: OperationInput) {
  const parsed = operationInputSchema.parse(input);
  storage.setItem(PENDING_OPERATION_KEY, JSON.stringify(parsed));
  // Verify persistence before sending any mutation.
  if (JSON.stringify(readPendingOperation(storage)) !== JSON.stringify(parsed)) throw new Error("The request could not be retained safely. No operation was sent.");
}
export function clearPendingOperation(storage: IntentStorage) { storage.removeItem(PENDING_OPERATION_KEY); }
export class OperationFailure extends Error {
  constructor(message: string, readonly definitive: boolean) { super(message); }
}
const definitiveCodes: Record<string, number> = { INVALID_REQUEST: 400, ORIGIN_REJECTED: 403, CONTENT_TYPE: 415, BODY_TOO_LARGE: 413, STALE_STATE: 409, REQUEST_CONFLICT: 409, BACKUP_NOT_FOUND: 404, INCOMPATIBLE_BACKUP: 409, INVALID_BACKUP: 409, UNSUPPORTED_SCHEMA: 409, INVALID_DATABASE: 409, BACKUP_LIMIT: 409 };
export async function requestResetStatus(signal: AbortSignal, before?: number, fetcher: typeof fetch = fetch): Promise<ResetStatus> {
  try {
    const response = await fetcher(`/api/admin/reset${before === undefined ? "" : `?before=${before}`}`, { cache: "no-store", signal });
    if (!response.ok) throw new Error("No review available");
    return resetStatusSchema.parse(await response.json());
  } catch { throw new Error("Current counts and backups could not be verified. No replacement was requested. Review again."); }
}
export async function requestDemoOperation(value: OperationInput, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<OperationReceipt> {
  const input = operationInputSchema.parse(value);
  let response: Response;
  try { response = await fetcher("/api/admin/reset", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal }); }
  catch { throw new OperationFailure("The result is not confirmed. Keep this saved request and retry it; a new operation has not been prepared.", false); }
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new OperationFailure("The result could not be verified. Retry the same saved request.", false); }
  if (!response.ok) {
    const error = operationErrorSchema.safeParse(data);
    if (error.success && definitiveCodes[error.data.error.code] === response.status) throw new OperationFailure(error.data.error.message, true);
    throw new OperationFailure("The result is not confirmed. Retry the same saved request to check its outcome.", false);
  }
  const receipt = receiptSchema.safeParse(data);
  if (!receipt.success || receipt.data.requestId !== input.requestId || receipt.data.action !== input.action || receipt.data.restoredFrom !== (input.action === "restore" ? input.backupId : null)) throw new OperationFailure("The returned receipt does not match the saved request. Retry the same request to confirm its outcome.", false);
  return receipt.data;
}
