"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
export default function RefreshReview() {
  const router = useRouter(), [pending, transition] = useTransition();
  return <button type="button" className="button-secondary" disabled={pending} onClick={() => transition(() => router.refresh())}>{pending ? "Refreshing review state…" : "Refresh review state"}</button>;
}
