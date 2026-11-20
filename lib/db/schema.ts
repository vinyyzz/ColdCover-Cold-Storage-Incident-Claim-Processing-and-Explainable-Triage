import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { AnalysisSnapshot } from "../analysis/types";
import type { CorrectionInput } from "../documents/corrections";
import type { ExtractedFacts } from "../documents/contract";
import type { CopyInput, SourceSnapshot } from "../documents/copy-contract";
import type { OperationInput, OperationReceipt, ResetSnapshot } from "../reset/contract";

export const chambers = sqliteTable("chambers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  commodity: text("commodity", { enum: ["potatoes"] }).notNull(),
  normalMinC: real("normal_min_c").notNull(),
  normalMaxC: real("normal_max_c").notNull(),
}, (t) => [
  check("chamber_temperature_range", sql`${t.normalMinC} <= ${t.normalMaxC}`),
  check("chamber_commodity", sql`${t.commodity} = 'potatoes'`),
]);

export const equipment = sqliteTable("equipment", {
  id: text("id").primaryKey(),
  chamberId: text("chamber_id").notNull().references(() => chambers.id),
  equipmentCode: text("equipment_code").notNull().unique(),
  description: text("description").notNull(),
});

export const batches = sqliteTable("batches", {
  id: text("id").primaryKey(),
  batchCode: text("batch_code").notNull().unique(),
  ownerName: text("owner_name").notNull(),
  chamberId: text("chamber_id").notNull().references(() => chambers.id),
  quantityKg: real("quantity_kg").notNull(),
  recordedValueInr: real("recorded_value_inr"),
  enteredAt: text("entered_at").notNull(),
  exitedAt: text("exited_at"),
}, (t) => [
  index("batch_chamber_entry_idx").on(t.chamberId, t.enteredAt),
  check("batch_positive_quantity", sql`${t.quantityKg} > 0`),
  check("batch_nonnegative_value", sql`${t.recordedValueInr} IS NULL OR ${t.recordedValueInr} >= 0`),
  check("batch_storage_order", sql`${t.exitedAt} IS NULL OR julianday(${t.exitedAt}) >= julianday(${t.enteredAt})`),
]);

export const scenarios = sqliteTable("scenarios", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  expectedJson: text("expected_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
});

export const temperatureReadings = sqliteTable("temperature_readings", {
  id: text("id").primaryKey(),
  chamberId: text("chamber_id").notNull().references(() => chambers.id),
  scenarioId: text("scenario_id").references(() => scenarios.id),
  recordedAt: text("recorded_at").notNull(),
  temperatureC: real("temperature_c").notNull(),
}, (t) => [
  uniqueIndex("temperature_chamber_timestamp_idx").on(t.chamberId, t.recordedAt),
]);

export const thresholds = sqliteTable("thresholds", {
  id: integer("id").primaryKey().default(1),
  abnormalAboveC: real("abnormal_above_c").notNull().default(5),
  minAbnormalMinutes: integer("min_abnormal_minutes").notNull().default(30),
  maxGapMinutes: integer("max_gap_minutes").notNull().default(30),
  expectedIntervalMinutes: integer("expected_interval_minutes").notNull().default(10),
  highExposureThresholdInr: real("high_exposure_threshold_inr").notNull().default(150000),
}, (t) => [
  check("threshold_singleton", sql`${t.id} = 1`),
  check("threshold_positive_durations", sql`${t.minAbnormalMinutes} > 0 AND ${t.maxGapMinutes} > 0 AND ${t.expectedIntervalMinutes} > 0`),
  check("threshold_nonnegative_exposure", sql`${t.highExposureThresholdInr} >= 0`),
]);

