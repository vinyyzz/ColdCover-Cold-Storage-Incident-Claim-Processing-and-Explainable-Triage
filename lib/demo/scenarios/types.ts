export type ScenarioCategory = "normal" | "standard_incident" | "brief_spike" | "missing_readings" | "conflicting_evidence" | "ongoing" | "stock_timing" | "missing_evidence" | "high_exposure" | "multiple_events" | "boundary";
export type Readiness = "Needs more evidence" | "Ready for initial review";
export type Priority = "Specialist review required" | "High priority" | "Standard priority";

export interface ScenarioBatch {
  id: string;
  batchCode: string;
  ownerName: string;
  chamberId: string;
  quantityKg: number;
  recordedValueInr: number | null;
  enteredAt: string;
  exitedAt: string | null;
}

export interface ScenarioReading {
  id: string;
  chamberId: string;
  scenarioId: string;
  recordedAt: string;
  temperatureC: number;
}

export interface ScenarioDocument {
  id: string;
  docType: "maintenance_report" | "stock_inspection_report";
  rawText: string;
  filename: string;
  // Zero-based expected investigation window; simulator assigns real incident IDs.
  intervalIndex: number;
}

export interface ExpectedInterval {
  start: string;
  end: string | null;
  presentThroughout: string[];
  presentPartially: string[];
  notPresent: string[];
  exposureValueInr: number;
  valuationComplete: boolean;
  readiness: Readiness;
  priority: Priority;
  dataGapUncertainty: boolean;
  keyReasons: string[];
}

export interface ScenarioExpected {
  abnormalIntervals: ExpectedInterval[];
  briefSpikes: { start: string; end: string | null; durationMinutes: number }[];
  dataGaps: { start: string; end: string }[];
}

export interface ScenarioFixture {
  number: number;
  id: string;
  name: string;
  category: ScenarioCategory;
  description: string;
  batches: ScenarioBatch[];
  readings: ScenarioReading[];
  documents: ScenarioDocument[];
  expected: ScenarioExpected;
}
