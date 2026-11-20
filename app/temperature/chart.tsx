"use client";

import dynamic from "next/dynamic";
import { Component, useMemo, useState, type ReactNode } from "react";
import { buildChartModel, chartDate, chartPage, type ChartReading, type ChartSettings } from "@/lib/temperature/chart";

const Plot = dynamic(() => import("./plot"), { ssr: false, loading: () => <p role="status" className="flex h-80 items-center justify-center text-sm text-muted">Loading temperature chart…</p> });
class PlotBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div role="alert" className="rounded-xl border border-line p-6"><p>The chart could not be displayed. The readings table remains available below.</p><button type="button" className="button-secondary mt-3" onClick={() => this.setState({ failed: false })}>Retry chart</button></div> : this.props.children; }
}

function ReadingTable({ readings, settings }: { readings: ChartReading[]; settings: ChartSettings }) {
  const [page, setPage] = useState(0);
  const current = Math.min(page, Math.max(0, Math.ceil(readings.length / 50) - 1));
  const rows = readings.slice(current * 50, (current + 1) * 50);
  return <details className="mt-6 rounded-xl border border-line p-4">
    <summary className="cursor-pointer text-sm font-medium">Readings table — exact values and timestamps</summary>
    <div className="mt-4 overflow-x-auto" role="region" aria-label="Temperature readings table; scroll horizontally on small screens" tabIndex={0}>
      <table className="w-full min-w-[580px] text-left text-xs"><caption className="sr-only">Readings in the chart window, 50 per table page. Times are IST.</caption><thead><tr>{["Timestamp (IST)", "Temperature", "Observation", "Source"].map((label) => <th key={label} scope="col" className="border-b border-line p-3 font-medium">{label}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.id}><th scope="row" className="border-b border-line p-3 font-normal whitespace-nowrap">{chartDate(Date.parse(row.recordedAt))}</th><td className="border-b border-line p-3">{row.temperatureC} °C</td><td className="border-b border-line p-3">{row.temperatureC > settings.abnormalAboveC ? "Above threshold" : row.temperatureC < settings.normalMinC ? "Below normal band" : row.temperatureC > settings.normalMaxC ? "Above normal band" : "Within normal band"}</td><td className="border-b border-line p-3">{row.scenarioId ? "Scenario record" : "CSV import"}</td></tr>)}</tbody></table>
    </div>
    <div className="mt-4 flex flex-wrap items-center gap-3"><button className="button-secondary" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous table rows</button><button className="button-secondary" disabled={(current + 1) * 50 >= readings.length} onClick={() => setPage(current + 1)}>Next table rows</button><p role="status" className="text-xs text-muted">Rows {current * 50 + 1}–{current * 50 + rows.length} of {readings.length} in this chart window</p></div>
  </details>;
}

export default function TemperatureChart({ readings, settings }: { readings: ChartReading[]; settings: ChartSettings }) {
  const [olderPage, setOlderPage] = useState(0);
  const view = useMemo(() => chartPage(readings, olderPage), [readings, olderPage]);
  const model = useMemo(() => buildChartModel(view.readings, settings), [view.readings, settings]);
  return <section aria-labelledby="chart-heading" className="min-w-0 rounded-2xl border border-line bg-white p-4 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-wider text-teal">Observed temperature</p><h2 id="chart-heading" className="mt-2 text-xl font-semibold">CH-1 temperature chart</h2></div><p className="rounded-full border border-line px-3 py-1 text-xs text-muted">Observation spans only</p></div>
    <p className="mt-3 text-sm leading-7 text-muted">Normal band {settings.normalMinC}–{settings.normalMaxC} °C. Above-threshold observations are strictly greater than {settings.abnormalAboveC} °C. Gaps over {settings.maxGapMinutes} minutes are hatched; the line stops across them.</p>
    {readings.length === 0 ? <div className="mt-6 rounded-xl border border-dashed border-line px-5 py-12 text-center"><h3 className="font-semibold">No temperature readings yet</h3><p className="mt-2 text-sm text-muted">Import a CSV below to plot the recorded log.</p></div> : <>
      <div className="my-5 flex flex-wrap gap-x-5 gap-y-3 text-xs" aria-label="Chart legend"><span><span aria-hidden="true" className="mr-2 inline-block h-3 w-6 bg-teal-soft ring-1 ring-teal/30" />Normal band</span><span><span aria-hidden="true" className="mr-2 inline-block w-6 border-t-2 border-dashed border-amber-800" />Above threshold</span><span><span aria-hidden="true" className="mr-2 inline-block h-3 w-6 border border-dashed border-slate-500" />Hatched gap · no readings</span></div>
      {model.plottable ? <PlotBoundary key={`${view.start}-${view.end}`}><Plot model={model} settings={settings} /></PlotBoundary> : <p role="alert" className="rounded-xl border border-line p-6 text-sm">The numeric range is too wide to plot reliably. Exact values remain available in the readings table below.</p>}
      <p className="mt-3 text-xs leading-6 text-muted">Use Tab to focus the chart, then left/right arrows to inspect values. Shaded spans join recorded above-threshold points within this view; they are not incident intervals. Saved-log qualification, spike alerts and batch evidence appear in Stored-log analysis below.</p>
      <div className="mt-5 flex flex-wrap items-center gap-3"><button className="button-secondary" disabled={view.page >= view.pageCount - 1} onClick={() => setOlderPage(view.page + 1)}>Older readings</button><button className="button-secondary" disabled={view.page === 0} onClick={() => setOlderPage(view.page - 1)}>Newer readings</button><p role="status" className="text-xs text-muted">Showing readings {view.start + 1}–{view.end} of {readings.length}. Up to 1,000 per chart, without thinning.</p></div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2"><div className="rounded-xl bg-surface p-4"><h3 className="text-sm font-semibold">Above-threshold observations</h3><p className="mt-2 text-sm">{model.aboveCount} {model.aboveCount === 1 ? "reading" : "readings"} in {model.spans.length} observed {model.spans.length === 1 ? "span" : "spans"}</p><details className="mt-3 text-xs"><summary className="cursor-pointer font-medium">View above-threshold times</summary>{model.spans.length === 0 ? <p className="mt-3">No above-threshold readings in this view.</p> : <ul className="mt-3 space-y-3">{model.spans.map((span) => <li key={span.start}>{chartDate(span.start)}{span.end !== span.start ? ` to ${chartDate(span.end)}` : " (single observation)"} IST · {span.count} {span.count === 1 ? "reading" : "readings"}</li>)}</ul>}</details></div><div className="rounded-xl bg-surface p-4"><h3 className="text-sm font-semibold">Gaps between readings</h3><p className="mt-2 text-sm">{model.gaps.length} {model.gaps.length === 1 ? "gap" : "gaps"} over {settings.maxGapMinutes} minutes in this view</p><details className="mt-3 text-xs"><summary className="cursor-pointer font-medium">View gap times</summary>{model.gaps.length === 0 ? <p className="mt-3">No gaps over {settings.maxGapMinutes} minutes between these readings.</p> : <ul className="mt-3 space-y-3">{model.gaps.map((gap) => <li key={gap.start}>{chartDate(gap.start)} to {chartDate(gap.end)} IST · {new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 }).format(gap.minutes)} minutes between observations</li>)}</ul>}</details></div></div>
      <ReadingTable key={view.start} readings={view.readings} settings={settings} />
    </>}
  </section>;
}
