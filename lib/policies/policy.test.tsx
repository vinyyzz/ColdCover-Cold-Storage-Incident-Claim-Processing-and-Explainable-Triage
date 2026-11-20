import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DatabaseConnection } from "../db/client";
import { initializeDatabase } from "../db/initialize";
import { policies } from "../db/schema";
import { demonstrationPolicy as authored } from "../demo/policy";
import { captureSnapshot } from "../reset/snapshot";
import { getCurrentPolicy } from "./service";
import PolicyDetails from "../../app/policy/details";
import PolicyError from "../../app/policy/error";
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
let dir: string, c: DatabaseConnection;
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "coldcover-policy-")); c = await initializeDatabase(pathToFileURL(join(dir, "qa.db")).href); });
afterEach(() => { c.close(); rmSync(dir, { recursive: true, force: true }); });
it("reads stored seeded fields and IST check time without changing any active row", async () => {
  const before = await captureSnapshot(c.db), view = await getCurrentPolicy(c.db);
  expect(view.status).toBe("available"); if (view.status !== "available") throw new Error();
  expect(view.policy.wording).toBe(authored.wording); expect(view.requiredRecords).toEqual(authored.requiredRecords); expect(view.policy.machineryBreakdownCoverRequired).toBe(true); expect(view.checkedAt).toMatch(/\+05:30$/); expect(await captureSnapshot(c.db)).toEqual(before);
});
it("reflects changed values, preserves exact stored text and separates CRLF/empty evidence lines", async () => {
  const wording = "  Fictional changed wording\nSecond line.  "; await c.db.update(policies).set({ name: "Changed stored name", wording, machineryBreakdownCoverRequired: false, recordsRequiredText: " First source\r\n\r\nSecond source\rThird source\n", notes: "Stored note only", demonstrationLabel: "Stored annotation" });
  const view = await getCurrentPolicy(c.db); expect(view.status).toBe("available"); if (view.status !== "available") throw new Error(); expect(view.policy.wording).toBe(wording); expect(view.requiredRecords).toEqual([" First source", "Second source", "Third source"]);
  const html = renderToStaticMarkup(createElement(PolicyDetails, { view })); for (const text of ["Changed stored name", wording, "Stored note only", "Stored annotation", "No — not recorded as a requirement.", authored.label.replaceAll("'", "&#x27;"), "Prepared claim packets retain"]) expect(html).toContain(text); expect(html).not.toContain(authored.wording);
});
it("does not select an unrelated policy or recreate a missing record", async () => {
  await c.db.delete(policies); await c.db.insert(policies).values({ id: "unrelated", name: "Wrong policy", machineryBreakdownCoverRequired: true, recordsRequiredText: "Wrong record", notes: "Wrong notes", wording: "Wrong wording", demonstrationLabel: "Wrong label" });
  const before = await captureSnapshot(c.db), view = await getCurrentPolicy(c.db); expect(view).toMatchObject({ status: "unavailable", reason: "missing" }); expect(await captureSnapshot(c.db)).toEqual(before); expect(renderToStaticMarkup(createElement(PolicyDetails, { view }))).not.toContain("Wrong wording");
});
it.each(["name", "recordsRequiredText", "notes", "wording", "demonstrationLabel"] as const)("withholds blank %s without substituting authored wording", async (field) => {
  await c.db.update(policies).set({ [field]: " \n " }); const view = await getCurrentPolicy(c.db); expect(view).toMatchObject({ status: "unavailable", reason: "invalid" }); const html = renderToStaticMarkup(createElement(PolicyDetails, { view })); expect(html).toContain("could not be verified"); expect(html).not.toContain(authored.wording);
});
it("withholds unreadable control characters", async () => { await c.db.update(policies).set({ notes: "Invalid\u0001note" }); expect(await getCurrentPolicy(c.db)).toMatchObject({ status: "unavailable", reason: "invalid" }); });
it("escapes stored strings and renders evidence lines as text, never active source markup", async () => {
  await c.db.update(policies).set({ name: "<script>unsafe</script>", wording: "<img src=x onerror=unsafe>", recordsRequiredText: "<svg onload=unsafe>\nhttps://example.invalid", notes: "<a href=javascript:unsafe>note</a>" }); const view = await getCurrentPolicy(c.db); const html = renderToStaticMarkup(createElement(PolicyDetails, { view })); expect(html).toContain("&lt;script&gt;"); expect(html).toContain("&lt;img"); expect(html).not.toContain("<script"); expect(html).not.toContain("<img"); expect(html).not.toContain("href=\"https://example.invalid");
});
it("refreshes after changed and repaired stored records without caching stale results", async () => {
  const first = await getCurrentPolicy(c.db); await c.db.update(policies).set({ notes: "" }).where(eq(policies.id, authored.id)); expect((await getCurrentPolicy(c.db)).status).toBe("unavailable"); await c.db.update(policies).set({ notes: "Repaired stored note" }); const next = await getCurrentPolicy(c.db); expect(first.status).toBe("available"); expect(next).toMatchObject({ status: "available", policy: { notes: "Repaired stored note" } });
});
it("renders generic recoverable database error wording without policy content", () => { const html = renderToStaticMarkup(createElement(PolicyError, { retry: vi.fn() })); expect(html).toContain('role="alert"'); expect(html).toContain("Try again"); expect(html).not.toContain(authored.wording); });
