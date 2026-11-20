import { arrayFields, extractionSchema, fieldLabels, scalarFields, storedExtractionSchema, type EvidenceQuote, type ExtractedFacts, type ExtractionField, type StoredExtraction } from "./contract";
import { ruleInstantSchema } from "../rules/validation";

type Candidate = { field: ExtractionField; value: string | null; passage: string; start: number; context?: { quote: string; start: number; end: number } };
const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const unavailable = /^(?:unknown|not (?:known|recorded|available|reported|inspected)|none|n\/?a|undetermined|no (?:fault|cause|inspection))\b/i;
const timeFields = new Set<ExtractionField>(["fault_time", "repair_time", "restart_time", "inspection_date"]);

// Deliberately narrow grammar. Never borrow a date from an incident/header/clock.
export function parseSourceInstant(value: string, hasIstContext: boolean) {
  const iso = ruleInstantSchema.safeParse(value);
  if (iso.success) return iso.data;
  const written = /^(\d{2}):(\d{2})(?::(\d{2}))? on (\d{1,2}) ([A-Za-z]+) (\d{4})(?:\s+(IST|\+05:30))?$/i.exec(value);
  if (!written || (!hasIstContext && !written[7])) return null;
  const month = months.indexOf(written[5].toLowerCase()) + 1;
  const parsed = ruleInstantSchema.safeParse(`${written[6]}-${String(month).padStart(2, "0")}-${written[4].padStart(2, "0")}T${written[1]}:${written[2]}:${written[3] ?? "00"}+05:30`);
  return parsed.success ? parsed.data : null;
}

function candidates(rawText: string) {
  const result: Candidate[] = [];
  const zone = /(?:^|[\n(])[ \t]*((?:all times IST(?:,? \+05:30)?|All timestamps have the explicit IST offset \+05:30))(?=[).\s]|$)/im.exec(rawText);
  const conflictingZone = /\ball times (?!IST\b)[A-Za-z]+\b/i.test(rawText);
  const zoneStart = zone ? zone.index + zone[0].indexOf(zone[1]) : 0;
  const context = zone && !conflictingZone ? { quote: zone[1], start: zoneStart, end: zoneStart + zone[1].length } : undefined;
  const add = (field: ExtractionField, value: string, passage: string, start: number) => {
    const trimmed = value.trim().replace(/\.$/, "").trim();
    let parsed: string | null = !trimmed || unavailable.test(trimmed) || passage.length > 600 ? null : trimmed;
    if (timeFields.has(field)) parsed = parseSourceInstant(trimmed, !!context);
    result.push({ field, value: parsed, passage, start, ...(timeFields.has(field) && context && !ruleInstantSchema.safeParse(trimmed).success ? { context } : {}) });
  };
  // Labels must start a clause; prose mentioning an absent report isn't a fact.
  const label = /(^|[\n;|]|\.\s+)([ \t]*(?:Equipment ID|Refrigeration unit|Unit \/ asset|Reported fault|Reported cause|Fault reported|Repair completed|Refrigeration restarted|Restart time|Inspection date|Stock condition|Observation|Observations|The register references batches|Batch refs \(copied from register\)|Batches mentioned)[ \t]*:[ \t]*([^\n;|]*?))(?=\.\s+(?=[A-Za-z])|[\n;|]|$)/gim;
  const mapping: Record<string, ExtractionField> = { "equipment id": "equipment_id", "refrigeration unit": "equipment_id", "unit / asset": "equipment_id", "reported fault": "reported_fault", "reported cause": "reported_cause", "fault reported": "fault_time", "repair completed": "repair_time", "refrigeration restarted": "restart_time", "restart time": "restart_time", "inspection date": "inspection_date", "stock condition": "stock_condition", observation: "observations", observations: "observations", "the register references batches": "batches_mentioned", "batch refs (copied from register)": "batches_mentioned", "batches mentioned": "batches_mentioned" };
  for (const match of rawText.matchAll(label)) {
    const clause = match[2].trimStart(), start = match.index! + match[1].length + match[2].length - clause.length;
    const colon = clause.indexOf(":"), key = clause.slice(0, colon).trim().toLowerCase();
    const field = mapping[key];
    // A sentence boundary terminates a label, but not an ISO fractional second.
    const value = clause.slice(colon + 1).split(/\.\s+(?=[A-Za-z])/)[0].trim().replace(/\.$/, "").trim();
    const passage = clause.slice(0, colon + 1 + clause.slice(colon + 1).indexOf(value) + value.length);
    if (field === "batches_mentioned") {
      const codes = value.split(/[,/]/).map((s) => s.trim());
      if (codes.length && codes.every((s) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(s))) for (const code of codes) add(field, code, passage, start);
      else add(field, "unknown", passage, start);
    } else if (field === "equipment_id" && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(value)) add(field, "unknown", passage, start);
    else add(field, value, passage, start);
  }
  // Authored report's affirmative service sentences. Negated variants don't match.
  const phrases: [RegExp, ExtractionField, number][] = [
    [/\bThe technician attended refrigeration unit ([A-Za-z0-9_-]+) and recorded a [^.\n]+\./g, "equipment_id", 1],
    [/\bThe operator reported a ([^.\n]{1,150}?) at ([^.\n]{1,100})\./g, "reported_fault", 1],
    [/\bThe operator reported a ([^.\n]{1,150}?) at ([^.\n]{1,100})\./g, "fault_time", 2],
    [/\bThe technician attended refrigeration unit [A-Za-z0-9_-]+ and recorded a ([^.\n]{1,150}?) as the reported cause[^.\n]*\./g, "reported_cause", 1],
    [/\bRepair work was completed at ([^.\n]{1,100})\./g, "repair_time", 1],
    [/\bRefrigeration restarted at ([^.\n]{1,100})\./g, "restart_time", 1],
  ];
  for (const [regex, field, group] of phrases) for (const match of rawText.matchAll(regex)) add(field, match[group], match[0], match.index!);
  for (const [field, regex] of [
    ["restart_time", /\b(?:Refrigeration had not restarted|no restart time is reported)\b/gi],
    ["repair_time", /\bRepairs were not complete\b/gi],
  ] as const) for (const match of rawText.matchAll(regex)) result.push({ field, value: null, passage: match[0], start: match.index! });
  return result;
}

