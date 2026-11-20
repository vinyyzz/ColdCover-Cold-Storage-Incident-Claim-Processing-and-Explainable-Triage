import { describe, expect, it } from "vitest";
import { getScenario } from "../demo/scenarios/catalog";
import { extractDocument } from "../documents/extract";
import { applyCorrection, correctionInputSchema } from "../documents/corrections";
import type { ExtractionField, StoredExtraction } from "../documents/contract";
import { evaluateTriage } from "./triage";
import { analyzeTemperature } from "./temperature";
import type { TriageDocumentInput, TriageInput, TriageResult } from "./triage-types";

const settings = { abnormalAboveC: 5, minAbnormalMinutes: 30, maxGapMinutes: 30 };
const stamp = (time: string) => `2026-03-10T${time}+05:30`;
const reportText = (changes: { equipment?: string; cause?: string; repair?: string | null; restart?: string | null } = {}) => [
  `Equipment ID: ${changes.equipment ?? "REF-01"}`,
  `Reported cause: ${changes.cause ?? "compressor fault"}`,
  changes.repair === null ? "" : `Repair completed: ${changes.repair ?? stamp("05:00:00")}`,
  changes.restart === null ? "" : `Refrigeration restarted: ${changes.restart ?? stamp("05:10:00")}`,
].filter(Boolean).join("\n");
function document(rawText = reportText(), id = "maintenance", docType: TriageDocumentInput["docType"] = "maintenance_report", analysisId = "analysis-1"): TriageDocumentInput {
  return { id, incidentId: "incident", associationAnalysisId: analysisId, docType, rawText, extractionSource: "fallback", extractionJson: extractDocument(rawText, id, { method: "operator_selected", incidentId: "incident", analysisId }), corrections: { latestCorrectionId: null, selectedCorrectionId: null, history: [] } };
}
function input(): TriageInput {
  const fixture = getScenario("worked-example")!;
  return { incidentId: "incident", selectedAnalysisId: "analysis-1", linkedAnalyses: [{ id: "analysis-1", revision: 1 }], intervalId: analyzeTemperature(fixture.readings, settings).abnormalIntervals[0].id, equipment: { id: "equipment", code: "REF-01" }, settingsId: "thresholds", settings: { ...settings }, highExposureThresholdPaise: 15_000_000, readings: fixture.readings, batches: fixture.batches, documents: [document(), document(`Inspection date: ${stamp("08:00:00")}\nStock condition: separate assessment required`, "inspection", "stock_inspection_report")], stockRecords: [], policyId: null };
}
const checklist = (result: TriageResult, id: string) => result.checklist.find((item) => item.id === id)!;
function correct(doc: TriageDocumentInput, field: ExtractionField, value: string | null, quote = "", analysisRevision = 1) {
  const revision = doc.corrections.history.length + 1;
  const requestId = `00000000-0000-4000-8000-${String(revision).padStart(12, "0")}`;
  const start = doc.rawText.indexOf(quote);
  const change = correctionInputSchema.parse({ requestId, analysisId: `analysis-${analysisRevision}`, expectedCorrectionId: doc.corrections.latestCorrectionId, reason: "Fictional operator source review.", change: { field, value, evidence_quotes: value === null ? [] : [{ field, value, quote, start, end: start + quote.length, source_document_id: doc.id }], supportConfirmed: true } });
  const previous = doc.corrections.history.at(-1)?.extraction ?? (doc.extractionJson as StoredExtraction).extraction;
  const id = `correction-${requestId}`;
  doc.corrections.history.push({ id, documentId: doc.id, revision, previousCorrectionId: doc.corrections.latestCorrectionId, analysisId: change.analysisId, analysisRevision, createdAt: stamp("09:00:00"), actor: "storage_operator", input: change, extraction: applyCorrection(doc.rawText, doc.id, previous, change) });
  doc.corrections.latestCorrectionId = id; doc.corrections.selectedCorrectionId = id;
}

