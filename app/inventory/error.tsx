"use client";

export default function InventoryError({ retry }: { retry: () => void }) {
  return <section className="rounded-2xl border border-line bg-white p-8" role="alert"><h1 className="text-xl font-semibold">Inventory could not be loaded.</h1><p className="mt-3 text-sm text-muted">Please try again. Your stored records have not been cleared.</p><button onClick={retry} className="button-primary mt-5">Try again</button></section>;
}
