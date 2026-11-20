"use client";
export default function PolicyError({ retry }: { retry: () => void }) {
  return <section role="alert" className="max-w-3xl rounded-2xl border border-line bg-white p-8"><h1 className="text-xl font-semibold">Policy could not be loaded.</h1><p className="mt-3 text-sm leading-7 text-muted">Current stored policy details are unavailable. Try again to check them.</p><button type="button" className="button-primary mt-5" onClick={retry}>Try again</button></section>;
}
