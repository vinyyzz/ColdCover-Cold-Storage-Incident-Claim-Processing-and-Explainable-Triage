import { CLAIM_DISCLAIMER } from "../claims/contract";
import { formatPaise } from "../analysis/contract";
import { escapeHtml as h } from "../reports/render";
import { REPORT_DOCUMENT_CSP } from "../reports/contract";
import type { getCase } from "./service";

const disclaimer = CLAIM_DISCLAIMER;
const styles = `
@page{margin:16mm}
body{font:14px/1.55 system-ui,sans-serif;color:#193a43;margin:0;padding:24px}
main{max-width:920px;margin:auto}
h1,h2,h3{line-height:1.2;break-after:avoid}
section{margin-top:26px;padding-top:8px;border-top:1px solid #becfce}
a{color:#006f70}
li,pre{overflow-wrap:anywhere}
pre{white-space:pre-wrap;font:inherit;background:#f3f6f6;padding:12px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;border-bottom:1px solid #cedbda;padding:5px;overflow-wrap:anywhere}
thead{display:table-header-group}tr{break-inside:avoid}
.notice{padding:10px;border:1px solid #93b6b4;background:#eef6f5}
`;

export function renderPolicyReport({ packet, reviews }: Awaited<ReturnType<typeof getCase>>) {
  const s = packet.snapshot;
  const readingRefs = new Map(s.readings.map((row, i) => [row.id, i + 1]));
  const source = (id: string) => readingRefs.has(id) ? `<a href="#reading-${readingRefs.get(id)}">${h(id)}</a>` : h(id);
  const timeline = s.analysis.map(({ schedule, gaps, runs }) => `
    <h3>${h(schedule.name)}</h3><p>${h(schedule.minC)} to ${h(schedule.maxC)} °C · ${h(schedule.minMinutes)} min excursion · gaps over ${h(schedule.maxGapMinutes)} min</p>
    ${runs.length ? `<ol>${runs.map((run) => `<li><strong>${h(run.direction)}</strong> · ${run.kind === "brief_spike" ? "Brief excursion" : "Investigation interval"}
      <p>${h(run.start)} to ${h(run.observedUntil)}${run.ongoing ? " · open at last observation" : ""}${run.dataGapUncertainty ? " · data gap requires review" : ""}</p>
      <p>Sources: ${[run.startReadingId, run.lastAbnormalReadingId, ...(run.endReadingId ? [run.endReadingId] : [])].map(source).join(", ")}</p>
      ${run.exposure ? `<p>${h(run.exposure.label)}: ${h(formatPaise(run.exposure.knownValueSubtotalPaise))}${run.exposure.valuationComplete ? "" : " · known subtotal only"}</p>
      <ul>${run.exposure.batches.map((batch) => `<li>${h(batch.batchCode)} · ${h(batch.classification.replaceAll("_", " "))} · ${h(batch.reason)}</li>`).join("")}</ul>` : ""}
    </li>`).join("")}</ol>` : "<p>No excursion observed in the supplied readings.</p>"}
    ${gaps.length ? `<p>Reading gaps: ${gaps.map((gap) => `${source(gap.leftReadingId)} to ${source(gap.rightReadingId)} (${h(gap.durationMinutes)} min)`).join(" · ")}</p>` : ""}
  `).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${h(REPORT_DOCUMENT_CSP)}"><title>${h(s.title)} | ColdCover policy evidence</title><style>${styles}</style></head><body><main>
  <header><p>ColdCover · Fictional evidence for human review</p><h1>${h(s.title)}</h1><p>${h(s.demonstrationLabel)}</p><p>Prepared ${h(packet.preparedAt)} · ${h(packet.id)}</p><p class="notice">${h(disclaimer)}</p></header>
  <section><h2>${h(s.policy.name)}</h2><p>${h(s.policy.wording)}</p><p>Listed demo triggers: ${h(s.policy.triggers.join(" · "))}</p>
  <p>Reported event: ${h(s.event)}${s.trigger ? "" : " · review against listed triggers"}</p><p>${h(s.readiness)}</p>
  ${s.linkedIncident ? `<p>Linked incident: ${h(s.linkedIncident.title)} · ${h(s.linkedIncident.id)}</p>` : ""}
  ${s.extensions.length ? `<p>Selected extensions: ${h(s.extensions.map((e) => e.name).join(" · "))}</p>` : ""}</section>
  <section><h2>Evidence checklist</h2><ul>${s.checklist.map((item) => `<li>${h(item.label)} · ${item.sources.length ? item.sources.map(source).join(", ") : "Needs evidence"}</li>`).join("")}</ul></section>
  ${s.targets.length ? `<section><h2>Declared assets and units</h2><ul>${s.targets.map((target) => `<li>${h(target.code)} · ${h(target.type.replaceAll("_", " "))} · ${h(target.description)}</li>`).join("")}</ul></section>` : ""}
  ${s.batches.length ? `<section><h2>Selected inventory records</h2><ul>${s.batches.map((b) => `<li>${h(b.batchCode)} · ${h(b.ownerName)} · ${h(b.quantityKg)} kg · ${h(b.recordedValueInr ?? "Value missing")} · ${h(b.enteredAt)} to ${h(b.exitedAt ?? "No exit recorded")}</li>`).join("")}</ul></section>` : ""}
  ${timeline ? `<section><h2>Temperature evidence timeline</h2><p>Fictional investigation schedules.</p>${timeline}</section>` : ""}
  <section><h2>Original evidence</h2>${s.evidence.map((record) => `<h3>${h(record.title)}</h3><p>${h(record.origin)} · ${h(record.id)}</p><pre>${h(record.text)}</pre>`).join("") || "<p>No records attached.</p>"}</section>
  <section><h2>Human review history</h2>${reviews.map((r) => `<h3>${h(r.decision)} · ${h(r.reviewer)}</h3><p>${h(r.recordedAt)}</p><pre>${h(r.comment)}</pre>`).join("") || "<p>No decision recorded.</p>"}</section>
  ${s.readings.length ? `<section><h2>Exact readings</h2><p>Source: ${h(s.readingSource)}.</p><table><thead><tr><th>Reading</th><th>Timestamp (IST)</th><th>°C</th></tr></thead><tbody>${s.readings.map((row, i) => `<tr id="reading-${i + 1}"><td>${h(row.id)}</td><td>${h(row.recordedAt)}</td><td>${h(row.temperatureC)}</td></tr>`).join("")}</tbody></table></section>` : ""}
  </main></body></html>`;
}
