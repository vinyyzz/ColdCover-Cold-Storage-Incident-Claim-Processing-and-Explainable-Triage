import type { ExposureBatchInput, IntervalBatchExposure, TemperatureAnalysis, TemperatureReading, TemperatureRuleSettings } from "../rules";

export interface AnalysisInputs {
  chamberId: "CH-1";
  ruleVersion: string;
  settings: TemperatureRuleSettings;
  readings: TemperatureReading[];
  batches: ExposureBatchInput[];
}

export interface AnalysisSnapshot {
  inputs: AnalysisInputs;
  temperature: TemperatureAnalysis;
  exposures: IntervalBatchExposure[];
  reconciliation: {
    previousAnalysisId: string | null;
    createdIncidentIds: string[];
    reusedIncidentIds: string[];
    /** Retained as history, not members of this revision. No documents moved. */
    retainedPreviousIncidentIds: string[];
  };
}

export class AnalysisError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "AnalysisError";
  }
}
