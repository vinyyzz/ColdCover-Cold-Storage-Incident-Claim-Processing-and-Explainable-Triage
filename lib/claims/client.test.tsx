import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import ClaimPreparation from "../../app/incidents/[id]/claim-preparation";
import { CLAIM_VERSION, type PrepareInput } from "./contract";
import { loadPending, requestPreparation, requestPreview, savePending } from "./client";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => vi.unstubAllGlobals());
const input: PrepareInput = { requestId: "c8f3f779-5d9a-4331-8d34-99ad7fdc272f", analysisId: "analysis", policyId: "policy", expectedSourceToken: "a".repeat(64), evidenceReviewed: true };
const receipt = { version: CLAIM_VERSION, claimId: `claim-${input.requestId}`, incidentId: "incident", analysisId: input.analysisId, preparedAt: "2026-11-01T12:00:00+05:30", reused: false };
it("retains exactly a pending intent and verifies persistence before sending", () => {
  let text: string | null = null; const storage = { getItem: () => text, setItem: (_key: string, value: string) => { text = value; } };
  expect(loadPending(null, "incident")).toBeNull(); savePending(storage, "key", "incident", input); expect(loadPending(text, "incident")).toEqual(input);
  expect(text).not.toContain("rawText"); expect(() => loadPending(text, "different")).toThrow(); expect(() => loadPending("{", "incident")).toThrow();
  expect(() => savePending({ getItem: () => null, setItem: () => {} }, "key", "incident", input)).toThrow("No preparation was sent");
});
it("validates matching success receipts and no-store request details", async () => {
  const fetcher = vi.fn(async () => Response.json(receipt)); vi.stubGlobal("fetch", fetcher);
  expect(await requestPreparation("incident", input)).toEqual(receipt);
  expect(fetcher.mock.calls[0]).toEqual(["/api/incidents/incident/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), cache: "no-store" }]);
});
it.each(["network", "html", "wrong_claim", "wrong_incident", "wrong_revision", "unknown_error", "mismatched_error"])("keeps %s outcomes pending", async (kind) => {
  vi.stubGlobal("fetch", async () => {
    if (kind === "network") throw new Error("Disconnected"); if (kind === "html") return new Response("html");
    if (kind === "unknown_error") return Response.json({ error: { code: "UNKNOWN", message: "Unknown" } }, { status: 409 });
    if (kind === "mismatched_error") return Response.json({ error: { code: "SOURCES_CHANGED", message: "Unknown" } }, { status: 500 });
    return Response.json({ ...receipt, ...(kind === "wrong_claim" ? { claimId: "other" } : kind === "wrong_incident" ? { incidentId: "other" } : { analysisId: "other" }) });
  });
  await expect(requestPreparation("incident", input)).rejects.toMatchObject({ definitive: false });
});
it("allows a definitive changed-source rejection to clear the pending intent", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ error: { code: "SOURCES_CHANGED", message: "Review again" } }, { status: 409 }));
  await expect(requestPreparation("incident", input)).rejects.toMatchObject({ definitive: true, message: "Review again" });
});
it("review rejects invalid or mismatched responses", async () => {
  vi.stubGlobal("fetch", async () => Response.json({})); await expect(requestPreview("incident", "analysis", new AbortController().signal)).rejects.toThrow();
});
it("SSR does not auto-review or prepare and exposes protected packet links", () => {
  const html = renderToStaticMarkup(createElement(ClaimPreparation, { incidentId: "incident", analysisId: "analysis", allowed: true, saved: [] }));
  expect(html).toContain("Review packet"); expect(html).not.toContain("Prepare immutable packet"); expect(html).toContain("disabled");
  const saved = renderToStaticMarkup(createElement(ClaimPreparation, { incidentId: "incident", analysisId: "analysis", allowed: false, saved: [{ id: "claim", createdAt: receipt.preparedAt }] }));
  expect(saved).toContain('/claims/claim'); expect(saved).toContain("Open prepared packet");
});
