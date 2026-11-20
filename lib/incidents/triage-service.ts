import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { RULE_VERSION } from "../analysis/service";
import type { AnalysisSnapshot } from "../analysis/types";
import type { Database } from "../db/client";
import { equipment, policies, thresholds } from "../db/schema";
import { demonstrationPolicy } from "../demo/policy";
import { verifyStoredExtraction } from "../documents/extract";
import { analyzeTemperature } from "../rules/temperature";
import { calculateBatchExposure, inrToPaise } from "../rules/exposure";
import { evaluateTriage } from "../rules/triage";
import type { TriageDocumentInput } from "../rules/triage-types";
import type { IncidentDetail, IncidentTriage, RevisionReference } from "./types";

const text = z.string().trim().min(1);
const policySchema = z.object({ id: text, name: text, machineryBreakdownCoverRequired: z.boolean(), recordsRequiredText: text, notes: text, wording: text, demonstrationLabel: text });
const unavailable = (code: string, reason: string): IncidentTriage => ({ status: "unavailable", code, reason });

/** Unqueued, read-only: the incident reader owns serialization and transaction. */
export async function readIncidentTriage(db: Pick<Database, "select">, context: Pick<IncidentDetail, "checkedAt" | "incident" | "documents" | "documentCorrections" | "revisions"> & { selected: RevisionReference; snapshot: AnalysisSnapshot; sourceFingerprint: string }): Promise<IncidentTriage> {
  const { snapshot, selected } = context;
  if (snapshot.inputs.ruleVersion !== RULE_VERSION) return unavailable("RULE_VERSION_UNSUPPORTED", "The selected saved analysis uses unsupported rule criteria. Its evidence is preserved; triage is withheld.");
  const hash = createHash("sha256").update(JSON.stringify(snapshot.inputs)).digest("hex");
  const temporal = analyzeTemperature(snapshot.inputs.readings, snapshot.inputs.settings);
  const exposures = calculateBatchExposure(temporal.abnormalIntervals, snapshot.inputs.batches);
  if (hash !== context.sourceFingerprint || !isDeepStrictEqual(temporal, snapshot.temperature) || !isDeepStrictEqual(exposures, snapshot.exposures)) throw new Error("Saved analysis sources and results could not be verified for triage");

  const units = await db.select().from(equipment).where(eq(equipment.chamberId, "CH-1"));
  const [config] = await db.select().from(thresholds).where(eq(thresholds.id, 1));
  const highExposureThresholdPaise = config ? inrToPaise(config.highExposureThresholdInr) : undefined;
  if (units.length !== 1 || !z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/).safeParse(units[0]?.equipmentCode).success || highExposureThresholdPaise === undefined || highExposureThresholdPaise / 100 !== config!.highExposureThresholdInr) return unavailable("REVIEW_CRITERIA_UNAVAILABLE", "Current equipment or high-exposure criteria could not be verified. Review criteria and refresh before using triage.");
  const [storedPolicy] = await db.select().from(policies).where(eq(policies.id, demonstrationPolicy.id));
  const policy = storedPolicy ? policySchema.safeParse(storedPolicy) : null;
  if (policy && !policy.success) return unavailable("POLICY_UNVERIFIED", "Stored demonstration policy details could not be verified. Triage is withheld until they can be reviewed.");

  const reports: TriageDocumentInput[] = [];
  for (const doc of context.documents) {
    if (doc.docType !== "maintenance_report" && doc.docType !== "stock_inspection_report") continue;
    const original = doc.extractionSource === "fallback" ? verifyStoredExtraction(doc.rawText, doc.id, context.incident.id, doc.extractionJson) : null;
    if (!original || !context.revisions.some((row) => row.analysisId === original.association.analysisId)) return unavailable("REPORT_ASSOCIATION_UNVERIFIED", "A report's original extraction or explicit analysis association could not be verified. Inspect the original reports; triage is withheld.");
    reports.push({ id: doc.id, incidentId: doc.incidentId, associationAnalysisId: original.association.analysisId, docType: doc.docType, rawText: doc.rawText, extractionSource: "fallback", extractionJson: original, corrections: context.documentCorrections[doc.id] });
  }
  const criteria = { basis: "current_records" as const, settingsId: String(config!.id), highExposureThresholdPaise, equipment: { id: units[0].id, code: units[0].equipmentCode }, policy: policy?.success ? policy.data : null };
  const result = evaluateTriage({ incidentId: context.incident.id, selectedAnalysisId: selected.analysisId, linkedAnalyses: context.revisions.map((row) => ({ id: row.analysisId, revision: row.revision })), intervalId: selected.intervalId, equipment: criteria.equipment, settingsId: criteria.settingsId, settings: snapshot.inputs.settings, highExposureThresholdPaise, readings: snapshot.inputs.readings, batches: snapshot.inputs.batches, documents: reports, stockRecords: [], policyId: criteria.policy?.id ?? null });
  return { status: "available", checkedAt: context.checkedAt, evidenceMembership: selected.membership, criteria, result };
}
