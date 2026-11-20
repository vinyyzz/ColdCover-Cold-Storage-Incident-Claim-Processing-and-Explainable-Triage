"use client";

import { useEffect, useRef, useState } from "react";
import { demonstrationPolicy } from "@/lib/demo/policy";
import { formatPaise } from "@/lib/analysis/contract";
import { formatInr, formatIstDate } from "@/lib/inventory/format";
import { requestScenarioEvaluation } from "@/lib/evaluation/client";
import type { Comparison, EvaluationReport, ScenarioActual, ScenarioResult } from "@/lib/evaluation/contract";
import type { SummaryFact } from "@/lib/summaries/contract";

function comparisonValue(value: Comparison["actual"], id: string) {
  if (value === null) return "No recorded recovery / no value";
  if (Array.isArray(value)) return value.length ? value.join("; ") : "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (id.endsWith("knownValueSubtotalPaise") && typeof value === "number") return formatPaise(value);
  return String(value);
}
function Source({ source, actual }: { source: SummaryFact["sources"][number]; actual: ScenarioActual }) {
  const reading = source.type === "reading" ? actual.readings.find((row) => row.id === source.id) : null;
  const batch = source.type === "batch" ? actual.batches.find((row) => row.id === source.id) : null;
  const doc = source.type === "document" ? actual.documents.find((row) => row.id === source.id) : null;
  return <details className="rounded-lg border border-line bg-white p-3 text-xs leading-6">
    <summary className="cursor-pointer break-words font-medium focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal">{source.type === "document" ? "Fictional report passage" : source.type === "reading" ? "Exact temperature observation" : source.type === "batch" ? `Batch ${batch?.batchCode ?? "record"}` : "Fixed fixture criteria / analysis"} · {source.id}</summary>
    {reading && <p className="mt-2">{reading.recordedAt} · {reading.temperatureC} °C</p>}
    {batch && <p className="mt-2">Entry: {batch.enteredAt}. Exit: {batch.exitedAt ?? "No exit recorded"}. Recorded value: {batch.recordedValueInr === null ? "Missing" : formatInr(batch.recordedValueInr)}. {batch.quantityKg} kg · {batch.ownerName}.</p>}
    {source.type === "document" && source.quote && <>
      <blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 border-teal pl-3">{source.quote.quote}</blockquote>
      <p>Exact original offsets {source.quote.start}–{source.quote.end} · {source.quote.field.replaceAll("_", " ")}</p>
      {source.quote.time_zone_context && <p>Explicit time context: {source.quote.time_zone_context.quote} · offsets {source.quote.time_zone_context.start}–{source.quote.time_zone_context.end}</p>}
    </>}
    {doc && <details className="mt-2"><summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-teal">Full original fictional report · interval {doc.intervalIndex + 1}</summary><pre className="mt-2 whitespace-pre-wrap break-words font-sans">{doc.rawText}</pre></details>}
    {source.type === "policy" && <p>{demonstrationPolicy.label} {demonstrationPolicy.wording}</p>}
    {source.type === "settings" && <p>Fixture threshold above 5 °C; qualification 30 minutes; gaps over 30 minutes; high recorded value strictly above ₹1,50,000.00.</p>}
    {source.type === "equipment" && <p>Fixture chamber CH-1 · refrigeration unit REF-01.</p>}
    {source.type === "analysis" && <p>This is a calculated fixture selection in this run. It is separate from saved incident revisions.</p>}
  </details>;
}

export function ScenarioDetails({ row }: { row: ScenarioResult }) {
  const actual = row.actual;
  return <div className="mt-5 space-y-6 border-t border-line pt-5">
    {row.error && <p role="alert" className="text-sm">{row.error}</p>}
    <details open={row.status === "different"}>
      <summary className="cursor-pointer text-sm font-semibold focus-visible:outline-2 focus-visible:outline-teal">Expected and calculated comparisons ({row.comparisons.filter((check) => check.passed).length}/{row.comparisons.length} matched)</summary>
      <div className="mt-3 space-y-2">{row.comparisons.map((check) => <div key={check.id} className={`rounded-lg border p-3 text-xs leading-6 ${check.passed ? "border-line" : "border-amber-600 bg-amber-50"}`}>
        <p className="font-semibold">{check.passed ? "Matched" : "Different"} · {check.label}</p>
        <dl className="mt-1 grid min-w-0 gap-1 sm:grid-cols-2"><div className="min-w-0"><dt className="text-muted">Expected</dt><dd className="break-words">{comparisonValue(check.expected, check.id)}</dd></div><div className="min-w-0"><dt className="text-muted">Calculated</dt><dd className="break-words">{comparisonValue(check.actual, check.id)}</dd></div></dl>
      </div>)}</div>
    </details>
    {actual && <>
      {!actual.intervals.length && <p className="text-sm leading-7">No qualified incident interval. {actual.briefSpikes.length ? `${actual.briefSpikes.length} brief spike alert(s); no batch exposure or triage is assigned to spikes.` : "No brief spike alerts."}</p>}
      {actual.intervals.map((interval, index) => <section key={interval.id} aria-label={`Calculated interval ${index + 1}`} className="space-y-4 rounded-xl bg-surface p-4 sm:p-5">
        <h3 className="font-semibold">Calculated interval {index + 1}</h3>
        <p className="break-words text-xs leading-6">{interval.start} → {interval.end ?? `Ongoing; last observed ${interval.observedUntil}`} · IST{interval.dataGapUncertainty ? " · Gaps leave continuity and boundaries uncertain" : ""}</p>
        <p className="text-sm font-semibold">Inventory value under investigation: {formatPaise(interval.knownValueSubtotalPaise)}{interval.valuationComplete ? "" : " · Known subtotal; incomplete"}</p>
        <dl className="grid gap-3 text-xs leading-6 sm:grid-cols-3">{[["Present throughout", interval.presentThroughout], ["Present partially", interval.presentPartially], ["Not present", interval.notPresent]].map(([label, values]) => <div key={String(label)}><dt className="font-semibold">{label}</dt><dd>{(values as string[]).join(", ") || "None"}</dd></div>)}</dl>
        <p className="text-sm"><strong>Readiness:</strong> {interval.readiness} · <strong>Priority:</strong> {interval.priority}</p>
        <ul className="space-y-2 text-xs leading-6">{interval.reasons.map((reason) => <li key={reason.id}>{reason.text}<div className="mt-1 space-y-1">{reason.sources.map((source, i) => <Source key={i} source={source} actual={actual} />)}</div></li>)}</ul>
        {interval.dateObservations.map((note) => <div key={note.id} className="text-xs leading-6"><p>{note.text}</p>{note.sources.map((source, i) => <Source key={i} source={source} actual={actual} />)}</div>)}
        <details><summary className="cursor-pointer text-sm font-semibold focus-visible:outline-2 focus-visible:outline-teal">Checklist and follow-up questions</summary>
          <ul className="mt-3 space-y-2 text-xs leading-6">{interval.checklist.map((item) => <li key={item.id}><strong>{item.status.replaceAll("_", " ")}:</strong> {item.text}</li>)}</ul>
          <ul className="mt-3 space-y-2 text-xs leading-6">{interval.questions.map((question) => <li key={question.id}>{question.text}</li>)}</ul>
        </details>
        <details><summary className="cursor-pointer text-sm font-semibold focus-visible:outline-2 focus-visible:outline-teal">Evidence-linked fallback summary</summary>
          <p className="mt-3 text-xs font-medium text-teal">AI unavailable — using rule-based fallback</p>
          <ol className="mt-3 space-y-4 text-sm leading-7">{interval.summary.statements.map((statement, i) => <li key={i}><p>{statement.text}</p><details className="mt-1"><summary className="cursor-pointer text-xs font-medium focus-visible:outline-2 focus-visible:outline-teal">Statement sources</summary><div className="mt-2 space-y-2">{statement.source_ids.flatMap((id) => interval.summary.facts.find((fact) => fact.source_id === id)!.sources).map((source, j) => <Source key={j} source={source} actual={actual} />)}</div></details></li>)}</ol>
        </details>
      </section>)}
      <details><summary className="cursor-pointer text-sm font-semibold focus-visible:outline-2 focus-visible:outline-teal">Source records and extraction ({actual.readings.length} observations · {actual.documents.length} reports)</summary>
        <p className="mt-3 text-xs leading-6">Reports are attached by the authored interval assignment. Stock-record mappings are absent; inspection batch mentions do not create them.</p>
        {actual.documents.map((doc) => <details key={doc.id} className="mt-3 rounded-lg border border-line p-3 text-xs leading-6"><summary className="cursor-pointer break-words font-medium focus-visible:outline-2 focus-visible:outline-teal">{doc.id} · interval {doc.intervalIndex + 1}</summary><pre className="mt-3 whitespace-pre-wrap break-words font-sans">{doc.rawText}</pre><p className="mt-3 font-semibold">Source-verified extraction</p><pre className="mt-2 whitespace-pre-wrap break-words font-sans">{JSON.stringify(doc.extraction, null, 2)}</pre>{doc.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</details>)}
        <details className="mt-3"><summary className="cursor-pointer text-xs font-medium focus-visible:outline-2 focus-visible:outline-teal">All exact temperature observations</summary><div role="region" aria-label={`Exact fixture readings for ${row.name}`} tabIndex={0} className="mt-3 max-h-96 overflow-auto focus-visible:outline-2 focus-visible:outline-teal"><table className="w-full text-left text-xs leading-6"><thead><tr><th scope="col" className="pr-4">Source ID</th><th scope="col" className="pr-4">Timestamp (IST)</th><th scope="col">°C</th></tr></thead><tbody>{actual.readings.map((reading) => <tr key={reading.id}><td className="pr-4">{reading.id}</td><td className="whitespace-nowrap pr-4">{reading.recordedAt}</td><td>{reading.temperatureC}</td></tr>)}</tbody></table></div></details>
      </details>
    </>}
  </div>;
}
function Case({ row }: { row: ScenarioResult }) {
  const [open, setOpen] = useState(false);
  return <details className="min-w-0 rounded-xl border border-line bg-white p-4 sm:p-5" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer break-words text-sm leading-7 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal"><span className="font-semibold">{row.number}. {row.name}</span><span className={`ml-3 inline-block rounded-full border px-2 py-0.5 text-xs font-semibold ${row.status === "passed" ? "border-line text-teal" : "border-amber-600 text-amber-900"}`}>{row.status === "passed" ? "Matched" : row.status === "different" ? "Different" : "Evaluation error"}</span></summary>
    {open && <ScenarioDetails row={row} />}
  </details>;
}

export function EvaluationResults({ report }: { report: EvaluationReport }) {
  const [filter, setFilter] = useState("all");
  const rows = report.results.filter((row) => filter === "all" || (filter === "issues" ? row.status !== "passed" : row.status === "passed"));
  return <section aria-label="Scenario evaluation results" className="mt-8 space-y-5">
    <div role="status" className="rounded-xl border border-line bg-white p-5"><p className="text-lg font-semibold">{report.passed} of {report.total} scenarios matched</p><p className="mt-2 text-sm leading-7">{report.different} different · {report.errors} evaluation errors · {report.results.reduce((n, row) => n + row.comparisons.length, 0)} comparisons</p><p className="mt-2 text-xs text-muted">Completed {formatIstDate(report.checkedAt)} IST. This run is kept on this page until reload.</p></div>
    <label className="block text-sm font-medium">Show cases <select className="form-input ml-2" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All 30 scenarios</option><option value="issues">Differences and errors</option><option value="matched">Matched scenarios</option></select></label>
    {!rows.length ? <p className="text-sm leading-7">No differences or errors in this completed run.</p> : rows.map((row) => <Case key={row.id} row={row} />)}
  </section>;
}

export default function ScenarioEvaluation() {
  const [report, setReport] = useState<EvaluationReport | null>(null), [running, setRunning] = useState(false), [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null), ticket = useRef(0);
  useEffect(() => () => { ticket.current++; active.current?.abort(); }, []);
  async function run() {
    if (active.current) return;
    const controller = new AbortController(), current = ++ticket.current;
    active.current = controller; setRunning(true); setReport(null); setError(null);
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const result = await requestScenarioEvaluation(controller.signal);
      if (ticket.current === current && !controller.signal.aborted) setReport(result);
    } catch (reason) {
      if (ticket.current === current) setError(controller.signal.aborted ? "The scenario check took too long. Run it again." : reason instanceof Error ? reason.message : "Scenario checks could not be completed. Try again.");
    } finally { clearTimeout(timer); if (ticket.current === current) { active.current = null; setRunning(false); } }
  }
  return <>
    <aside aria-label="Fixed demonstration criteria" className="mt-7 rounded-xl border border-line bg-white p-5 text-xs leading-7 text-muted"><p className="font-semibold text-ink">Fixed fixture criteria</p><p>CH-1 · REF-01 · above 5 °C · qualification 30 minutes · gaps over 30 minutes · high recorded value strictly above ₹1,50,000.00.</p><p>{demonstrationPolicy.label}</p><p>Each run uses isolated fictional sources. Your saved evidence and settings are preserved. Claim/review workflows and live AI are outside this evaluation.</p></aside>
    <div className="mt-6 flex flex-wrap items-center gap-4"><button type="button" className="button-primary" disabled={running} onClick={run}>{running ? "Checking scenarios…" : "Run all 30 scenarios"}</button>{running && <p role="status" className="text-sm">Calculating and comparing the fictional cases…</p>}</div>
    {error && <p role="alert" className="mt-5 rounded-lg border border-amber-600 bg-amber-50 p-4 text-sm leading-7">{error}</p>}
    {!running && !error && !report && <p className="mt-6 text-sm leading-7 text-muted">No evaluation yet. Run all 30 scenarios to see actual comparisons.</p>}
    {report && <EvaluationResults report={report} />}
  </>;
}
