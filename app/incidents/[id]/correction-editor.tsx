"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { arrayFields, fieldLabels, scalarFields, type ExtractionField } from "../../../lib/documents/contract";
import { applyCorrection, correctionInputSchema, correctionReceiptSchema, passageOccurrences, timeFields, type CorrectionInput } from "../../../lib/documents/corrections";
import type { ExtractedFacts } from "../../../lib/documents/contract";
import type { IncidentDetail } from "../../../lib/incidents/types";

type Item = { value: string; quote: string; occurrence: string; context: string; contextOccurrence: string };
const blank = (): Item => ({ value: "", quote: "", occurrence: "", context: "", contextOccurrence: "" });
export default function CorrectionEditor({ document, analysisId, expectedCorrectionId, previous, onFeedback, onClose }: {
  document: IncidentDetail["documents"][number]; analysisId: string; expectedCorrectionId: string | null; previous: ExtractedFacts;
  onFeedback: (message: string, error: boolean) => void; onClose: () => void;
}) {
  const router = useRouter();
  const [field, setField] = useState<ExtractionField>("equipment_id"), [items, setItems] = useState<Item[]>([blank()]);
  const [clear, setClear] = useState(false), [reason, setReason] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const inFlight = useRef(false), pending = useRef<CorrectionInput | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const array = (arrayFields as readonly string[]).includes(field), time = timeFields.has(field), token = field === "equipment_id" || field === "batches_mentioned";
  const patch = (index: number, change: Partial<Item>) => setItems((old) => old.map((item, i) => i === index ? { ...item, ...change } : item));
  function passage(quote: string, occurrence: string) {
    const matches = passageOccurrences(document.rawText, quote);
    const selected = matches.length === 1 ? matches[0] : occurrence !== "" ? matches[Number(occurrence)] : undefined;
    if (selected === undefined) throw new Error("Copy a complete original source line exactly. If it occurs more than once, choose its occurrence.");
    return { quote, start: selected, end: selected + quote.length };
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (inFlight.current) return;
    let input: CorrectionInput;
    try {
      if (pending.current) input = pending.current;
      else {
        const evidence = clear ? [] : items.map((item) => ({ ...passage(item.quote, item.occurrence), field, value: time || token ? item.value.trim() : item.quote.trim(), source_document_id: document.id, ...(time && item.context ? { time_zone_context: passage(item.context, item.contextOccurrence) } : {}) }));
        const value = clear ? array ? [] : null : array ? evidence.map((q) => q.value) : evidence[0].value;
        const parsed = correctionInputSchema.safeParse({ requestId: crypto.randomUUID(), analysisId, expectedCorrectionId, reason: reason.trim(), change: { field, value, evidence_quotes: evidence, supportConfirmed: confirmed } });
        if (!parsed.success) throw new Error("Enter a reason, confirm source relevance, and provide one supported value/passage per item. Times need a full ISO date and explicit offset.");
        input = parsed.data;
        applyCorrection(document.rawText, document.id, previous, input);
      }
    } catch (error) { onFeedback(error instanceof Error ? error.message : "Check the correction and source passages.", true); return; }
    pending.current = input; inFlight.current = true; setBusy(true); onFeedback("", false);
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(document.id)}/extraction`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), cache: "no-store" });
      const body: unknown = await response.json();
      if (!mounted.current) return;
      if (!response.ok) {
        const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null && "message" in body.error && typeof body.error.message === "string" ? body.error.message : "Correction save could not be confirmed. Inspect history or retry the same submission.";
        if (response.status >= 400 && response.status < 500) { pending.current = null; setUncertain(false); router.refresh(); }
        else setUncertain(true);
        onFeedback(message, true); return;
      }
      const receipt = correctionReceiptSchema.parse(body);
      if (receipt.documentId !== document.id || receipt.analysisId !== input.analysisId || receipt.correctionId !== `correction-${input.requestId}`) throw new Error("Invalid correction receipt");
      onFeedback(`Operator correction ${receipt.revision} ${receipt.reused ? "confirmed" : "saved"}. Original text and fallback extraction are preserved.`, false);
      pending.current = null; setUncertain(false); onClose(); router.refresh();
    } catch {
      if (mounted.current) { setUncertain(true); onFeedback("The correction could not be confirmed. This submission is retained. Inspect history or retry the same submission safely.", true); }
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  const quoteControl = (item: Item, i: number, context = false) => {
    const value = context ? item.context : item.quote, occurrence = context ? item.contextOccurrence : item.occurrence;
    const matches = passageOccurrences(document.rawText, value), id = `${document.id}-${context ? "zone" : "quote"}-${i}`;
    return <div><label htmlFor={id} className="block text-sm font-medium">{context ? "Explicit IST context line (optional)" : `Exact source passage ${i + 1}`}</label><textarea id={id} value={value} maxLength={600} rows={3} required={!context} onChange={(event) => patch(i, context ? { context: event.target.value, contextOccurrence: "" } : { quote: event.target.value, occurrence: "" })} className="mt-2 w-full rounded-lg border border-line p-3 text-sm" />{value && <p className="mt-1 text-xs text-muted">{matches.length ? `${matches.length} exact complete-line occurrence${matches.length === 1 ? "" : "s"} found.` : "No matching complete source line found."}</p>}{matches.length > 1 && <div className="mt-2"><label htmlFor={`${id}-occurrence`} className="block text-xs">{context ? "Choose timezone occurrence" : `Choose source occurrence ${i + 1}`}</label><select id={`${id}-occurrence`} value={occurrence} required onChange={(event) => patch(i, context ? { contextOccurrence: event.target.value } : { occurrence: event.target.value })} className="mt-1 w-full rounded-lg border border-line bg-white p-3 text-sm"><option value="">Choose occurrence</option>{matches.map((at, n) => <option key={at} value={n}>Occurrence {n + 1} · source line {document.rawText.slice(0, at).split("\n").length}</option>)}</select></div>}</div>;
  };
  return <form aria-label={`Correct facts in ${document.filename}`} onSubmit={submit} className="mt-4 min-w-0 space-y-4 rounded-xl border border-teal p-4">
    <h3 className="font-semibold">Correct extracted facts</h3><p className="text-xs leading-6 text-muted">Change one field. Copy complete original lines to retain qualifiers. Free-text wording is copied verbatim; identifiers must appear as whole tokens. Full dates and explicit timezone support are required for times. Source matching checks literal support; you confirm the passage’s relevance. These remain reported facts for human review.</p>
    <fieldset disabled={busy || uncertain} className="min-w-0 space-y-4">
      <div><label htmlFor={`${document.id}-field`} className="block text-sm font-medium">Field to correct</label><select id={`${document.id}-field`} value={field} onChange={(event) => { setField(event.target.value as ExtractionField); setItems([blank()]); setClear(false); setConfirmed(false); }} className="mt-2 w-full rounded-lg border border-line bg-white p-3 text-sm">{[...scalarFields, ...arrayFields].map((key) => <option key={key} value={key}>{fieldLabels[key]}</option>)}</select></div>
      <label className="flex items-start gap-3 text-sm leading-7"><input type="checkbox" checked={clear} onChange={(event) => setClear(event.target.checked)} className="mt-2" />Clear this field as unsupported or unrecorded</label>
      {!clear && items.map((item, i) => <div key={i} className="min-w-0 space-y-3 rounded-lg bg-surface p-3">{(time || token) && <div><label htmlFor={`${document.id}-value-${i}`} className="block text-sm font-medium">{time ? "Corrected timestamp with offset" : `Corrected identifier ${i + 1}`}</label><input id={`${document.id}-value-${i}`} value={item.value} onChange={(event) => patch(i, { value: event.target.value })} required maxLength={600} placeholder={time ? "2026-03-10T05:10:00+05:30" : "REF-01"} className="mt-2 w-full rounded-lg border border-line bg-white p-3 text-sm" /></div>}{quoteControl(item, i)}{time && quoteControl(item, i, true)}{!time && !token && item.quote && <p className="whitespace-pre-wrap break-words text-xs leading-6">Corrected wording: {item.quote.trim()}</p>}{array && items.length > 1 && <button type="button" className="button-secondary" onClick={() => setItems((old) => old.filter((_, n) => n !== i))}>Remove item {i + 1}</button>}</div>)}
      {array && !clear && <button type="button" disabled={items.length >= 100} className="button-secondary" onClick={() => setItems((old) => [...old, blank()])}>Add another item</button>}
      <div><label htmlFor={`${document.id}-reason`} className="block text-sm font-medium">Reason for correction</label><textarea id={`${document.id}-reason`} value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={600} rows={2} className="mt-2 w-full rounded-lg border border-line p-3 text-sm" /></div>
      <label className="flex items-start gap-3 text-sm leading-7"><input type="checkbox" required checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-2" />I confirm the quoted passages support this field, or that I am explicitly clearing unsupported information.</label>
    </fieldset>
    <div className="flex flex-wrap gap-3"><button type="submit" disabled={busy} className="button-primary">{busy ? "Saving correction…" : uncertain ? "Retry same correction" : "Save operator correction"}</button><button type="button" disabled={busy} onClick={() => router.refresh()} className="button-secondary">Refresh correction history</button><button type="button" disabled={busy || uncertain} onClick={onClose} className="button-secondary">Cancel correction</button></div>
  </form>;
}
