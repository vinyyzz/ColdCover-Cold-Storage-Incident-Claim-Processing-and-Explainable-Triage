import { z } from "zod";
import { arrayFields, extractionSchema, fieldSchema, quoteSchema, type ExtractedFacts } from "./contract";
import { parseSourceInstant } from "./extract";
import { ruleInstantSchema } from "../rules/validation";

export const correctionIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/);
const text = z.string().min(1).max(600).refine((s) => s.trim() === s && s.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s));
export const timeFields = new Set(["fault_time", "repair_time", "restart_time", "inspection_date"]);
export const correctionInputSchema = z.object({
  requestId: z.uuid().transform((s) => s.toLowerCase()), analysisId: correctionIdentifier,
  expectedCorrectionId: correctionIdentifier.nullable(), reason: text,
  change: z.object({ field: fieldSchema, value: z.union([text, z.array(text).max(100), z.null()]), evidence_quotes: z.array(quoteSchema).max(100), supportConfirmed: z.literal(true) }).strict(),
}).strict().superRefine(({ change }, ctx) => {
  const array = (arrayFields as readonly string[]).includes(change.field);
  if (array !== Array.isArray(change.value)) ctx.addIssue({ code: "custom", path: ["change", "value"], message: "Use an array for array fields, and a string or null for scalar fields." });
  const values = Array.isArray(change.value) ? change.value : change.value === null ? [] : [change.value];
  if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", path: ["change", "value"], message: "Values must be unique." });
  if (change.evidence_quotes.length !== values.length) ctx.addIssue({ code: "custom", path: ["change", "evidence_quotes"], message: "Supply one supporting passage per value; clears have no passages." });
  if (timeFields.has(change.field) && change.value !== null && !ruleInstantSchema.safeParse(change.value).success) ctx.addIssue({ code: "custom", path: ["change", "value"], message: "Use a complete offset-qualified timestamp." });
  if (timeFields.has(change.field) && change.evidence_quotes.some((q) => !ruleInstantSchema.safeParse(q.value).success)) ctx.addIssue({ code: "custom", path: ["change", "evidence_quotes"], message: "Time citations need valid offset timestamps." });
}).transform((input) => {
  if (timeFields.has(input.change.field) && typeof input.change.value === "string") {
    const value = ruleInstantSchema.parse(input.change.value);
    return { ...input, change: { ...input.change, value, evidence_quotes: input.change.evidence_quotes.map((q) => ({ ...q, value: ruleInstantSchema.parse(q.value) })) } };
  }
  return input;
});
export type CorrectionInput = z.infer<typeof correctionInputSchema>;
export interface CorrectionRevision {
  id: string; documentId: string; revision: number; previousCorrectionId: string | null;
  analysisId: string; analysisRevision: number; createdAt: string; actor: "storage_operator";
  input: CorrectionInput; extraction: ExtractedFacts;
}
export interface DocumentCorrectionState {
  /** Latest across the entire document, used for compare-and-swap writes. */
  latestCorrectionId: string | null;
  selectedCorrectionId: string | null;
  history: CorrectionRevision[];
}
export const correctionReceiptSchema = z.object({ correctionId: correctionIdentifier, documentId: correctionIdentifier, analysisId: correctionIdentifier, revision: z.number().int().positive(), createdAt: ruleInstantSchema, reused: z.boolean() }).strict();
export type CorrectionReceipt = z.infer<typeof correctionReceiptSchema>;

const revisionSchema = z.object({ id: correctionIdentifier, documentId: correctionIdentifier, revision: z.number().int().positive(), previousCorrectionId: correctionIdentifier.nullable(), analysisId: correctionIdentifier, analysisRevision: z.number().int().positive(), createdAt: ruleInstantSchema, actor: z.literal("storage_operator"), input: correctionInputSchema, extraction: extractionSchema }).strict();
const stateSchema = z.object({ latestCorrectionId: correctionIdentifier.nullable(), selectedCorrectionId: correctionIdentifier.nullable(), history: z.array(revisionSchema) }).strict();
export function verifyCorrectionState(raw: string, documentId: string, original: ExtractedFacts, value: unknown, selectedAnalysisRevision: number | null): DocumentCorrectionState | null {
  try {
    const state = stateSchema.parse(value);
    let previous = original;
    for (const [i, row] of state.history.entries()) {
      const last = state.history[i - 1];
      if (row.documentId !== documentId || row.revision !== i + 1 || row.id !== `correction-${row.input.requestId}` || row.previousCorrectionId !== (last?.id ?? null) || row.input.expectedCorrectionId !== row.previousCorrectionId || row.analysisId !== row.input.analysisId || (last && row.analysisRevision < last.analysisRevision)) return null;
      const expected = applyCorrection(raw, documentId, previous, row.input);
      if (JSON.stringify(expected) !== JSON.stringify(row.extraction)) return null;
      previous = expected;
    }
    const selected = selectedAnalysisRevision === null ? undefined : state.history.findLast((row) => row.analysisRevision <= selectedAnalysisRevision);
    return state.latestCorrectionId === (state.history.at(-1)?.id ?? null) && state.selectedCorrectionId === (selected?.id ?? null) ? state : null;
  } catch { return null; }
}

