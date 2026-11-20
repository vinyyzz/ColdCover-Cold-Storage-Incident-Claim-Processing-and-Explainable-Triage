# ColdCover: five-minute demonstration

Use fictional data only. This walkthrough creates a calculated incident, explicitly associates reports, prepares an immutable packet and records one fictional review. It does not determine stock condition, policy cover or payment. Read [README.md](README.md) for setup.

## Prepare before the timer

Start a **separate demonstration instance** with a fresh local SQLite file and a free port. Configure the file and port using the setup instructions in the README. Do not reset, replace, or rehearse writes against operator records. A new seed has144 ten-minute readings, A/B/C, one unanalysed draft/raw maintenance report, and no claim or review. Seed is insert-missing, not reset. Repeating this walkthrough on an already prepared incident disables later evidence changes; use a new disposable instance for each rehearsal.

Open Temperature, Scenario checks, and Demo policy in separate tabs. In Scenario checks, deliberately **Run all scenarios**, verify30/30 and retain the tab (reload clears results). Results are actual deterministic function evaluations, not saved incidents or claim packets. Have the fictional supplementary report below ready to paste. The five-minute route assumes the seed is unchanged; identifiers for generated incidents/claims are discovered through the interface, not hard-coded.

## Timed walkthrough

| Time | Action and words to use | Verify on screen |
|---|---|---|
| 0:00–0:30 | On Temperature choose **Normal operation**. Say: “This is a fictional source preview; it changes no stored records and does not run analysis.” Briefly show scenario01's actual evaluated no-incident result in the prepared Scenario checks tab. | Preview-only label; actual evaluation reports zero qualified intervals. Do not present the chart preview as a calculated outcome. |
| 0:30–1:10 | Return to Temperature, **Show stored log**, then **Run stored-log analysis**. Select the calculated interval and open its incident link. | 10March2026,01:20–05:40 IST; A/B throughout; C absent because entry is06:00. **Inventory value under investigation: ₹80,000.00**. The new incident initially has no associated report: the seed report stays on its original draft. |
| 1:10–1:50 | Under **Reuse an existing report**, **Browse existing reports**. Select `fictional-maintenance-REF-01.txt` from the seeded draft, inspect its original, confirm the source/target association, then **Copy report to this incident**. | New report has deterministic fallback extraction and provenance; original stays unchanged. Compressor fault is attributed to this report. Inspection remains missing; readiness **Needs more evidence**, priority **Standard priority**. |
| 1:50–2:30 | In **Interactive evidence timeline**, choose **Select interval 1 · selected** / **Inspect selected interval and report passages**. Inspect A/B and muted C; choose a summary source or report passage and open the full original. | Adjacent exact-source inspector, saved readings, batch storage reason, reported restart at05:10 and exact quoted text. The summary says an inspection is needed; temperature alone does not establish stock condition. Report upload time is separate from reported equipment time. |
| 2:30–3:15 | Under **Add report text**, select Maintenance report, filename `fictional-restart-clarification.txt`, paste the supplementary source below and **Save report and extract**. Inspect the extracted04:00 restart and exact source. | **Specialist review required**, neutral restart conflict: an actual high reading at05:30 is more than60 minutes after04:00. Missing inspection/readiness stays independent of priority. The two reports' different restart times remain attributed; neither original is replaced. |
| 3:15–4:00 | **Review packet**, inspect checklist/current stored policy, choose the demonstration policy, confirm the reviewed interval/reports/missing evidence, then **Prepare immutable packet** and **Open prepared packet**. | Policy banner, frozen preparation-time sources/criteria, ₹80,000.00, Needs more evidence/Specialist, missing inspection. Preparation is allowed with missing evidence and is not submission or approval. |
| 4:00–4:30 | In **Review decision and history**, choose **Needs more information**. Name: `Fictional Demo Reviewer`. Comment: `Please provide a stock inspection report and clarify the two reported restart times. No condition or payment determination is made.` Confirm the frozen packet review and **Record review decision**. | Attributed immutable decision/comment history; frozen readiness/priority/value do not change. No real authentication is implied. |
| 4:30–5:00 | **Printable report** → inspect disclaimer, sources, saved chart, policy and recorded review → **Download HTML**. Show **Print / Save as PDF** as the browser print option. | Self-contained HTML download; exact source readings and passages retained; disclaimer below. Native Save-as-PDF was verified on2November2026; it remains outside this timed browser route. |

Say at the end: “This packet organises evidence for human review. Recorded inventory value is not a compensation calculation.” The browser-only route was rehearsed on2November2026 in129.625seconds (2min10s rounded), excluding setup, spoken narration and the separate native PDF save. This is automation elapsed time, not a measured narrated presentation.

## Fictional supplementary source

Paste exactly as maintenance-report text. This deliberately introduces a different reported restart time; it does not correct or overwrite the first report.

```text
FICTIONAL DEMONSTRATION RECORD — Supplementary maintenance note
Equipment ID: REF-01
Service date: 10 March 2026 (all times IST, +05:30)
Reported fault: compressor fault
Reported cause: compressor fault
Refrigeration restarted: 2026-03-10T04:00:00+05:30

This fictional supplementary note records the operator's stated restart time for human review. It describes refrigeration service only. It does not establish the condition of any potatoes, verify batch quantities or recorded values, or establish policy cover. Another maintenance report may record a different restart time. Retain both originals, compare their exact passages with the temperature log, and ask the operator to clarify the difference. Cooling can continue after a restart. No stock inspection was performed for this note. Prepared by a fictional technician solely for this demonstration.
```

## Optional branches, outside the five minutes

- **Audited correction:** before preparation, expand a report and **Correct extracted facts**. Select a field, quote a complete original supporting line (and explicit timezone/date context for a time), enter a reason, confirm relevance and **Save operator correction**. Inspect original fallback/effective correction/history. Clear only unsupported fields; do not invent a source or use the correction form to reconcile two different originals. Prepared packets do not unlock for later corrections.
- **Other calculated cases:** Scenario checks has brief spike08, gap11, wrong equipment15, ongoing18, missing valuation26 and multiple events29. Inspect actual interval/readiness/priority/source comparisons. Temperature simulator buttons are source previews; there is no persisted scenario activation button. Do not bulk-insert overlapping fixture timestamps into the active register.
- **CSV:** download the sample on Temperature; its three normal readings use11March to avoid the seed's10March timestamps. A duplicate import rejects atomically. Browser form selection/import/duplicate/invalid-row/refresh checks passed2November through the normal native picker without changing security settings; the extension setFiles helper remains permission-limited. Use only a disposable rehearsal database for testing.
- **Reset/recovery:** only on the separate disposable instance. In Scenario checks review reset state/counts, inspect/archive/download, type the exact displayed confirmation phrase and perform the explicit operation. Review and restore the chosen archive separately. If outcome is unconfirmed, retry its retained UUID; never create a new attempt to guess the result. Seed itself never resets.
- **Interrupted writes:** retain the displayed request and use its exact retry; a reload never auto-replays a mutation. Stale source/state messages require an explicit refresh/review. Do not promise success until the stored packet/receipt/history confirms it.
