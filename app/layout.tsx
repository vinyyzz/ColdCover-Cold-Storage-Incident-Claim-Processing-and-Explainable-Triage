import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "ColdCover | Incident investigation", template: "%s | ColdCover" },
  description:
    "Cold-storage incident evidence, organised for human review. A fictional demonstration for potato storage.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <a href="#main-content" className="skip-link">Skip to content</a>
        <header className="border-b border-line bg-white">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-5 px-6 py-5 sm:px-10">
            <Link href="/" className="flex items-center gap-3" aria-label="ColdCover home">
              <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-xl bg-ink font-serif text-2xl text-white">c.</span>
              <span className="text-xl font-semibold tracking-tight">ColdCover</span>
            </Link>
            <nav aria-label="Main navigation" className="flex flex-wrap items-center gap-4 text-sm font-medium sm:gap-6">
              <Link className="nav-link" href="/">Overview</Link>
              <Link className="nav-link" href="/inventory">Inventory</Link>
              <Link className="nav-link" href="/temperature">Temperature</Link>
              <Link className="nav-link" href="/reviewer" prefetch={false}>Reviewer queue</Link>
              <Link className="nav-link" href="/policy">Policies</Link>
              <Link className="nav-link" href="/admin">Scenario checks</Link>
              <span className="rounded-full border border-line px-3 py-1 text-xs text-muted">Fictional demo</span>
            </nav>
          </div>
        </header>
        <main id="main-content" className="mx-auto max-w-6xl px-6 py-12 sm:px-10 sm:py-16">{children}</main>
        <footer className="mx-auto flex max-w-6xl flex-wrap justify-between gap-3 border-t border-line px-6 py-6 text-xs leading-6 text-muted sm:px-10">
          <p>Evidence for human review. All demonstration data is fictional.</p>
          <p>CH-1 · Potatoes · REF-01</p>
        </footer>
      </body>
    </html>
  );
}
