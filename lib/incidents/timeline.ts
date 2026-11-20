import { fieldLabels } from "../documents/contract";
import type { TriageSource } from "../rules/triage-types";
import type { IncidentDetail } from "./types";
import { incidentDate } from "./presentation";

export interface TimelineItem {
  id: string; kind: "report" | "attachment" | "batch" | "reading";
  label: string; at: string | null; text: string; source: TriageSource;
}
type Context = Pick<IncidentDetail, "timeline" | "evidence" | "summary" | "documents">;
const timeFields = new Set(["fault_time", "repair_time", "restart_time", "inspection_date"]);

export function timelineRange(start: number, end: number, from: number, to: number) {
  if (![start, end, from].every(Number.isFinite) || !(Number.isFinite(to) || to === Infinity) || end <= start || to < from) throw new Error("Invalid timeline range.");
  const position = (time: number) => Math.max(0, Math.min(100, (time - start) / (end - start) * 100));
  return { left: position(from), width: Math.max(0, position(to) - position(from)), before: from < start, after: to > end, outside: to <= start ? "before" as const : from >= end ? "after" as const : null, empty: from === to };
}

/** Display preparation only; exposure and interval qualification stay in rules. */
export function buildEvidenceTimeline(data: Context, requestedPage = 0) {
  const { timeline, evidence, summary } = data;
  if (timeline.status !== "available" || !evidence || summary.status !== "available") return null;
  if (timeline.analysisId !== summary.analysisId || timeline.intervalId !== evidence.interval.id || timeline.analysisId !== evidence.revision.analysisId) throw new Error("Timeline evidence contexts differ.");
  const pageCount = Math.max(1, Math.ceil(timeline.readings.length / 1000));
  const page = Math.max(0, Math.min(Number.isSafeInteger(requestedPage) ? requestedPage : 0, pageCount - 1));
  const readings = timeline.readings.slice(page * 1000, (page + 1) * 1000);
  if (!readings.length) throw new Error("Verified timeline has no source readings.");
  let previous = -Infinity;
  for (const row of timeline.readings) {
    const time = Date.parse(row.recordedAt);
    if (!Number.isFinite(time) || time <= previous || !Number.isFinite(row.temperatureC)) throw new Error("Timeline readings must be finite, ordered and unique.");
    previous = time;
  }
  const first = Date.parse(readings[0].recordedAt), last = Date.parse(readings.at(-1)!.recordedAt);
  const padding = Math.max(60000, (last - first) / 20);
  // Interior page edges stop at actual samples; padding must not cover omitted
  // readings from the next/previous page and imply they were displayed.
  const start = first - (page === 0 ? padding : 0), end = last + (page === pageCount - 1 ? padding : 0);
  const x = (time: number) => (time - start) / (end - start) * 100;
  // Normalize before subtraction to preserve very large finite CSV values.
  const scale = Math.max(1, Math.abs(evidence.settings.abnormalAboveC), ...readings.map((row) => Math.abs(row.temperatureC)));
  const values = readings.map((row) => row.temperatureC / scale), low = Math.min(...values, evidence.settings.abnormalAboveC / scale), high = Math.max(...values, evidence.settings.abnormalAboveC / scale);
  const extent = Math.max(high - low, 0.01), y = (value: number) => 150 - ((value / scale - low) / extent) * 120;
  const segments: { id: string; x: number; y: number }[][] = [], gaps: { start: number; end: number }[] = [];
  for (const [i, row] of readings.entries()) {
    const time = Date.parse(row.recordedAt), prior = readings[i - 1];
    if (!prior || time - Date.parse(prior.recordedAt) > evidence.settings.maxGapMinutes * 60000) {
      segments.push([]); if (prior) gaps.push({ start: Date.parse(prior.recordedAt), end: time });
    }
    segments.at(-1)!.push({ id: row.id, x: x(time), y: y(row.temperatureC) });
  }
  const items: TimelineItem[] = [], documents = new Set<string>(), quotes = new Set<string>();
  for (const fact of summary.facts) for (const source of fact.sources) {
    if (source.type !== "document") continue;
    const doc = data.documents.find((row) => row.id === source.id);
    if (!doc) throw new Error("Timeline report unavailable.");
    if (!documents.has(doc.id)) {
      documents.add(doc.id); items.push({ id: `attachment:${doc.id}`, kind: "attachment", at: doc.uploadedAt, label: doc.filename, text: "Recorded attachment upload time; this is not an equipment occurrence.", source: { type: "document", id: doc.id, correctionId: source.correctionId } });
    }
    if (!source.quote) continue;
    const key = JSON.stringify(source); if (quotes.has(key)) continue; quotes.add(key);
    const quote = source.quote;
    items.push({ id: key, kind: "report", at: timeFields.has(quote.field) ? quote.value : null, label: `${doc.filename} · ${fieldLabels[quote.field]}`, text: quote.quote, source: structuredClone(source) });
  }
  for (const row of evidence.exposure.batches) items.push({ id: `batch:${row.id}`, kind: "batch", at: null, label: `Batch ${row.batchCode}`, text: row.reason, source: { type: "batch", id: row.id } });
  for (const row of readings) items.push({ id: `reading:${row.id}`, kind: "reading", at: row.recordedAt, label: `${incidentDate(row.recordedAt)} · ${row.temperatureC} °C`, text: row.id, source: { type: "reading", id: row.id } });
  return { page, pageCount, readings, start, end, x, y, segments, gaps, thresholdY: y(evidence.settings.abnormalAboveC), items };
}

export function retainedTimelineItem(items: readonly TimelineItem[], selected: TimelineItem | null) {
  return selected ? items.find((item) => JSON.stringify(item) === JSON.stringify(selected)) ?? null : null;
}