export const incidents = sqliteTable("incidents", {
  id: text("id").primaryKey(),
  chamberId: text("chamber_id").notNull().references(() => chambers.id),
  title: text("title").notNull(),
  status: text("status", { enum: ["draft", "claim_prepared", "submitted", "under_review", "decided"] }).notNull().default("draft"),
  // A draft may hold source documents before interval analysis has run.
  abnormalStart: text("abnormal_start"),
  abnormalEnd: text("abnormal_end"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("incident_chamber_idx").on(t.chamberId),
  check("incident_status", sql`${t.status} IN ('draft','claim_prepared','submitted','under_review','decided')`),
  check("incident_interval_order", sql`${t.abnormalEnd} IS NULL OR (${t.abnormalStart} IS NOT NULL AND julianday(${t.abnormalEnd}) >= julianday(${t.abnormalStart}))`),
]);

export const incidentEvents = sqliteTable("incident_events", {
  id: text("id").primaryKey(),
  incidentId: text("incident_id").notNull().references(() => incidents.id),
  occurredAt: text("occurred_at").notNull(),
  eventType: text("event_type", { enum: ["abnormal_start", "abnormal_end", "equipment_fault", "repair", "restart", "inspection", "document_uploaded", "data_gap"] }).notNull(),
  description: text("description").notNull(),
  sourceType: text("source_type").notNull(),
  sourceRef: text("source_ref").notNull(),
}, (t) => [
  index("incident_event_time_idx").on(t.incidentId, t.occurredAt),
  check("event_type", sql`${t.eventType} IN ('abnormal_start','abnormal_end','equipment_fault','repair','restart','inspection','document_uploaded','data_gap')`),
]);

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  incidentId: text("incident_id").notNull().references(() => incidents.id),
  docType: text("doc_type", { enum: ["maintenance_report", "stock_inspection_report", "invoice", "other"] }).notNull(),
  filename: text("filename").notNull(),
  rawText: text("raw_text").notNull(),
  uploadedAt: text("uploaded_at").notNull(),
  extractionJson: text("extraction_json", { mode: "json" }).$type<Record<string, unknown>>(),
  extractionSource: text("extraction_source", { enum: ["ai", "fallback"] }),
}, (t) => [
  index("document_incident_idx").on(t.incidentId),
  check("document_type", sql`${t.docType} IN ('maintenance_report','stock_inspection_report','invoice','other')`),
  check("document_extraction_source", sql`${t.extractionSource} IS NULL OR ${t.extractionSource} IN ('ai','fallback')`),
]);

export const policies = sqliteTable("policies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  machineryBreakdownCoverRequired: integer("machinery_breakdown_cover_required", { mode: "boolean" }).notNull(),
  recordsRequiredText: text("records_required_text").notNull(),
  notes: text("notes").notNull(),
  wording: text("wording").notNull(),
  demonstrationLabel: text("demonstration_label").notNull(),
}, (t) => [check("policy_cover_boolean", sql`${t.machineryBreakdownCoverRequired} IN (0,1)`)]);

export const claims = sqliteTable("claims", {
  id: text("id").primaryKey(),
  incidentId: text("incident_id").notNull().references(() => incidents.id),
  policyId: text("policy_id").notNull().references(() => policies.id),
  readiness: text("readiness", { enum: ["Needs more evidence", "Ready for initial review"] }).notNull(),
  priority: text("priority", { enum: ["Specialist review required", "High priority", "Standard priority"] }).notNull(),
  triageReasonsJson: text("triage_reasons_json", { mode: "json" }).$type<Record<string, unknown>[]>().notNull(),
  exposureValueInr: real("exposure_value_inr").notNull(),
  summaryJson: text("summary_json", { mode: "json" }).$type<{ text: string; source_ids: string[] }[]>().notNull(),
  missingEvidenceJson: text("missing_evidence_json", { mode: "json" }).$type<Record<string, unknown>[]>().notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("claim_incident_idx").on(t.incidentId),
  check("claim_readiness", sql`${t.readiness} IN ('Needs more evidence','Ready for initial review')`),
  check("claim_priority", sql`${t.priority} IN ('Specialist review required','High priority','Standard priority')`),
  check("claim_nonnegative_exposure", sql`${t.exposureValueInr} >= 0`),
]);

export const reviewDecisions = sqliteTable("review_decisions", {
  id: text("id").primaryKey(),
  claimId: text("claim_id").notNull().references(() => claims.id),
  reviewerName: text("reviewer_name").notNull(),
  status: text("status", { enum: ["approved_for_assessment", "needs_more_info", "referred_to_specialist", "closed"] }).notNull(),
  comment: text("comment").notNull(),
  decidedAt: text("decided_at").notNull(),
}, (t) => [
  index("review_claim_idx").on(t.claimId),
  check("review_status", sql`${t.status} IN ('approved_for_assessment','needs_more_info','referred_to_specialist','closed')`),
]);

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  at: text("at").notNull(),
  detail: text("detail").notNull(),
}, (t) => [index("audit_entity_idx").on(t.entity, t.entityId)]);

