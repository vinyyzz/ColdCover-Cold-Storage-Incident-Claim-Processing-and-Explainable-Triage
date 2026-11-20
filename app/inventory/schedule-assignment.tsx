"use client";
import Link from "next/link";
import { useState } from "react";
import { scheduleIds, scheduleLabel, type ScheduleId } from "@/lib/policy-cases/catalogue";
import { caseErrorMessage, sendCaseJson } from "@/lib/policy-cases/client";
import type { CaseInputs } from "@/lib/policy-cases/service";

function Assignment({ batch }: { batch: CaseInputs["batches"][number] }) {
  const [saved, setSaved] = useState(batch.scheduleId ?? "");
  const [choice, setChoice] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  async function save() {
    setBusy(true);
    setResult("");
    try {
      const response = await sendCaseJson<{scheduleId: ScheduleId | null}>("/api/policy-cases/assignments", {
        batchId: batch.id, scheduleId: choice || null, expectedScheduleId: saved || null,
      }, "PUT");
      setSaved(response.scheduleId ?? "");
      setResult(`Schedule saved for batch ${batch.batchCode}.`);
    } catch (error) { setResult(caseErrorMessage(error)); }
    finally { setBusy(false); }
  }
  return <li className="flex flex-wrap items-center gap-3 border-t border-line py-3">
    <label className="flex flex-wrap items-center gap-2"><span className="min-w-16 font-semibold">{batch.batchCode}</span>
      <select disabled={busy} value={choice} onChange={(e) => setChoice(e.target.value)} className="max-w-full rounded-md border border-line bg-white p-2">
        <option value="">Original potato schedule</option>
        {scheduleIds.map((id) => <option key={id} value={id}>{scheduleLabel(id)}</option>)}
      </select>
    </label>
    <button type="button" disabled={busy || choice === saved} onClick={save} className="rounded-md border border-line bg-white px-3 py-2 disabled:opacity-50">Save schedule</button>
    {result && <span role="status" className="text-xs">{result}</span>}
  </li>;
}
export default function ScheduleAssignments({ batches }: { batches: CaseInputs["batches"] }) {
  return <section id="stock-schedules" className="mt-8 rounded-xl border border-line bg-white p-5 text-sm">
    <h2 className="text-xl font-semibold">Stock policy schedules</h2>
    <p className="my-3 text-muted">Review or change the schedule recorded for each batch.</p>
    <ul>{batches.map((batch) => <Assignment key={batch.id} batch={batch} />)}</ul>
    <Link href="/policy/cases" className="mt-2 inline-block text-teal underline">Open policy case workspace</Link>
  </section>;
}
