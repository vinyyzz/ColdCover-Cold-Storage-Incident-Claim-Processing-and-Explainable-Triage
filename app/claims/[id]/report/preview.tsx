"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reportFilename, reportUrl } from "@/lib/reports/contract";
import { previewReportHtml, requestReportDownload } from "@/lib/reports/client";
export default function ReportPreview({ claimId, state }: { claimId: string; state: string }) {
  const router = useRouter(), frame = useRef<HTMLIFrameElement>(null), active = useRef<AbortController | null>(null), ticket = useRef(0);
  const [documentHtml, setDocumentHtml] = useState<string | null>(null), [ready, setReady] = useState(false), [failed, setFailed] = useState(false), [working, setWorking] = useState(false), [message, setMessage] = useState(""), [refreshing, transition] = useTransition();
  useEffect(() => {
    let live = true; const requests = ticket, controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    void requestReportDownload(claimId, state, controller.signal).then((blob) => blob.text()).then((html) => { if (live) setDocumentHtml(previewReportHtml(html, claimId, state)); }).catch((error: unknown) => { if (live) { setFailed(true); setMessage(error instanceof Error ? error.message : "The report preview could not be verified. Refresh and try again."); } }).finally(() => clearTimeout(timer));
    return () => { live = false; requests.current++; controller.abort(); active.current?.abort(); clearTimeout(timer); };
  }, [claimId, state]);
  const src = reportUrl(claimId, state);
  function loaded() {
    try { if (frame.current?.contentDocument?.documentElement.dataset.reportState !== state) throw new Error("Unmatched report"); setReady(true); setFailed(false); setMessage(""); }
    catch { setReady(false); setFailed(true); setMessage("The report preview could not be verified. Refresh it before printing or downloading."); }
  }
  function print() {
    if (!ready) return;
    try { frame.current?.contentWindow?.focus(); frame.current?.contentWindow?.print(); }
    catch { setMessage("Print preview is unavailable here. Open the full report and use your browser's Print command."); }
  }
  async function download() {
    if (!ready || active.current) return;
    const controller = new AbortController(), current = ++ticket.current; active.current = controller; setWorking(true); setMessage("");
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const blob = await requestReportDownload(claimId, state, controller.signal);
      if (ticket.current !== current || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = reportFilename(claimId); link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000); setMessage("HTML download requested. The saved file includes its sources and print layout.");
    } catch (error) { if (ticket.current === current) { setReady(false); setMessage(error instanceof Error ? error.message : "The report could not be downloaded. Refresh and try again."); } }
    finally { clearTimeout(timer); if (ticket.current === current) { active.current = null; setWorking(false); } }
  }
  return <section aria-label="Claim report preview" className="min-w-0 space-y-4">
    <div className="flex flex-wrap gap-3"><button type="button" className="button-primary" disabled={!ready || refreshing} onClick={print}>Print / Save as PDF</button><button type="button" className="button-secondary" disabled={!ready || working || refreshing} onClick={download}>{working ? "Checking download…" : "Download HTML"}</button><button type="button" className="button-secondary" disabled={refreshing || working} onClick={() => transition(() => router.refresh())}>{refreshing ? "Refreshing report…" : "Refresh report"}</button><a className="button-secondary" href={src} target="_blank" rel="noopener noreferrer">Open full report</a></div>
    <p className="text-xs leading-6 text-muted">The preview is a checked snapshot of frozen evidence and recorded review history. Refresh to include later decisions. HTML downloads contain the same reviewed state and can be opened and printed offline. PDF saving uses the browser print dialog.</p>
    <p role="status" className="min-h-6 break-words text-sm">{message || (!ready ? "Loading and verifying the printable report…" : "Report verified and ready to print.")}</p>
    {documentHtml !== null && <iframe ref={frame} title="Printable claim report" srcDoc={documentHtml} sandbox="allow-same-origin allow-modals" onLoad={loaded} className={failed ? "hidden" : "block h-[75vh] min-h-[600px] w-full rounded-xl border border-line bg-white"} />}
  </section>;
}
