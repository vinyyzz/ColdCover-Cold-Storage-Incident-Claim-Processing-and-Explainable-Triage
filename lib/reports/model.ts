import { arrayFields, scalarFields, type EvidenceQuote, type ExtractedFacts } from "../documents/contract";
import { verifyCorrectionState } from "../documents/corrections";
import { verifyStoredExtraction } from "../documents/extract";
import { buildEvidenceTimeline } from "../incidents/timeline";
import type { getReviewerPacket } from "../reviews/service";
import { workflowFor } from "../reviews/contract";
import type { TriageSource } from "../rules/triage-types";

type ReviewerPacket = Awaited<ReturnType<typeof getReviewerPacket>>;
export function prepareReport(data: ReviewerPacket, state: string) {
  const { packet, review } = data;
  if (packet.status !== "available" || review.status !== "available" || !packet.data.evidence || packet.data.triage.status !== "available" || packet.data.summary.status !== "available" || packet.data.timeline.status !== "available") throw new Error("Verified report sources unavailable");
  const last = review.history.at(-1);
  if (last ? review.workflow !== workflowFor(last.status) : !["claim_prepared", "submitted"].includes(review.workflow)) throw new Error("Verified review workflow unavailable");
  const { evidence, triage, summary, timeline } = packet.data;
  if (!triage.criteria.policy) throw new Error("Frozen report policy unavailable");
  const readings = timeline.readings;
  const documents = [...packet.data.documents.map((document) => ({ document, corrections: packet.data.documentCorrections[document.id], copy: packet.data.documentCopies[document.id], ancestor: false })), ...packet.copySources.map((source) => ({ ...source, ancestor: true }))];
  if (new Set(documents.map((row) => row.document.id)).size !== documents.length) throw new Error("Duplicate report source");
  const passages: { source: Extract<TriageSource, { type: "document" }>; anchor: string }[] = [];
  const addSource = (source: TriageSource) => {
    if (source.type === "document") {
      const doc = documents.find((row) => row.document.id === source.id);
      if (!doc) throw new Error("Report document reference unavailable");
      if (source.quote) {
        const q = source.quote;
        if (q.source_document_id !== source.id || doc.document.rawText.slice(q.start, q.end) !== q.quote || (q.time_zone_context && doc.document.rawText.slice(q.time_zone_context.start, q.time_zone_context.end) !== q.time_zone_context.quote)) throw new Error("Report passage does not match original");
        if (!passages.some((item) => JSON.stringify(item.source) === JSON.stringify(source))) passages.push({ source, anchor: `passage-${passages.length + 1}` });
      }
    } else if (source.type === "reading" ? !readings.some((row) => row.id === source.id) : source.type === "batch" ? !evidence.exposure.batches.some((row) => row.id === source.id) : source.type === "analysis" ? source.id !== evidence.revision.analysisId : source.type === "policy" ? source.id !== triage.criteria.policy!.id : source.type === "equipment" ? source.id !== triage.criteria.equipment.id : source.id !== triage.criteria.settingsId) throw new Error("Report reference unavailable");
  };
  for (const fact of summary.facts) fact.sources.forEach(addSource);
  for (const item of [...triage.result.readiness.reasons, ...triage.result.priority.reasons, ...triage.result.conflicts, ...triage.result.checklist, ...triage.result.questions]) item.sources.forEach(addSource);
  const reportDocuments = documents.map((row) => {
    const original = row.document.extractionSource === "fallback" ? verifyStoredExtraction(row.document.rawText, row.document.id, row.document.incidentId, row.document.extractionJson) : null;
    const selectedRevision = row.ancestor ? null : evidence.revision.revision;
    const corrections = original ? verifyCorrectionState(row.document.rawText, row.document.id, original.extraction, row.corrections, selectedRevision) : null;
    if ((row.document.docType === "maintenance_report" || row.document.docType === "stock_inspection_report") && row.document.extractionSource !== null && !original || original && !corrections) throw new Error("Report extraction history unavailable");
    const selected = corrections?.history.find((item) => item.id === corrections.selectedCorrectionId);
    const effective = selected?.extraction ?? original?.extraction ?? null;
    const quotes = (facts: ExtractedFacts | null, correctionId: string | null) => facts?.evidence_quotes.forEach((quote) => addSource({ type: "document", id: row.document.id, correctionId, quote }));
    quotes(original?.extraction ?? null, null); quotes(effective, selected?.id ?? null);
    for (const correction of corrections?.history ?? []) correction.input.change.evidence_quotes.forEach((quote) => addSource({ type: "document", id: row.document.id, correctionId: correction.id, quote }));
    return { ...row, original, effective, selected, corrections };
  });
  const charts = Array.from({ length: Math.max(1, Math.ceil(readings.length / 1000)) }, (_, page) => {
    const chart = buildEvidenceTimeline(packet.data, page);
    if (!chart) throw new Error("Report chart unavailable");
    const prior = readings[page * 1000 - 1], first = chart.readings[0];
    return { ...chart, boundaryGap: prior && Date.parse(first.recordedAt) - Date.parse(prior.recordedAt) > evidence.settings.maxGapMinutes * 60000 ? { left: prior, right: first } : null };
  });
  const sourceTarget = (source: TriageSource) => {
    addSource(source);
    if (source.type === "document") {
      const index = reportDocuments.findIndex((row) => row.document.id === source.id);
      const passage = source.quote ? passages.find((item) => JSON.stringify(item.source) === JSON.stringify(source)) : null;
      return { anchor: passage?.anchor ?? `document-${index + 1}`, label: `D${index + 1}${passage ? `, quote ${passages.indexOf(passage) + 1}` : ""}` };
    }
    if (source.type === "reading") { const index = readings.findIndex((row) => row.id === source.id); return { anchor: `reading-${index + 1}`, label: `R${index + 1}` }; }
    if (source.type === "batch") { const index = evidence.exposure.batches.findIndex((row) => row.id === source.id); return { anchor: `batch-${index + 1}`, label: `B${index + 1}` }; }
    return { anchor: source.type === "analysis" ? "saved-analysis" : source.type === "policy" ? "saved-policy" : "saved-criteria", label: source.type === "analysis" ? "A1" : source.type === "policy" ? "P1" : "C1" };
  };
  return { state, claimId: packet.claim.id, preparedAt: packet.preparedAt, checkedAt: review.checkedAt, disclaimer: packet.disclaimer, incident: packet.data.incident, chamber: packet.data.chamber, evidence, triage: triage.result, criteria: triage.criteria, policy: triage.criteria.policy, summary, review, readings, charts, documents: reportDocuments, passages, sourceTarget };
}
export type ClaimReport = ReturnType<typeof prepareReport>;
export function factRows(facts: ExtractedFacts | null) {
  return facts ? [...scalarFields, ...arrayFields].flatMap((field) => {
    const value = facts[field], values = Array.isArray(value) ? value : value === null ? [] : [value];
    return values.map((value) => ({ field, value, quotes: facts.evidence_quotes.filter((quote) => quote.field === field && quote.value === value) }));
  }) : [];
}
export function quoteSource(documentId: string, correctionId: string | null, quote: EvidenceQuote): TriageSource { return { type: "document", id: documentId, correctionId, quote }; }
