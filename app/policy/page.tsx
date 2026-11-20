import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDatabase } from "@/lib/db";
import { getCurrentPolicy } from "@/lib/policies/service";
import PolicyDetails from "./details";
import PolicyCatalogue from "./catalogue";
export const metadata: Metadata = { title: "Policy catalogue" };
async function StoredPolicy() {
  await connection();
  return <PolicyDetails view={await getCurrentPolicy(await getDatabase())} />;
}
export default function PolicyPage() {
  return <><PolicyCatalogue /><section id="stored-potato-policy" className="mt-12 border-t border-line pt-8"><Suspense fallback={<p role="status" className="rounded-xl border border-line bg-white p-6">Checking stored demonstration policy…</p>}><StoredPolicy /></Suspense></section></>;
}
