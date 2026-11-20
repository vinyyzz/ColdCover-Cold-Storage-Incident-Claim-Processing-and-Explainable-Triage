import { z } from "zod";
import { documentInputSchema, extractionSchema, type ExtractedFacts } from "../documents/contract";
import { extractDocument } from "../documents/extract";
import { summaryFactSchema, summarySourceSchema, summaryStatementSchema, type SummaryStatement } from "../summaries/contract";

// Bump when prompts, support rules, source semantics or fallback versions change.
export const AI_BOUNDARY_VERSION = "ai-boundary-v1:fallback-v1:fallback-summary-v1:triage-v1";
const id = z.string().min(1).max(600).refine((s) => s.trim() === s && s.trim().length > 0 && s.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(s));
const text = z.string().min(1).max(3000).refine((s) => s.trim().length > 0 && s.isWellFormed());
const scopeSchema = z.object({ incidentId: id, analysisId: id, intervalId: id.nullable(), sourceVersion: id }).strict();
const documentSchema = z.object({ id, correctionId: id.nullable(), rawText: documentInputSchema.shape.rawText }).strict();
const referenceSchema = z.object({ type: z.enum(["reading", "batch", "analysis", "equipment", "settings", "policy"]), id }).strict();
const sources = { documents: z.array(documentSchema).max(100), references: z.array(referenceSchema).max(20_000) };
const questionItemSchema = z.object({
  id, kind: z.enum(["missing", "conflict"]), text, question: text,
  sources: z.array(summarySourceSchema).min(1).max(1000),
}).strict();
export const aiInputSchema = z.discriminatedUnion("task", [
  z.object({ task: z.literal("extraction"), scope: scopeSchema, document: z.object({
    id, docType: documentInputSchema.shape.docType, rawText: documentInputSchema.shape.rawText,
    // Initial extraction cannot overwrite an effective operator correction.
    correctionId: z.null(),
  }).strict() }).strict(),
  z.object({ task: z.literal("summary"), scope: scopeSchema, ...sources, facts: z.array(summaryFactSchema).min(1).max(2000) }).strict(),
  z.object({ task: z.literal("questions"), scope: scopeSchema, ...sources, items: z.array(questionItemSchema).max(2000) }).strict(),
]);
export type AiInput = z.infer<typeof aiInputSchema>;
export type AiTask = AiInput["task"];
export const questionOutputSchema = z.object({ target_id: id, text }).strict();
export type AiQuestion = z.infer<typeof questionOutputSchema>;
export type ValidatedAiOutput =
  | { task: "extraction"; output: ExtractedFacts }
  | { task: "summary"; output: SummaryStatement[] }
  | { task: "questions"; output: AiQuestion[] };

function unique(ids: string[]) { return new Set(ids).size === ids.length; }
const referenceKey = (source: { type: string; id: string }) => JSON.stringify([source.type, source.id]);

/** Input is local, already eligible evidence, never an unverified HTTP body. */
export function parseAiInput(value: unknown): AiInput {
  const input = aiInputSchema.parse(value);
  if (input.task === "extraction") return input;
  if (!unique(input.documents.map((doc) => doc.id)) || !unique(input.references.map(referenceKey))) throw new Error("AI source identities must be unique.");
  const refs = new Set(input.references.map(referenceKey));
  if (input.references.some((ref) => ref.type === "analysis" && ref.id !== input.scope.analysisId)) throw new Error("AI analysis source differs from selected scope.");
  const rows = input.task === "summary" ? input.facts.map((fact) => ({ id: fact.source_id, sources: fact.sources })) : input.items;
  if (!unique(rows.map((row) => row.id))) throw new Error("AI fact/question identities must be unique.");
  for (const source of rows.flatMap((row) => row.sources)) {
    if (source.type !== "document") {
      if (!refs.has(referenceKey(source))) throw new Error("AI source is absent from the verified manifest.");
      continue;
    }
    const doc = input.documents.find((doc) => doc.id === source.id);
    if (!doc || doc.correctionId !== source.correctionId) throw new Error("AI document source version differs.");
    const exact = (passage: { start: number; end: number; quote: string }) => passage.end > passage.start && passage.end <= doc.rawText.length && doc.rawText.slice(passage.start, passage.end) === passage.quote;
    if (source.quote && (source.quote.source_document_id !== doc.id || !exact(source.quote) || (source.quote.time_zone_context && !exact(source.quote.time_zone_context)))) throw new Error("AI source passage differs from its original.");
  }
  return input;
}

export function fallbackOutput(input: AiInput): ValidatedAiOutput {
  if (input.task === "extraction") return { task: "extraction", output: extractDocument(input.document.rawText, input.document.id, { method: "operator_selected", incidentId: input.scope.incidentId, analysisId: input.scope.analysisId }).extraction };
  if (input.task === "summary") return { task: "summary", output: input.facts.map((fact) => ({ text: fact.text, source_ids: [fact.source_id] })) };
  return { task: "questions", output: input.items.map((item) => ({ target_id: item.id, text: item.question })) };
}

export const questionWording = (question: string) => [question, `Please clarify the following: ${question}`];

/** Citation validity alone cannot prove that arbitrary prose follows from facts. */
export function validateAiOutput(input: AiInput, value: unknown): ValidatedAiOutput {
  if (input.task === "extraction") {
    const output = extractionSchema.parse(value), expected = fallbackOutput(input).output;
    // Exact canonical support includes offsets, IDs, timezone context and nulls
    // for conflicting/unsupported fields. No semantic guesses enter evidence.
    if (JSON.stringify(output) !== JSON.stringify(expected)) throw new Error("Extraction is not independently supported by the original.");
    return { task: "extraction", output };
  }
  if (input.task === "summary") {
    const output = z.array(summaryStatementSchema).min(1).max(2000).parse(value);
    const seen = new Set<string>();
    for (const statement of output) {
      const facts = statement.source_ids.map((id) => input.facts.find((fact) => fact.source_id === id));
      if (facts.some((fact) => !fact) || !unique(statement.source_ids) || statement.source_ids.some((id) => seen.has(id)) || statement.text !== facts.map((fact) => fact!.text).join(" ")) throw new Error("Summary text and citations differ from supported facts.");
      for (const id of statement.source_ids) seen.add(id);
    }
    if (seen.size !== input.facts.length) throw new Error("Summary must retain uncertainty and every supplied fact.");
    return { task: "summary", output };
  }
  const output = z.array(questionOutputSchema).max(2000).parse(value);
  if (output.length !== input.items.length || !unique(output.map((row) => row.target_id)) || output.some((row) => {
    const item = input.items.find((item) => item.id === row.target_id);
    return !item || !questionWording(item.question).includes(row.text);
  })) throw new Error("Questions must retain their supported targets and neutral wording.");
  return { task: "questions", output };
}
