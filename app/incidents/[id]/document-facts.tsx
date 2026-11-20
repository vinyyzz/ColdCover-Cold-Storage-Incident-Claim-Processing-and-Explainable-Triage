"use client";
import { useState } from "react";
import { arrayFields, fieldLabels, scalarFields, type ExtractedFacts } from "../../../lib/documents/contract";
import { verifyCorrectionState, type DocumentCorrectionState } from "../../../lib/documents/corrections";
import { verifyStoredExtraction } from "../../../lib/documents/extract";
import { incidentDate } from "../../../lib/incidents/presentation";
import type { IncidentDetail } from "../../../lib/incidents/types";
import CorrectionEditor from "./correction-editor";

function FactList({ facts }: { facts: ExtractedFacts }) {
  return (<dl className="divide-y divide-line">{[...scalarFields, ...arrayFields].map((field) => {
      const value = facts[field];
      const values = Array.isArray(value) ? value : value === null ? [] : [value];
      return <div key={field} className="grid min-w-0 gap-2 py-4 lg:grid-cols-[180px_minmax(0,1fr)]"><dt className="text-sm font-medium">{fieldLabels[field]}</dt><dd className="min-w-0 text-sm leading-7">{values.length === 0 ? <span className="text-muted">Not extracted</span> : values.map((item) => {
        const quotes = facts.evidence_quotes.filter((quote) => quote.field === field && quote.value === item);
        return <div key={item} className="mb-3 min-w-0"><p className="whitespace-pre-wrap break-words">{item}</p>{quotes.map((quote) => <figure key={`${quote.start}:${quote.end}`} className="mt-2 min-w-0 border-l-2 border-teal bg-surface p-3"><blockquote className="whitespace-pre-wrap break-words text-xs">{quote.quote}</blockquote><figcaption className="mt-2 break-all font-mono text-[11px]">Source: {quote.source_document_id} · characters {quote.start}–{quote.end} (end exclusive)</figcaption>{quote.time_zone_context && <p className="mt-2 whitespace-pre-wrap break-words text-xs">Timezone context: {quote.time_zone_context.quote} · characters {quote.time_zone_context.start}–{quote.time_zone_context.end}</p>}</figure>)}</div>;
      })}</dd></div>;
    })}</dl>);
}
export default function DocumentFacts({ document, corrections, analysisId = null, analysisRevision = null, editable = false }: {
  document: IncidentDetail["documents"][number]; corrections?: DocumentCorrectionState; analysisId?: string | null; analysisRevision?: number | null; editable?: boolean;
}) {
  const [editing, setEditing] = useState(false), [feedback, setFeedback] = useState({ text: "", error: false });
  if (document.extractionSource === null) return null;
  const data = document.extractionSource === "fallback" ? verifyStoredExtraction(document.rawText, document.id, document.incidentId, document.extractionJson) : null;
  if (!data) return <p className="mt-4 rounded-lg bg-amber-50 p-4 text-sm" role="status">Stored extraction could not be verified. Inspect the original text; extracted fields are withheld.</p>;
  const state = verifyCorrectionState(document.rawText, document.id, data.extraction, corrections ?? { latestCorrectionId: null, selectedCorrectionId: null, history: [] }, analysisRevision);
  const selected = state?.history.find((row) => row.id === state.selectedCorrectionId);
  const facts = selected?.extraction ?? data.extraction;
  return <div className="mt-4 min-w-0 space-y-4">
    <p className="inline-block rounded-full bg-surface px-3 py-1 text-xs font-semibold">{selected ? `Operator corrected · revision ${selected.revision}` : "Fallback extraction · deterministic"}</p>
    <p className="break-words text-xs leading-6 text-muted">Original operator-selected association · analysis <span className="break-all">{data.association.analysisId}</span>. Facts below are reported wording, not verified findings. Times are normalised to IST. Batch references do not establish presence.</p>
    {!state && <p role="alert" className="rounded-lg bg-amber-50 p-4 text-sm">Correction history could not be verified. Corrected fields are withheld; only the verified original fallback is shown.</p>}
    {selected && <p className="text-xs leading-6">Correction {selected.revision} recorded {incidentDate(selected.createdAt)} by storage operator against analysis revision {selected.analysisRevision}. These document annotations do not change saved temperature calculations or historical claim packets.</p>}
    {!selected && data.warnings.length > 0 && <ul className="space-y-2 rounded-lg bg-amber-50 p-4 text-xs leading-6">{data.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
    <section aria-label={`Displayed facts in ${document.filename}`}><FactList facts={facts} /></section>
    {state && editable && (document.docType === "maintenance_report" || document.docType === "stock_inspection_report") && analysisId && !editing && <button type="button" className="button-secondary" onClick={() => { setEditing(true); setFeedback({ text: "", error: false }); }}>Correct extracted facts</button>}
    {state && editable && (document.docType === "maintenance_report" || document.docType === "stock_inspection_report") && analysisId && editing && <CorrectionEditor key={`${document.id}:${analysisId}:${state.latestCorrectionId ?? "original"}`} document={document} analysisId={analysisId} expectedCorrectionId={state.latestCorrectionId} previous={state.history.at(-1)?.extraction ?? data.extraction} onFeedback={(text, error) => setFeedback({ text, error })} onClose={() => setEditing(false)} />}
    {feedback.text && <p role={feedback.error ? "alert" : "status"} className="rounded-lg bg-surface p-4 text-sm leading-7">{feedback.text}</p>}
    {(state?.history.length ?? 0) > 0 && <>
      <details className="rounded-lg border border-line p-4"><summary className="cursor-pointer text-sm font-semibold">Original fallback extraction · preserved</summary><ul className="mt-3 space-y-2 text-xs leading-6">{data.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><FactList facts={data.extraction} /></details>
      <details className="rounded-lg border border-line p-4"><summary className="cursor-pointer text-sm font-semibold">Operator correction history · {state!.history.length} revision{state!.history.length === 1 ? "" : "s"}</summary><p className="mt-3 text-xs leading-6">Every saved correction remains inspectable. Later-analysis annotations are listed here and are not applied to an older selected analysis.</p>{state!.history.map((row) => <details key={row.id} className="mt-3 min-w-0 rounded-lg border border-line p-3"><summary className="cursor-pointer break-words text-sm">Correction {row.revision} · {fieldLabels[row.input.change.field]} · {incidentDate(row.createdAt)}{row.id === state!.selectedCorrectionId ? " · displayed" : analysisRevision !== null && row.analysisRevision > analysisRevision ? " · later analysis; not applied" : " · prior correction"}</summary><p className="mt-3 break-words text-xs leading-6">Analysis revision {row.analysisRevision} · storage operator · reason: {row.input.reason}</p><p className="mt-2 text-xs leading-6">The operator confirmed source relevance or explicitly cleared unsupported information. Source matching checks literal/date support; it does not independently verify interpretation or report truth.</p><FactList facts={row.extraction} /></details>)}</details>
    </>}
  </div>;
}