describe("Readiness and six independent evidence checklist categories", () => {
  it("uses the worked example's actual readings/batches and explicitly associated maintenance source", () => {
    const data = input(), fixture = getScenario("worked-example")!;
    data.documents = [document(fixture.documents[0].rawText)];
    const result = evaluateTriage(data);
    expect(result.readiness.status).toBe("Needs more evidence");
    expect(result.readiness.reasons.map((row) => row.code)).toEqual(["missing_stock_inspection_report"]);
    expect(result.priority.status).toBe("Standard priority");
    expect(checklist(result, "batch_valuations")).toMatchObject({ status: "provided", batchIds: fixture.batches.slice(0, 2).map((row) => row.id) });
  });
  it("keeps missing policy and stock records separate from the three readiness gates", () => {
    const result = evaluateTriage(input());
    expect(result.readiness.status).toBe("Ready for initial review");
    expect(result.checklist.map((item) => [item.id, item.status])).toEqual([["maintenance_report", "provided"], ["stock_inspection_report", "provided"], ["batch_valuations", "provided"], ["stock_records", "missing"], ["temperature_log_coverage", "provided"], ["policy_details", "missing"]]);
    expect(result.questions.filter((q) => q.checklistId).map((q) => q.checklistId)).toEqual(["stock_records", "policy_details"]);
  });
  it("reports each missing readiness item and a source-linked template question", () => {
    const data = input(); data.documents = []; data.batches = data.batches.map((row) => ({ ...row, recordedValueInr: null }));
    const result = evaluateTriage(data);
    expect(result.readiness.reasons.map((row) => row.code)).toEqual(["missing_maintenance_report", "missing_stock_inspection_report", "missing_batch_valuations"]);
    for (const item of result.checklist.filter((row) => row.status === "missing")) expect(result.questions.find((q) => q.checklistId === item.id)?.sources.length).toBeGreaterThan(0);
  });
  it("treats known zero as provided and ignores absent missing values", () => {
    const data = input(); data.batches = data.batches.map((row, i) => ({ ...row, recordedValueInr: i === 2 ? null : 0 }));
    expect(evaluateTriage(data).readiness.status).toBe("Ready for initial review");
  });
  it("does not require valuations or stock records when no supplied batch overlaps", () => {
    const data = input(); data.batches = [];
    const result = evaluateTriage(data);
    expect(checklist(result, "batch_valuations").status).toBe("not_applicable");
    expect(checklist(result, "stock_records").status).toBe("not_applicable");
    expect(result.questions.some((q) => q.checklistId === "stock_records")).toBe(false);
    expect(result.readiness.status).toBe("Ready for initial review");
  });
  it("requires explicit supporting records for each exposed batch, not invoice-like prose", () => {
    const data = input(); const [a, b, c] = data.batches;
    data.stockRecords = [{ documentId: "invoice-a", batchIds: [a.id, c.id] }]; data.policyId = "demo-policy";
    let result = evaluateTriage(data);
    expect(checklist(result, "stock_records")).toMatchObject({ status: "missing", batchIds: [b.id] });
    expect(checklist(result, "policy_details")).toMatchObject({ status: "provided", sources: [{ type: "policy", id: "demo-policy" }] });
    data.stockRecords = [{ documentId: "invoice-ab", batchIds: [a.id, b.id] }]; result = evaluateTriage(data);
    expect(checklist(result, "stock_records").status).toBe("provided");
    expect(result.questions.some((q) => q.checklistId === "stock_records")).toBe(false);
  });
  it("counts an associated unextracted report as supplied but makes no extracted finding", () => {
    const data = input(); data.documents = [document("Reported cause: unknown\nEquipment ID: REF-02"), data.documents[1]].map((row) => ({ ...row, extractionSource: null, extractionJson: null }));
    const result = evaluateTriage(data);
    expect(result.readiness.status).toBe("Ready for initial review"); expect(result.conflicts).toEqual([]);
    expect(result.questions.map((q) => q.code)).toContain("cause_not_reported");
  });
});

