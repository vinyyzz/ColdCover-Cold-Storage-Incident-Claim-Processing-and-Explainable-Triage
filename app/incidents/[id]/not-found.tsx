import Link from "next/link";
export default function IncidentNotFound() {
  return <section className="rounded-2xl border border-line bg-white p-6"><h1 className="text-2xl font-semibold">Incident evidence not found</h1><p className="mt-3 text-sm leading-7">The incident or selected linked revision is not available in CH-1.</p><Link className="button-secondary mt-4 inline-block" href="/" prefetch={false}>Back to overview</Link></section>;
}
