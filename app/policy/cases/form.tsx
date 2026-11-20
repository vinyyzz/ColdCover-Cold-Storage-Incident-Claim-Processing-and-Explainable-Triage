"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { fromIstInput } from "@/lib/inventory/format";
import { catalogue, evidenceLabels, extensions, extensionIds, policyIds, schedules, scheduleIds, scheduleLabel, type PolicyId, type ScheduleId } from "@/lib/policy-cases/catalogue";
import { caseDraftSchema, targetSchema, type CaseDraft } from "@/lib/policy-cases/contract";
import { caseErrorMessage, sendCaseJson } from "@/lib/policy-cases/client";
import type { CaseInputs, CaseSnapshot, VerifiedPacket } from "@/lib/policy-cases/service";
import CaseEvidence from "./evidence";
import { inputClass, primaryClass, secondaryClass } from "./styles";

type Preview = {snapshot: CaseSnapshot; hash: string};
type RecordEntry = CaseDraft["evidence"][number] & { key: number };
type Target = CaseDraft["targets"][number] & { key: number };
const targetTypes = targetSchema.shape.type.options;
const selectedSchedule = (id: string | null): ScheduleId | undefined => id === null ? "potato" : scheduleIds.find((key) => key === id);

export default function CaseForm({ inputs, initialPolicy, initialIncident }: { inputs: CaseInputs; initialPolicy: PolicyId; initialIncident?: string }) {
  const router = useRouter();
  const [policyId, setPolicy] = useState(initialPolicy);
  const [source, setSource] = useState<"stored" | "csv" | "none">("stored");
  const [event, setEvent] = useState(catalogue[initialPolicy].triggers[0]);
  const [batchIds, setBatches] = useState<string[]>([]);
  const [selectedExtensions, setExtensions] = useState<CaseDraft["extensions"]>([]);
  const [targets, setTargets] = useState<Target[]>([{ key: 0, code: "", description: "", type: initialPolicy === "machinery" ? "equipment" : "cold_room" }]);
  const [evidence, setEvidence] = useState<RecordEntry[]>([]);
  const [key, setKey] = useState(1);
  const [preview, setPreview] = useState<{draft: CaseDraft; value: Preview; id: string}>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const policy = catalogue[policyId], goods = policy.group === "goods";
  const eligible = inputs.batches.flatMap((batch) => {
    const id = selectedSchedule(batch.scheduleId);
    return id && schedules[id].policyId === policyId ? [{ ...batch, id: batch.id, schedule: id }] : [];
  });
  const extensionOptions = extensionIds.filter((id) => {
    const extension = extensions[id];
    return extension.policyId === policyId && (!extension.schedule || eligible.some((b) => batchIds.includes(b.id) && b.schedule === extension.schedule));
  });
  function switchPolicy(id: PolicyId) {
    setPolicy(id); setBatches([]); setExtensions([]); setEvidence([]); setEvent(catalogue[id].triggers[0]);
    setTargets([{ key: 0, code: "", description: "", type: id === "machinery" ? "equipment" : "cold_room" }]);
  }
  function invalidate() { setPreview(undefined); setConfirmed(false); setError(""); }
  async function inspect(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(""); setBusy(true);
    const data = new FormData(e.currentTarget);
    try {
      const draft = caseDraftSchema.parse({
        title: data.get("title"), policyId, event: event === "other" ? data.get("otherEvent") : event,
        incidentId: data.get("incident") || undefined, batchIds: goods ? batchIds : [],
        targets: goods ? [] : targets.map(({ code, description, type }) => ({ code, description, type })),
        extensions: goods ? selectedExtensions.filter((id) => extensionOptions.includes(id)) : [],
        evidence: evidence.map(({ kind, title, text }) => ({ kind, title, text })),
        readings: !goods || source === "none" ? { source: "none" } : source === "csv"
          ? { source, csv: data.get("csv") }
          : { source, from: fromIstInput(String(data.get("from"))), to: fromIstInput(String(data.get("to"))) },
      });
      const value = await sendCaseJson<Preview>("/api/policy-cases/preview", draft);
      setPreview({ draft, value, id: crypto.randomUUID() }); setConfirmed(false);
    } catch (cause) { setError(caseErrorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!preview || !confirmed) return;
    setBusy(true); setError("");
    try {
      const saved = await sendCaseJson<VerifiedPacket>("/api/policy-cases", { id: preview.id, draft: preview.draft, expectedHash: preview.value.hash, confirmed: true });
      router.push(`/policy/cases/${saved.id}`);
    } catch (cause) { setError(caseErrorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <section id="new-policy-case" className="mt-8 rounded-xl border border-line bg-white p-5 sm:p-6">
    <h2 className="text-xl font-semibold">New evidence case</h2>
    <form onSubmit={inspect} onChange={invalidate} className="mt-4 space-y-5 text-sm">
      <fieldset disabled={busy} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label>Case title<input name="title" required maxLength={120} className={inputClass} /></label>
          <label>Policy<select value={policyId} onChange={(e) => switchPolicy(e.target.value as PolicyId)} className={inputClass}>
            {(["goods","operator"] as const).map((group) => <optgroup key={group} label={group === "goods" ? "Policies for the goods" : "Policies for the cold-storage operator"}>
              {policyIds.filter((id) => catalogue[id].group === group).map((id) => <option key={id} value={id}>{catalogue[id].name}</option>)}
            </optgroup>)}
          </select></label>
          <label>Reported event<select value={event} onChange={(e) => setEvent(e.target.value)} className={inputClass}>
            {policy.triggers.map((trigger) => <option key={trigger}>{trigger}</option>)}<option value="other">Other or uncertain event</option>
          </select></label>
          {event === "other" && <label>Describe reported event<input name="otherEvent" required maxLength={120} className={inputClass} /></label>}
          <label>Link original incident reports (optional)<select name="incident" defaultValue={initialIncident ?? ""} className={inputClass}>
            <option value="">No linked incident</option>{inputs.incidents.map((incident) => <option key={incident.id} value={incident.id}>{incident.title}</option>)}
          </select></label>
        </div>
        {goods ? <>
          <fieldset className="rounded-lg border border-line p-3">
            <legend className="px-1 font-semibold">Batches assigned to {policy.name}</legend>
            {eligible.length === 0 && <p className="text-muted">Assign a batch to this policy’s schedule in Inventory first.</p>}
            {eligible.map((batch) => <label key={batch.id} className="flex items-center gap-2 py-1">
              <input type="checkbox" checked={batchIds.includes(batch.id)} onChange={(e) => setBatches((previous) => e.target.checked ? [...previous, batch.id] : previous.filter((id) => id !== batch.id))} />
              {batch.batchCode} · {scheduleLabel(batch.schedule)}
            </label>)}
            <Link className="text-teal underline" href="/inventory#stock-schedules">Stock policy schedules</Link>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <label>Temperature source<select value={source} onChange={(e) => setSource(e.target.value as typeof source)} className={inputClass}>
              <option value="stored">Saved chamber readings</option><option value="csv">Paste case-specific temperature CSV</option><option value="none">Temperature evidence missing</option>
            </select></label>
            {source === "stored" && <div className="grid gap-2"><label>Start (IST)<input type="datetime-local" name="from" defaultValue="2026-03-10T00:00" required className={inputClass} /></label>
              <label>End (IST)<input type="datetime-local" name="to" defaultValue="2026-03-10T23:50" required className={inputClass} /></label></div>}
            {source === "csv" && <label>CSV with timestamp,temperature_c headers<textarea name="csv" required maxLength={180000} rows={5} className={inputClass} /></label>}
          </div>
          {extensionOptions.length > 0 && <fieldset className="rounded-lg border border-line p-3"><legend className="px-1 font-semibold">Optional evidence extensions</legend>
            {extensionOptions.map((id) => <label key={id} className="flex items-center gap-2 py-1"><input type="checkbox" checked={selectedExtensions.includes(id)} onChange={(e) => setExtensions((previous) => e.target.checked ? [...previous, id] : previous.filter((other) => other !== id))} />{extensions[id].name}</label>)}
          </fieldset>}
        </> : <fieldset className="space-y-3 rounded-lg border border-line p-3"><legend className="px-1 font-semibold">{policyId === "machinery" ? "Equipment units" : "Facility assets"}</legend>
          {targets.map((target, i) => <div key={target.key} className="grid gap-2 sm:grid-cols-3">
            <label>Asset or unit code {i+1}<input required maxLength={120} value={target.code} onChange={(e) => setTargets((previous) => previous.map((item) => item.key === target.key ? { ...item, code: e.target.value } : item))} className={inputClass} /></label>
            <label>Description {i+1}<input required maxLength={120} value={target.description} onChange={(e) => setTargets((previous) => previous.map((item) => item.key === target.key ? { ...item, description: e.target.value } : item))} className={inputClass} /></label>
            <label>Type {i+1}<select value={target.type} onChange={(e) => setTargets((previous) => previous.map((item) => item.key === target.key ? { ...item, type: e.target.value as Target["type"] } : item))} className={inputClass}>
              {targetTypes.filter((type) => (type === "equipment") === (policyId === "machinery")).map((type) => <option key={type} value={type}>{type.replaceAll("_"," ")}</option>)}</select></label>
            {targets.length > 1 && <button type="button" className={secondaryClass} onClick={() => { setTargets((previous) => previous.filter((item) => item.key !== target.key)); invalidate(); }}>Remove asset {i+1}</button>}
          </div>)}
          <button type="button" disabled={targets.length >= 12} className={secondaryClass} onClick={() => { setTargets((previous) => [...previous, { key, code: "", description: "", type: policyId === "machinery" ? "equipment" : "cold_room" }]); setKey(key+1); invalidate(); }}>Add another target</button>
        </fieldset>}
        <fieldset className="space-y-3 rounded-lg border border-line p-3"><legend className="px-1 font-semibold">Evidence records</legend>
          <p className="text-muted">Required for review: {policy.required.map((kind) => evidenceLabels[kind]).join(" · ")}</p>
          {evidence.map((record, i) => <div key={record.key} className="space-y-2 rounded-lg border border-line p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <label>Evidence kind {i+1}<select value={record.kind} onChange={(e) => setEvidence((previous) => previous.map((item) => item.key === record.key ? { ...item, kind: e.target.value as RecordEntry["kind"] } : item))} className={inputClass}>
                {Object.entries(evidenceLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
              <label>Evidence title {i+1}<input value={record.title} required maxLength={120} onChange={(e) => setEvidence((previous) => previous.map((item) => item.key === record.key ? { ...item, title: e.target.value } : item))} className={inputClass} /></label>
            </div>
            <label>Original record text {i+1}<textarea value={record.text} required maxLength={8000} rows={3} onChange={(e) => setEvidence((previous) => previous.map((item) => item.key === record.key ? { ...item, text: e.target.value } : item))} className={inputClass} /></label>
            <button type="button" className={secondaryClass} onClick={() => { setEvidence((previous) => previous.filter((item) => item.key !== record.key)); invalidate(); }}>Remove evidence {i+1}</button>
          </div>)}
          <button disabled={evidence.length >= 24} type="button" className={secondaryClass} onClick={() => { setEvidence((previous) => [...previous, { key, kind: policy.required.find((kind) => !previous.some((record) => record.kind === kind)) ?? policy.required[0], title: "", text: "" }]); setKey(key+1); invalidate(); }}>Add evidence record</button>
        </fieldset>
        <button className={primaryClass} disabled={busy}>Preview evidence</button>
      </fieldset>
    </form>
    {busy && <p role="status" className="mt-3 text-sm">Checking case evidence…</p>}
    {preview && <section className="mt-5 space-y-4 border-t border-line pt-5" aria-label="Evidence preview">
      <h3 className="text-xl font-semibold">Evidence preview · {preview.value.snapshot.title}</h3>
      <CaseEvidence snapshot={preview.value.snapshot} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I reviewed the evidence and selected policy.</label>
      <button type="button" disabled={!confirmed || busy} onClick={save} className={primaryClass}>Prepare immutable policy packet</button>
    </section>}
    {error && <p role="alert" className="mt-4 rounded-lg bg-surface p-3 text-sm">{error}</p>}
  </section>;
}
