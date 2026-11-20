"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { documentInputSchema, receiptSchema, type DocumentInput } from "../../../lib/documents/contract";

export default function DocumentTextInput({ incidentId, analysisId, allowed, reason }: { incidentId: string; analysisId: string | null; allowed: boolean; reason: string | null }) {
  const router = useRouter();
  const [docType, setDocType] = useState<DocumentInput["docType"]>("maintenance_report");
  const [filename, setFilename] = useState(""), [rawText, setRawText] = useState("");
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState(""), [error, setError] = useState("");
  const pending = useRef<DocumentInput | null>(null), inFlight = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!allowed || !analysisId || inFlight.current) return;
    const parsed = documentInputSchema.safeParse(pending.current ?? { requestId: crypto.randomUUID(), analysisId, docType, filename, rawText });
    if (!parsed.success) { setError("Enter a display filename without paths and nonblank report text, up to 50,000 characters. Control characters are unsupported."); return; }
    pending.current = parsed.data;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/documents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed.data), cache: "no-store" });
      const body: unknown = await response.json();
      if (!mounted.current) return;
      if (!response.ok) {
        const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null && "message" in body.error && typeof body.error.message === "string" ? body.error.message : "Report save could not be confirmed. Refresh evidence before continuing.";
        if (response.status >= 400 && response.status < 500) { pending.current = null; setUncertain(false); }
        else setUncertain(true);
        setError(message); router.refresh(); return;
      }
      const receipt = receiptSchema.parse(body);
      if (receipt.incidentId !== incidentId || receipt.analysisId !== parsed.data.analysisId || receipt.documentId !== `document-${parsed.data.requestId.toLowerCase()}`) throw new Error("Unverified receipt");
      pending.current = null; setUncertain(false); setFilename(""); setRawText("");
      setNotice(`${receipt.reused ? "Previously saved report confirmed" : "Report saved"} with fallback extraction. Open its document below to inspect facts and exact passages.`);
      router.refresh();
    } catch {
      if (mounted.current) { setUncertain(true); setError("The save could not be confirmed. Refresh evidence to inspect saved reports, or retry the same submission safely. Text is held until its result is confirmed."); }
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  return <section aria-labelledby="document-input-heading" className="rounded-2xl border border-line bg-white p-5 sm:p-6">
    <h2 id="document-input-heading" className="text-xl font-semibold">Add report text</h2>
    <p className="mt-3 text-sm leading-7 text-muted">Attach a maintenance or stock inspection report to this selected incident. Deterministic fallback extracts only supported wording; it does not verify the report or determine stock condition. Existing documents stay on their original records.</p>
    {!allowed ? <p className="mt-4 rounded-xl bg-surface p-4 text-sm leading-7">{reason}</p> : <form onSubmit={submit} className="mt-4 space-y-4">
      <fieldset disabled={busy || uncertain} className="min-w-0 space-y-4">
        <div><label htmlFor="document-type" className="block text-sm font-medium">Report type</label><select id="document-type" value={docType} onChange={(event) => setDocType(event.target.value as DocumentInput["docType"])} className="mt-2 w-full rounded-lg border border-line bg-white p-3 text-sm"><option value="maintenance_report">Maintenance report</option><option value="stock_inspection_report">Stock inspection report</option></select></div>
        <div><label htmlFor="document-filename" className="block text-sm font-medium">Display filename</label><input id="document-filename" value={filename} onChange={(event) => setFilename(event.target.value)} required maxLength={160} placeholder="maintenance-report.txt" className="mt-2 w-full rounded-lg border border-line p-3 text-sm" /></div>
        <div><label htmlFor="document-text" className="block text-sm font-medium">Original report text</label><textarea id="document-text" value={rawText} onChange={(event) => setRawText(event.target.value)} required maxLength={50_000} rows={9} aria-describedby="document-text-help" className="mt-2 w-full rounded-lg border border-line p-3 font-mono text-sm" /><p id="document-text-help" className="mt-2 text-xs leading-6 text-muted">Up to 50,000 characters. Preserve original wording. Full dates and an explicit timezone are needed for times; missing facts remain unrecorded. No file upload or automatic incident selection.</p></div>
      </fieldset>
      <div className="flex flex-wrap gap-3"><button type="submit" disabled={busy} className="button-primary">{busy ? "Saving report…" : uncertain ? "Retry same submission" : "Save report and extract"}</button><button type="button" disabled={busy} className="button-secondary" onClick={() => router.refresh()}>Refresh evidence</button></div>
    </form>}
    {notice && <p role="status" className="mt-4 rounded-xl bg-surface p-4 text-sm leading-7">{notice}</p>}
    {error && <p role="alert" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-7">{error}</p>}
  </section>;
}
