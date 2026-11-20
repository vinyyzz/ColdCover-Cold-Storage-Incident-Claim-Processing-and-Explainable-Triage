"use client";
import Link from "next/link";
export default function ReviewError({ retry }: { retry: () => void }) {
  return <section role="alert" className="rounded-2xl border border-line bg-white p-6"><h2 className="text-xl font-semibold">Reviewer queue is unavailable</h2><p className="mt-3 text-sm leading-7">Prepared records or review state could not be loaded. No decision has been recorded from this screen.</p><div className="mt-4 flex flex-wrap gap-3"><button type="button" className="button-secondary" onClick={retry}>Try again</button><Link href="/reviewer" className="button-secondary" prefetch={false}>Open newest claims</Link></div></section>;
}
