"use client";
export default function TemperatureError({ retry }: { retry: () => void }) {
  return <div role="alert" className="mt-8 rounded-xl border border-line bg-white p-6"><p>Temperature records could not be loaded.</p><button className="button-secondary mt-4" onClick={retry}>Try again</button></div>;
}