describe("Ordered priority and actual-observation restart boundaries", () => {
  it.each([{ name: "below", value: 79_999.99, expected: "High priority" }, { name: "equal", value: 80_000, expected: "Standard priority" }, { name: "above", value: 80_000.01, expected: "Standard priority" }])("compares exact paise when threshold is $name the known subtotal", ({ value, expected }) => {
    const data = input(); data.highExposureThresholdPaise = Math.round(value * 100);
    expect(evaluateTriage(data).priority.status).toBe(expected);
  });
  it("keeps missing valuations incomplete while allowing a known subtotal to establish High priority", () => {
    const data = input(); data.batches = data.batches.map((row, i) => i === 1 ? { ...row, recordedValueInr: null } : row); data.highExposureThresholdPaise = 4_999_999;
    const result = evaluateTriage(data);
    expect(result.readiness.status).toBe("Needs more evidence"); expect(result.priority.status).toBe("High priority");
    expect(result.priority.reasons[0].text).toContain("incomplete");
  });
  it("does not treat a missing valuation as a low known total or a specialist finding", () => {
    const data = input(); data.batches = data.batches.map((row) => ({ ...row, recordedValueInr: null }));
    const result = evaluateTriage(data); expect(result.priority.status).toBe("Standard priority"); expect(result.priority.reasons[0].text).toContain("does not establish consistency or completeness");
  });
  it("marks an ongoing qualified interval High priority without consulting a wall clock", () => {
    const data = input(); data.readings = data.readings.filter((row) => Date.parse(row.recordedAt) <= Date.parse(stamp("05:30:00")));
    const result = evaluateTriage(data); expect(result.priority.status).toBe("High priority"); expect(result.priority.reasons[0].code).toBe("ongoing_interval");
  });
  it("Specialist wins over ongoing and high exposure, retaining every specialist trigger", () => {
    const data = input(); data.readings = data.readings.filter((row) => Date.parse(row.recordedAt) <= Date.parse(stamp("05:30:00"))); data.highExposureThresholdPaise = 0;
    data.documents = [document(reportText({ equipment: "REF-02", cause: "unknown", restart: stamp("04:00:00") })), data.documents[1]];
    const result = evaluateTriage(data);
    expect(result.priority.status).toBe("Specialist review required");
    expect(result.priority.reasons.map((row) => row.code)).toEqual(["equipment_mismatch", "restart_log_conflict", "cause_unclear"]);
    expect(result.readiness.status).toBe("Ready for initial review");
  });
  it("matches equipment codes ignoring letter case without replacing identifiers", () => {
    const data = input(); data.documents = [document(reportText({ equipment: "ref-01" })), data.documents[1]];
    expect(evaluateTriage(data).conflicts).toEqual([]);
  });
  it.each([
    { name: "exactly 60 minutes", restart: "04:30:00", conflict: false },
    { name: "60 minutes plus one millisecond", restart: "04:29:59.999", conflict: true },
    { name: "less than 60 minutes", restart: "04:30:00.001", conflict: false },
    { name: "60 minutes before closing normal, only 50 before actual high", restart: "04:40:00", conflict: false },
    { name: "after the last high", restart: "06:00:00", conflict: false },
  ])("uses $name", ({ restart, conflict }) => {
    const data = input(); data.documents = [document(reportText({ restart: stamp(restart) })), data.documents[1]];
    const result = evaluateTriage(data); expect(result.conflicts.some((row) => row.code === "restart_log_conflict")).toBe(conflict);
    if (conflict) { expect(result.conflicts[0].text).toContain("may take time to cool"); expect(result.conflicts[0].sources.some((row) => row.type === "reading" && row.id.endsWith("033"))).toBe(true); }
  });
  it("compares equivalent timestamp offsets and retains a fully dated earlier report", () => {
    const data = input(); data.documents = [document(reportText({ restart: "2026-03-09T22:30:00Z" })), data.documents[1]];
    expect(evaluateTriage(data).conflicts[0].code).toBe("restart_log_conflict");
    data.documents = [document(reportText({ restart: "2026-03-09T05:10:00+05:30" })), data.documents[1]];
    expect(evaluateTriage(data).conflicts[0].code).toBe("restart_log_conflict");
  });
  it("does not equate repair completion with restart", () => {
    const data = input(); data.documents = [document(reportText({ repair: stamp("03:00:00"), restart: null })), data.documents[1]];
    const result = evaluateTriage(data); expect(result.conflicts).toEqual([]); expect(result.questions.map((q) => q.code)).toContain("restart_not_reported");
  });
  it("ignores high readings in a later separate incident", () => {
    const data = input(); data.readings = data.readings.map((row) => Date.parse(row.recordedAt) >= Date.parse(stamp("12:00:00")) && Date.parse(row.recordedAt) < Date.parse(stamp("13:00:00")) ? { ...row, temperatureC: 8 } : row);
    expect(evaluateTriage(data).conflicts).toEqual([]);
  });
  it("evaluates each maintenance source without choosing a convenient report", () => {
    const data = input(); data.documents = [...data.documents, document(reportText({ restart: stamp("04:00:00") }), "earlier-report")];
    const result = evaluateTriage(data); expect(result.priority.status).toBe("Specialist review required");
    expect(result.questions.map((q) => q.code)).toContain("different_restart_times");
    expect(result.conflicts[0].sources.find((row) => row.type === "document")?.id).toBe("earlier-report");
  });
  it("does not use maintenance-like facts from an inspection report as maintenance findings", () => {
    const data = input(); data.documents = [data.documents[0], document(reportText({ equipment: "REF-02", cause: "unknown", restart: stamp("01:00:00") }), "inspection", "stock_inspection_report")];
    expect(evaluateTriage(data).conflicts).toEqual([]);
  });
});

