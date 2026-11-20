import Link from "next/link";
import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { getDatabase } from "@/lib/db";
import { getReviewerIndex } from "@/lib/reviews/service";
import { reviewQuerySchema } from "@/lib/reviews/contract";
import ReviewerList from "./list";
import RefreshReview from "./refresh";
export const metadata: Metadata = { title: "Reviewer queue" };
async function Queue({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection(); const raw = await searchParams, query = reviewQuerySchema.parse(raw);
  return <ReviewerList data={await getReviewerIndex(await getDatabase(), query)} older={query.after !== undefined} />;
}
export default function ReviewerPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <><div className="mb-6 flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-wider text-teal">Fictional human review</p><h1 className="mt-3 text-3xl font-semibold">Reviewer queue</h1><p className="mt-3 max-w-2xl text-sm leading-7 text-muted">Review prepared evidence and record a decision with a comment. Opening a packet does not submit a claim or record a decision. Approval for assessment is a review step; it does not decide stock condition, cover or payment.</p></div><RefreshReview /></div><Link href="/policy/cases" className="mb-5 inline-block text-sm font-semibold text-teal underline">Review prepared policy cases</Link><Suspense fallback={<p role="status">Verifying prepared packets and review history…</p>}><Queue {...props} /></Suspense></>;
}
