"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { requestStoredAnalysis } from "@/lib/analysis/client";
import type { AnalysisResponse } from "@/lib/analysis/contract";
import { formatIstDate } from "@/lib/inventory/format";
import AnalysisResults from "./analysis-results";

export default function StoredAnalysis({ refreshToken, previewActive, importBusy, onRunningChange }: { refreshToken: number; previewActive: boolean; importBusy: boolean; onRunningChange: (running: boolean) => void }) {
  const [value, setValue] = useState<AnalysisResponse | null>(null), [pending, setPending] = useState<"GET" | "POST" | null>("GET");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [mustRefresh, setMustRefresh] = useState(false);
  const [completedRefreshToken, setCompletedRefreshToken] = useState(-1);
  const active = useRef(0), controller = useRef<AbortController | null>(null);
  const load = useCallback(async (method: "GET" | "POST") => {
    const ticket = ++active.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setPending(method); setError(""); setNotice(""); setCheckedAt(null);
    try {
      const result = await requestStoredAnalysis(method, abort.signal);
      if (ticket !== active.current || abort.signal.aborted) return;
      setValue(result); setCheckedAt(new Date().toISOString()); setMustRefresh(false);
      if (method === "POST" && result.status !== "not_analyzed") setNotice(result.reused ? "Inputs unchanged. Existing analysis reused; no incidents, events or audit entries duplicated." : `Analysis saved as revision ${result.analysis.revision}. Previous evidence retained.`);
    } catch (failure) {
      if (ticket !== active.current || abort.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : "Analysis unavailable. Refresh analysis before retrying.");
      if (method === "POST") setMustRefresh(true);
    } finally { if (ticket === active.current) setPending(null); }
  }, []);
  useEffect(() => {
    const ticket = ++active.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    void requestStoredAnalysis("GET", abort.signal).then((result) => {
      if (ticket !== active.current || abort.signal.aborted) return;
      setValue(result); setCheckedAt(new Date().toISOString()); setMustRefresh(false); setError(""); setNotice("");
    }).catch((failure: unknown) => {
      if (ticket !== active.current || abort.signal.aborted) return;
      setCheckedAt(null); setError(failure instanceof Error ? failure.message : "Analysis unavailable. Refresh analysis before retrying.");
    }).finally(() => {
      if (ticket === active.current && !abort.signal.aborted) { setPending(null); setCompletedRefreshToken(refreshToken); }
    });
    return () => abort.abort();
  }, [refreshToken]);
  useEffect(() => () => controller.current?.abort(), []);
  async function run() {
    onRunningChange(true);
    try { await load("POST"); } finally { onRunningChange(false); }
  }
  const refreshing = completedRefreshToken !== refreshToken;
  const inFlight = refreshing || pending !== null;
  const freshness = importBusy ? "Stored import in progress" : inFlight ? pending === "POST" ? "Analysis running…" : "Checking analysis…" : !checkedAt ? "Freshness unavailable" : value?.status === "stale" ? "Stale · reanalysis needed" : value?.status === "current" ? "Current at last check" : "Not analysed";
  return <section id="stored-log-analysis" aria-labelledby="stored-analysis-heading" className="min-w-0 scroll-mt-6 rounded-2xl border border-line bg-white p-4 sm:p-6" aria-busy={inFlight}>
    <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-wider text-teal">Saved CH-1 records only</p><h2 id="stored-analysis-heading" className="mt-2 text-xl font-semibold">Stored-log analysis</h2></div><p role="status" className={`rounded-full border px-3 py-2 text-xs font-semibold ${value?.status === "stale" || !checkedAt ? "border-amber-200 bg-amber-50 text-amber-900" : "border-line text-teal"}`}>{freshness}</p></div>
    <p className="mt-4 text-sm leading-7 text-muted">Run deterministic analysis of saved temperatures and inventory. Analysis is deliberate; imports and simulator selections do not run it. Results organise recorded evidence for human review and do not establish stock condition or payment.</p>
    {previewActive && <p className="mt-4 rounded-xl border border-teal bg-teal-soft p-4 text-sm leading-7">A scenario preview is selected or loading above. Results below refer only to saved CH-1 records. Use Show stored log before running analysis; preview data will not be analysed.</p>}
    <div className="mt-5 flex flex-wrap gap-3"><button type="button" className="button-primary" disabled={inFlight || previewActive || importBusy || mustRefresh} onClick={() => void run()}>{pending === "POST" ? "Analysing saved records…" : "Run stored-log analysis"}</button><button type="button" className="button-secondary" disabled={inFlight || importBusy} onClick={() => void load("GET")}>{refreshing || pending === "GET" ? "Checking analysis…" : "Refresh analysis"}</button></div>
    {checkedAt && !importBusy && !inFlight && <p className="mt-3 text-xs text-muted">Freshness checked {formatIstDate(checkedAt)} IST. Refresh after edits made elsewhere.</p>}
    <p role="status" className="mt-3 text-sm leading-7 text-teal">{!refreshing && notice}</p>
    {!refreshing && error && <div role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-7 text-red-900"><p>{error}</p><p className="mt-2">Freshness is unconfirmed. {value?.analysis ? "The previous snapshot is retained below for reference." : "No verified results to display."} Use Refresh analysis to check saved results before retrying.</p></div>}
    {value?.status === "stale" && <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-7 text-amber-950">Historical snapshot · saved evidence has changed. Values and interval membership below describe revision {value.analysis.revision}, not the current stored records. Run analysis again to reconcile them.</p>}
    {value?.status === "not_analyzed" && <p className="mt-4 rounded-xl border border-dashed border-line p-5 text-sm leading-7 text-muted">No stored-log analysis yet. Run analysis to identify qualified intervals, brief spikes, gaps and batch presence. The source draft/report is not a calculated incident.</p>}
    {value?.analysis && <AnalysisResults key={value.analysis.id} result={value} />}
  </section>;
}
