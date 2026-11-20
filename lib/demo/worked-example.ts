const day = "2026-03-10";

export const workedExample = {
  scenarioId: "worked-example",
  incidentId: "demo-incident-01",
  documentId: "demo-maintenance-01",
  createdAt: `${day}T08:00:00+05:30`,
  expected: {
    abnormalIntervals: [{ start: `${day}T01:20:00+05:30`, end: `${day}T05:40:00+05:30` }],
    exposedBatchCodes: ["A", "B"],
    notPresentBatchCodes: ["C"],
    exposureValueInr: 80000,
    readiness: "Needs more evidence",
    priority: "Standard priority",
    keyReasons: ["Stock inspection report missing"],
  },
  batches: [
    { id: "demo-batch-a", batchCode: "A", ownerName: "Fictional Grower A", chamberId: "CH-1", quantityKg: 2500, recordedValueInr: 50000, enteredAt: "2026-03-09T18:00:00+05:30", exitedAt: null },
    { id: "demo-batch-b", batchCode: "B", ownerName: "Fictional Grower B", chamberId: "CH-1", quantityKg: 1500, recordedValueInr: 30000, enteredAt: "2026-03-09T20:00:00+05:30", exitedAt: null },
    { id: "demo-batch-c", batchCode: "C", ownerName: "Fictional Grower C", chamberId: "CH-1", quantityKg: 1000, recordedValueInr: 20000, enteredAt: `${day}T06:00:00+05:30`, exitedAt: null },
  ],
  maintenanceReport: `FICTIONAL DEMONSTRATION RECORD — Maintenance report
Chamber: CH-1 | Refrigeration unit: REF-01
Service date: 10 March 2026 (all times IST, +05:30)

The operator reported a compressor fault at 01:10 on 10 March 2026. The technician attended refrigeration unit REF-01 and recorded a compressor fault as the reported cause of the interruption. This report describes equipment service only and does not establish the condition of any potatoes held in the chamber.

Repair work was completed at 05:00 on 10 March 2026. Refrigeration restarted at 05:10 on 10 March 2026. The operator was asked to retain the temperature records and check the chamber readings after restart. Cooling can continue after equipment resumes operation; the temperature log should be reviewed alongside this report.

The technician did not inspect stock or verify batch quantities and recorded values. A separate stock inspection report is not included with this fictional record. Prepared by Demo Service Technician for the ColdCover demonstration.`,
};

export function workedExampleReadings() {
  return Array.from({ length: 144 }, (_, step) => {
    const hour = String(Math.floor(step / 6)).padStart(2, "0");
    const minute = String((step % 6) * 10).padStart(2, "0");
    return {
      id: `worked-example-reading-${String(step).padStart(3, "0")}`,
      chamberId: "CH-1",
      scenarioId: workedExample.scenarioId,
      recordedAt: `${day}T${hour}:${minute}:00+05:30`,
      temperatureC: step >= 8 && step < 34 ? [6.1, 6.5, 7, 6.7][step % 4] : [3, 3.1, 2.9, 3.2][step % 4],
    };
  });
}
