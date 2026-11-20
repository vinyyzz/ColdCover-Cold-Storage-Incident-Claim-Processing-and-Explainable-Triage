"use client";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { outcomes, type ReviewInput } from "@/lib/policy-cases/contract";
import { caseErrorMessage, sendCaseJson } from "@/lib/policy-cases/client";
import { inputClass, primaryClass } from "../styles";

export default function PolicyReview({ id, hash, revision }: { id: string; hash: string; revision: number }) {
  const router = useRouter();
  const pending = useRef<{signature: string; id: string} | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError("");
    const data = new FormData(e.currentTarget);
    const fields = { confirmed: true, expectedHash: hash, expectedRevision: revision, reviewer: data.get("reviewer"), comment: data.get("comment"), decision: data.get("decision") };
    const signature = JSON.stringify(fields);
    if (pending.current?.signature !== signature) pending.current = { signature, id: crypto.randomUUID() };
    try {
      await sendCaseJson(`/api/policy-cases/${id}/review`, { ...fields, id: pending.current.id } as ReviewInput);
      setSaved(true);
      router.refresh();
    } catch (cause) { setError(caseErrorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="mt-5 space-y-3 text-sm">
    <fieldset disabled={busy || saved} className="space-y-3">
      <label>Reviewer name<input name="reviewer" required maxLength={120} className={inputClass} /></label>
      <label>Outcome<select name="decision" className={inputClass}>{outcomes.map((outcome) => <option key={outcome}>{outcome}</option>)}</select></label>
      <label>Review comment<textarea name="comment" required maxLength={2000} rows={3} className={inputClass} /></label>
      <label className="flex items-center gap-2"><input type="checkbox" required />I reviewed the frozen packet.</label>
      <button className={primaryClass}>{busy ? "Recording…" : "Record review decision"}</button>
    </fieldset>
    {saved && <p role="status">Decision recorded.</p>}{error && <p role="alert">{error}</p>}
  </form>;
}
