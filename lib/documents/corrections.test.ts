import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractDocument } from "./extract";
import { applyCorrection, completeSourcePassage, correctionInputSchema, passageOccurrences, verifyCorrectionState, type CorrectionInput, type DocumentCorrectionState } from "./corrections";
import type { ExtractionField } from "./contract";

const raw = "📋 Fictional technician notebook\r\nAttended asset REF-02 according to the work sheet.\r\nNo compressor fault has been established.\r\nCooling resumed at 2026-03-10T05:10:00+05:30.\r\nAll times IST.\r\nOperator noted 05:10 on 10 March 2026 after service.\r\nThe register mentions A and B.\r\nRepeated source line.\r\nRepeated source line.";
const doc = "document-source", association = { method: "operator_selected" as const, incidentId: "incident", analysisId: "analysis-1" };
const original = extractDocument(raw, doc, association).extraction;
const quote = (line: string) => ({ quote: line, start: raw.indexOf(line), end: raw.indexOf(line) + line.length });
function input(field: ExtractionField, value: string | string[] | null, line?: string): CorrectionInput {
  const values = Array.isArray(value) ? value : value === null ? [] : [value];
  return correctionInputSchema.parse({ requestId: randomUUID(), analysisId: "analysis-1", expectedCorrectionId: null, reason: "Reviewed the original handwritten transcription", change: { field, value, supportConfirmed: true, evidence_quotes: line ? values.map((value) => ({ ...quote(line), field, value, source_document_id: doc })) : [] } });
}
describe("Source-supported operator correction validation", () => {
  it("supports a missed equipment phrase without changing fallback or original text", () => {
    expect(original.equipment_id).toBeNull();
    const next = applyCorrection(raw, doc, original, input("equipment_id", "REF-02", "Attended asset REF-02 according to the work sheet."));
    expect(next.equipment_id).toBe("REF-02"); expect(original.equipment_id).toBeNull();
  });
  it("copies complete free-text wording and retains negation rather than inventing a finding", () => {
    const line = "No compressor fault has been established.";
    expect(applyCorrection(raw, doc, original, input("reported_fault", line, line)).reported_fault).toBe(line);
    expect(() => applyCorrection(raw, doc, original, input("reported_fault", "compressor fault", line))).toThrow(/verbatim/);
    expect(() => applyCorrection(raw, doc, original, input("reported_fault", "compressor fault", "compressor fault"))).toThrow(/complete source line/);
  });
  it("requires exact complete-line occurrences and handles repeated text and CRLF/emoji offsets", () => {
    expect(passageOccurrences(raw, "Repeated source line.")).toHaveLength(2);
    expect(passageOccurrences(raw, "source line")).toEqual([]);
    expect(completeSourcePassage(raw, quote("All times IST."))).toBe(true);
    expect(completeSourcePassage(raw, { ...quote("All times IST."), start: 1 })).toBe(false);
    expect(completeSourcePassage(raw, { quote: raw, start: 0, end: raw.length + 100 })).toBe(false);
  });
  it("supports a full explicit-offset instant and normalizes an equivalent submitted offset", () => {
    const change = input("restart_time", "2026-03-09T23:40:00Z", "Cooling resumed at 2026-03-10T05:10:00+05:30.");
    expect(change.change.value).toBe("2026-03-10T05:10:00+05:30");
    expect(applyCorrection(raw, doc, original, change).restart_time).toBe("2026-03-10T05:10:00+05:30");
  });
  it("supports a complete written date with separately quoted IST declaration", () => {
    const change = input("restart_time", "2026-03-10T05:10:00+05:30", "Operator noted 05:10 on 10 March 2026 after service.");
    expect(() => applyCorrection(raw, doc, original, change)).toThrow(/explicit timezone/);
    change.change.evidence_quotes[0].time_zone_context = quote("All times IST.");
    expect(applyCorrection(raw, doc, original, change).restart_time).toBe("2026-03-10T05:10:00+05:30");
  });
  it.each(["Not all times IST.", "All times UTC.", "Service date: 10 March 2026", "All times IST.\nAll times UTC."])("rejects unsupported/conflicting timezone context: %s", (context) => {
    const source = `Operator noted 05:10 on 10 March 2026 after service.\n${context}`;
    const change = input("restart_time", "2026-03-10T05:10:00+05:30", "Operator noted 05:10 on 10 March 2026 after service.");
    change.change.evidence_quotes[0].start = 0; change.change.evidence_quotes[0].end = change.change.evidence_quotes[0].quote.length;
    change.change.evidence_quotes[0].time_zone_context = { quote: context.split("\n")[0], start: source.indexOf(context), end: source.indexOf(context) + context.split("\n")[0].length };
    expect(() => applyCorrection(source, doc, original, change)).toThrow(/Timezone context/);
  });
  it.each(["2026-03-10T05:10:00.1234+05:30", "2026-03-10T05:10:00+05:300", "05:10", "10 March 2026", "2026-02-30T05:10:00+05:30"])("does not invent an instant from invalid or partial source: %s", (time) => {
    const source = `Restart noted at ${time}.`, change = input("restart_time", "2026-03-10T05:10:00+05:30", "Cooling resumed at 2026-03-10T05:10:00+05:30.");
    change.change.evidence_quotes[0] = { ...change.change.evidence_quotes[0], quote: source, start: 0, end: source.length };
    expect(() => applyCorrection(source, doc, original, change)).toThrow(/corrected instant/);
  });
  it("requires whole identifier tokens, and per-item array support", () => {
    expect(() => applyCorrection(raw, doc, original, input("equipment_id", "REF-0", "Attended asset REF-02 according to the work sheet."))).toThrow(/whole source tokens/);
    const result = applyCorrection(raw, doc, original, input("batches_mentioned", ["A", "B"], "The register mentions A and B."));
    expect(result.batches_mentioned).toEqual(["A", "B"]); expect(result.evidence_quotes).toHaveLength(2);
  });
  it("explicitly clears scalar and array fields without fake citations", () => {
    const next = applyCorrection(raw, doc, original, input("equipment_id", "REF-02", "Attended asset REF-02 according to the work sheet."));
    expect(applyCorrection(raw, doc, next, input("equipment_id", null)).equipment_id).toBeNull();
    expect(applyCorrection(raw, doc, next, input("observations", [])).observations).toEqual([]);
  });
  it.each(["source", "offset", "quote", "value", "field", "context"])("rejects fabricated citation metadata: %s", (kind) => {
    const change = input("equipment_id", "REF-02", "Attended asset REF-02 according to the work sheet."), q = change.change.evidence_quotes[0];
    if (kind === "source") q.source_document_id = "other";
    if (kind === "offset") q.start++;
    if (kind === "quote") q.quote = "Fabricated quote";
    if (kind === "value") q.value = "REF-99";
    if (kind === "field") q.field = "reported_cause";
    if (kind === "context") q.time_zone_context = quote("All times IST.");
    expect(() => applyCorrection(raw, doc, original, change)).toThrow();
  });
  it.each(["reason", "confirmation", "type", "extra", "duplicate", "missingQuote", "invalidTime"])("rejects malformed correction contracts: %s", (kind) => {
    const body: Record<string, unknown> = structuredClone(input("equipment_id", "REF-02", "Attended asset REF-02 according to the work sheet."));
    const change = body.change as CorrectionInput["change"];
    if (kind === "reason") body.reason = " ";
    if (kind === "confirmation") Object.assign(change, { supportConfirmed: false });
    if (kind === "type") change.value = ["REF-02"];
    if (kind === "extra") body.extra = true;
    if (kind === "duplicate") { change.field = "batches_mentioned"; change.value = ["A", "A"]; }
    if (kind === "missingQuote") change.evidence_quotes = [];
    if (kind === "invalidTime") { change.field = "restart_time"; change.value = "2026-03-10T05:10:00+05:30"; change.evidence_quotes[0].value = "bad"; }
    expect(correctionInputSchema.safeParse(body).success).toBe(false);
  });
  it("validates the immutable display chain and withholds a later correction for an older analysis", () => {
    const first = input("equipment_id", "REF-02", "Attended asset REF-02 according to the work sheet."), id1 = `correction-${first.requestId}`;
    const one = applyCorrection(raw, doc, original, first), second = input("equipment_id", null); second.expectedCorrectionId = id1; second.analysisId = "analysis-2";
    const id2 = `correction-${second.requestId}`, two = applyCorrection(raw, doc, one, second);
    const state: DocumentCorrectionState = { latestCorrectionId: id2, selectedCorrectionId: id1, history: [{ id: id1, documentId: doc, revision: 1, previousCorrectionId: null, analysisId: "analysis-1", analysisRevision: 1, createdAt: "2026-10-28T13:00:00+05:30", actor: "storage_operator", input: first, extraction: one }, { id: id2, documentId: doc, revision: 2, previousCorrectionId: id1, analysisId: "analysis-2", analysisRevision: 2, createdAt: "2026-10-28T13:01:00+05:30", actor: "storage_operator", input: second, extraction: two }] };
    expect(verifyCorrectionState(raw, doc, original, state, 1)).toEqual(state);
    expect(verifyCorrectionState(raw, doc, original, { ...state, selectedCorrectionId: id2 }, 1)).toBeNull();
    state.history[0].extraction.equipment_id = "REF-99";
    expect(verifyCorrectionState(raw, doc, original, state, 1)).toBeNull();
  });
});
