"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ApiErrorBody, Batch } from "@/lib/inventory/types";
import { formatInr, formatIstDate, fromIstInput, stockPresence, toIstInput } from "@/lib/inventory/format";
import { batchInputSchema, instantSchema } from "@/lib/inventory/validation";
import { z } from "zod";
import { scheduleIds, scheduleLabel } from "@/lib/policy-cases/catalogue";

type FormValues = { batchCode: string; ownerName: string; quantityKg: string; recordedValueInr: string; enteredAt: string; exitedAt: string };
const emptyForm: FormValues = { batchCode: "", ownerName: "", quantityKg: "", recordedValueInr: "", enteredAt: "2026-03-10T03:00", exitedAt: "" };
const labels: Record<keyof FormValues, string> = { batchCode: "Batch code", ownerName: "Owner name", quantityKg: "Quantity (kg)", recordedValueInr: "Recorded value (INR, optional)", enteredAt: "Entry (IST)", exitedAt: "Exit (IST, optional)" };

export default function InventoryRegister({ initialBatches }: { initialBatches: Batch[] }) {
  const router = useRouter();
  const [records, setRecords] = useState(initialBatches);
  const [selectedAt, setSelectedAt] = useState("2026-03-10T03:00");
  const [onlyPresent, setOnlyPresent] = useState(false);
  const [editing, setEditing] = useState<Batch | null>(null);
  const [schedule, setSchedule] = useState("");
  const [form, setForm] = useState<FormValues>(emptyForm);
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState("");
  const [message, setMessage] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const lookup = instantSchema.safeParse(fromIstInput(selectedAt));
  const present = lookup.success ? records.filter((batch) => stockPresence(batch, lookup.data) === "present") : [];
  const visible = onlyPresent && lookup.success ? present : records;

  function openEditor(batch: Batch | null) {
    setEditing(batch); setSchedule(""); setFormError(""); setFields({}); setMessage("");
    setForm(batch ? { batchCode: batch.batchCode, ownerName: batch.ownerName, quantityKg: String(batch.quantityKg), recordedValueInr: batch.recordedValueInr === null ? "" : String(batch.recordedValueInr), enteredAt: toIstInput(batch.enteredAt), exitedAt: batch.exitedAt === null ? "" : toIstInput(batch.exitedAt) } : { ...emptyForm, enteredAt: selectedAt || emptyForm.enteredAt });
    dialog.current?.showModal();
  }

  async function refreshRecords() {
    setRefreshing(true); setRefreshError("");
    try {
      const response = await fetch("/api/batches", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const payload: { batches: Batch[] } = await response.json();
      setRecords(payload.batches); setMessage("Inventory records refreshed.");
    } catch { setRefreshError("Records could not be refreshed. Please try again."); }
    finally { setRefreshing(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFormError(""); setFields({});
    const input = batchInputSchema.safeParse({ scheduleId: !editing && schedule ? schedule : undefined, batchCode: form.batchCode, ownerName: form.ownerName, quantityKg: Number(form.quantityKg), recordedValueInr: form.recordedValueInr === "" ? null : Number(form.recordedValueInr), enteredAt: fromIstInput(form.enteredAt), exitedAt: form.exitedAt === "" ? null : fromIstInput(form.exitedAt) });
    if (!input.success) {
      setFields(z.flattenError(input.error).fieldErrors); setFormError("Check the highlighted fields."); return;
    }
    setSaving(true);
    try {
      const response = await fetch(editing ? `/api/batches/${encodeURIComponent(editing.id)}` : "/api/batches", { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.data) });
      const payload: { batch?: Batch } & Partial<ApiErrorBody> = await response.json();
      if (!response.ok || !payload.batch) {
        setFormError(payload.error?.message ?? "This record could not be saved. Please try again."); setFields(payload.error?.fields ?? {}); return;
      }
      const saved = payload.batch;
      setRecords((current) => [...current.filter((batch) => batch.id !== saved.id), saved].sort((a, b) => a.batchCode.localeCompare(b.batchCode)));
      setMessage(`Batch ${saved.batchCode} saved. Changes are recorded in the audit log.`);
      dialog.current?.close(); router.refresh();
    } catch { setFormError("The save could not be confirmed. Refresh records before retrying to check whether it completed."); }
    finally { setSaving(false); }
  }

  return (
    <div className="mt-8">
      <div className="grid gap-4 sm:grid-cols-3">
        {[["Registered batches", records.length], ["Present at selected time", lookup.success ? present.length : "—"], ["Missing recorded values", records.filter((batch) => batch.recordedValueInr === null).length]].map(([label, value]) => <div key={label} className="rounded-xl border border-line bg-white p-5"><p className="text-xs font-medium text-muted">{label}</p><p className="mt-2 text-2xl font-semibold">{value}</p></div>)}
      </div>
      <section aria-labelledby="lookup-heading" className="mt-6 rounded-2xl border border-line bg-white p-6">
        <h2 id="lookup-heading" className="font-semibold">Stock present at time</h2>
        <div className="mt-4 flex flex-wrap items-end gap-5">
          <div><label htmlFor="stock-time" className="block text-sm font-medium">Date and time (IST)</label><input id="stock-time" type="datetime-local" step="1" value={selectedAt} onChange={(event) => setSelectedAt(event.target.value)} className="form-input mt-2" aria-describedby="lookup-help" /></div>
          <label className="flex items-center gap-2 py-3 text-sm"><input type="checkbox" checked={onlyPresent} onChange={(event) => setOnlyPresent(event.target.checked)} disabled={!lookup.success} /> Show only present batches</label>
        </div>
        <p id="lookup-help" className="mt-3 text-xs leading-6 text-muted">All times use IST (+05:30). A batch is present from entry up to, but not including, its exit time. The initial time is from the fictional worked example.</p>
        {!lookup.success && <p role="alert" className="mt-2 text-sm text-red-800">Choose a valid date and time to check stock presence.</p>}
      </section>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-4"><h2 className="text-xl font-semibold">Batch records</h2><div className="flex gap-3"><button className="button-secondary" onClick={refreshRecords} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh records"}</button><button className="button-primary" onClick={() => openEditor(null)}>Add batch</button></div></div>
      <p role="status" className="mt-3 min-h-6 text-sm text-teal">{message}</p>
      {refreshError && <p role="alert" className="mb-3 text-sm text-red-800">{refreshError}</p>}
      <div className="overflow-x-auto rounded-2xl border border-line bg-white focus-visible:outline-2 focus-visible:outline-teal" role="region" aria-label="Inventory records table; scroll horizontally on small screens" tabIndex={0}>
        <table className="w-full min-w-[940px] text-left text-sm">
          <caption className="sr-only">CH-1 batches, recorded values, storage times in IST, and presence at the selected time</caption>
          <thead className="border-b border-line bg-surface text-xs text-muted"><tr>{["Batch / owner", "Quantity", "Recorded value", "Entry / exit (IST)", "At selected time", "Actions"].map((heading) => <th key={heading} scope="col" className="px-5 py-4 font-medium">{heading}</th>)}</tr></thead>
          <tbody className="divide-y divide-line">
            {visible.map((batch) => {
              const presence = lookup.success ? stockPresence(batch, lookup.data) : null;
              return <tr key={batch.id} className={presence && presence !== "present" ? "bg-surface/60 text-muted" : ""}>
                <th scope="row" className="px-5 py-5 font-normal"><span className="block font-semibold text-ink">{batch.batchCode}</span><span className="mt-1 block text-xs text-muted">{batch.ownerName}</span></th>
                <td className="px-5 py-5 whitespace-nowrap">{new Intl.NumberFormat("en-IN").format(batch.quantityKg)} kg</td>
                <td className="px-5 py-5 whitespace-nowrap">{batch.recordedValueInr === null ? <span className="font-medium text-amber-900">Not recorded</span> : formatInr(batch.recordedValueInr)}</td>
                <td className="px-5 py-5 text-xs leading-6 whitespace-nowrap"><span className="block">In: {formatIstDate(batch.enteredAt)}</span><span className="block text-muted">Out: {batch.exitedAt === null ? "Still stored" : formatIstDate(batch.exitedAt)}</span></td>
                <td className="px-5 py-5"><span className={presence === "present" ? "rounded-full bg-teal-soft px-3 py-1 text-xs font-medium text-teal" : "text-xs"}>{presence === "present" ? "Present" : presence === "not_entered" ? "Not yet entered" : presence === "departed" ? "Already departed" : "Choose a time"}</span></td>
                <td className="px-5 py-5"><button onClick={() => openEditor(batch)} className="font-medium text-teal underline underline-offset-4" aria-label={`Edit batch ${batch.batchCode}`}>Edit</button></td>
              </tr>;
            })}
            {visible.length === 0 && <tr><td colSpan={6} className="px-6 py-12 text-center text-muted">{records.length === 0 ? "No batches registered yet. Add your first batch to begin." : "No batches were present at the selected time."}</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs leading-6 text-muted">Recorded inventory values and stock presence are evidence records. Incident exposure is calculated separately during investigation.</p>
      <dialog ref={dialog} aria-labelledby="batch-dialog-title" className="m-auto max-h-[90vh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-2xl border border-line bg-white p-6 text-ink shadow-xl backdrop:bg-ink/40" onCancel={(event) => { if (saving) event.preventDefault(); }}>
        <h2 id="batch-dialog-title" className="text-xl font-semibold">{editing ? `Edit batch ${editing.batchCode}` : "Add batch"}</h2>
        <p className="mt-2 text-xs leading-6 text-muted">Chamber CH-1 · Potatoes. Entry defaults to the selected lookup time. All storage times are IST.</p>
        <form onSubmit={save} className="mt-5">
          <fieldset disabled={saving} className="grid gap-4 sm:grid-cols-2">
            <legend className="sr-only">Batch details</legend>
            {(Object.keys(labels) as (keyof FormValues)[]).map((key) => <div key={key} className={key === "ownerName" ? "sm:col-span-2" : ""}>
              <label htmlFor={`batch-${key}`} className="block text-sm font-medium">{labels[key]}</label>
              <input id={`batch-${key}`} name={key} className="form-input mt-2 w-full" type={key.endsWith("At") ? "datetime-local" : key === "quantityKg" || key === "recordedValueInr" ? "number" : "text"} step={key.endsWith("At") ? "0.001" : key === "recordedValueInr" ? "0.01" : "any"} min={key === "quantityKg" || key === "recordedValueInr" ? "0" : undefined} maxLength={key === "batchCode" ? 40 : key === "ownerName" ? 120 : undefined} required={key !== "recordedValueInr" && key !== "exitedAt"} value={form[key]} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} aria-invalid={Boolean(fields[key]?.length)} aria-describedby={fields[key]?.length ? `error-${key}` : undefined} />
              {fields[key]?.length ? <p id={`error-${key}`} className="mt-1 text-xs text-red-800">{fields[key].join(" ")}</p> : null}
            </div>)}
          </fieldset>
          <p className="mt-4 text-xs leading-6 text-muted">Leave value blank if it is unknown; zero is a known recorded value. Leave exit blank while the batch remains in storage.</p>
          {!editing && <label className="mt-4 block text-sm font-medium">Stock schedule<select className="form-input mt-2 w-full" value={schedule} onChange={(e) => setSchedule(e.target.value)} disabled={saving}><option value="">Original potato schedule</option>{scheduleIds.map((id) => <option key={id} value={id}>{scheduleLabel(id)}</option>)}</select></label>}
          {formError && <p role="alert" className="mt-4 text-sm text-red-800">{formError}</p>}
          <div className="mt-6 flex justify-end gap-3"><button type="button" className="button-secondary" disabled={saving} onClick={() => dialog.current?.close()}>Cancel</button><button type="submit" className="button-primary" disabled={saving}>{saving ? "Saving…" : "Save batch"}</button></div>
        </form>
      </dialog>
    </div>
  );
}
