"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { formatPaise } from "@/lib/analysis/contract";
import { CLAIM_DISCLAIMER, type ClaimPreview, type PrepareInput } from "@/lib/claims/contract";
import { loadPending, PreparationFailure, requestPreparation, requestPreview, savePending } from "@/lib/claims/client";

export default function ClaimPreparation({ incidentId, analysisId, allowed, saved }: { incidentId: string; analysisId: string | null; allowed: boolean; saved: { id: string; createdAt: string }[] }) {
  const router = useRouter(), storageKey = `coldcover-claim:${incidentId}`;
  const [preview, setPreview] = useState<ClaimPreview | null>(null), [reviewed, setReviewed] = useState(false), [policyId, setPolicyId] = useState("");
  const [pending, setPending] = useState<PrepareInput | null>(null), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null), ticket = useRef(0), lock = useRef(false);
  useEffect(() => {
    let active = true;
    const requests = ticket;
    queueMicrotask(() => {
      if (!active) return;
      try { setPending(loadPending(sessionStorage.getItem(storageKey), incidentId)); setReady(true); }
      catch { setMessage("The saved preparation request could not be read. Keep this browser session and inspect existing packets before trying another request."); }
    });
    return () => { active = false; requests.current++; controller.current?.abort(); };
  }, [incidentId, storageKey]);
  async function review() {
    if (!analysisId || lock.current || pending) return;
    lock.current = true; setBusy(true); setMessage(""); setPreview(null); setReviewed(false); setPolicyId("");
    controller.current?.abort(); controller.current = new AbortController(); const current = ++ticket.current;
    try { const value = await requestPreview(incidentId, analysisId, controller.current.signal); if (current === ticket.current) setPreview(value); }
    catch (error) { if (current === ticket.current) setMessage(error instanceof Error ? error.message : "Packet review is unavailable."); }
    finally { if (current === ticket.current) { lock.current = false; setBusy(false); } }
  }
  async function prepare() {
    if (lock.current || !ready) return;
    const input = pending ?? (preview && reviewed && policyId === preview.policy.id ? { requestId: crypto.randomUUID(), analysisId: preview.analysisId, policyId, expectedSourceToken: preview.sourceToken, evidenceReviewed: true as const } : null);
    if (!input) return;
    lock.current = true; setBusy(true); setMessage("");
    try {
      // Persist intent before sending; no automatic retry or new UUID after unknown outcomes.
      savePending(sessionStorage, storageKey, incidentId, input); setPending(input);
      const receipt = await requestPreparation(incidentId, input);
      sessionStorage.removeItem(storageKey); setPending(null); setPreview(null); setReviewed(false); setPolicyId("");
      setMessage(receipt.reused ? "The original prepared packet was recovered." : "Packet prepared. Its evidence is now frozen for human review."); router.refresh();
    } catch (error) {
      if (error instanceof PreparationFailure && error.definitive) { sessionStorage.removeItem(storageKey); setPending(null); setPreview(null); setReviewed(false); setPolicyId(""); }
      setMessage(error instanceof Error ? error.message : "Preparation could not be confirmed. Keep this request for retry.");
    } finally { lock.current = false; setBusy(false); }
  }
  return <section aria-labelledby="prepare-heading" className="min-w-0 rounded-2xl border border-line bg-white p-5 sm:p-6">
    <h2 id="prepare-heading" className="text-xl font-semibold">Prepare an evidence packet</h2>
    <p className="mt-3 text-sm leading-7">Attach or explicitly copy the relevant reports above, then review the policy and checklist. Preparation freezes this interval and its attached evidence. A packet may still need more evidence.</p>
    <p className="mt-3 text-xs leading-6 text-muted">{CLAIM_DISCLAIMER}</p>
    {saved.length > 0 && <ul className="mt-4 space-y-3">{saved.map((claim) => <li key={claim.id}><Link className="button-secondary inline-block break-all" href={`/claims/${encodeURIComponent(claim.id)}`} prefetch={false}>Open prepared packet</Link></li>)}</ul>}
    {pending ? <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-sm leading-7">A preparation result is awaiting confirmation. Retry the saved request to recover its original result, including after a reload.</p><button type="button" className="button-primary mt-4" disabled={busy || !ready} onClick={prepare}>{busy ? "Confirming preparation…" : "Retry saved preparation"}</button></div> : <>
      {(!allowed || !analysisId) && saved.length === 0 && <p className="mt-4 text-sm">Preparation is unavailable for this selected revision. Open a fresh, linked, unclaimed draft.</p>}
      <button type="button" className="button-secondary mt-4" disabled={!ready || busy || !allowed || !analysisId || saved.length > 0} onClick={review}>{busy ? "Checking evidence…" : "Review packet"}</button>
      {preview && <div className="mt-5 space-y-4 rounded-xl bg-surface p-4">
        <p className="text-sm">Readiness: <strong>{preview.readiness}</strong><br />Priority: <strong>{preview.priority}</strong></p>
        <p className="text-sm">Inventory value under investigation: <strong>{formatPaise(preview.knownValueSubtotalPaise)}</strong>{!preview.valuationComplete && " · known subtotal only, incomplete valuation"}</p>
        <p className="break-words text-xs">{preview.documentIds.length} original attached documents will be frozen with their effective versions. All attached reports are included.</p>
        <label className="block text-sm font-medium">Demonstration policy<select className="mt-2 block w-full rounded-lg border border-line bg-white p-3" value={policyId} onChange={(event) => { setPolicyId(event.target.value); setReviewed(false); }}><option value="">Choose a policy</option><option value={preview.policy.id}>{preview.policy.name}</option></select></label>
        <details className="rounded-lg border border-line bg-white p-4"><summary className="cursor-pointer text-sm font-semibold">Stored policy wording and review criteria</summary><p className="mt-3 text-xs font-semibold">{preview.policy.demonstrationLabel}</p><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7">{preview.policy.wording}</p><p className="mt-3 whitespace-pre-wrap text-sm">{preview.policy.recordsRequiredText}</p><p className="mt-3 whitespace-pre-wrap text-xs">{preview.policy.notes}</p></details>
        <ul className="space-y-2 text-sm">{preview.checklist.map((item) => <li key={item.id}><strong>{item.status.replaceAll("_", " ")}</strong> · {item.text}</li>)}</ul>
        <label className="flex items-start gap-3 text-sm leading-7"><input type="checkbox" className="mt-2" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />I reviewed this interval, the attached original reports, missing evidence and selected demonstration policy.</label>
        <button type="button" className="button-primary" disabled={busy || !reviewed || policyId !== preview.policy.id} onClick={prepare}>Prepare immutable packet</button>
      </div>}
    </>}
    <p role="status" className="mt-4 whitespace-pre-wrap break-words text-sm leading-7">{message}</p>
  </section>;
}
