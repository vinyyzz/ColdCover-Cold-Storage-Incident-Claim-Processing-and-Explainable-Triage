import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/db";
import { claimIdentifier } from "@/lib/claims/contract";
import Link from "next/link";
import { getReviewerPacket } from "@/lib/reviews/service";
import RefreshReview from "../../reviewer/refresh";
import ReviewPanel from "./review";
import { ClaimError } from "@/lib/claims/service";
import PacketView from "./packet";
export const metadata: Metadata = { title: "Prepared evidence packet" };
async function PacketData({ params }: { params: Promise<{ id: string }> }) {
  await connection(); const { id } = await params;
  if (!claimIdentifier.safeParse(id).success) notFound();
  const result = await getReviewerPacket(await getDatabase(), id).catch((error: unknown) => { if (error instanceof ClaimError && error.status === 404) notFound(); throw error; });
  return <><div className="mb-6 flex flex-wrap gap-3"><Link className="button-secondary" href="/reviewer" prefetch={false}>Back to reviewer queue</Link><a className="button-secondary" href="#review-heading">Review decision and history</a><RefreshReview /><Link className="button-secondary" href={`/claims/${encodeURIComponent(id)}/report`} prefetch={false}>Printable report</Link></div><PacketView value={result.packet} /><div className="mt-6"><ReviewPanel key={`${result.review.claimId}:${result.review.checkedAt}:${result.review.status === "available" ? result.review.state : "unavailable"}`} state={result.review} /></div></>;
}
export default function ClaimPage(props: { params: Promise<{ id: string }> }) { return <Suspense fallback={<p role="status">Verifying frozen packet and review history…</p>}><PacketData {...props} /></Suspense>; }
