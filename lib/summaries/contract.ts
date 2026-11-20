import { z } from "zod";
import { quoteSchema } from "../documents/contract";

const id = z.string().min(1).max(600);
export const summarySourceSchema = z.union([
  z.object({ type: z.literal("document"), id, correctionId: id.nullable(), quote: quoteSchema.optional() }).strict(),
  z.object({ type: z.enum(["reading", "batch", "analysis", "equipment", "settings", "policy"]), id }).strict(),
]);
const text = z.string().min(1).max(3000).refine((value) => value.isWellFormed());
export const summaryFactSchema = z.object({
  source_id: id,
  kind: z.enum(["interval", "inventory", "batch", "report", "gap", "conflict", "missing"]),
  text, sources: z.array(summarySourceSchema).min(1),
}).strict();
export const summaryStatementSchema = z.object({ text, source_ids: z.array(id).min(1) }).strict();
export type SummaryFact = z.infer<typeof summaryFactSchema>;
export type SummaryStatement = z.infer<typeof summaryStatementSchema>;
export interface FallbackSummary {
  version: "fallback-summary-v1";
  mode: "fallback";
  facts: SummaryFact[];
  statements: SummaryStatement[];
}

/** A deterministic statement must retain its complete canonical fact/citation. */
export function validateFallbackStatements(value: unknown, inputFacts: readonly SummaryFact[]): SummaryStatement[] {
  const facts = z.array(summaryFactSchema).min(1).parse(inputFacts);
  if (new Set(facts.map((fact) => fact.source_id)).size !== facts.length) throw new Error("Summary fact identifiers must be unique.");
  const statements = z.array(summaryStatementSchema).parse(value);
  if (statements.length !== facts.length || statements.some((statement, index) => statement.text !== facts[index].text || statement.source_ids.length !== 1 || statement.source_ids[0] !== facts[index].source_id)) throw new Error("Summary statements must match their supported facts and citations.");
  return statements;
}
