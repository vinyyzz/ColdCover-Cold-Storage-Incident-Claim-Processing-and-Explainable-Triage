"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { copyInputSchema, copyReceiptSchema, reportSourceHref, sourceListSchema, sourcePreviewSchema, type CopyInput, type SourceList, type SourcePreview } from "../../../lib/documents/copy-contract";
import { incidentDate } from "../../../lib/incidents/presentation";

function errorMessage(body: unknown, fallback: string) {
  return typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null && "message" in body.error && typeof body.error.message === "string" ? body.error.message : fallback;
}
export default function ExistingReportCopy({ targetId, targetTitle, analysisId, allowed, reason }: { targetId: string; targetTitle: string; analysisId: string | null; allowed: boolean; reason: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [pages, setPages] = useState<Array<string | null>>([null]);
  const [catalog, setCatalog] = useState<SourceList | null>(null), [listState, setListState] = useState("idle"), [listError, setListError] = useState(""), [listReload, setListReload] = useState(0);
  const [sourceId, setSourceId] = useState(""), [preview, setPreview] = useState<SourcePreview | null>(null), [previewState, setPreviewState] = useState("idle"), [previewError, setPreviewError] = useState(""), [previewReload, setPreviewReload] = useState(0);
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [mustReload, setMustReload] = useState(false);
  const [notice, setNotice] = useState(""), [error, setError] = useState("");
  const pending = useRef<CopyInput | null>(null), inFlight = useRef(false), mounted = useRef(true);
  const cursor = pages.at(-1) ?? null;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!open || !allowed) return;
    const controller = new AbortController(); let active = true;
    void (async () => {
      setListState("loading"); setListError("");
      try {
        const response = await fetch(`/api/incidents/${encodeURIComponent(targetId)}/document-sources${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`, { cache: "no-store", signal: controller.signal });
        const body: unknown = await response.json();
        if (!response.ok) throw new Error(errorMessage(body, "Source reports could not be loaded."));
        const data = sourceListSchema.parse(body); if (data.targetIncidentId !== targetId) throw new Error("Source list did not match this target.");
        if (active) { setCatalog(data); setListState("ready"); }
      } catch (error) { if (active) { setListState("error"); setListError(error instanceof Error ? error.message : "Source reports could not be loaded."); } }
    })();
    return () => { active = false; controller.abort(); };
  }, [open, allowed, targetId, cursor, listReload]);
  useEffect(() => {
    if (!sourceId || !open || !allowed) return;
    const controller = new AbortController(); let active = true;
    void (async () => {
      setPreviewState("loading"); setPreviewError("");
      try {
        const response = await fetch(`/api/incidents/${encodeURIComponent(targetId)}/document-sources/${encodeURIComponent(sourceId)}`, { cache: "no-store", signal: controller.signal });
        const body: unknown = await response.json();
        if (!response.ok) throw new Error(errorMessage(body, "Source report could not be verified."));
        const data = sourcePreviewSchema.parse(body); if (data.targetIncidentId !== targetId || data.source.id !== sourceId) throw new Error("Source preview did not match the selected report.");
        if (active) { setPreview(data); setPreviewState("ready"); setMustReload(false); }
      } catch (error) { if (active) { setPreviewState("error"); setPreviewError(error instanceof Error ? error.message : "Source report could not be verified."); } }
    })();
    return () => { active = false; controller.abort(); };
  }, [open, allowed, targetId, sourceId, previewReload]);
  function choose(id: string) { setSourceId(id); setPreview(null); setPreviewState("idle"); setConfirmed(false); setError(""); setNotice(""); setMustReload(false); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (inFlight.current || !allowed || !analysisId) return;
    const selected = preview?.source.id === sourceId ? preview : null;
    const parsed = copyInputSchema.safeParse(pending.current ?? (selected && { requestId: crypto.randomUUID(), analysisId, sourceDocumentId: selected.source.id, expectedSourceFingerprint: selected.fingerprint, expectedSourceCorrectionId: selected.latestCorrectionId, associationConfirmed: confirmed }));
    if (!parsed.success || (!pending.current && (previewState !== "ready" || mustReload))) { setError("Load a source report and explicitly confirm its association with this target before copying."); return; }
    pending.current = parsed.data; inFlight.current = true; setBusy(true); setNotice(""); setError("");
    try {
      const response = await fetch(`/api/incidents/${encodeURIComponent(targetId)}/document-copies`, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed.data) });
      const body: unknown = await response.json(); if (!mounted.current) return;
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) { pending.current = null; setUncertain(false); setMustReload(true); setConfirmed(false); router.refresh(); }
        else setUncertain(true);
        setError(errorMessage(body, "The copy could not be confirmed. Inspect attached reports or retry the same submission.")); return;
      }
      const receipt = copyReceiptSchema.parse(body);
      if (receipt.incidentId !== targetId || receipt.analysisId !== parsed.data.analysisId || receipt.documentId !== `document-${parsed.data.requestId}` || receipt.sourceDocumentId !== parsed.data.sourceDocumentId || (selected && receipt.sourceIncidentId !== selected.source.incidentId)) throw new Error("Unverified copy receipt");
      pending.current = null; setUncertain(false); choose(""); setNotice(`${receipt.reused ? "Previously saved copy confirmed" : "Report copied"} with independent fallback extraction. The source report and its corrections are unchanged. Open the copied document below to inspect its origin.`); router.refresh();
    } catch { if (mounted.current) { setUncertain(true); setError("The copy could not be confirmed. This source and target are retained; inspect attached reports or retry the same submission safely."); } }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  const selected = preview?.source.id === sourceId ? preview : null;
  return <section aria-labelledby="report-reuse-heading" className="min-w-0 rounded-2xl border border-line bg-white p-5 sm:p-6">
    <h2 id="report-reuse-heading" className="text-xl font-semibold">Reuse an existing report</h2>
    <p className="mt-3 text-sm leading-7 text-muted">Choose a source report and review its original text before associating a new copy with this incident. The source remains unchanged. Fresh fallback extraction is run on the copy; source operator corrections are not copied.</p>
    {!allowed ? <p className="mt-4 rounded-xl bg-surface p-4 text-sm leading-7">{reason}</p> : !open ? <button type="button" className="button-secondary mt-4" onClick={() => setOpen(true)}>Browse existing reports</button> : <form aria-label="Copy an existing report" onSubmit={submit} className="mt-4 space-y-4">
      <p className="break-words rounded-lg bg-surface p-4 text-sm leading-7"><strong>Selected target:</strong> {targetTitle}<br /><span className="break-all font-mono text-xs">{targetId}</span></p>
      {listState === "loading" && <p role="status" className="text-sm">Loading source reports…</p>}
      {listError && <p role="alert" className="text-sm">{listError}</p>}
      <fieldset disabled={busy || uncertain || listState !== "ready"} className="min-w-0 space-y-4">
        {catalog && <><div><label htmlFor="copy-source" className="block text-sm font-medium">Source report</label><select id="copy-source" value={sourceId} onChange={(event) => choose(event.target.value)} className="mt-2 w-full min-w-0 truncate rounded-lg border border-line bg-white p-3 text-sm"><option value="">Choose a report</option>{catalog.sources.map((source) => <option key={source.id} value={source.id}>{source.filename} · {source.incidentTitle}</option>)}</select>{catalog.sources.length === 0 && <p className="mt-2 text-sm text-muted">No other maintenance or inspection reports on this source page.</p>}</div><div className="flex flex-wrap gap-3"><button type="button" className="button-secondary" disabled={pages.length === 1} onClick={() => { choose(""); setPages((old) => old.slice(0, -1)); }}>Previous sources</button><button type="button" className="button-secondary" disabled={!catalog.nextCursor} onClick={() => { choose(""); setPages((old) => [...old, catalog.nextCursor]); }}>More sources</button></div><p className="text-xs text-muted">Source page {pages.length} · checked {incidentDate(catalog.checkedAt)}. Reports are not matched automatically.</p></>}
      </fieldset>
      <button type="button" className="button-secondary" disabled={busy || uncertain || listState === "loading"} onClick={() => { choose(""); setListReload((value) => value + 1); }}>Refresh source list</button>
      {sourceId && <>
        {previewState === "loading" && <p role="status" className="text-sm">Loading original source text…</p>}
        {previewError && <p role="alert" className="text-sm">{previewError}</p>}
        {selected && <div className="min-w-0 rounded-xl border border-line p-4"><h3 className="break-words text-sm font-semibold">Source preview · {selected.source.filename}</h3><p className="mt-2 break-words text-xs leading-6">{selected.source.incidentTitle} · workflow {selected.source.incidentStatus.replaceAll("_", " ")}<br />Uploaded {incidentDate(selected.source.uploadedAt)}. Reviewed {incidentDate(selected.checkedAt)}.</p><a href={reportSourceHref(selected.source.incidentId, selected.source.id)} className="mt-2 inline-block text-sm text-teal underline underline-offset-4">Inspect original source record</a><p className="mt-3 text-xs leading-6">{selected.sourceIsCopy ? "This source is itself a copy; its immediate origin remains recorded on its source page. " : ""}{selected.correctionRevision > 0 ? `This source has ${selected.correctionRevision} operator correction${selected.correctionRevision === 1 ? "" : "s"}. Only its original text is copied; those corrections stay on the source.` : "This source has no operator corrections."}</p><details className="mt-3"><summary className="cursor-pointer text-sm font-medium">Original source text to copy</summary><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7">{selected.source.rawText}</p></details></div>}
        <button type="button" className="button-secondary" disabled={busy || uncertain || previewState === "loading"} onClick={() => { setConfirmed(false); setError(""); setNotice(""); setMustReload(true); setPreviewReload((value) => value + 1); }}>Reload selected source</button>
        <fieldset disabled={busy || uncertain || previewState !== "ready" || mustReload} className="min-w-0"><label className="flex items-start gap-3 text-sm leading-7"><input type="checkbox" checked={confirmed} required onChange={(event) => setConfirmed(event.target.checked)} className="mt-2" />I confirm this source report should be copied to the selected target incident. This association requires human review and does not establish that both records describe the same event.</label></fieldset>
      </>}
      {mustReload && <p className="text-xs leading-6">Reload the selected source and review it again before a new copy attempt.</p>}
      <div className="flex flex-wrap gap-3"><button type="submit" className="button-primary" disabled={busy || (!uncertain && (!selected || previewState !== "ready" || !confirmed || mustReload))}>{busy ? "Copying report…" : uncertain ? "Retry same copy" : "Copy report to this incident"}</button><button type="button" className="button-secondary" disabled={busy} onClick={() => router.refresh()}>Refresh incident evidence</button></div>
    </form>}
    {notice && <p role="status" className="mt-4 rounded-xl bg-surface p-4 text-sm leading-7">{notice}</p>}
    {error && <p role="alert" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-7">{error}</p>}
  </section>;
}
