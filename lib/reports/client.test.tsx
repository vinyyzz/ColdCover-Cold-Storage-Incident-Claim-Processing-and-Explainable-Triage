import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ReportPreview from "../../app/claims/[id]/report/preview";
import { previewReportHtml, readReportBody, requestReportDownload } from "./client";
import { reportFilename, reportUrl } from "./contract";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const id = "claim-example", state = "a".repeat(64), html = `<!doctype html><html lang="en" data-report-state="${state}"><head><title>Verified report</title></head><body>Fictional evidence</body></html>`;
const response = (body = html) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "x-coldcover-report-state": state, "content-disposition": `attachment; filename="${reportFilename(id)}"` } });
describe("Verified report download", () => {
  it("uses exact preview state/no-store and returns an offline HTML Blob", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response()), signal = new AbortController().signal, blob = await requestReportDownload(id, state, signal, fetcher);
    expect(await blob.text()).toBe(html); expect(blob.type).toContain("text/html"); expect(fetcher).toHaveBeenCalledWith(reportUrl(id, state, true), { cache: "no-store", signal });
  });
  it.each(["network", "proxy", "type", "state", "filename", "contents", "truncated"])("withholds %s downloads", async (kind) => {
    const fetcher: typeof fetch = async () => { if (kind === "network") throw new Error("Disconnected"); if (kind === "proxy") return new Response("proxy error", { status: 502 }); const r = response(kind === "contents" ? "{}" : kind === "truncated" ? html.slice(0, -7) : html); if (kind === "type") r.headers.set("content-type", "application/json"); if (kind === "state") r.headers.set("x-coldcover-report-state", "b".repeat(64)); if (kind === "filename") r.headers.set("content-disposition", 'attachment; filename="different.html"'); return r; };
    await expect(requestReportDownload(id, state, new AbortController().signal, fetcher)).rejects.toThrow();
  });
  it("retains the exact stale-state explanation without creating a file", async () => { await expect(requestReportDownload(id, state, new AbortController().signal, async () => Response.json({ error: { code: "REPORT_CHANGED", message: "Refresh the report before downloading" } }, { status: 409 }))).rejects.toThrow("Refresh the report"); });
  it("bounds streamed bytes and rejects invalid UTF-8", async () => {
    await expect(readReportBody(new Response("123456789"), 8)).rejects.toThrow("exceeds"); await expect(readReportBody(new Response(new Uint8Array([255])))).rejects.toThrow("could not be read");
  });
  it("SSR keeps print/download disabled until the frame state is verified", () => {
    const markup = renderToStaticMarkup(createElement(ReportPreview, { claimId: id, state })); expect(markup).toContain("Print / Save as PDF"); expect(markup).toContain("Download HTML"); expect(markup).toContain("disabled"); expect(markup).not.toContain("<iframe"); expect(markup).toContain("Open full report"); expect(markup).not.toContain("allow-scripts"); expect(markup).toContain("Loading and verifying");
  });
  it("routes preview citations to the checked report without changing escaped original wording", () => {
    const original = '<a href="#reading-1">R1</a><rect fill="url(#gap)"></rect><p>href=&quot;#quoted&quot; url(#original)</p>';
    expect(previewReportHtml(original, id, state)).toBe(`<a href="${reportUrl(id, state)}#reading-1">R1</a><rect fill="url(about:srcdoc#gap)"></rect><p>href=&quot;#quoted&quot; url(#original)</p>`);
  });
  it("rejects unsafe filenames and malformed expected state", () => { expect(() => reportFilename("../../secret")).toThrow(); expect(() => reportUrl(id, "bad")).toThrow(); });
});
