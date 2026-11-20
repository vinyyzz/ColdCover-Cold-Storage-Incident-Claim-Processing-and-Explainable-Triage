"use client";
import { useState } from "react";
import { formatIstDate } from "@/lib/inventory/format";
import type { CaseSnapshot } from "@/lib/policy-cases/service";

type Analysis = CaseSnapshot["analysis"][number];
export default function ScheduleTimeline({ analysis, readings }: { analysis: Analysis; readings: CaseSnapshot["readings"] }) {
  const [selected, setSelected] = useState<number | null>(null);
  const start = readings[0], end = readings.at(-1);
  if (!start || !end || readings.length < 2) return null;
  const first = Date.parse(start.recordedAt), span = Date.parse(end.recordedAt) - first;
  const percent = (stamp: string) => Math.max(0, Math.min(100, (Date.parse(stamp) - first) / span * 100));
  const run = selected === null ? undefined : analysis.runs[selected];
  const ids = run ? new Set([run.startReadingId, run.lastAbnormalReadingId, run.endReadingId, ...run.reviewQuestions.flatMap((q) => q.sourceReadingIds)]) : new Set();
  return <div className="mt-3 space-y-2">
    <p className="font-medium">Observed interval positions</p>
    <div className="relative h-14 overflow-hidden rounded-md border border-line bg-surface">
      {analysis.gaps.map((gap) => <span key={gap.id} title={`Gap of ${gap.durationMinutes} minutes`} className="absolute inset-y-0 bg-amber-100" style={{ left: `${percent(gap.start)}%`, width: `${percent(gap.end)-percent(gap.start)}%` }} />)}
      {analysis.runs.map((entry, index) => <button key={`${entry.direction}:${entry.id}`} type="button"
        className={`absolute h-5 min-w-2 rounded-sm border outline-teal ${entry.direction === "Above band" ? "top-1 bg-teal-soft" : "bottom-1 bg-sky-100"} ${selected === index ? "border-ink ring-2 ring-inset ring-teal" : "border-teal"}`}
        style={{ left: `${Math.min(99,percent(entry.start))}%`, width: `${percent(entry.observedUntil)-percent(entry.start)}%` }}
        aria-label={`${entry.direction} from ${formatIstDate(entry.start)} IST, inspect source observations`}
        aria-pressed={selected === index} onClick={() => setSelected(index)} />)}
    </div>
    <div className="flex justify-between gap-3 text-xs text-muted"><time dateTime={start.recordedAt}>{formatIstDate(start.recordedAt)} IST</time><time dateTime={end.recordedAt}>{formatIstDate(end.recordedAt)} IST</time></div>
    <p className="text-xs text-muted">Above band on top, below band underneath. Amber marks gaps. Select a bar to inspect its recorded observations.</p>
    {run && <div className="rounded-md border border-line p-2" role="status">
      <p className="font-semibold">{run.direction} · source observations</p>
      <ul>{readings.filter((row) => ids.has(row.id)).map((row) => <li key={row.id} className="break-all">{formatIstDate(row.recordedAt)} IST · {row.temperatureC} °C · {row.id}</li>)}</ul>
    </div>}
  </div>;
}
