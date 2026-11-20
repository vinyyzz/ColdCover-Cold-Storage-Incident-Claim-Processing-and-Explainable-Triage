import type { Metadata } from "next";
import ScenarioEvaluation from "./scenarios";
import DemoReset from "./reset";

export const metadata: Metadata = { title: "Scenario checks" };
export default function AdminPage() {
  return <>
    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal">Fictional demonstration · Scenario checks</p>
    <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">Check all 30 scenarios</h1>
    <p className="mt-4 max-w-3xl text-sm leading-7 text-muted">Run the temperature, inventory, report extraction, triage and summary functions against the authored fictional fixtures. Compare calculated outcomes with their expected results and inspect the evidence behind each case.</p>
    <ScenarioEvaluation />
    <DemoReset />
  </>;
}
