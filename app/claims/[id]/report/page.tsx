import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/db";
import { claimIdentifier } from "@/lib/claims/contract";
import { ClaimError } from "@/lib/claims/service";
import { getClaimReport, ReportError } from "@/lib/reports/service";
import ReportPreview from "./preview";
export const metadata: Metadata = { title: "Printable claim report" };
async function ReportData({ params }: { params: Promise<{ id: string }> }) {
  await connection(); const { id } = await params; if (!claimIdentifier.safeParse(id).success) notFound();
  const result = await getClaimReport(await getDatabase(), id).catch((error: unknown) => {
    if (error instanceof ClaimError && error.status === 404) notFound();
    if (error instanceof ReportError) return { error: error.message };
    throw error;
  });
  if ("error" in result) return <section role="alert" className="rounded-xl border border-line bg-white p-6"><h2 className="text-xl font-semibold">Report unavailable</h2><p className="mt-3 text-sm leading-7">{result.error}</p><Link className="button-secondary mt-4 inline-block" href={`/claims/${encodeURIComponent(id)}`} prefetch={false}>Back to saved packet</Link></section>;
  return <ReportPreview key={`${result.state}:${result.checkedAt}`} claimId={id} state={result.state} />;
}
export default function ReportPage(props: { params: Promise<{ id: string }> }) { return <><div className="mb-6"><Link href="/reviewer" prefetch={false} className="text-sm text-teal underline underline-offset-4">Back to reviewer queue</Link><h1 className="mt-4 text-3xl font-semibold">Printable claim report</h1><p className="mt-3 text-sm leading-7 text-muted">Fictional evidence for human review. Preparation and review do not determine stock condition, policy cover or payment.</p></div><Suspense fallback={<p role="status">Verifying report evidence and review history…</p>}><ReportData {...props} /></Suspense></>; }