describe("Absent, explicit unknown and corrected cause evidence", () => {
  it.each(["unknown", "unclear", "undetermined", "not known", "UNKNOWN."])("cites exact source wording for %s, even when fallback-v1 discards it", (cause) => {
    const data = input(); data.documents = [document(reportText({ cause })), data.documents[1]];
    const result = evaluateTriage(data); const conflict = result.conflicts.find((row) => row.code === "cause_unclear")!;
    expect(result.priority.status).toBe("Specialist review required");
    for (const source of conflict.sources) { expect(source.type).toBe("document"); if (source.type === "document") expect(data.documents[0].rawText.slice(source.quote!.start, source.quote!.end)).toBe(source.quote!.quote); }
  });
  it.each(["not unknown", "unknown previously; now compressor fault", "compressor fault; the inspector says cause unknown", "known compressor fault", "unclearance check completed"])("does not infer explicit unknown from %s", (cause) => {
    const data = input(); data.documents = [document(reportText({ cause })), data.documents[1]];
    expect(evaluateTriage(data).conflicts.some((row) => row.code === "cause_unclear")).toBe(false);
  });
  it("asks about absent unsupported cause without treating absence as a specialist trigger", () => {
    const data = input(); data.documents = [document("Equipment ID: REF-01\nNo cause information was provided.\nHistorical correspondence mentioned an unknown cause."), data.documents[1]];
    const result = evaluateTriage(data); expect(result.priority.status).toBe("Standard priority"); expect(result.questions.map((q) => q.code)).toContain("cause_not_reported");
  });
  it("applies a verified operator clear and does not rescan the cleared raw unknown clause", () => {
    const data = input(); const doc = document(reportText({ cause: "unclear" })); correct(doc, "reported_cause", null); data.documents = [doc, data.documents[1]];
    const result = evaluateTriage(data); expect(result.conflicts).toEqual([]); expect(result.questions.map((q) => q.code)).toContain("cause_not_reported");
  });
  it("selects the applicable correction for old and current analyses, not simply the latest", () => {
    const data = input(); data.linkedAnalyses.push({ id: "analysis-2", revision: 2 });
    const doc = document(reportText({ cause: "unclear" })); correct(doc, "reported_cause", null, "", 2); doc.corrections.selectedCorrectionId = null; data.documents = [doc, data.documents[1]];
    expect(evaluateTriage(data).priority.status).toBe("Specialist review required");
    data.selectedAnalysisId = "analysis-2"; doc.corrections.selectedCorrectionId = doc.corrections.latestCorrectionId;
    expect(evaluateTriage(data).priority.status).toBe("Standard priority");
  });
  it("uses source-supported corrected wording and carries the selected correction ID", () => {
    const data = input(); const doc = document(reportText() + "\nReported cause: unknown."); correct(doc, "reported_cause", "Reported cause: unknown.", "Reported cause: unknown."); data.documents = [doc, data.documents[1]];
    const result = evaluateTriage(data); expect(result.conflicts[0].code).toBe("cause_unclear"); expect(result.conflicts[0].sources[0]).toMatchObject({ type: "document", correctionId: doc.corrections.selectedCorrectionId });
  });
  it("retains exact UTF-16 offsets after Unicode and CRLF text", () => {
    const data = input(); const raw = "FICTIONAL 🥔 service note\r\n" + reportText({ cause: "unknown" }).replaceAll("\n", "\r\n"); data.documents = [document(raw), data.documents[1]];
    const source = evaluateTriage(data).conflicts[0].sources[0];
    expect(source.type).toBe("document"); if (source.type === "document") { expect(source.quote!.start).toBe(raw.indexOf("Reported cause")); expect(raw.slice(source.quote!.start, source.quote!.end)).toBe("Reported cause: unknown"); }
  });
  it("withholds an overlong raw cause passage instead of emitting an invalid citation", () => {
    const data = input(); data.documents = [document(`Equipment ID: REF-01\nReported cause:${" ".repeat(601)}unknown`), data.documents[1]];
    expect(evaluateTriage(data).conflicts).toEqual([]);
  });
  it("uses a supported operator restart correction without altering the original fallback", () => {
    const data = input(); const line = `Refrigeration restarted: ${stamp("04:00:00")}`;
    const doc = document(reportText() + `\n${line}`); const original = structuredClone(doc.extractionJson); correct(doc, "restart_time", stamp("04:00:00"), line); data.documents = [doc, data.documents[1]];
    const result = evaluateTriage(data); expect(result.conflicts[0]).toMatchObject({ code: "restart_log_conflict" });
    expect(result.conflicts[0].sources[0]).toMatchObject({ type: "document", correctionId: doc.corrections.selectedCorrectionId, quote: { value: stamp("04:00:00") } }); expect(doc.extractionJson).toEqual(original);
  });
  it("withholds future-origin report attachments from older selected analyses", () => {
    const data = input(); data.linkedAnalyses.push({ id: "analysis-2", revision: 2 }); data.documents = [document(reportText({ equipment: "REF-02" }), "future", "maintenance_report", "analysis-2"), data.documents[1]];
    const result = evaluateTriage(data); expect(checklist(result, "maintenance_report").status).toBe("missing"); expect(result.conflicts).toEqual([]);
    data.selectedAnalysisId = "analysis-2"; expect(evaluateTriage(data).priority.status).toBe("Specialist review required");
  });
});

