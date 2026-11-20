import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeStoredLog, latestStoredAnalysis } from "../analysis/service";
import { openDatabase, type DatabaseConnection } from "../db/client";
import { applyMigrations } from "../db/migrate";
import { batchPolicySchedules, batches, policyCasePackets } from "../db/schema";
import { seedDatabase } from "../db/seed";
import { getClaim, prepareClaim, previewClaim } from "../claims/service";
import { createBatch } from "../inventory/service";
import { downloadDemoBackup, getResetStatus, runDemoOperation } from "../reset/service";
import { catalogue } from "./catalogue";
import { type CaseDraft } from "./contract";
import { renderPolicyReport } from "./report";
import { appendPolicyCaseReview, assignSchedule, getCase, prepareCase, previewCase } from "./service";

vi.mock("server-only", () => ({}));

const csv = (temperatures: number[], minutes = [0, 10, 20, 30, 40, 50]) =>
  "timestamp,temperature_c\n" + temperatures.map((value, index) => `2026-03-10T00:${String(minutes[index]).padStart(2,"0")}:00+05:30,${value}`).join("\n");
const beginning = "2026-03-09T18:00:00+05:30";
const property: CaseDraft = {
  title: "Mock fire report",
  policyId: "property",
  event: "Fire",
  batchIds: [],
  targets: [{ code: "COLD-1", description: "Cold-room insulation panels", type: "insulation" }],
  evidence: [
    { kind: "event", title: "Fictional fire record", text: "Event observed at the cold room." },
    { kind: "declaration", title: "Declared assets", text: "COLD-1 insulation panels." },
    { kind: "damage", title: "Inspection", text: "Examiner observed panel damage. <script>alert(1)</script>" },
  ],
  extensions: [],
  readings: { source: "none" },
};

