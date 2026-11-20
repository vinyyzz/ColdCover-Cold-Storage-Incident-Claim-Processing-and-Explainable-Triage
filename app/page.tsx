import { Suspense } from "react";
import { connection } from "next/server";
import { getDatabase } from "@/lib/db";
import { listIncidents } from "@/lib/incidents/service";
import IncidentIndexView from "./components/incident-index";
import RefreshRecords from "./components/refresh-records";

async function OverviewData() {
  await connection();
  return <IncidentIndexView data={await listIncidents(await getDatabase())} />;
}

export default function OverviewPage() {
  return <><p className="text-xs font-semibold uppercase tracking-wider text-teal">Chamber CH-1 · Investigation overview</p><div className="mt-4 flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Recorded evidence. Clear context.</h1><p className="mt-4 max-w-2xl text-sm leading-7 text-muted">Browse calculated incidents, retained history and records awaiting association. Open each incident to inspect its source evidence.</p></div><RefreshRecords /></div><Suspense fallback={<p role="status" className="mt-8">Loading incident records and checking freshness…</p>}><OverviewData /></Suspense></>;
}
