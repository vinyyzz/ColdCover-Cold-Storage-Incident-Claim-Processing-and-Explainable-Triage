"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

export default function RefreshRecords() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <button type="button" className="button-secondary" disabled={pending} onClick={() => startTransition(() => router.refresh())}>{pending ? "Refreshing evidence…" : "Refresh evidence"}</button>;
}
