"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { formatIstDate } from "@/lib/inventory/format";
import { clearPendingOperation, OperationFailure, readPendingOperation, requestDemoOperation, requestResetStatus, savePendingOperation } from "@/lib/reset/client";
import { operationInputSchema, type OperationInput, type OperationReceipt, type ResetStatus } from "@/lib/reset/contract";

export function RecordCounts({ counts }: { counts: ResetStatus["counts"] }) {
  return <>
    <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">{[["Batches", counts.batches], ["Temperature readings", counts.temperature_readings], ["Incidents", counts.incidents], ["Reports / documents", counts.documents], ["Claim packets", counts.claims], ["Review decisions", counts.review_decisions], ["Policy cases", counts.policy_case_packets], ["Policy case reviews", counts.policy_case_reviews]].map(([name, value]) => <div key={name}><dt className="text-xs text-muted">{name}</dt><dd className="mt-1 font-semibold">{Number(value).toLocaleString("en-IN")}</dd></div>)}</dl>
    <details className="mt-4 text-xs leading-7"><summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-teal">All record counts</summary><dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">{Object.entries(counts).map(([name, value]) => <div key={name}><dt className="inline text-muted">{name.replaceAll("_", " ")}: </dt><dd className="inline">{value.toLocaleString("en-IN")}</dd></div>)}</dl></details>
  </>;
}
export function SavedReceipt({ receipt }: { receipt: OperationReceipt }) {
  return <div role="status" className="mt-5 rounded-xl border border-teal bg-teal-soft p-5 text-sm leading-7">
    <p className="font-semibold">{receipt.action === "reset" ? "Reset receipt confirmed" : "Restore receipt confirmed"}{receipt.reused ? " · saved result replayed" : ""}</p>
    <p>Recorded {formatIstDate(receipt.createdAt)} IST. This receipt describes that completed operation; current counts are checked separately.</p>
    <a className="font-medium underline underline-offset-4" href={`/api/admin/backups/${receipt.backupId}`}>Download the backup saved before this operation</a>
    {receipt.restoredFrom && <p><a className="underline underline-offset-4" href={`/api/admin/backups/${receipt.restoredFrom}`}>Download the backup used for restoration</a></p>}
  </div>;
}