function build(rawText: string, sourceDocumentId: string) {
  const found = candidates(rawText);
  const extraction: ExtractedFacts = { equipment_id: null, reported_fault: null, reported_cause: null, fault_time: null, repair_time: null, restart_time: null, stock_condition: null, inspection_date: null, observations: [], batches_mentioned: [], evidence_quotes: [] };
  const warnings: string[] = [];
  for (const field of [...scalarFields, ...arrayFields]) {
    const items = found.filter((item) => item.field === field);
    const values = [...new Set(items.map((item) => item.value))];
    const multiple = (arrayFields as readonly string[]).includes(field);
    if (items.some((item) => item.value === null) || (!multiple && values.length > 1)) {
      warnings.push(`${fieldLabels[field]}: conflicting, incomplete or unsupported wording; inspect the original text.`);
      continue;
    }
    const supported = values.filter((v): v is string => v !== null).slice(0, 100);
    if (multiple) extraction[field as "observations" | "batches_mentioned"] = supported;
    else extraction[field as typeof scalarFields[number]] = supported[0] ?? null;
    if (values.length > 100) warnings.push(`${fieldLabels[field]}: only the first 100 references were extracted; inspect the original text.`);
    for (const value of supported) {
      const item = items.find((candidate) => candidate.value === value)!;
      extraction.evidence_quotes.push({ field, value, quote: item.passage, start: item.start, end: item.start + item.passage.length, source_document_id: sourceDocumentId, ...(item.context ? { time_zone_context: item.context } : {}) });
    }
  }
  if (!extraction.evidence_quotes.length) warnings.push("No supported labelled facts found. Missing fields remain unrecorded; inspect the original text.");
  return { extraction: extractionSchema.parse(extraction), warnings };
}

export function extractDocument(rawText: string, sourceDocumentId: string, association: StoredExtraction["association"]): StoredExtraction {
  return storedExtractionSchema.parse({ schemaVersion: 1, extractorVersion: "fallback-v1", sourceDocumentId, association, ...build(rawText, sourceDocumentId) });
}

// Verify source IDs, exact offsets, coverage AND deterministic support before display.
// An exact but unrelated quotation is not evidence for a fabricated field value.
export function verifyStoredExtraction(rawText: string, sourceDocumentId: string, incidentId: string, value: unknown): StoredExtraction | null {
  const parsed = storedExtractionSchema.safeParse(value);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (data.sourceDocumentId !== sourceDocumentId || data.association.incidentId !== incidentId) return null;
  const exact = (q: { start: number; end: number; quote: string }) => q.end > q.start && rawText.slice(q.start, q.end) === q.quote;
  if (data.extraction.evidence_quotes.some((q: EvidenceQuote) => q.source_document_id !== sourceDocumentId || !exact(q) || (q.time_zone_context && !exact(q.time_zone_context)))) return null;
  const expected = build(rawText, sourceDocumentId);
  return JSON.stringify(data.extraction) === JSON.stringify(expected.extraction) && JSON.stringify(data.warnings) === JSON.stringify(expected.warnings) ? data : null;
}
