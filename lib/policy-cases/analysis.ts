import { analyzeTemperature, calculateBatchExposure, type ExposureBatchInput, type TemperatureReading } from "../rules";
import { toIstIso } from "../inventory/format";
import { schedules, type ScheduleId } from "./catalogue";

export type ScheduledBatch = ExposureBatchInput & { scheduleId: ScheduleId };
export const MAX_CASE_READINGS = 2_000;

// Each temperature direction has its own start and closing observation.
// Negation lets the same deterministic detector handle below-band readings.
export function analyzeSchedules(readings: readonly TemperatureReading[], batches: readonly ScheduledBatch[]) {
  return Array.from(new Set(batches.map((batch) => batch.scheduleId))).sort().map((id) => {
    const schedule = schedules[id];
    const input = batches.filter((batch) => batch.scheduleId === id);
    const settings = { minAbnormalMinutes: schedule.minMinutes, maxGapMinutes: schedule.maxGapMinutes };
    const warm = analyzeTemperature(readings, { ...settings, abnormalAboveC: schedule.maxC });
    const cold = analyzeTemperature(readings.map((row) => ({ ...row, temperatureC: -row.temperatureC })), {
      ...settings, abnormalAboveC: -schedule.minC,
    });
    const runs = ([{ direction: "Above band", ...warm }, { direction: "Below band", ...cold }] as const)
      .flatMap(({ direction, abnormalIntervals, briefSpikes }) =>
        [...abnormalIntervals, ...briefSpikes].map((run) => ({ ...run, direction })))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const gaps = warm.dataGaps;
    return {
      id, schedule, gaps,
      runs: runs.map((run) => {
        // A case with a finite supplied log cannot establish overlap beyond
        // its latest observation. Keep the open endpoint visible separately.
        const cap = run.end ?? toIstIso(run.observedUntil);
        const exposure = run.kind === "abnormal_interval"
          ? calculateBatchExposure([{ ...run, end: cap }], input)[0] : null;
        return { ...run, exposure };
      }),
    };
  });
}