export default function DemoReset() {
  const [ready, setReady] = useState(false), [working, setWorking] = useState(false), [review, setReview] = useState<ResetStatus | null>(null);
  const [pending, setPending] = useState<OperationInput | null>(null), [receipt, setReceipt] = useState<OperationReceipt | null>(null), [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<"reset" | "restore">("reset"), [backupId, setBackupId] = useState(""), [phrase, setPhrase] = useState(""), [olderPage, setOlderPage] = useState(false);
  const active = useRef<AbortController | null>(null), ticket = useRef(0);
  const cancelActive = useCallback(() => { ticket.current++; const controller = active.current; active.current = null; controller?.abort(); }, []);
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => {
      if (!live) return;
      try { setPending(readPendingOperation(sessionStorage)); setWorking(false); setReview(null); setPhrase(""); setBackupId(""); setReady(true); }
      catch { setError("Saved request details could not be verified. No replacement has been requested from this page. Reload to check them again."); }
    });
    return () => { live = false; cancelActive(); };
  }, [cancelActive]);
  async function loadReview(before?: number) {
    if (active.current || pending || !ready) return;
    const controller = new AbortController(), current = ++ticket.current;
    active.current = controller; setWorking(true); setReview(null); setPhrase(""); setBackupId(""); setError(null);
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const result = await requestResetStatus(controller.signal, before);
      if (ticket.current === current && !controller.signal.aborted) { setReview(result); setOlderPage(before !== undefined); }
    } catch (reason) { if (ticket.current === current) setError(reason instanceof Error ? reason.message : "The workspace could not be reviewed. Try again."); }
    finally { clearTimeout(timer); if (ticket.current === current) { active.current = null; setWorking(false); } }
  }
  async function perform(input: OperationInput) {
    if (active.current) return;
    // Persist intent before any fetch. A reload can then offer the exact UUID,
    // state and confirmation again, without automatic submission.
    try { savePendingOperation(sessionStorage, input); }
    catch { setReady(false); setError("The request could not be retained safely. No operation was sent. Reload before continuing."); return; }
    const controller = new AbortController(), current = ++ticket.current;
    active.current = controller; setPending(input); setWorking(true); setReview(null); setReceipt(null); setPhrase(""); setError(null);
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const result = await requestDemoOperation(input, controller.signal);
      if (ticket.current !== current || controller.signal.aborted) return;
      setReceipt(result); setPending(null);
      try { clearPendingOperation(sessionStorage); } catch { /* A retained confirmed UUID can only replay this receipt. */ }
      try { const result = await requestResetStatus(controller.signal); if (ticket.current === current && !controller.signal.aborted) { setReview(result); setOlderPage(false); setBackupId(""); } }
      catch { if (ticket.current === current) setError("The operation is confirmed, but current counts could not be checked. Review the workspace again before another replacement."); }
    } catch (reason) {
      if (ticket.current !== current) return;
      if (reason instanceof OperationFailure && reason.definitive) {
        try { clearPendingOperation(sessionStorage); setPending(null); }
        catch { setReady(false); setError("The request was rejected, but its saved details could not be cleared safely. Reload before preparing another operation."); return; }
      }
      setError(reason instanceof Error ? reason.message : "The result is not confirmed. Retry the same saved request.");
    } finally { clearTimeout(timer); if (ticket.current === current) { active.current = null; setWorking(false); } }
  }
  function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!review || pending || working || !ready) return;
    const selected = review.backups.find((backup) => backup.id === backupId);
    if (action === "restore" && (!selected || !selected.compatible)) return;
    const input = operationInputSchema.safeParse(action === "reset"
      ? { requestId: crypto.randomUUID(), expectedState: review.state, action, confirmation: phrase }
      : { requestId: crypto.randomUUID(), expectedState: review.state, action, backupId, confirmation: phrase });
    if (input.success) void perform(input.data);
  }
  const expectedPhrase = action === "reset" ? "RESET DEMO" : "RESTORE BACKUP";
  const selectedBackup = review?.backups.find((backup) => backup.id === backupId);
  return <section aria-labelledby="demo-reset-heading" className="mt-12 border-t border-line pt-8">
    <h2 id="demo-reset-heading" className="text-2xl font-semibold">Reset or recover the demonstration workspace</h2>
    <p className="mt-3 max-w-3xl text-sm leading-7 text-muted">A reset replaces the active stored workspace with the original worked example. A complete backup is saved first, including evidence history, corrections, copied reports, claim packets and reviews. Restoration also saves the current workspace before replacing it.</p>
    <p className="mt-2 text-xs leading-7 text-muted">Backups remain in this database. Download one for a separate copy. Other open evidence and edit screens should be refreshed after replacement.</p>
    {!ready && !error && <p role="status" className="mt-4 text-sm">Checking for an unfinished request…</p>}
    <button type="button" className="button-secondary mt-5" disabled={!ready || working || pending !== null} onClick={() => loadReview()}>Review current workspace and backups</button>
    {working && <p role="status" className="mt-4 text-sm">{pending ? "Saving a backup and confirming the operation…" : "Reading current counts and backups…"}</p>}
    {error && <p role="alert" className="mt-4 rounded-lg border border-amber-600 bg-amber-50 p-4 text-sm leading-7">{error}</p>}
    {pending && <div className="mt-5 rounded-xl border border-amber-600 bg-white p-5 text-sm leading-7"><p className="font-semibold">Saved {pending.action} request · outcome needs confirmation</p><p>Its identifier and confirmation are retained. Retry this same request to confirm the result; it will not create a second operation if the first already completed.</p><button type="button" className="button-primary mt-3" disabled={working || !ready} onClick={() => perform(pending)}>Retry saved request</button></div>}
    {receipt && <SavedReceipt receipt={receipt} />}
    {review && !pending && <div className="mt-6 rounded-xl border border-line bg-white p-5 sm:p-6">
      <h3 className="font-semibold">Reviewed workspace</h3><p className="mt-1 text-xs text-muted">Checked {formatIstDate(review.checkedAt)} IST. Any later record change requires a new review.</p><RecordCounts counts={review.counts} />
      <div className="mt-6 border-t border-line pt-5"><h3 className="font-semibold">Available backups</h3>
        <p className="mt-2 text-xs leading-7 text-muted">{review.backups.length ? "Each backup is the complete workspace saved immediately before its listed operation." : "No backups have been created yet. The first reset will create one before replacing data."}</p>
        <ul className="mt-3 space-y-3 text-xs leading-6">{review.backups.map((backup) => <li key={backup.id} className="rounded-lg border border-line p-3"><p className="font-semibold">Backup #{backup.sequence} · before {backup.action} · {formatIstDate(backup.createdAt)} IST</p><p>{backup.counts.incidents} incidents · {backup.counts.documents} documents · {backup.counts.claims} packets · {backup.counts.review_decisions} reviews{backup.compatible ? "" : " · Restoration requires compatibility review"}</p><a className="underline underline-offset-4" href={`/api/admin/backups/${backup.id}`}>Download verified backup #{backup.sequence}</a></li>)}</ul>
        <div className="mt-3 flex flex-wrap gap-3">{review.nextCursor !== null && <button type="button" className="button-secondary" disabled={working} onClick={() => loadReview(review.nextCursor!)}>Older backups</button>}{olderPage && <button type="button" className="button-secondary" disabled={working} onClick={() => loadReview()}>Newest backups</button>}</div>
      </div>
      <form onSubmit={confirm} className="mt-6 space-y-4 border-t border-line pt-5">
        <label className="block text-sm font-medium">Operation<select className="form-input mt-2 block w-full" value={action} disabled={working} onChange={(event) => { setAction(event.target.value as "reset" | "restore"); setPhrase(""); }}><option value="reset">Reset to the worked example</option><option value="restore">Restore a saved backup</option></select></label>
        {action === "restore" && <label className="block text-sm font-medium">Choose backup<select className="form-input mt-2 block w-full" value={backupId} disabled={working} onChange={(event) => { setBackupId(event.target.value); setPhrase(""); }}><option value="">Choose a reviewed backup</option>{review.backups.map((backup) => <option key={backup.id} value={backup.id} disabled={!backup.compatible}>Backup #{backup.sequence} · {formatIstDate(backup.createdAt)} IST</option>)}</select></label>}
        <div className="rounded-lg bg-surface p-4 text-sm leading-7"><p className="font-semibold">{action === "reset" ? "Replace active records with the worked example" : selectedBackup ? `Replace active records with backup #${selectedBackup.sequence}` : "Choose the backup to restore"}</p><p>{action === "reset" ? "The active workspace will contain A/B/C, 144 readings, default settings/policy and the unanalysed draft with its original maintenance text. Active calculated analyses, corrections, policy assignments, claim packets and reviews are removed from view and retained in the new backup." : "The selected backup's records and history will become active. The current workspace is saved as a new backup first. A new restoration audit is added."}</p>{selectedBackup && action === "restore" && <RecordCounts counts={selectedBackup.counts} />}</div>
        <label className="block text-sm font-medium">Type {expectedPhrase} to confirm<input className="form-input mt-2 block w-full" autoComplete="off" spellCheck={false} value={phrase} disabled={working} onChange={(event) => setPhrase(event.target.value)} /></label>
        <button type="submit" className="button-primary" disabled={working || phrase !== expectedPhrase || (action === "restore" && !selectedBackup?.compatible)}>{action === "reset" ? "Back up and reset demo" : "Back up and restore selection"}</button>
      </form>
    </div>}
  </section>;
}
