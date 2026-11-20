import Link from "next/link";
import { catalogue, demoScheduleNotice, evidenceLabels, extensions, policyIds, scheduleIds, schedules } from "@/lib/policy-cases/catalogue";
import { demonstrationPolicy } from "@/lib/demo/policy";

export default function PolicyCatalogue() {
  return <section aria-labelledby="policy-catalogue">
    <p className="text-xs font-semibold uppercase tracking-widest text-teal">ColdCover</p>
    <h1 id="policy-catalogue" className="mt-4 text-4xl font-semibold tracking-tight">Policy catalogue</h1>
    <p className="mt-4 text-sm font-medium text-teal">{demonstrationPolicy.label}</p>
    <div className="mt-5 flex flex-wrap gap-4 text-sm">
      <Link href="/policy/cases" className="font-semibold underline underline-offset-4">Open policy case workspace</Link>
      <Link href="/inventory#stock-schedules" className="underline underline-offset-4">Assign stock schedules</Link>
      <a href="#stored-potato-policy" className="underline underline-offset-4">Read the original potato policy</a>
    </div>
    {(["goods", "operator"] as const).map((group) => <section key={group} className="mt-10">
      <h2 className="text-2xl font-semibold">{group === "goods" ? "Policies for the goods" : "Policies for the cold-storage operator"}</h2>
      {group === "goods" && <><h3 className="mt-3 text-lg font-semibold">Deterioration of Stock</h3><p className="mt-2 text-sm text-muted">{demoScheduleNotice} Exact limits are in band. Incorrect settings are recorded for clarification.</p></>}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {policyIds.filter((id) => catalogue[id].group === group).map((id) => {
          const policy = catalogue[id];
          return <article key={id} className="min-w-0 space-y-3 rounded-xl border border-line bg-white p-5 text-sm leading-6">
            <h4 className="text-lg font-semibold">{policy.name}</h4>
            <p>{policy.wording}</p><p className="text-muted">{policy.example}</p>
            <p><strong>Listed demo triggers</strong> {policy.triggers.join(" · ")}</p>
            {group === "goods" && <ul className="space-y-1">
              {scheduleIds.filter((key) => schedules[key].policyId === id).map((key) => {
                const s = schedules[key];
                return <li key={key}>{s.name} · {s.minC} to {s.maxC} °C · {s.minMinutes} min excursion · gap over {s.maxGapMinutes} min</li>;
              })}
              {Object.values(extensions).filter((item) => item.policyId === id).map((item) => <li key={item.name} className="text-muted">Optional evidence · {item.name}</li>)}
            </ul>}
            <details><summary className="cursor-pointer font-medium">Review checklist</summary><ul className="mt-2 list-disc pl-5">{policy.required.map((kind) => <li key={kind}>{evidenceLabels[kind]}</li>)}{group === "goods" && <li>Temperature readings</li>}</ul></details>
            <Link href={`/policy/cases?policy=${id}#new-policy-case`} className="inline-block font-semibold text-teal underline underline-offset-4">Start {policy.name} case</Link>
          </article>;
        })}
      </div>
    </section>)}
  </section>;
}
