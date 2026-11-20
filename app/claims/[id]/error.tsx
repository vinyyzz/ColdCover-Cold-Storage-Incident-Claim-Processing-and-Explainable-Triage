"use client";
export default function PacketError({ retry }: { retry: () => void }) {
  return <div role="alert" className="rounded-xl border border-line bg-white p-6"><h2 className="text-xl font-semibold">Prepared packet is unavailable</h2><p className="mt-3 text-sm leading-7">The frozen evidence could not be verified. Its contents are withheld.</p><button type="button" className="button-secondary mt-4" onClick={retry}>Try again</button></div>;
}
