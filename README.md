# ColdCover

ColdCover organises fictional cold-storage incident evidence into explainable claim packets for human review. It connects temperature readings, inventory presence, equipment events, and original report passages. The application labels recorded exposure **Inventory value under investigation**.

## Run locally

Install Git and Node.js **22.12 or newer in the 22.x series, or 24.0 and newer**. Clone and run ColdCover with the lockfile and fictional seed data:

```sh
git clone https://github.com/vinyyzz/ColdCover-Cold-Storage-Incident-Claim-Processing-and-Explainable-Triage.git ColdCover
cd ColdCover
npm ci
npm run seed
npm run dev
```

If you already have the project, run the last three commands from its root. Open the Local URL printed by Next.js, usually [http://localhost:3000](http://localhost:3000). If that port is occupied, run `npm run dev -- --hostname 127.0.0.1 --port 3100` and open [http://localhost:3100](http://localhost:3100).

The seed applies the tracked database migrations and adds the fictional worked example. It creates a local SQLite file at `data/coldcover.db` by default. If you need a different file, copy `.env.example` to `.env.local` and set `DATABASE_URL` to a local SQLite file URL. Setup requires no API keys.

## Try the demo

1. Open **Temperature** and choose **Run stored-log analysis**. The worked example shows the abnormal interval on 10 March 2026 from 01:20 to 05:40 IST. Batches A and B account for ₹80,000 of inventory value under investigation. Batch C arrived after the interval.
2. Open the calculated incident and use **Reuse an existing report** to copy the seeded maintenance report explicitly. Inspect the timeline, cited passages, triage, and evidence checklist.
3. Prepare an immutable evidence packet, record a fictional decision from the **Reviewer queue**, and open the printable report.

**Policies** includes four stock deterioration variants with nine fictional schedules, as well as Property Insurance and Machinery Breakdown. **Scenario checks** runs all 30 deterministic fixture evaluations. [Full worked walkthrough](DEMO_SCRIPT.md) · [Policy case walkthroughs](presentation_samples/policy-expansion/README.md) · [Sample CSV and reports](presentation_samples/README.md)

The policies and data are fictional. The application organises evidence for human review and does not determine stock condition, coverage, or payment.

## Verify and build

```sh
npm test
npm run lint
npm run typecheck
npm run build
```

After building, run `npm start` to serve the production build locally. Stop the development instance first or select a different port. Use a fresh local database for rehearsals that write records. Re-running the seed preserves existing records.

ColdCover uses Next.js, React, strict TypeScript, Tailwind CSS, Drizzle, SQLite, Zod, Recharts, and Vitest. Application code is under `app/` and `lib/`. Database migrations and their metadata are tracked under `drizzle/`.

## Files to keep local

Keep installed dependencies, build output, caches, coverage, SQLite databases and backups, local environment files, credentials, and generated rehearsal or presentation artifacts out of Git. The repository includes `.env.example`, the dependency lockfile, migrations, and fictional seed code so a clean clone can recreate its own local setup.
