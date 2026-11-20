import type { DataGap, TemperatureAnalysis, TemperatureReading, TemperatureRuleSettings, TemperatureRun } from "./types";
import { temperatureRulesInputSchema } from "./validation";

/**
 * Analyze observed temperature runs without persistence or inference of stock
 * condition. Gaps cannot establish recovery; retain an uncertain envelope until
 * the first observed normal reading. Never substitute the current time for an
 * unresolved endpoint. Input must be ordered; do not silently sort/merge it.
 */
export function analyzeTemperature(readings: readonly TemperatureReading[], settings: TemperatureRuleSettings): TemperatureAnalysis {
  const parsed = temperatureRulesInputSchema.parse({ readings, settings });
  const rows = parsed.readings.map((row) => ({ ...row, time: Date.parse(row.recordedAt) }));
  const config = parsed.settings;
  const gaps: { value: DataGap; startTime: number; endTime: number }[] = [];
  const runs: { startIndex: number; endIndex: number | null }[] = [];
  let startIndex: number | null = null;

  rows.forEach((row, index) => {
    const previous = rows[index - 1];
    if (previous && row.time - previous.time > config.maxGapMinutes * 60000) gaps.push({
      startTime: previous.time, endTime: row.time,
      value: { id: `temperature-gap:${JSON.stringify([previous.id, row.id])}`, start: previous.recordedAt, end: row.recordedAt, durationMinutes: (row.time - previous.time) / 60000, leftReadingId: previous.id, rightReadingId: row.id },
    });
    if (row.temperatureC > config.abnormalAboveC) {
      if (startIndex === null) startIndex = index;
    } else if (startIndex !== null) {
      runs.push({ startIndex, endIndex: index }); startIndex = null;
    }
  });
  if (startIndex !== null) runs.push({ startIndex, endIndex: null });

  const result: TemperatureAnalysis = { abnormalIntervals: [], briefSpikes: [], dataGaps: gaps.map((gap) => gap.value) };
  let gapCursor = 0;
  for (const run of runs) {
    const first = rows[run.startIndex], lastObserved = rows[run.endIndex ?? rows.length - 1];
    const lastAbnormal = rows[run.endIndex === null ? rows.length - 1 : run.endIndex - 1];
    // Inclusive contact is deliberate: a gap ending at the first abnormal or
    // starting at the closing normal sample is adjacent, not silently ignored.
    while (gapCursor < gaps.length && gaps[gapCursor].endTime < first.time) gapCursor++;
    const linked: DataGap[] = [];
    for (let index = gapCursor; index < gaps.length && gaps[index].startTime <= lastObserved.time; index++) linked.push(gaps[index].value);
    const durationMs = lastObserved.time - first.time;
    const base: TemperatureRun = {
      id: `temperature-run:${JSON.stringify([first.id])}`,
      start: first.recordedAt, end: run.endIndex === null ? null : lastObserved.recordedAt,
      observedUntil: lastObserved.recordedAt, durationMinutes: durationMs / 60000, ongoing: run.endIndex === null,
      startReadingId: first.id, lastAbnormalReadingId: lastAbnormal.id, endReadingId: run.endIndex === null ? null : lastObserved.id,
      dataGapUncertainty: linked.length > 0, gapIds: linked.map((gap) => gap.id),
      reviewQuestions: linked.map((gap) => ({ code: "temperature_data_gap", gapId: gap.id, text: `Readings missing between ${gap.start} and ${gap.end}; the true start/end may differ.`, sourceReadingIds: [gap.leftReadingId, gap.rightReadingId] })),
    };
    if (durationMs >= config.minAbnormalMinutes * 60000) result.abnormalIntervals.push({ ...base, kind: "abnormal_interval" });
    else result.briefSpikes.push({ ...base, kind: "brief_spike", label: "Brief spike alert", provisional: run.endIndex === null });
  }
  return result;
}
