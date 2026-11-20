import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import DemoReset, { RecordCounts, SavedReceipt } from "../../app/admin/reset";
import { clearPendingOperation, OperationFailure, PENDING_OPERATION_KEY, readPendingOperation, requestDemoOperation, requestResetStatus, savePendingOperation } from "./client";
import { countsSchema, operationInputSchema, receiptSchema, type OperationInput } from "./contract";

const request = operationInputSchema.parse({ requestId: "8d995a91-6448-487c-b083-45a0b5bfd011", expectedState: "0".repeat(64), action: "reset", confirmation: "RESET DEMO" });
const counts = countsSchema.parse({ chambers: 1, equipment: 1, thresholds: 1, policies: 1, scenarios: 30, batches: 3, temperature_readings: 144, incidents: 1, analysis_runs: 0, analysis_incident_links: 0, documents: 1, incident_events: 1, claims: 0, review_decisions: 0, audit_log: 1, document_corrections: 0, document_copies: 0, ai_result_cache: 0 });
const receipt = receiptSchema.parse({ version: "demo-reset-v1", requestId: request.requestId, action: "reset", backupId: "ba7fc58e-8295-41f3-b865-408fa6e4d423", restoredFrom: null, createdAt: "2026-11-01T09:00:00+05:30", beforeCounts: counts, afterCounts: { ...counts, audit_log: 2 }, reused: false });
const status = { version: "demo-reset-v1", checkedAt: receipt.createdAt, state: "1".repeat(64), counts, backups: [], nextCursor: null };
function storage() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; }

describe("Pending reset intent and browser response contract", () => {
  it("persists only exact request intent and recovers it across page instances without sending", () => {
    const store = storage(); expect(readPendingOperation(store)).toBeNull(); savePendingOperation(store, request);
    expect(readPendingOperation(store)).toEqual(request); expect(JSON.parse(store.values.get(PENDING_OPERATION_KEY)!)).toEqual(request);
    expect(store.values.size).toBe(1); clearPendingOperation(store); expect(readPendingOperation(store)).toBeNull();
  });
  it("retains the same restore ID/source/state/confirmation across retry", () => {
    const store = storage(), input: OperationInput = { requestId: request.requestId, expectedState: request.expectedState, action: "restore", backupId: receipt.backupId, confirmation: "RESTORE BACKUP" };
    savePendingOperation(store, input); expect(readPendingOperation(store)).toEqual(input);
    expect(() => savePendingOperation(store, { ...input, confirmation: "RESET DEMO" } as unknown as OperationInput)).toThrow(); expect(readPendingOperation(store)).toEqual(input);
  });
  it("rejects unreadable storage or failed persistence before a request can be prepared", () => {
    const store = storage(); store.values.set(PENDING_OPERATION_KEY, "{"); expect(() => readPendingOperation(store)).toThrow();
    expect(() => savePendingOperation({ ...store, setItem() { throw new Error("storage unavailable"); } }, request)).toThrow();
    expect(() => savePendingOperation({ getItem: () => null, setItem() {}, removeItem() {} }, request)).toThrow("retained safely");
  });
  it("sends only the saved operation and validates matching receipt", async () => {
    const signal = new AbortController().signal, fetcher = vi.fn<typeof fetch>(async () => Response.json(receipt));
    expect(await requestDemoOperation(request, signal, fetcher)).toEqual(receipt);
    expect(fetcher).toHaveBeenCalledWith("/api/admin/reset", expect.objectContaining({ method: "POST", cache: "no-store", body: JSON.stringify(request), signal }));
  });
  it.each(["wrong request", "wrong action", "wrong backup source", "missing counts", "malformed JSON"])("keeps %s receipt failures unconfirmed", async (kind) => {
    const value = structuredClone(receipt);
    if (kind === "wrong request") value.requestId = value.backupId;
    if (kind === "wrong action") Object.assign(value, { action: "restore", restoredFrom: value.backupId });
    if (kind === "wrong backup source") value.restoredFrom = value.backupId;
    if (kind === "missing counts") delete (value.beforeCounts as Partial<typeof counts>).claims;
    const fetcher = vi.fn<typeof fetch>(async () => kind === "malformed JSON" ? new Response("not JSON") : Response.json(value));
    await expect(requestDemoOperation(request, new AbortController().signal, fetcher)).rejects.toMatchObject({ definitive: false });
  });
  it.each([[400, "INVALID_REQUEST", true], [409, "STALE_STATE", true], [409, "INVALID_BACKUP", true], [500, "RESET_UNCONFIRMED", false], [409, "INVALID_RECEIPT", false], [500, "STALE_STATE", false], [400, "unrecognised", false]])("handles a structured HTTP rejection without creating another UUID", async (status, code, definitive) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: { code, message: "Review again" } }, { status }));
    await expect(requestDemoOperation(request, new AbortController().signal, fetcher)).rejects.toMatchObject({ definitive }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("network and proxy/abort failures remain unconfirmed with no raw diagnostics", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error("private transport path"); });
    try { await requestDemoOperation(request, new AbortController().signal, fetcher); throw new Error("Should reject"); }
    catch (error) { expect(error).toBeInstanceOf(OperationFailure); expect(error).toMatchObject({ definitive: false }); expect(String(error)).not.toContain("private transport path"); }
    await expect(requestDemoOperation(request, new AbortController().signal, vi.fn(async () => new Response("proxy failed", { status: 502 })))).rejects.toMatchObject({ definitive: false });
  });
  it("reads review pages with no-store and rejects missing counts or transport failure", async () => {
    const signal = new AbortController().signal, fetcher = vi.fn<typeof fetch>(async () => Response.json(status));
    expect((await requestResetStatus(signal, 20, fetcher)).counts).toEqual(counts);
    expect(fetcher).toHaveBeenCalledWith("/api/admin/reset?before=20", { cache: "no-store", signal });
    await expect(requestResetStatus(signal, undefined, vi.fn(async () => Response.json({ ...status, counts: {} })))).rejects.toThrow("could not be verified");
    await expect(requestResetStatus(signal, undefined, vi.fn(async () => { throw new Error("private"); }))).rejects.toThrow("No replacement was requested");
  });
  it("SSR has no prepared operation or automatic replacement and labels historical receipts", () => {
    const html = renderToStaticMarkup(createElement(DemoReset)); expect(html).toContain("Review current workspace and backups"); expect(html).toContain("disabled"); expect(html).not.toContain("Back up and reset demo"); expect(html).not.toContain("Reset receipt confirmed");
    const details = renderToStaticMarkup(createElement(RecordCounts, { counts })); expect(details).toContain("Claim packets"); expect(details).toContain("144");
    const saved = renderToStaticMarkup(createElement(SavedReceipt, { receipt: { ...receipt, reused: true } })); expect(saved).toContain("saved result replayed"); expect(saved).toContain("current counts are checked separately"); expect(saved).toContain(`/api/admin/backups/${receipt.backupId}`);
  });
});