// Append-only evidence revisions. Highest chamber revision is the latest
// candidate, whose fingerprint must be checked against current source records.
export const analysisRuns = sqliteTable("analysis_runs", {
  id: text("id").primaryKey(),
  chamberId: text("chamber_id").notNull().references(() => chambers.id),
  revision: integer("revision").notNull(),
  sourceFingerprint: text("source_fingerprint").notNull(),
  snapshotJson: text("snapshot_json", { mode: "json" }).$type<AnalysisSnapshot>().notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("analysis_chamber_revision_idx").on(t.chamberId, t.revision),
  check("analysis_positive_revision", sql`${t.revision} > 0`),
]);

export const analysisIncidentLinks = sqliteTable("analysis_incident_links", {
  id: text("id").primaryKey(),
  analysisId: text("analysis_id").notNull().references(() => analysisRuns.id),
  intervalId: text("interval_id").notNull(),
  incidentId: text("incident_id").notNull().references(() => incidents.id),
  evidenceFingerprint: text("evidence_fingerprint").notNull(),
}, (t) => [
  uniqueIndex("analysis_interval_idx").on(t.analysisId, t.intervalId),
  index("analysis_link_incident_idx").on(t.incidentId),
]);

export const documentCorrections = sqliteTable("document_corrections", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => documents.id),
  revision: integer("revision").notNull(),
  previousCorrectionId: text("previous_correction_id").references((): AnySQLiteColumn => documentCorrections.id),
  analysisId: text("analysis_id").notNull().references(() => analysisRuns.id),
  originalFingerprint: text("original_fingerprint").notNull(),
  requestJson: text("request_json", { mode: "json" }).$type<CorrectionInput>().notNull(),
  extractionJson: text("extraction_json", { mode: "json" }).$type<ExtractedFacts>().notNull(),
  actor: text("actor", { enum: ["storage_operator"] }).notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("document_correction_revision_idx").on(t.documentId, t.revision),
  check("document_correction_chain", sql`(${t.revision} = 1 AND ${t.previousCorrectionId} IS NULL) OR (${t.revision} > 1 AND ${t.previousCorrectionId} IS NOT NULL)`),
  check("document_correction_actor", sql`${t.actor} = 'storage_operator'`),
]);

export const documentCopies = sqliteTable("document_copies", {
  documentId: text("document_id").primaryKey().references(() => documents.id),
  sourceDocumentId: text("source_document_id").notNull().references(() => documents.id),
  sourceIncidentId: text("source_incident_id").notNull().references(() => incidents.id),
  sourceCorrectionId: text("source_correction_id").references(() => documentCorrections.id),
  sourceCorrectionRevision: integer("source_correction_revision").notNull(),
  analysisId: text("analysis_id").notNull().references(() => analysisRuns.id),
  requestJson: text("request_json", { mode: "json" }).$type<CopyInput>().notNull(),
  sourceSnapshotJson: text("source_snapshot_json", { mode: "json" }).$type<SourceSnapshot>().notNull(),
  actor: text("actor", { enum: ["storage_operator"] }).notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  check("document_copy_distinct_source", sql`${t.documentId} != ${t.sourceDocumentId}`),
  check("document_copy_source_revision", sql`(${t.sourceCorrectionId} IS NULL AND ${t.sourceCorrectionRevision} = 0) OR (${t.sourceCorrectionId} IS NOT NULL AND ${t.sourceCorrectionRevision} > 0)`),
  check("document_copy_actor", sql`${t.actor} = 'storage_operator'`),
]);

// Disposable validated AI results. Never source evidence or claim snapshots.
export const aiResultCache = sqliteTable("ai_result_cache", {
  key: text("cache_key").primaryKey(),
  inputFingerprint: text("input_fingerprint").notNull(),
  boundaryVersion: text("boundary_version").notNull(),
  task: text("task", { enum: ["extraction", "summary", "questions"] }).notNull(),
  adapterRevision: text("adapter_revision").notNull(),
  outputJson: text("output_json", { mode: "json" }).$type<unknown>().notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  check("ai_cache_key_length", sql`length(${t.key}) = 64 AND length(${t.inputFingerprint}) = 64`),
  check("ai_cache_task", sql`${t.task} IN ('extraction','summary','questions')`),
]);

