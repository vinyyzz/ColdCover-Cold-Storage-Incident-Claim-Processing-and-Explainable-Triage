export type ChartReading = { id: string; recordedAt: string; temperatureC: number; scenarioId: string | null };
export type ChartSettings = { normalMinC: number; normalMaxC: number; abnormalAboveC: number; maxGapMinutes: number };
export type ChartPoint = { time: number; temperatureC: number | null; aboveC: number | null };
export type ObservedSpan = { start: number; end: number; count: number };
export type ObservedGap = { start: number; end: number; minutes: number };
export const CHART_PAGE_SIZE = 1000;

// Page without thinning: every reading and extreme in the visible slice remains.
// Pages count backwards from the latest record and never mutate the source.
export function chartPage(readings: readonly ChartReading[], olderPage: number) {
  const pageCount = Math.max(1, Math.ceil(readings.length / CHART_PAGE_SIZE));
  const page = Math.max(0, Math.min((Number.isFinite(olderPage) ? Math.trunc(olderPage) : 0), pageCount - 1));
  const end = readings.length - page * CHART_PAGE_SIZE;
  const start = Math.max(0, end - CHART_PAGE_SIZE);
  return { readings: readings.slice(start, end), start, end, page, pageCount };
}

// Display observations only. These spans stop at their last observed point and
// split at gaps; they are deliberately not rules-engine incident envelopes.
export function buildChartModel(readings: readonly ChartReading[], settings: ChartSettings) {
  if (![settings.normalMinC, settings.normalMaxC, settings.abnormalAboveC, settings.maxGapMinutes].every(Number.isFinite) || settings.normalMinC > settings.normalMaxC || settings.maxGapMinutes <= 0) throw new Error("Invalid chart settings.");
  const points: ChartPoint[] = [], spans: ObservedSpan[] = [], gaps: ObservedGap[] = [];
  let previous = -Infinity, span: ObservedSpan | null = null, aboveCount = 0;
  let low = settings.normalMinC, high = Math.max(settings.normalMaxC, settings.abnormalAboveC);
  for (const reading of readings) {
    const time = Date.parse(reading.recordedAt), value = reading.temperatureC;
    if (!Number.isFinite(time) || !Number.isFinite(value) || time <= previous) throw new Error("Chart readings need finite values and strictly increasing instants.");
    if (previous !== -Infinity && time - previous > settings.maxGapMinutes * 60000) {
      gaps.push({ start: previous, end: time, minutes: (time - previous) / 60000 });
      points.push({ time: previous + (time - previous) / 2, temperatureC: null, aboveC: null });
      span = null;
    }
    const above = value > settings.abnormalAboveC;
    points.push({ time, temperatureC: value, aboveC: above ? value : null });
    if (above) {
      aboveCount++;
      if (!span) { span = { start: time, end: time, count: 1 }; spans.push(span); }
      else { span.end = time; span.count++; }
    } else span = null;
    low = Math.min(low, value); high = Math.max(high, value); previous = time;
  }
  // Multiplication before addition avoids overflow with large finite CSV values.
  const pad = Math.max((high / 10 - low / 10), 0.5);
  const yDomain: [number, number] = [Math.max(-Number.MAX_VALUE, low - pad), Math.min(Number.MAX_VALUE, high + pad)];
  const first = points[0]?.time ?? 0, last = points.at(-1)?.time ?? first;
  const xDomain: [number, number] = first === last ? [first - 5 * 60000, last + 5 * 60000] : [first, last];
  return { points, spans, gaps, aboveCount, yDomain, xDomain, plottable: Number.isFinite(yDomain[1] - yDomain[0]) };
}
export type ChartModel = ReturnType<typeof buildChartModel>;

const preciseDate = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false });
const axisDate = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
export const chartDate = (time: number) => preciseDate.format(time);
export const chartTick = (time: number) => axisDate.format(time);
