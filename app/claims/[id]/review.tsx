"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { incidentDate } from "@/lib/incidents/presentation";
import { clearPendingDecision, DecisionFailure, readPendingDecision, requestDecision, savePendingDecision } from "@/lib/reviews/client";
import { decisionInputSchema, decisionLabels, decisionStatuses, type DecisionInput, type ReviewState } from "@/lib/reviews/contract";

export default function ReviewPanel({ state }: { state: ReviewState }) {
  const router = useRouter(), claimId = state.claimId;
  const [ready, setReady] = useState(false), [pending, setPending] = useState<DecisionInput | null>(null), [working, setWorking] = useState(false), [message, setMessage] = useState("");
  const [status, setStatus] = useState(""), [name, setName] = useState(""), [comment, setComment] = useState(""), [confirmed, setConfirmed] = useState(false), [needsRefresh, setNeedsRefresh] = useState(false);
  const active = useRef<AbortController | null>(null), ticket = useRef(0);
  useEffect(() => {
    let live = true; const requests = ticket;
    void Promise.resolve().then(() => {
      if (!live) return;
      try { setPending(readPendingDecision(sessionStorage, claimId)); setReady(true); }
      catch { setMessage("The saved review request could not be read. Keep this session and inspect the recorded history before trying another request."); }
    });
    return () => { live = false; requests.current++; active.current?.abort(); };
  }, [claimId]);
  const candidate = state.status === "available" ? decisionInputSchema.safeParse({ requestId: "00000000-0000-4000-8000-000000000000", expectedLatestDecisionId: state.latestDecisionId, expectedRevision: state.history.length, expectedState: state.state, status, reviewerName: name, comment, packetReviewed: confirmed }) : null;
  async function perform() {
    if (active.current || !ready || (!pending && (state.status !== "available" || !state.canRecord || needsRefresh || !candidate?.success))) return;
    const input = pending ?? decisionInputSchema.parse({ ...candidate!.data, requestId: crypto.randomUUID() });
    try { savePendingDecision(sessionStorage, claimId, input); }
    catch { setReady(false); setMessage("The request could not be retained safely. No decision was sent. Reload before continuing."); return; }
    const controller = new AbortController(), current = ++ticket.current;
    active.current = controller; setPending(input); setWorking(true); setMessage("");
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const receipt = await requestDecision(claimId, input, controller.signal);
      if (ticket.current !== current || controller.signal.aborted) return;
      try { clearPendingDecision(sessionStorage, claimId); } catch { /* Retained exact intent can only replay its receipt. */ }
      setPending(null); setConfirmed(false); setStatus(""); setName(""); setComment(""); setNeedsRefresh(true);
      setMessage(receipt.reused ? "The original recorded decision was recovered. Refreshing its history…" : "Review decision recorded. Refreshing its history…"); router.refresh();
    } catch (error) {
      if (ticket.current !== current) return;
      if (error instanceof DecisionFailure && error.definitive) {
        try { clearPendingDecision(sessionStorage, claimId); setPending(null); } catch { /* Keep the request locked if storage cannot clear it. */ }
        setConfirmed(false); setNeedsRefresh(true);
      }
      setMessage(error instanceof Error ? error.message : "The decision result is unconfirmed. Retry the same saved request.");
    } finally { clearTimeout(timer); if (ticket.current === current) { active.current = null; setWorking(false); } }
  }
  const history = state.status === "available" ? state.history : state.legacyHistory;
  return <section aria-labelledby="review-heading" className="min-w-0 rounded-2xl border border-line bg-white p-5 sm:p-6">
    <h2 id="review-heading" tabIndex={-1} className="text-xl font-semibold">Review decision and history</h2><p className="mt-3 text-xs leading-6 text-muted">Checked {incidentDate(state.checkedAt)}. Reviewer names are fictional and recorded as provided. Saved packet facts, readiness and priority remain unchanged by these decisions.</p>
    {history.length === 0 ? <p className="mt-4 text-sm">No {state.status === "available" ? "review decisions" : "readable earlier review records"} recorded.</p> : <ol aria-label="Recorded review decisions" className="mt-4 space-y-4">{history.map((row, i) => <li key={row.id} className="rounded-xl bg-surface p-4"><h3 className="text-sm font-semibold">{decisionLabels[row.status]}{state.status === "available" ? ` · review ${i + 1}` : " · earlier record"}{state.status === "available" && i === history.length - 1 ? " · latest recorded" : ""}</h3><p className="mt-2 break-words text-xs leading-6">{row.reviewerName} · {incidentDate(row.decidedAt)}</p><p className="mt-3 text-xs font-semibold">Reviewer comment · original wording</p><blockquote className="mt-2 whitespace-pre-wrap break-words text-sm leading-7">{row.comment}</blockquote></li>)}</ol>}
    {state.reason && <p className="mt-4 rounded-xl bg-surface p-4 text-sm leading-7">{state.reason}</p>}
    {pending ? <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4"><h3 className="font-semibold">Review result awaiting confirmation</h3><p className="mt-3 text-sm leading-7">Retry the retained request to recover its original outcome. A reload keeps this intent; it never records another decision automatically.</p><p className="mt-3 break-words text-sm">{decisionLabels[pending.status]} · {pending.reviewerName}</p><blockquote className="mt-3 whitespace-pre-wrap break-words text-sm leading-7">{pending.comment}</blockquote><button type="button" className="button-primary mt-4" disabled={working || !ready} onClick={perform}>{working ? "Confirming decision…" : "Retry saved review"}</button></div> : state.status === "available" && state.canRecord && <form className="mt-5 space-y-4 rounded-xl bg-surface p-4" onSubmit={(event) => { event.preventDefault(); void perform(); }}>
      <h3 className="font-semibold">Record a review decision</h3><p className="text-sm leading-7">Inspect the packet and sources above, then select a status and add a comment. Approval for assessment does not determine stock condition, policy cover or payment.</p>
      <label className="block text-sm font-medium">Review outcome<select className="mt-2 block w-full rounded-lg border border-line bg-white p-3" value={status} disabled={working || !ready || needsRefresh} onChange={(event) => { setStatus(event.target.value); setConfirmed(false); }} required><option value="">Choose an outcome</option>{decisionStatuses.map((value) => <option key={value} value={value}>{decisionLabels[value]}</option>)}</select></label>
      {status === "closed" && <p className="text-sm leading-7">Closing ends this review. Its packet and all prior decisions remain available; new decisions cannot be added after closure.</p>}
      <label className="block text-sm font-medium">Fictional reviewer name<input className="mt-2 block w-full rounded-lg border border-line bg-white p-3" value={name} maxLength={120} disabled={working || !ready || needsRefresh} onChange={(event) => { setName(event.target.value); setConfirmed(false); }} autoComplete="off" required /></label>
      <label className="block text-sm font-medium">Review comment<textarea className="mt-2 block min-h-32 w-full rounded-lg border border-line bg-white p-3" value={comment} maxLength={2000} disabled={working || !ready || needsRefresh} onChange={(event) => { setComment(event.target.value); setConfirmed(false); }} required /></label>
      <p className="text-xs text-muted">Up to 2,000 characters. Preserve earlier decisions by recording a new comment rather than editing history.</p>
      <label className="flex items-start gap-3 text-sm leading-7"><input type="checkbox" className="mt-2" checked={confirmed} disabled={working || !ready || needsRefresh} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed the frozen packet and am recording this fictional review decision.</label>
      <button type="submit" className="button-primary" disabled={working || !ready || needsRefresh || !candidate?.success}>Record review decision</button>
    </form>}
    {!pending && needsRefresh && <button type="button" className="button-secondary mt-4" disabled={working} onClick={() => router.refresh()}>Refresh this review</button>}
    <p role="status" className="mt-4 whitespace-pre-wrap break-words text-sm leading-7">{message}</p>
  </section>;
}