describe("Gap uncertainty and evidence integrity", () => {
  it("flags an inside/adjacent gap and keeps readiness separate from coverage", () => {
    const data = input(); data.readings = data.readings.filter((row) => Date.parse(row.recordedAt) < Date.parse(stamp("02:00:00")) || Date.parse(row.recordedAt) >= Date.parse(stamp("03:00:00")));
    data.documents = [document(reportText({ restart: stamp("04:00:00") })), data.documents[1]];
    const result = evaluateTriage(data); expect(checklist(result, "temperature_log_coverage").status).toBe("missing"); expect(result.readiness.status).toBe("Ready for initial review");
    expect(result.conflicts[0].text).toContain("continuity uncertain");
    expect(result.questions.find((q) => q.checklistId === "temperature_log_coverage")?.sources.every((s) => s.type === "reading")).toBe(true);
  });
  it("does not treat a gap far outside the selected interval as missing interval coverage", () => {
    const data = input(); data.readings = data.readings.filter((row) => Date.parse(row.recordedAt) < Date.parse(stamp("10:00:00")) || Date.parse(row.recordedAt) >= Date.parse(stamp("11:00:00")));
    expect(checklist(evaluateTriage(data), "temperature_log_coverage").status).toBe("provided");
  });
  it("uses only extant typed sources and exact quotes in every reason/checklist/question", () => {
    const data = input(); data.documents = [document(reportText({ equipment: "REF-02", cause: "unknown", restart: stamp("04:00:00") })), data.documents[1]];
    const result = evaluateTriage(data); const all = [...result.readiness.reasons, ...result.priority.reasons, ...result.conflicts, ...result.checklist, ...result.questions];
    const sourceIds = { reading: data.readings.map((row) => row.id), batch: data.batches.map((row) => row.id), document: data.documents.map((row) => row.id), analysis: [data.selectedAnalysisId], settings: [data.settingsId], equipment: [data.equipment.id], policy: [] };
    for (const row of all) { expect(row.sources.length).toBeGreaterThan(0); for (const source of row.sources) { expect(sourceIds[source.type]).toContain(source.id); if (source.type === "document" && source.quote) { const raw = data.documents.find((doc) => doc.id === source.id)!.rawText; expect(raw.slice(source.quote.start, source.quote.end)).toBe(source.quote.quote); expect(source.quote.source_document_id).toBe(source.id); } } }
    for (const q of result.questions) { if (q.checklistId) expect(result.checklist.some((item) => item.id === q.checklistId && item.status === "missing")).toBe(true); if (q.conflictId) expect(result.conflicts.some((conflict) => conflict.id === q.conflictId)).toBe(true); }
    expect(new Set(result.questions.map((q) => q.id)).size).toBe(result.questions.length);
  });
  it("is repeatable, JSON-safe and isolated from input/output mutation", () => {
    const data = input(), before = structuredClone(data); const first = evaluateTriage(data), second = evaluateTriage(data);
    expect(first).toEqual(second); expect(data).toEqual(before); expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    first.checklist[0].sources[0].id = "changed"; expect(evaluateTriage(data)).toEqual(second); expect(data).toEqual(before);
  });
});

