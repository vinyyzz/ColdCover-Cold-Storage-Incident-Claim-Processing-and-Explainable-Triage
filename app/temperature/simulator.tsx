"use client";

import { useEffect, useRef, useState } from "react";
import { formatInr, formatIstDate } from "@/lib/inventory/format";
import { simulatorControls, simulatorPreviewSchema, type SimulatorPreview } from "@/lib/simulator/types";
import type { ChartReading, ChartSettings } from "@/lib/temperature/chart";
import TemperatureChart from "./chart";
import StoredAnalysis from "./analysis";

export default function ScenarioSimulator({ storedReadings, storedSettings, refreshToken, importBusy, onAnalysisRunning }: { storedReadings: ChartReading[]; storedSettings: ChartSettings; refreshToken: number; importBusy: boolean; onAnalysisRunning: (running: boolean) => void }) {
  const [preview, setPreview] = useState<SimulatorPreview | null>(null);
  const [loading, setLoading] = useState<string | null>(null), [error, setError] = useState("");
  const activeRequest = useRef(0), controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  function showStoredLog() {
    activeRequest.current++; controller.current?.abort(); setPreview(null); setLoading(null); setError("");
  }
  async function selectScenario(id: string) {
    const requestId = ++activeRequest.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setLoading(id); setError("");
    try {
      const response = await fetch(`/api/simulator/${encodeURIComponent(id)}`, { method: "POST", cache: "no-store", signal: abort.signal });
      if (!response.ok) throw new Error("Preview unavailable");
      const result = simulatorPreviewSchema.parse(await response.json());
      if (result.id !== id) throw new Error("Unexpected preview");
      if (activeRequest.current === requestId) setPreview(result);
    } catch {
      if (!abort.signal.aborted && activeRequest.current === requestId) setError("The preview could not be loaded. Your displayed data has not changed. Choose the scenario again to retry.");
    } finally { if (activeRequest.current === requestId) setLoading(null); }
  }

  return <>
    <section aria-labelledby="simulator-heading" className="rounded-2xl border border-line bg-white p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-wider text-teal">Fictional demonstration</p><h2 id="simulator-heading" className="mt-2 text-xl font-semibold">Scenario simulator</h2></div><button type="button" className="button-secondary" onClick={showStoredLog} aria-pressed={!preview && !loading}>Show stored log</button></div>
      <p className="mt-3 text-sm leading-7 text-muted">Preview fictional readings, inventory and report text. Selecting a scenario does not change your stored records or run incident analysis. Scenario names describe authored examples, not calculated outcomes.</p>
      <div role="group" aria-label="Scenario previews" className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-busy={loading !== null}>
        {simulatorControls.map((control) => <button key={control.id} type="button" aria-label={control.label} aria-pressed={preview?.id === control.id} className={`rounded-xl border p-4 text-left ${preview?.id === control.id ? "border-teal bg-teal-soft ring-1 ring-teal" : "border-line hover:border-teal"}`} onClick={() => selectScenario(control.id)}><span className="block text-sm font-semibold">{control.label}</span><span className="mt-2 block text-xs leading-5 text-muted">{loading === control.id ? "Loading preview…" : control.hint}</span>{preview?.id === control.id && <span className="mt-2 block text-xs font-semibold text-teal">Selected preview</span>}</button>)}
      </div>
      <p role="status" className="mt-4 text-sm text-teal">{loading ? `Loading ${simulatorControls.find((item) => item.id === loading)?.label} preview…` : preview ? `Previewing ${preview.label}. Stored log unchanged.` : "Showing the stored log. No scenario preview selected."}</p>
      {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}
    </section>
    {preview && <section aria-labelledby="preview-heading" className="rounded-2xl border border-teal bg-teal-soft p-4 sm:p-6">
      <p className="text-xs font-semibold uppercase tracking-wider text-teal">Preview only · not analysed</p><h2 id="preview-heading" className="mt-2 text-xl font-semibold">{preview.label} — source fixture</h2>
      <p className="mt-3 text-sm leading-7">{preview.name}. {preview.description !== preview.name ? preview.description : ""}</p>
      <p className="mt-2 text-xs leading-6 text-muted">{preview.readings.length} fictional readings · {preview.batches.length} batches · {preview.documents.length} source documents. Fixed fixture band {preview.settings.normalMinC}–{preview.settings.normalMaxC} °C; above {preview.settings.abnormalAboveC} °C, gap over {preview.settings.maxGapMinutes} minutes. This preview uses its authored settings. Stored log counts and CSV imports refer to your saved records.</p>
      <details className="mt-4 rounded-xl border border-teal/20 bg-white p-4"><summary className="cursor-pointer text-sm font-semibold">Fixture inventory and documents</summary>
        <p className="mt-3 text-xs leading-6 text-muted">Source records only. Batch presence, exposure, report conflicts and readiness have not been calculated.</p>
        <div role="region" aria-label="Fixture inventory table; scroll horizontally on small screens" tabIndex={0} className="mt-4 overflow-x-auto"><table className="w-full min-w-[650px] text-left text-xs"><caption className="sr-only">Fictional scenario inventory, not stored inventory</caption><thead><tr>{["Batch / owner", "Quantity", "Recorded value", "Entry (IST)", "Exit (IST)"].map((label) => <th key={label} scope="col" className="border-b border-line px-3 py-3">{label}</th>)}</tr></thead><tbody>{preview.batches.map((batch) => <tr key={batch.id}><th scope="row" className="border-b border-line px-3 py-3 font-normal"><span className="block font-semibold">{batch.batchCode}</span>{batch.ownerName}</th><td className="border-b border-line px-3 py-3">{new Intl.NumberFormat("en-IN").format(batch.quantityKg)} kg</td><td className="border-b border-line px-3 py-3">{batch.recordedValueInr === null ? "Not recorded" : formatInr(batch.recordedValueInr)}</td><td className="border-b border-line px-3 py-3 whitespace-nowrap">{formatIstDate(batch.enteredAt)}</td><td className="border-b border-line px-3 py-3 whitespace-nowrap">{batch.exitedAt ? formatIstDate(batch.exitedAt) : "Still stored"}</td></tr>)}</tbody></table></div>
        <h3 className="mt-6 text-sm font-semibold">Unprocessed source documents</h3>{preview.documents.length === 0 ? <p className="mt-3 text-xs text-muted">This fixture has no source documents.</p> : preview.documents.map((document) => <details key={document.id} className="mt-3 rounded-lg border border-line p-3"><summary className="cursor-pointer text-xs font-medium">{document.filename} · {document.docType.replaceAll("_", " ")}</summary><p className="mt-3 whitespace-pre-wrap break-words text-xs leading-6">{document.rawText}</p></details>)}
      </details>
    </section>}
    <TemperatureChart key={preview?.id ?? "stored-log"} readings={preview?.readings ?? storedReadings} settings={preview?.settings ?? storedSettings} />
    <StoredAnalysis refreshToken={refreshToken} previewActive={preview !== null || loading !== null} importBusy={importBusy} onRunningChange={onAnalysisRunning} />
  </>;
}
