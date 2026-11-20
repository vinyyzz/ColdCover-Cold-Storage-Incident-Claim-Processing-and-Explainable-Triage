import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDatabase } from "@/lib/db";
import { formatIstDate } from "@/lib/inventory/format";
import { caseIdSchema } from "@/lib/policy-cases/contract";
import { getCase, PolicyCaseError } from "@/lib/policy-cases/service";
import CaseEvidence from "../evidence";
import PolicyReview from "./review";

async function Packet({ params }: { params: Promise<{id: string}> }) {
  await connection();
  const parsed = caseIdSchema.safeParse((await params).id);
  if (!parsed.success) notFound();
  let data: Awaited<ReturnType<typeof getCase>>;
  try { data = await getCase(await getDatabase(), parsed.data); }
  catch (error) {
    if (error instanceof PolicyCaseError) {
      if (error.status === 404) notFound();
      return <p role="alert" className="mt-5">{error.message}</p>;
    }
    throw error;
  }
  const { packet, reviews } = data, latest = reviews.at(-1);
  return <>
    <h1 className="mt-5 text-3xl font-semibold">{packet.snapshot.title}</h1>
    <p className="mt-2 text-sm text-muted">Prepared {formatIstDate(packet.preparedAt)} IST</p>
    <a className="mt-3 inline-block text-sm font-semibold text-teal underline" href={`/api/policy-cases/${packet.id}/report`}>Open printable report</a>
    <a className="mt-3 ml-4 inline-block text-sm text-teal underline" href={`/api/policy-cases/${packet.id}/report?download=1`}>Download HTML</a>
    <article className="mt-5 rounded-xl border border-line bg-white p-5"><CaseEvidence snapshot={packet.snapshot} /></article>
    <section className="mt-5 rounded-xl border border-line bg-white p-5">
      <h2 className="text-xl font-semibold">Human review history</h2>
      {reviews.length === 0 ? <p className="mt-3 text-sm text-muted">No decision recorded yet.</p> : <ol className="mt-3 space-y-3 text-sm">{reviews.map((review) => <li key={review.id}>
        <p className="font-semibold">{review.decision} · {review.reviewer}</p><p>{formatIstDate(review.recordedAt)} IST</p><p className="whitespace-pre-wrap">{review.comment}</p>
      </li>)}</ol>}
      {latest?.decision === "Closed" || reviews.length >= 200 ? <p className="mt-4 text-sm">Review history is closed to new entries.</p> : <PolicyReview key={latest?.revision ?? 0} id={packet.id} hash={packet.packetHash} revision={latest?.revision ?? 0} />}
    </section>
  </>;
}
export default function PolicyPacketPage({ params }: { params: Promise<{id: string}> }) {
  return <><Link href="/policy/cases" className="text-sm text-teal underline">Policy case workspace</Link><Suspense fallback={<p role="status">Verifying evidence…</p>}><Packet params={params} /></Suspense></>;
}