// Administrative archives/receipts survive both reset and restoration.
export const demoBackups = sqliteTable("demo_backups", {
  id: text("id").primaryKey(), sequence: integer("sequence").notNull().unique(),
  action: text("action", { enum: ["reset", "restore"] }).notNull(), createdAt: text("created_at").notNull(),
  schemaFingerprint: text("schema_fingerprint").notNull(), snapshotHash: text("snapshot_hash").notNull(),
  snapshotJson: text("snapshot_json", { mode: "json" }).$type<ResetSnapshot>().notNull(),
  countsJson: text("counts_json", { mode: "json" }).$type<Record<string, number>>().notNull(),
}, (t) => [
  check("demo_backup_sequence", sql`${t.sequence} > 0`),
  check("demo_backup_action", sql`${t.action} IN ('reset','restore')`),
  check("demo_backup_hashes", sql`length(${t.schemaFingerprint}) = 64 AND length(${t.snapshotHash}) = 64`),
]);
export const demoOperations = sqliteTable("demo_operations", {
  requestId: text("request_id").primaryKey(),
  action: text("action", { enum: ["reset", "restore"] }).notNull(),
  backupId: text("backup_id").notNull().references(() => demoBackups.id),
  restoredFrom: text("restored_from").references(() => demoBackups.id),
  requestJson: text("request_json", { mode: "json" }).$type<OperationInput>().notNull(),
  receiptJson: text("receipt_json", { mode: "json" }).$type<OperationReceipt>().notNull(), createdAt: text("created_at").notNull(),
}, (t) => [check("demo_operation_kind", sql`(${t.action} = 'reset' AND ${t.restoredFrom} IS NULL) OR (${t.action} = 'restore' AND ${t.restoredFrom} IS NOT NULL)`)]);

// Immutable prepared evidence. Legacy claims deliberately have no backfilled packet.
export const claimPackets = sqliteTable("claim_packets", {
  claimId: text("claim_id").primaryKey().references(() => claims.id),
  requestId: text("request_id").notNull().unique(),
  requestJson: text("request_json", { mode: "json" }).$type<import("../claims/contract").PrepareInput>().notNull(),
  analysisId: text("analysis_id").notNull().references(() => analysisRuns.id),
  preparedAt: text("prepared_at").notNull(),
  packetJson: text("packet_json", { mode: "json" }).$type<import("../claims/contract").FrozenPacket>().notNull(),
  packetHash: text("packet_hash").notNull(),
}, (t) => [check("claim_packet_hash", sql`length(${t.packetHash}) = 64`)]);

// Additive tables leave v1 potato analysis and frozen claim source layouts intact.
export const batchPolicySchedules = sqliteTable("batch_policy_schedules", {
  batchId: text("batch_id").primaryKey().references(() => batches.id),
  scheduleId: text("schedule_id").notNull(),
  assignedAt: text("assigned_at").notNull(),
});

export const policyCasePackets = sqliteTable("policy_case_packets", {
  id: text("id").primaryKey(),
  preparedAt: text("prepared_at").notNull(),
  policyId: text("policy_id").notNull(),
  title: text("title").notNull(),
  requestHash: text("request_hash").notNull(),
  packetHash: text("packet_hash").notNull(),
  snapshot: text("snapshot_json", { mode: "json" }).$type<unknown>().notNull(),
}, (t) => [
  check("policy_case_hashes", sql`length(${t.requestHash}) = 64 AND length(${t.packetHash}) = 64`),
  index("policy_case_prepared_idx").on(t.preparedAt, t.id),
]);

export const policyCaseReviews = sqliteTable("policy_case_reviews", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull().references(() => policyCasePackets.id),
  recordedAt: text("recorded_at").notNull(),
  revision: integer("revision").notNull(),
  decision: text("decision").notNull(),
  reviewer: text("reviewer").notNull(),
  comment: text("comment").notNull(),
}, (t) => [uniqueIndex("policy_case_review_revision_idx").on(t.caseId, t.revision)]);
