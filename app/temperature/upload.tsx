"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { formatIstDate } from "@/lib/inventory/format";
import { MAX_CSV_BYTES, type CsvIssue } from "@/lib/temperature/csv";
import ScenarioSimulator from "./simulator";
import type { TemperatureOverview } from "@/lib/temperature/service";

export default function TemperatureInput({ overview }: { overview: TemperatureOverview }) {
  const router = useRouter(), fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [error, setError] = useState(""), [issues, setIssues] = useState<CsvIssue[]>([]);
  const [refreshToken, setRefreshToken] = useState(0), [analysisRunning, setAnalysisRunning] = useState(false);
  function refreshStored() { setRefreshToken((token) => token + 1); router.refresh(); }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setIssues([]); setMessage("");
    const file = fileInput.current?.files?.[0];
    if (!file) { setError("Choose a CSV file to import."); return; }
    if (file.size > MAX_CSV_BYTES) { setError("CSV files must be 2 MiB or smaller."); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/temperature/upload", { method: "POST", headers: { "Content-Type": "text/csv" }, body: file });
      const result = await response.json();
      if (!response.ok) { setError(result.error?.message ?? "The import could not be confirmed. Refresh records before retrying."); setIssues(result.error?.issues ?? []); return; }
      setMessage(`${new Intl.NumberFormat("en-IN").format(result.inserted)} readings imported. ${formatIstDate(result.firstAt)} to ${formatIstDate(result.lastAt)} IST. Existing records were preserved.`);
      if (fileInput.current) fileInput.current.value = "";
    } catch { setError("The import could not be confirmed. Refresh records before retrying to check whether it completed."); }
    finally { setBusy(false); refreshStored(); }
  }
  return <div className="mt-8 space-y-6">
    <section aria-labelledby="coverage-heading" className="rounded-2xl border border-line bg-white p-6">
      <h2 id="coverage-heading" className="font-semibold">Stored log</h2>
      <p className="mt-3 text-3xl font-semibold">{new Intl.NumberFormat("en-IN").format(overview.count)} <span className="text-sm font-normal text-muted">readings</span></p>
      <p className="mt-2 text-sm leading-6 text-muted">{overview.firstAt && overview.lastAt ? `${formatIstDate(overview.firstAt)} to ${formatIstDate(overview.lastAt)} IST` : "No readings recorded yet. Upload a CSV to begin."}</p>
      <p className="mt-3 text-xs leading-6 text-muted">This range describes recorded timestamps; it does not establish uninterrupted coverage or stock condition. Run stored-log analysis below to calculate investigation intervals and batch presence.</p>
      <a href="#stored-log-analysis" className="mt-3 inline-block text-sm font-medium text-teal underline underline-offset-4">Go to saved-log analysis</a>
    </section>
    <ScenarioSimulator storedReadings={overview.readings} storedSettings={overview.settings} refreshToken={refreshToken} importBusy={busy} onAnalysisRunning={setAnalysisRunning} />
    <section aria-labelledby="upload-heading" className="rounded-2xl border border-line bg-white p-6">
      <div className="flex flex-wrap items-center justify-between gap-4"><h2 id="upload-heading" className="text-xl font-semibold">Import CSV to stored log</h2><a className="font-medium text-teal underline underline-offset-4" href="/api/temperature/sample" download>Download sample CSV</a></div>
      <p id="csv-help" className="mt-4 text-sm leading-7 text-muted">Use the columns <code>timestamp,temperature_c</code>. Include a timezone (for example, <code>+05:30</code>), use earliest-to-latest order, and include each timestamp only once. Up to 20,000 readings, UTF-8, 2 MiB maximum.</p>
      <p className="mt-3 text-sm leading-7 text-muted">Imports update the stored CH-1 log, including while a scenario preview is displayed. Use Show stored log to view your saved readings. If any row is invalid or a timestamp already exists, the entire upload is rejected. No readings are replaced. The sample uses 11 March 2026, following the seeded demonstration day; importing it a second time will report a conflict.</p>
      <form onSubmit={upload} className="mt-5">
        <label htmlFor="temperature-file" className="block text-sm font-medium">CSV file</label>
        <input ref={fileInput} id="temperature-file" type="file" accept=".csv,text/csv" required disabled={busy || analysisRunning} aria-describedby="csv-help" className="form-input mt-2 block w-full" />
        <div className="mt-4 flex flex-wrap gap-3"><button type="submit" disabled={busy || analysisRunning} className="button-primary">{busy ? "Importing…" : "Import readings"}</button><button type="button" disabled={busy || analysisRunning} className="button-secondary" onClick={refreshStored}>Refresh records</button></div>
      </form>
      <p role="status" className="mt-4 text-sm text-teal">{message}</p>
      {error && <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"><p>{error}</p>{issues.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5">{issues.map((issue, index) => <li key={index}>Row {issue.row}: {issue.message}</li>)}</ul>}</div>}
    </section>
    <section aria-labelledby="recent-heading" className="rounded-2xl border border-line bg-white p-6"><h2 id="recent-heading" className="font-semibold">Most recent readings</h2>{overview.recent.length === 0 ? <p className="mt-4 text-sm text-muted">No readings to display.</p> : <ul className="mt-4 divide-y divide-line">{overview.recent.map((reading) => <li key={reading.id} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><span>{formatIstDate(reading.recordedAt)} IST <span className="text-xs text-muted">· {reading.scenarioId ? "Scenario record" : "CSV import"}</span></span><span className="font-mono">{reading.temperatureC} °C</span></li>)}</ul>}</section>
  </div>;
}