let conn: DatabaseConnection;
let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "coldcover-policy-case-test-"));
  conn = await openDatabase(`file:${join(dir, "fixture.db")}`);
  await applyMigrations(conn.db);
  await seedDatabase(conn.db);
});
afterEach(() => { conn?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

async function save(draft: CaseDraft) {
  const { hash } = await previewCase(conn.db, draft);
  return prepareCase(conn.db, { id: randomUUID(), expectedHash: hash, draft, confirmed: true });
}

describe("Expanded policy cases", () => {
  it.each([
    ["fruit", "banana", [14, 10, 10, 10, 10, 14], "Below band"],
    ["vegetables", "leafy-greens", [1, -2, -2, -2, 1, 1], "Below band"],
    ["meat", "frozen-meat", [-20, -8, -8, -8, -8, -20], "Above band"],
    ["seafood", "fresh-iced-seafood", [1, 7, 7, 7, 1, 1], "Above band"],
  ] as const)("prepares the %s variant using its assigned %s schedule", async (policyId, scheduleId, temperatures, direction) => {
    const batch = await createBatch(conn.db, { batchCode: "NEW", ownerName: "Case owner", quantityKg: 20, recordedValueInr: 1234, enteredAt: beginning, scheduleId });
    const draft: CaseDraft = { title: "Stock case", policyId, batchIds: [batch.id], targets: [], event: catalogue[policyId].triggers[0], extensions: [], evidence: [], readings: { source: "csv", csv: csv([...temperatures]) } };
    const saved = await save(draft);
    const [series] = saved.snapshot.analysis;
    expect(series.id).toBe(scheduleId);
    expect(series.runs[0]).toMatchObject({ direction, kind: "abnormal_interval", exposure: { knownValueSubtotalPaise: 123400 }, startReadingId: "csv-row-3" });
    expect(saved.snapshot.readiness).toBe("Needs more evidence");
    expect(renderPolicyReport(await getCase(conn.db, saved.id))).toContain('href="#reading-2"');
    await assignSchedule(conn.db, { batchId: batch.id, scheduleId: policyId === "vegetables" ? "apple" : "potato", expectedScheduleId: scheduleId });
    expect((await getCase(conn.db, saved.id)).packet.snapshot).toEqual(saved.snapshot);
    await expect(previewCase(conn.db, draft)).rejects.toMatchObject({ status: 422 });
  });

  it("separates chilled and frozen readings for mixed assignments", async () => {
    const all = await Promise.all(["chilled-meat", "frozen-meat"].map((scheduleId, index) => createBatch(conn.db, { batchCode: `LOT${index}`, ownerName: "Mixed demo", quantityKg: 10, recordedValueInr: index + 1, enteredAt: beginning, scheduleId })));
    const { snapshot } = await previewCase(conn.db, { title: "Mixed meat schedules", policyId: "meat", event: "Unknown event", batchIds: all.map((b) => b.id), targets: [], extensions: [], evidence: [], readings: { source: "csv", csv: csv([4,4,4,4,4,4]) } });
    const [chilled, frozen] = snapshot.analysis;
    expect(chilled.runs).toEqual([]);
    expect(frozen.runs[0]).toMatchObject({ direction: "Above band", ongoing: true, exposure: { knownValueSubtotalPaise: 200 } });
    expect(frozen.runs[0].exposure?.batches.map((batch) => batch.id)).toEqual([all[1].id]);
    expect(snapshot.trigger).toBe(false);
  });

  it("marks gaps and asks for extension evidence independently", async () => {
    const batch = await createBatch(conn.db, { batchCode: "APPLE", ownerName: "Grower", quantityKg: 10, recordedValueInr: 20, enteredAt: beginning, scheduleId: "apple" });
    const { snapshot } = await previewCase(conn.db, { title: "Apple evidence", policyId: "fruit", event: catalogue.fruit.triggers[0], batchIds: [batch.id], targets: [], extensions: ["atmosphere"], evidence: [], readings: { source: "csv", csv: csv([5, 5, 2], [0, 40, 50]) } });
    expect(snapshot.analysis[0].runs[0].dataGapUncertainty).toBe(true);
    expect(snapshot.checklist.filter((row) => row.kind === "temperature" || row.kind === "atmosphere").map((row) => row.sources)).toEqual([[], []]);
  });

  it("preserves the potato baseline and verifies old-style frozen claims with assigned goods in the database", async () => {
    await createBatch(conn.db, { batchCode: "BANANA", ownerName: "Grower", quantityKg: 10, recordedValueInr: 5, enteredAt: beginning, scheduleId: "banana" });
    const legacy = await analyzeStoredLog(conn.db);
    expect(legacy.analysis.exposures[0].knownValueSubtotalPaise).toBe(8000000);
    expect(legacy.analysis.inputs.batches.map((batch) => batch.batchCode).sort()).toEqual(["A","B","C"]);
    expect((await latestStoredAnalysis(conn.db)).status).toBe("current");
    const incidentId = legacy.incidents[0].incidentId, analysisId = legacy.analysis.id;
    const preview = await previewClaim(conn.db, incidentId, analysisId);
    const receipt = await prepareClaim(conn.db, incidentId, { requestId: randomUUID(), analysisId, policyId: preview.policy.id, expectedSourceToken: preview.sourceToken, evidenceReviewed: true });
    expect(await getClaim(conn.db, receipt.claimId)).toMatchObject({ status: "available" });
    const old = await previewCase(conn.db, {
      title: "Potato schedule", policyId: "vegetables", event: catalogue.vegetables.triggers[0],
      batchIds: ["demo-batch-a", "demo-batch-b", "demo-batch-c"], targets: [], extensions: [], evidence: [], incidentId: "demo-incident-01",
      readings: { source: "stored", from: "2026-03-10T00:00:00+05:30", to: "2026-03-10T23:50:00+05:30" },
    });
    expect(old.snapshot.analysis[0].runs[0].exposure?.knownValueSubtotalPaise).toBe(8000000);
    expect(old.snapshot.evidence[0].origin).toContain("demo-incident-01");
  });

  it("builds distinct property and machinery packets, with original evidence shared by explicit reference", async () => {
    const first = await save({ ...property, incidentId: "demo-incident-01" });
    const machinery = await save({
      ...property, title: "Compressor burnout", policyId: "machinery", event: "Sudden electrical breakdown", incidentId: "demo-incident-01",
      targets: [{ code: "REF-01", type: "equipment", description: "Compressor motor" }],
      evidence: [
        { kind: "declaration", title: "Equipment declaration", text: "Declared refrigeration unit REF-01." },
        { kind: "repair", title: "Technician estimate", text: "Technician supplied repair documentation." },
      ],
    });
    expect(first.snapshot.evidence.at(-1)?.id).toBe(machinery.snapshot.evidence.at(-1)?.id);
    expect(first.snapshot.readiness).toBe("Ready for human review");
    expect(machinery.snapshot.readiness).toBe("Ready for human review");
    expect(machinery.snapshot.analysis).toEqual([]);
    await expect(previewCase(conn.db, { ...property, targets: machinery.snapshot.targets })).rejects.toMatchObject({ status: 422 });
    const exportHtml = renderPolicyReport(await getCase(conn.db, first.id));
    expect(exportHtml).toContain("Property Insurance");
    expect(exportHtml).toContain("&lt;script&gt;");
    expect(exportHtml).not.toContain("<script>");
  });

  it("guards preview changes and verifies archive reset, restore and review replay", async () => {
    const draft: CaseDraft = { ...property, incidentId: "demo-incident-01" };
    const { hash } = await previewCase(conn.db, draft);
    await expect(prepareCase(conn.db, { id: randomUUID(), expectedHash: hash, draft: { ...draft, title: "Changed draft" }, confirmed: true })).rejects.toMatchObject({ status: 409 });
    const request = { id: randomUUID(), expectedHash: hash, draft, confirmed: true };
    const packet = await prepareCase(conn.db, request);
    expect(await prepareCase(conn.db, request)).toEqual(packet);
    const reviewInput = { id: randomUUID(), expectedHash: packet.packetHash, expectedRevision: 0, reviewer: "Fictional reviewer", decision: "Closed", confirmed: true, comment: "Reviewed facility evidence." };
    const review = await appendPolicyCaseReview(conn.db, packet.id, reviewInput);
    expect(await appendPolicyCaseReview(conn.db, packet.id, reviewInput)).toEqual(review);
    await expect(appendPolicyCaseReview(conn.db, packet.id, { ...reviewInput, id: randomUUID(), expectedRevision: 1 })).rejects.toMatchObject({ status: 409 });
    await assignSchedule(conn.db, { batchId: "demo-batch-a", expectedScheduleId: null, scheduleId: "apple" });
    const reset = await runDemoOperation(conn.db, { requestId: randomUUID(), action: "reset", expectedState: (await getResetStatus(conn.db)).state, confirmation: "RESET DEMO" });
    await expect(getCase(conn.db, packet.id)).rejects.toMatchObject({ status: 404 });
    const backup = await downloadDemoBackup(conn.db, reset.backupId);
    expect(backup.snapshot.version).toBe("demo-reset-v3");
    expect(backup.counts).toMatchObject({ policy_case_packets: 1, policy_case_reviews: 1, batch_policy_schedules: 1 });
    await runDemoOperation(conn.db, { requestId: randomUUID(), action: "restore", expectedState: (await getResetStatus(conn.db)).state, backupId: reset.backupId, confirmation: "RESTORE BACKUP" });
    expect(await getCase(conn.db, packet.id)).toEqual({ packet, reviews: [review] });
    expect(await conn.db.select().from(batchPolicySchedules)).toMatchObject([{ scheduleId: "apple" }]);
    await conn.db.update(policyCasePackets).set({ snapshot: { title: "Tampered" } }).where(eq(policyCasePackets.id, packet.id));
    await expect(getCase(conn.db, packet.id)).rejects.toMatchObject({ status: 409 });
    expect(await conn.db.select().from(batches)).toHaveLength(3);
  });
});
