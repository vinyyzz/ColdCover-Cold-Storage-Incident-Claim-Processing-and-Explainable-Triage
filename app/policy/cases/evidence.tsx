import { formatPaise } from "@/lib/analysis/contract";
import { formatIstDate } from "@/lib/inventory/format";
import { demoScheduleNotice } from "@/lib/policy-cases/catalogue";
import ScheduleTimeline from "./timeline";
import type { CaseSnapshot } from "@/lib/policy-cases/service";

export default function CaseEvidence({ snapshot }: { snapshot: CaseSnapshot }) {
  const { readings } = snapshot;
  return <div className="space-y-5 text-sm leading-6">
    <div><p className="font-semibold">{snapshot.policy.name} · {snapshot.readiness}</p><p>{snapshot.demonstrationLabel}</p><p>{snapshot.policy.wording}</p>
      <p>Reported event: {snapshot.event}{snapshot.trigger ? "" : " · Review this event against the policy's listed triggers."}</p>
      {snapshot.linkedIncident && <p>Linked original incident: {snapshot.linkedIncident.title} · {snapshot.linkedIncident.id}</p>}
      {snapshot.readingWindow && <p>Requested readings: {formatIstDate(snapshot.readingWindow.from)} to {formatIstDate(snapshot.readingWindow.to)} IST.</p>}
      {snapshot.extensions.length > 0 && <p>Selected extensions: {snapshot.extensions.map((extension) => extension.name).join(" · ")}</p>}
    </div>
    {snapshot.targets.length > 0 && <div><h3 className="text-lg font-semibold">Declared targets</h3><ul className="list-disc pl-5">{snapshot.targets.map((target) => <li key={target.code}>{target.code} · {target.type.replaceAll("_", " ")} · {target.description}</li>)}</ul></div>}
    {snapshot.batches.length > 0 && <div><h3 className="text-lg font-semibold">Selected stock records</h3><ul className="list-disc pl-5">{snapshot.batches.map((batch) => <li key={batch.id}>{batch.batchCode} · {batch.ownerName} · {batch.quantityKg} kg{batch.recordedValueInr === null ? " · recorded value missing" : ""} · entered {formatIstDate(batch.enteredAt)} IST{batch.exitedAt ? ` · exited ${formatIstDate(batch.exitedAt)} IST` : ""}</li>)}</ul></div>}
    <div><h3 className="text-lg font-semibold">Evidence checklist</h3><ul className="list-disc pl-5">{snapshot.checklist.map((entry) => <li key={entry.kind}>{entry.label} · {entry.sources.length ? `Present: ${entry.sources.join(", ")}` : "Needs evidence"}</li>)}</ul></div>
    {snapshot.analysis.length > 0 && <div className="space-y-3">
      <h3 className="text-lg font-semibold">Temperature evidence timeline</h3><p>{demoScheduleNotice}</p>
      {snapshot.analysis.map((analysis) => <section key={analysis.id} className="rounded-lg border border-line p-3">
        <h4 className="font-semibold">{analysis.schedule.name} · {analysis.schedule.minC} to {analysis.schedule.maxC} °C</h4>
        <p>{analysis.schedule.minMinutes} minute excursion · gaps over {analysis.schedule.maxGapMinutes} minutes</p>
        {analysis.runs.length === 0 && <p>No excursion observed in the supplied readings.</p>}
        <ScheduleTimeline analysis={analysis} readings={readings} />
        <ol className="mt-2 space-y-3">{analysis.runs.map((run) => <li key={`${run.direction}:${run.id}`} className="border-t border-line pt-2">
          <p><strong>{run.direction} · {run.kind === "brief_spike" ? "Brief excursion" : "Investigation interval"}</strong></p>
          <p>{formatIstDate(run.start)} IST → {formatIstDate(run.observedUntil)} IST {run.ongoing ? "· still open at last observation" : ""}</p>
          <p className="break-all">Readings: {run.startReadingId}, {run.lastAbnormalReadingId}{run.endReadingId ? `, ${run.endReadingId}` : ""}{run.dataGapUncertainty && " · Data gap requires review"}</p>
          {run.exposure && <><p>{run.exposure.label}: {formatPaise(run.exposure.knownValueSubtotalPaise)}{run.exposure.valuationComplete ? "" : " · known subtotal only"}</p>
            <ul className="list-disc pl-5">{run.exposure.batches.map((batch) => <li key={batch.id}>{batch.batchCode} · {batch.classification.replaceAll("_", " ")} · {batch.reason}</li>)}</ul>
          </>}
        </li>)}</ol>
        {analysis.gaps.length > 0 && <details className="mt-2"><summary>Reading gaps ({analysis.gaps.length})</summary>{analysis.gaps.map((gap) => <p key={gap.id}>{formatIstDate(gap.start)} to {formatIstDate(gap.end)} IST · {gap.leftReadingId} → {gap.rightReadingId}</p>)}</details>}
      </section>)}
      <details><summary className="cursor-pointer font-semibold">Source readings ({readings.length}) · {snapshot.readingSource}</summary>
        <div className="max-h-80 overflow-auto" tabIndex={0} role="region" aria-label="Source readings">
          <table className="w-full text-left text-xs"><thead><tr><th>Reading</th><th>Time (IST)</th><th>°C</th></tr></thead><tbody>{readings.map((row) => <tr key={row.id}><td className="break-all">{row.id}</td><td>{formatIstDate(row.recordedAt)}</td><td>{row.temperatureC}</td></tr>)}</tbody></table>
        </div>
      </details>
    </div>}
    <div><h3 className="text-lg font-semibold">Source records</h3>
      {snapshot.evidence.length === 0 ? <p>No records attached.</p> : snapshot.evidence.map((record) => <details key={record.id} className="mt-2 rounded-md border border-line p-2">
        <summary className="cursor-pointer font-semibold">{record.title}</summary>
        <p className="break-all text-xs text-muted">{record.origin} · {record.id}</p><pre className="whitespace-pre-wrap break-words">{record.text}</pre>
      </details>)}
    </div>
  </div>;
}