export function completeSourcePassage(raw: string, passage: { start: number; end: number; quote: string }) {
  const { start, end, quote } = passage;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > raw.length || end <= start || raw.slice(start, end) !== quote) return false;
  const left = raw.slice(raw.lastIndexOf("\n", start - 1) + 1, start);
  const next = raw.indexOf("\n", end), right = raw.slice(end, next < 0 ? raw.length : next);
  return /^[ \t]*$/.test(left) && /^[ \t\r]*$/.test(right);
}
export function passageOccurrences(raw: string, quote: string) {
  if (!quote || quote.length > 600) return [];
  const hits: number[] = [];
  for (let at = raw.indexOf(quote); at >= 0; at = raw.indexOf(quote, at + 1)) if (completeSourcePassage(raw, { start: at, end: at + quote.length, quote })) hits.push(at);
  return hits;
}
const literalToken = (quote: string, value: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(value)) return false;
  for (let at = quote.indexOf(value); at >= 0; at = quote.indexOf(value, at + 1)) if (!/[A-Za-z0-9_-]/.test(quote[at - 1] ?? "") && !/[A-Za-z0-9_-]/.test(quote[at + value.length] ?? "")) return true;
  return false;
};
export function applyCorrection(raw: string, documentId: string, previous: ExtractedFacts, input: CorrectionInput): ExtractedFacts {
  const { change } = input;
  const values = Array.isArray(change.value) ? change.value : change.value === null ? [] : [change.value];
  const seen = new Set<string>();
  for (const quote of change.evidence_quotes) {
    if (quote.source_document_id !== documentId || quote.field !== change.field || !values.includes(quote.value) || seen.has(quote.value) || !completeSourcePassage(raw, quote)) throw new Error("Use one exact complete source line per corrected value, from this document.");
    seen.add(quote.value);
    if (timeFields.has(change.field)) {
      const context = quote.time_zone_context;
      const ist = context && completeSourcePassage(raw, context) && /^(?:All times IST(?:,? \+05:30)?\.?|All timestamps have the explicit IST offset \+05:30\.?|Service date: \d{1,2} [A-Za-z]+ \d{4} \(all times IST(?:,? \+05:30)?\))$/i.test(context.quote.trim()) && !/\ball times (?!IST\b)[A-Za-z]+\b/i.test(raw);
      if (context && !ist) throw new Error("Timezone context must be an exact explicit IST declaration from the original report.");
      const tokens = [...quote.quote.matchAll(/(?<![\dA-Za-z])(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})|\d{2}:\d{2}(?::\d{2})? on \d{1,2} [A-Za-z]+ \d{4}(?:\s+(?:IST|\+05:30))?)(?![\dA-Za-z:+-]|\.\d)/g)].map((m) => parseSourceInstant(m[0], !!ist));
      if (!tokens.includes(quote.value)) throw new Error("The corrected instant must be stated with its complete date and explicit timezone in the quoted source.");
    } else {
      if (quote.time_zone_context) throw new Error("Timezone context is only used for time fields.");
      const supported = change.field === "equipment_id" || change.field === "batches_mentioned" ? literalToken(quote.quote, quote.value) : quote.value === quote.quote.trim();
      if (!supported) throw new Error("Copy reported wording verbatim from the complete source passage; identifiers must be whole source tokens.");
    }
  }
  if (seen.size !== values.length) throw new Error("Every corrected value requires its own exact source passage.");
  return extractionSchema.parse({ ...previous, [change.field]: change.value, evidence_quotes: [...previous.evidence_quotes.filter((q) => q.field !== change.field), ...change.evidence_quotes] });
}
