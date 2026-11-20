import type { EvidenceQuote, ExtractedFacts, ExtractionField } from "../documents/contract";
import { verifyCorrectionState } from "../documents/corrections";
import { verifyStoredExtraction } from "../documents/extract";
import type { TriageDocumentInput, TriageSource } from "./triage-types";

export interface TriageDocument {
  input: TriageDocumentInput;
  facts: ExtractedFacts | null;
  correctionId: string | null;
  unknownCauseQuotes: EvidenceQuote[];
}

// Narrow vocabulary only. In particular, "not unknown" and historical prose
// mentioning an unknown cause must not silently become specialist triggers.
export function isExplicitUnknownCause(value: string) {
  return /^(?:reported cause\s*:\s*)?(?:unknown|unclear|undetermined|not known)[.!]?$/i.test(value.trim());
}

function originalUnknownCauses(raw: string, documentId: string): EvidenceQuote[] {
  const quotes: EvidenceQuote[] = [];
  const clauses = /(^|[\n;|]|\.\s+)([ \t]*Reported cause[ \t]*:[ \t]*([^\n;|]*?))(?=\.\s+(?=[A-Za-z])|[\n;|]|$)/gim;
  for (const match of raw.matchAll(clauses)) {
    const quote = match[2].trim();
    const value = match[3].trim().replace(/[.!]$/, "");
    if (quote.length > 600 || !isExplicitUnknownCause(value)) continue;
    const start = match.index! + match[1].length + match[2].indexOf(quote);
    quotes.push({ field: "reported_cause", value, quote, start, end: start + quote.length, source_document_id: documentId });
  }
  return quotes;
}

/** No DB access: the caller still owns copy ancestry and membership verification. */
export function readTriageDocument(input: TriageDocumentInput, revisions: ReadonlyMap<string, number>, selectedRevision: number): TriageDocument {
  const originRevision = revisions.get(input.associationAnalysisId);
  if (originRevision === undefined) throw new Error("Report attachment analysis is not linked to this incident.");
  if (input.extractionSource === null) {
    if (input.extractionJson !== null || input.corrections.latestCorrectionId !== null || input.corrections.selectedCorrectionId !== null || input.corrections.history.length !== 0) throw new Error("Unextracted reports cannot have extracted facts or corrections.");
    return { input, facts: null, correctionId: null, unknownCauseQuotes: [] };
  }
  const original = verifyStoredExtraction(input.rawText, input.id, input.incidentId, input.extractionJson);
  if (!original || original.association.analysisId !== input.associationAnalysisId) throw new Error("Original report extraction or association could not be verified.");
  const state = verifyCorrectionState(input.rawText, input.id, original.extraction, input.corrections, selectedRevision);
  if (!state || state.history.some((row) => revisions.get(row.analysisId) !== row.analysisRevision || row.analysisRevision < originRevision)) throw new Error("Report correction history or analysis provenance could not be verified.");
  const selected = state.history.find((row) => row.id === state.selectedCorrectionId);
  const facts = selected?.extraction ?? original.extraction;
  const causeChanged = state.history.some((row) => row.analysisRevision <= selectedRevision && row.input.change.field === "reported_cause");
  // fallback-v1 intentionally drops some unavailable values. Preserve it and
  // separately cite only explicit unknown clauses, unless an operator replaced
  // or cleared that cause in the applicable history.
  const unknownCauseQuotes = facts.reported_cause !== null
    ? isExplicitUnknownCause(facts.reported_cause) ? facts.evidence_quotes.filter((q) => q.field === "reported_cause" && q.value === facts.reported_cause) : []
    : causeChanged ? [] : originalUnknownCauses(input.rawText, input.id);
  return { input, facts, correctionId: selected?.id ?? null, unknownCauseQuotes };
}

export function documentSources(doc: TriageDocument, field?: ExtractionField): TriageSource[] {
  const quotes = field ? doc.facts?.evidence_quotes.filter((q) => q.field === field) ?? [] : [];
  return quotes.length ? quotes.map((quote) => ({ type: "document", id: doc.input.id, correctionId: doc.correctionId, quote: structuredClone(quote) })) : [{ type: "document", id: doc.input.id, correctionId: doc.correctionId }];
}
