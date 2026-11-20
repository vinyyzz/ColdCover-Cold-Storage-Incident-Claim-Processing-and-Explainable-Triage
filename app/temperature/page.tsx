import Link from "next/link";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDatabase } from "@/lib/db";
import { temperatureOverview } from "@/lib/temperature/service";
import TemperatureInput from "./upload";

export const metadata: Metadata = { title: "Temperature dashboard" };
async function TemperatureData() {
  await connection();
  return <TemperatureInput overview={await temperatureOverview(await getDatabase())} />;
}
export default function TemperaturePage() {
  return <>
    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal">Chamber CH-1 · Temperature log</p>
    <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">Temperature dashboard</h1>
    <p className="mt-4 max-w-2xl text-sm leading-7 text-muted">Inspect recorded temperatures and gaps, import additional readings, and deliberately analyse saved CH-1 evidence. Existing records and previous analysis are preserved.</p>
    <Link href="/policy/cases#new-policy-case" className="mt-4 inline-block text-sm font-semibold text-teal underline">Analyse by stock policy schedule</Link>
    <Suspense fallback={<p role="status" className="mt-8">Loading temperature records…</p>}><TemperatureData /></Suspense>
  </>;
}
