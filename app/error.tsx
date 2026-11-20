"use client";

export default function OverviewError({ retry }: { retry: () => void }) {
  return <div role="alert" className="rounded-xl border border-line bg-white p-6"><h2 className="text-xl font-semibold">Incident records are unavailable</h2><p className="mt-3 text-sm leading-7">Evidence could not be loaded or freshness verified. No current incident state is asserted.</p><button className="button-secondary mt-4" onClick={retry}>Try again</button></div>;
}