describe("Fail-closed triage input and source boundary", () => {
  const invalid: { name: string; change: (data: TriageInput) => void }[] = [
    { name: "unknown interval", change: (d) => { d.intervalId = "missing"; } },
    { name: "brief spike", change: (d) => { d.readings = d.readings.map((r) => ({ ...r, temperatureC: r.recordedAt === stamp("01:20:00") ? 7 : 3 })); } },
    { name: "invalid ordered source readings", change: (d) => { d.readings = [...d.readings].reverse(); } },
    { name: "invalid threshold", change: (d) => { d.highExposureThresholdPaise = NaN; } },
    { name: "fractional paise threshold", change: (d) => { d.highExposureThresholdPaise = 1.1; } },
    { name: "negative threshold", change: (d) => { d.highExposureThresholdPaise = -1; } },
    { name: "unsafe paise threshold", change: (d) => { d.highExposureThresholdPaise = Number.MAX_SAFE_INTEGER + 1; } },
    { name: "invalid temperature settings", change: (d) => { d.settings.maxGapMinutes = 0; } },
    { name: "duplicate batch", change: (d) => { d.batches = [...d.batches, d.batches[0]]; } },
    { name: "duplicate report", change: (d) => { d.documents = [...d.documents, d.documents[0]]; } },
    { name: "foreign incident report", change: (d) => { d.documents[0].incidentId = "other"; } },
    { name: "unlinked selected analysis", change: (d) => { d.selectedAnalysisId = "unknown"; } },
    { name: "duplicate linked analysis", change: (d) => { d.linkedAnalyses.push(d.linkedAnalyses[0]); } },
    { name: "duplicate revision number", change: (d) => { d.linkedAnalyses.push({ id: "other", revision: 1 }); } },
    { name: "unlinked attachment analysis", change: (d) => { d.documents[0].associationAnalysisId = "unknown"; } },
    { name: "forged original attachment analysis", change: (d) => { d.linkedAnalyses.push({ id: "analysis-2", revision: 2 }); d.documents[0].associationAnalysisId = "analysis-2"; } },
    { name: "original raw text tampering", change: (d) => { d.documents[0].rawText = reportText({ equipment: "REF-02" }); } },
    { name: "fabricated original facts", change: (d) => { (d.documents[0].extractionJson as StoredExtraction).extraction.equipment_id = "REF-02"; } },
    { name: "unextracted report with fallback data", change: (d) => { d.documents[0].extractionSource = null; } },
    { name: "correction with missing history", change: (d) => { d.documents[0].corrections.latestCorrectionId = "missing"; } },
    { name: "blank original report", change: (d) => { d.documents[0].rawText = "  "; } },
    { name: "duplicate stock record", change: (d) => { d.stockRecords = [{ documentId: "stock", batchIds: [d.batches[0].id] }, { documentId: "stock", batchIds: [d.batches[1].id] }]; } },
    { name: "stock record colliding with a report", change: (d) => { d.stockRecords = [{ documentId: d.documents[0].id, batchIds: [d.batches[0].id] }]; } },
    { name: "unknown stock batch association", change: (d) => { d.stockRecords = [{ documentId: "stock", batchIds: ["unknown"] }]; } },
    { name: "duplicate stock batch association", change: (d) => { d.stockRecords = [{ documentId: "stock", batchIds: [d.batches[0].id, d.batches[0].id] }]; } },
    { name: "missing policy identifier", change: (d) => { d.policyId = " "; } },
  ];
  it.each(invalid)("rejects $name", ({ change }) => { const data = input(); change(data); expect(() => evaluateTriage(data)).toThrow(); });
  it("rejects a correction whose analysis ID claims the wrong linked revision", () => {
    const data = input(); const doc = document(reportText({ cause: "unclear" })); correct(doc, "reported_cause", null); doc.corrections.history[0].analysisRevision = 2; data.documents = [doc, data.documents[1]];
    expect(() => evaluateTriage(data)).toThrow(/history|provenance/);
  });
  it("rejects corrupted corrections instead of silently falling back to original facts", () => {
    const data = input(); const doc = document(reportText({ cause: "unclear" })); correct(doc, "reported_cause", null); doc.corrections.history[0].extraction.equipment_id = "REF-02"; data.documents = [doc, data.documents[1]];
    expect(() => evaluateTriage(data)).toThrow(/history/);
  });
});
