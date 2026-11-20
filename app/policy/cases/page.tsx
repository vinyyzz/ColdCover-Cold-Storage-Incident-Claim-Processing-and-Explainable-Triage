import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDatabase } from "@/lib/db";
import { catalogue, policyIds, type PolicyId } from "@/lib/policy-cases/catalogue";
import { caseIdSchema } from "@/lib/policy-cases/contract";
import { listPolicyCases, policyCaseInputs, PolicyCaseError } from "@/lib/policy-cases/service";
import CaseForm from "./form";

export const metadata: Metadata = { title: "Policy case workspace" };

async function Workspace({ query }: { query: Promise<{ policy?: string; before?: string; incident?: string }> }) {
  await connection();
  const { policy, before, incident } = await query;
  const db = await getDatabase();
  const inputs = await policyCaseInputs(db);
  const cursor = caseIdSchema.safeParse(before);
  const listing = await listPolicyCases(db, cursor.success ? cursor.data : undefined).catch((error: unknown) => {
    if (error instanceof PolicyCaseError && error.status === 404) return listPolicyCases(db);
    throw error;
  });
  const initialPolicy = policyIds.includes(policy as PolicyId) ? policy as PolicyId : "vegetables";
  return <>
    <section className="mt-8 rounded-xl border border-line bg-white p-5">
      <h2 className="text-xl font-semibold">Prepared policy cases</h2>
      {listing.entries.length === 0 ? <p className="mt-3 text-sm text-muted">No policy case packets prepared yet.</p> :
        <ul className="mt-3 divide-y divide-line">{listing.entries.map((row) => <li key={row.id} className="py-3 text-sm">
          <Link href={`/policy/cases/${row.id}`} className="font-semibold underline">{row.title}</Link>
          <p className="text-muted">{policyIds.includes(row.policyId as PolicyId) ? catalogue[row.policyId as PolicyId].name : row.policyId}</p>
        </li>)}</ul>}
      {listing.next && <Link className="text-sm text-teal underline" href={`/policy/cases?before=${listing.next}`}>Older packets</Link>}
      {cursor.success && <Link href="/policy/cases" className="ml-4 text-sm underline">Newest packets</Link>}
    </section>
    <CaseForm key={`${initialPolicy}:${incident ?? ""}`} inputs={inputs} initialPolicy={initialPolicy} initialIncident={inputs.incidents.some((item) => item.id === incident) ? incident : undefined} />
  </>;
}
export default function CasesPage({ searchParams }: { searchParams: Promise<{ policy?: string; before?: string; incident?: string }> }) {
  return <>
    <Link className="text-sm text-teal underline" href="/policy">Policy catalogue</Link>
    <h1 className="mt-4 text-4xl font-semibold tracking-tight">Policy case workspace</h1>
    <p className="mt-3 text-sm text-muted">Review a fictional stock, facility or equipment case and save an evidence packet for a reviewer.</p>
    <Suspense fallback={<p role="status" className="mt-6">Loading policy cases…</p>}><Workspace query={searchParams} /></Suspense>
  </>;
}
