"use client";
import { useRef, useState } from "react";
import { currentSummaryFact, evidenceSourceLabel, incidentDate, membershipLabel } from "../../../lib/incidents/presentation";
import type { IncidentDetail } from "../../../lib/incidents/types";
import type { TriageSource } from "../../../lib/rules/triage-types";
import type { SummaryFact } from "../../../lib/summaries/contract";

export default function IncidentSummaryView({ data, onSource }: { data: IncidentDetail; onSource: (source: TriageSource) => void }) {
  const { summary } = data;
  const [selected, setSelected] = useState<SummaryFact | null>(null);
  const panel = useRef<HTMLElement>(null);
  const fact = currentSummaryFact(summary, selected);
  return <section aria-labelledby="summary-heading" className="min-w-0 space-y-5 rounded-2xl border border-line bg-white p-5 sm:p-6">
    <h2 id="summary-heading" tabIndex={-1} className="text-xl font-semibold">Evidence-linked incident summary</h2>
    {summary.status === "unavailable" ? <p role="status" className="rounded-xl bg-surface p-4 text-sm leading-7">Summary unavailable. {summary.reason}</p> : <>
      <p className="inline-block rounded-full bg-surface px-3 py-1 text-xs font-medium">AI unavailable — using rule-based fallback</p>
      <p className="text-xs leading-6 text-muted">{membershipLabel[summary.evidenceMembership]} · checked {incidentDate(summary.checkedAt)}. Review questions use current review criteria. These statements organise selected saved evidence for human review. They do not establish stock condition. Select a statement to inspect every supporting source.</p>
      <ol aria-label="Summary statements" className="space-y-3">{summary.statements.map((statement) => {
        const source = summary.facts.find((item) => item.source_id === statement.source_ids[0])!;
        return <li key={source.source_id}><button type="button" aria-controls="summary-source" aria-pressed={fact?.source_id === source.source_id} className="w-full break-words rounded-xl border border-line p-4 text-left text-sm leading-7 hover:bg-surface" onClick={() => { setSelected(source); panel.current?.focus(); }}>{statement.text}<span className="mt-2 block text-xs text-teal underline underline-offset-4">Inspect supporting sources</span></button></li>;
      })}</ol>
      <section id="summary-source" ref={panel} tabIndex={-1} aria-labelledby="summary-source-heading" className="min-w-0 rounded-xl border border-line bg-surface p-4">
        <h3 id="summary-source-heading" className="font-semibold">Summary statement sources</h3>
        <div role="status">{fact ? <><p className="mt-3 break-words text-sm leading-7">{fact.text}</p><ul aria-label="Statement supporting sources" className="mt-3 flex min-w-0 flex-wrap gap-x-4 gap-y-2">{fact.sources.map((source, index) => <li key={index} className="min-w-0 max-w-full"><button type="button" className="max-w-full break-words text-left text-xs leading-6 text-teal underline underline-offset-4" onClick={() => onSource(source)}>{evidenceSourceLabel(data, source)}</button></li>)}</ul></> : <p className="mt-3 text-sm text-muted">Choose a summary statement to inspect its sources. A changed statement must be selected again after refresh.</p>}</div>
      </section>
    </>}
  </section>;
}
