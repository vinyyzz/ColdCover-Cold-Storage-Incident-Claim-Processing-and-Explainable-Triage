import { z } from "zod";
import { MAX_REPORT_BYTES, reportFilename, reportUrl } from "./contract";
const failureSchema = z.object({ error: z.object({ code: z.string(), message: z.string().min(1) }) });
export class ReportDownloadError extends Error {}
export async function readReportBody(response: Response, maxBytes = MAX_REPORT_BYTES) {
  const reader = response.body?.getReader(); if (!reader) throw new ReportDownloadError("The report download was empty. Refresh and try again.");
  let text = "", bytes = 0; const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > maxBytes) { await reader.cancel(); throw new ReportDownloadError("The report exceeds the supported download size. No file was created."); } text += decoder.decode(part.value, { stream: true }); }
    text += decoder.decode(); return text;
  } catch (error) { if (error instanceof ReportDownloadError) throw error; throw new ReportDownloadError("The report response could not be read. No file was created."); }
  finally { reader.releaseLock(); }
}
export async function requestReportDownload(claimId: string, state: string, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  let response: Response;
  try { response = await fetcher(reportUrl(claimId, state, true), { cache: "no-store", signal }); }
  catch { throw new ReportDownloadError("The report could not be downloaded. Refresh the report and try again."); }
  if (!response.ok) {
    let message = "The report could not be verified. Refresh it before downloading again.";
    try { const error = failureSchema.safeParse(await response.json()); if (error.success && error.data.error.code === "REPORT_CHANGED" && response.status === 409) message = error.data.error.message; } catch { /* Withhold unexpected proxy responses. */ }
    throw new ReportDownloadError(message);
  }
  if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "text/html" || response.headers.get("x-coldcover-report-state") !== state || response.headers.get("content-disposition") !== `attachment; filename="${reportFilename(claimId)}"`) throw new ReportDownloadError("The report download did not match this preview. Refresh before trying again.");
  const html = await readReportBody(response);
  if (!html.startsWith(`<!doctype html><html lang="en" data-report-state="${state}">`) || !html.endsWith("</html>")) throw new ReportDownloadError("The report contents could not be verified. No file was created.");
  return new Blob([html], { type: "text/html;charset=utf-8" });
}

/** Generated fragment attributes only; escaped source wording is untouched. */
export function previewReportHtml(html: string, claimId: string, state: string) {
  return html.replaceAll('href="#', `href="${reportUrl(claimId, state)}#`).replaceAll('fill="url(#', 'fill="url(about:srcdoc#');
}
