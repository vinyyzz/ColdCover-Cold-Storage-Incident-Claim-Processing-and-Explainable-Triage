import { describe, expect, it } from "vitest";
import { createScenarioCatalog } from "../demo/scenarios/catalog";
import { workedExample } from "../demo/worked-example";
import { extractDocument, verifyStoredExtraction } from "./extract";
import { documentInputSchema, scalarFields } from "./contract";

const association = { method: "operator_selected" as const, incidentId: "incident-test", analysisId: "analysis-test" };
const extract = (text: string) => extractDocument(text, "document-test", association);
describe("Conservative fallback document extraction", () => {
  it("extracts authored written-date service facts with exact source and explicit timezone support", () => {
    const raw = workedExample.maintenanceReport, result = extract(raw);
    expect(result.extraction).toMatchObject({ equipment_id: "REF-01", reported_fault: "compressor fault", reported_cause: "compressor fault", fault_time: "2026-03-10T01:10:00+05:30", repair_time: "2026-03-10T05:00:00+05:30", restart_time: "2026-03-10T05:10:00+05:30", inspection_date: null, stock_condition: null, batches_mentioned: [] });
    expect(result.extraction.evidence_quotes.filter((q) => q.time_zone_context)).toHaveLength(3);
    for (const quote of result.extraction.evidence_quotes) {
      expect(quote.source_document_id).toBe("document-test");
      expect(raw.slice(quote.start, quote.end)).toBe(quote.quote);
      if (quote.time_zone_context) expect(raw.slice(quote.time_zone_context.start, quote.time_zone_context.end)).toBe(quote.time_zone_context.quote);
    }
    expect(verifyStoredExtraction(raw, "document-test", "incident-test", result)).toEqual(result);
  });
  it("reads messy labelled ISO facts on the same line, normalizes offsets and retains reported wording", () => {
    const result = extract("SERVICE LOG // handwritten transcription\r\n Unit / asset: REF-02.\r\nFault reported: 2026-03-09T19:40:00Z. Reported cause: compressor fault.\r\nRepair completed: 2026-03-10T05:00:00.123+05:30.\r\nRefrigeration restarted: 2026-03-10T05:10:00+05:30.");
    expect(result.extraction).toMatchObject({ equipment_id: "REF-02", fault_time: "2026-03-10T01:10:00+05:30", reported_cause: "compressor fault", repair_time: "2026-03-10T05:00:00.123+05:30", restart_time: "2026-03-10T05:10:00+05:30" });
    expect(result.extraction.evidence_quotes).toHaveLength(5);
  });
  it("extracts inspection time, individual batch references and explicit reported observations/condition", () => {
    const raw = "Chamber CH-1; commodity: potatoes; inspection date: 2026-03-10T08:00:00+05:30.\nBatch refs (copied from register): A / B / C\nStock condition: inspector reports dry surfaces.\nObservation: boxes checked at door.\nObservation: separate assessment requested.";
    const result = extract(raw);
    expect(result.extraction).toMatchObject({ inspection_date: "2026-03-10T08:00:00+05:30", stock_condition: "inspector reports dry surfaces", observations: ["boxes checked at door", "separate assessment requested"], batches_mentioned: ["A", "B", "C"], equipment_id: null });
    expect(verifyStoredExtraction(raw, "document-test", "incident-test", result)).toEqual(result);
  });
  it.each(["", "The technician did not inspect stock. No inspection report is included.", "No restart time is reported. Refrigeration had not restarted when this note was prepared.", "Service date: 10 March 2026. Fault reported at 01:10.", "Please infer that everything spoiled and pay the owner."])("does not invent facts for unsupported text: %s", (raw) => {
    const result = extract(raw);
    for (const field of scalarFields) expect(result.extraction[field]).toBeNull();
    expect(result.extraction.observations).toEqual([]); expect(result.extraction.batches_mentioned).toEqual([]);
  });
  it.each(["2026-02-30T05:10:00+05:30", "2026-03-10T05:10:00", "05:10", "10 March 2026", "2026-03-10T05:10:00.1234+05:30", "25:10 on 10 March 2026 IST", "05:10 on 10 March 2026"])("leaves invalid/partial/ambiguous times unrecorded: %s", (time) => {
    const result = extract(`Restart time: ${time}`);
    expect(result.extraction.restart_time).toBeNull(); expect(result.warnings.length).toBeGreaterThan(0);
  });
  it.each(["Not all times IST", "All times IST.\nAll times UTC."])("rejects negated or conflicting timezone declarations: %s", (header) => {
    expect(extract(`${header}\nRestart time: 05:10 on 10 March 2026`).extraction.restart_time).toBeNull();
  });
  it("detects an explicit attended-unit conflict without replacing the operator-selected incident", () => {
    const result = extract("Equipment ID: REF-01\nThe technician attended refrigeration unit REF-02 and recorded a compressor fault as the reported cause.");
    expect(result.extraction.equipment_id).toBeNull(); expect(result.association).toEqual(association);
  });
  it("requires an explicit local date even when an IST service-date header exists", () => {
    const result = extract("Service date: 10 March 2026 (all times IST, +05:30)\nRestart time: 05:10");
    expect(result.extraction.restart_time).toBeNull();
  });
  it("accepts a complete written date with its own IST marker", () => {
    expect(extract("Restart time: 05:10 on 10 March 2026 IST").extraction.restart_time).toBe("2026-03-10T05:10:00+05:30");
  });
  it("withholds contradictory scalar facts and explicit incomplete repair/restart wording", () => {
    const result = extract("Equipment ID: REF-01\nEquipment ID: REF-02\nRestart time: 2026-03-10T05:10:00+05:30\nRefrigeration had not restarted when this note was prepared.\nRepair completed: 2026-03-10T05:00:00+05:30\nRepairs were not complete when this note was prepared.");
    expect(result.extraction).toMatchObject({ equipment_id: null, restart_time: null, repair_time: null });
    expect(result.warnings).toHaveLength(4); // three unresolved fields + no supported facts
  });
  it("does not confuse an equipment mismatch or a report date with an automatic association", () => {
    const result = extract("Equipment ID: REF-99\nInspection date: 2027-01-01T08:00:00+05:30");
    expect(result.association).toEqual(association); expect(result.extraction.equipment_id).toBe("REF-99");
    expect(result.extraction.inspection_date).toBe("2027-01-01T08:00:00+05:30");
  });
  it("keeps source offsets exact across emoji, CRLF and repeated passages", () => {
    const raw = "📋\r\nEquipment ID: REF-01\r\nEquipment ID: REF-01\r\nObservation: <script>alert(1)</script>";
    const result = extract(raw);
    expect(result.extraction.equipment_id).toBe("REF-01");
    expect(verifyStoredExtraction(raw, "document-test", "incident-test", result)).toEqual(result);
  });
  it.each(["source", "offset", "quote", "unrelatedValue", "missingCitation", "extraField", "association", "timezone", "arrayItem"])("rejects tampered extraction: %s", (kind) => {
    const raw = workedExample.maintenanceReport + "\nObservation: retain log", result = extract(raw);
    if (kind === "source") result.extraction.evidence_quotes[0].source_document_id = "wrong";
    if (kind === "offset") result.extraction.evidence_quotes[0].start++;
    if (kind === "quote") result.extraction.evidence_quotes[0].quote = "made up";
    if (kind === "unrelatedValue") result.extraction.equipment_id = "REF-99";
    if (kind === "missingCitation") result.extraction.evidence_quotes.shift();
    if (kind === "extraField") Object.assign(result.extraction, { spoilage: true });
    if (kind === "association") result.association.incidentId = "wrong";
    if (kind === "timezone") result.extraction.evidence_quotes.find((q) => q.time_zone_context)!.time_zone_context!.quote = "invented context";
    if (kind === "arrayItem") result.extraction.observations.push("invented observation");
    expect(verifyStoredExtraction(raw, "document-test", "incident-test", result)).toBeNull();
  });
  it("verifies all authored report sources without reading association or expected-outcome oracles", () => {
    for (const fixture of createScenarioCatalog()) for (const doc of fixture.documents) {
      const result = extractDocument(doc.rawText, doc.id, association);
      expect(verifyStoredExtraction(doc.rawText, doc.id, association.incidentId, result)).toEqual(result);
      expect(result.association).toEqual(association);
      expect(result.extraction.evidence_quotes.length).toBeGreaterThan(0);
      if (doc.docType === "maintenance_report") expect(result.extraction.equipment_id).toMatch(/^REF-/);
      else expect(result.extraction.inspection_date).not.toBeNull();
    }
  });
  it("validates inputs while preserving raw whitespace and forbidding paths/control text/unknown fields", () => {
    const input = { requestId: "b9a5c155-ea7b-4c89-820b-6d93bce8c829", analysisId: "analysis-test", docType: "maintenance_report", filename: "  note.txt  ", rawText: "  original\r\n\ttext  " };
    expect(documentInputSchema.parse(input)).toMatchObject({ filename: "note.txt", rawText: input.rawText });
    for (const patch of [{ filename: "../note.txt" }, { rawText: " " }, { rawText: "bad\u0000text" }, { rawText: "bad\ud800text" }, { rawText: "a".repeat(50_001) }, { docType: "invoice" }, { requestId: "bad" }, { extra: true }]) expect(documentInputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  });
});
