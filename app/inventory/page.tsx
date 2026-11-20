import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDatabase } from "@/lib/db";
import { listBatches } from "@/lib/inventory/service";
import { policyCaseInputs } from "@/lib/policy-cases/service";
import ScheduleAssignments from "./schedule-assignment";
import InventoryRegister from "./register";

export const metadata: Metadata = { title: "Inventory register" };

async function InventoryData() {
  // Initialization may write a new local demo DB; wait for a real request.
  await connection();
  const db = await getDatabase();
  const records = await listBatches(db);
  const input = await policyCaseInputs(db);
  return <><InventoryRegister initialBatches={records} /><ScheduleAssignments batches={input.batches} /></>;
}

export default function InventoryPage() {
  return (
    <>
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal">Chamber CH-1 · Stock records</p>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">Inventory register</h1>
      <p className="mt-4 max-w-2xl text-sm leading-7 text-muted">Keep quantities, recorded values, and storage times together. Check which batches were present at a particular time.</p>
      <Suspense fallback={<p className="mt-8 rounded-xl border border-line bg-white p-6" role="status">Loading inventory records…</p>}>
        <InventoryData />
      </Suspense>
    </>
  );
}
