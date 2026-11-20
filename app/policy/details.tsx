import { demonstrationPolicy } from "@/lib/demo/policy";
import { formatIstDate } from "@/lib/inventory/format";
import type { PolicyView } from "@/lib/policies/service";
import RefreshPolicy from "./refresh";

export default function PolicyDetails({ view }: { view: PolicyView }) {
  return <article className="max-w-3xl min-w-0 break-words">
    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal">Current stored policy reference</p>
    <h2 className="mt-5 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">{view.status === "available" ? view.policy.name : "Demonstration policy unavailable"}</h2>
    <p className="mt-6 rounded-xl border border-teal/20 bg-teal-soft p-4 text-sm font-medium text-teal">{demonstrationPolicy.label}</p>
    <div className="mt-6 flex flex-wrap items-center gap-4"><RefreshPolicy /><p className="text-xs leading-6 text-muted">Checked <time dateTime={view.checkedAt}>{formatIstDate(view.checkedAt)} IST</time>.</p></div>
    <p className="mt-4 text-sm leading-7 text-muted">This page shows the current stored demonstration policy as checked above. Refresh to check again. Prepared claim packets retain their own policy wording from preparation; this page does not change those snapshots or determine cover or payment.</p>
    {view.status === "unavailable" ? <section role="status" className="mt-8 rounded-xl border border-line bg-white p-6"><h2 className="text-xl font-semibold">Stored policy details unavailable</h2><p className="mt-3 text-sm leading-7 text-muted">{view.reason === "missing" ? "The demonstration policy record is missing." : "The stored demonstration policy record could not be verified."} Refresh after the stored record has been reviewed. No replacement wording is being shown.</p></section> : <>
      <dl className="mt-8 grid gap-2 text-sm sm:grid-cols-[180px_minmax(0,1fr)]"><dt className="text-muted">Stored policy ID</dt><dd className="font-mono [overflow-wrap:anywhere]">{view.policy.id}</dd><dt className="text-muted">Stored policy label</dt><dd className="whitespace-pre-wrap">{view.policy.demonstrationLabel}</dd><dt className="text-muted">Machinery breakdown cover required</dt><dd>{view.policy.machineryBreakdownCoverRequired ? "Yes — recorded requirement." : "No — not recorded as a requirement."}</dd></dl>
      <section className="mt-9 space-y-4 text-base leading-8 text-muted" aria-labelledby="coverage-heading"><h2 id="coverage-heading" className="text-xl font-semibold text-ink">Stored wording</h2><p className="whitespace-pre-wrap">{view.policy.wording}</p><p className="text-sm">The requirement flag and wording are shown as stored. A human reviewer must clarify any discrepancy; this page does not interpret it.</p></section>
      <section className="mt-9 rounded-2xl border border-line bg-white p-6" aria-labelledby="records-heading"><h2 id="records-heading" className="text-xl font-semibold">Required claim evidence — stored list</h2><ul className="mt-4 list-disc space-y-3 pl-5 text-sm leading-6 text-muted">{view.requiredRecords.map((record, index) => <li key={index} className="whitespace-pre-wrap">{record}</li>)}</ul></section>
      <section className="mt-9 text-sm leading-7 text-muted" aria-labelledby="notes-heading"><h2 id="notes-heading" className="font-semibold text-ink">Stored notes and references</h2><p className="mt-2 whitespace-pre-wrap">{view.policy.notes}</p></section>
    </>}
  </article>;
}
