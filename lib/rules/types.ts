export interface TemperatureReading {
  id: string;
  recordedAt: string;
  temperatureC: number;
}
export interface TemperatureRuleSettings {
  abnormalAboveC: number;
  minAbnormalMinutes: number;
  maxGapMinutes: number;
}
export interface DataGap {
  id: string;
  start: string;
  end: string;
  durationMinutes: number;
  leftReadingId: string;
  rightReadingId: string;
}
export interface GapReviewQuestion {
  code: "temperature_data_gap";
  gapId: string;
  text: string;
  sourceReadingIds: [string, string];
}
export interface TemperatureRun {
  /** Opaque deterministic reference anchored to the first abnormal source ID. */
  id: string;
  start: string;
  end: string | null;
  observedUntil: string;
  /** Endpoint span, not proof of uninterrupted abnormal conditions in gaps. */
  durationMinutes: number;
  ongoing: boolean;
  startReadingId: string;
  lastAbnormalReadingId: string;
  endReadingId: string | null;
  dataGapUncertainty: boolean;
  gapIds: string[];
  reviewQuestions: GapReviewQuestion[];
}
export interface AbnormalInterval extends TemperatureRun { kind: "abnormal_interval" }
export interface BriefSpike extends TemperatureRun {
  kind: "brief_spike";
  label: "Brief spike alert";
  provisional: boolean;
}
export interface TemperatureAnalysis {
  abnormalIntervals: AbnormalInterval[];
  briefSpikes: BriefSpike[];
  dataGaps: DataGap[];
}

export type ExposureIntervalInput = Pick<AbnormalInterval, "id" | "kind" | "start" | "end">;
export interface ExposureBatchInput {
  id: string;
  batchCode: string;
  ownerName: string;
  quantityKg: number;
  recordedValueInr: number | null;
  enteredAt: string;
  exitedAt: string | null;
}
export type BatchPresence = "present_throughout" | "present_partially" | "not_present";
export type BatchPresenceReason = "covers_recorded_interval" | "stored_at_start_without_exit" | "entered_during_interval" | "left_during_interval" | "entered_and_left_during_interval" | "left_at_or_before_start" | "entered_at_or_after_end" | "empty_storage_period";
export interface BatchExposure extends ExposureBatchInput {
  batchId: string;
  classification: BatchPresence;
  reasonCode: BatchPresenceReason;
  reason: string;
  overlapStart: string | null;
  overlapEnd: string | null;
  recordedValuePaise: number | null;
}
export interface IntervalBatchExposure {
  intervalId: string;
  start: string;
  end: string | null;
  label: "Inventory value under investigation";
  batches: BatchExposure[];
  /** Known recorded subtotal only; missing valuations are not assigned zero. */
  knownValueSubtotalInr: number;
  /** Exact decimal currency text, including cents near numeric display limits. */
  knownValueSubtotalInrExact: string;
  /** Exact safe integer; authoritative for subsequent monetary comparisons. */
  knownValueSubtotalPaise: number;
  valuationComplete: boolean;
  missingValuationBatchIds: string[];
}
