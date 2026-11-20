import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/db";
import { getIncident, IncidentError, incidentIdSchema } from "@/lib/incidents/service";
import { listIncidentClaims } from "@/lib/claims/service";
import RefreshRecords from "../../components/refresh-records";
import IncidentRecordView from "./record";

export const metadata: Metadata = { title: "Incident evidence" };
type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
async function IncidentData({ params, searchParams }: Props) {
  await connection();
  const { id } = await params, search = await searchParams;
  if (!incidentIdSchema.safeParse(id).success || (search.revision !== undefined && !incidentIdSchema.safeParse(search.revision).success)) notFound();
  const data = await getIncident(await getDatabase(), id, search.revision as string | undefined).catch((error: unknown) => {
    if (error instanceof IncidentError && error.status === 404) notFound();
    throw error;
  });
  return <IncidentRecordView key={`${data.incident.id}-${data.evidence?.revision.analysisId ?? "unassigned"}`} data={data} preparedClaims={await listIncidentClaims(await getDatabase(), id)} />;
}
export default function IncidentPage(props: Props) {
  return <><div className="mb-6 flex flex-wrap items-center justify-between gap-4"><p className="text-xs font-semibold uppercase tracking-wider text-teal">Chamber CH-1 · Incident evidence</p><RefreshRecords /></div><Suspense fallback={<p role="status">Loading incident evidence and checking freshness…</p>}><IncidentData {...props} /></Suspense></>;
}
