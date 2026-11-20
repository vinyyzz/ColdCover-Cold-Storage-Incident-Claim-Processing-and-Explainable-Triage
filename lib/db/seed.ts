import type { Database } from "./client";
import * as tables from "./schema";
import { demonstrationPolicy } from "../demo/policy";
import { workedExample, workedExampleReadings } from "../demo/worked-example";
import { scenarioCatalog } from "../demo/scenarios/catalog";

export async function seedDatabase(db: Database) {
  // Fixed primary keys and targeted conflict handling preserve edits. Any other
  // integrity conflict aborts the transaction rather than silently hiding data.
  await db.transaction(insertMissingDemoRecords);
}

// Unqueued primitive for an already-owned transaction. Normal seed remains
// insert-missing-only; an explicit reset clears active rows separately.
export async function insertMissingDemoRecords(tx: Pick<Database, "insert">) {
    await tx.insert(tables.chambers).values({ id: "CH-1", name: "Demonstration chamber CH-1", commodity: "potatoes", normalMinC: 2, normalMaxC: 5 }).onConflictDoNothing({ target: tables.chambers.id });
    await tx.insert(tables.equipment).values({ id: "REF-01", chamberId: "CH-1", equipmentCode: "REF-01", description: "Fictional chamber refrigeration unit" }).onConflictDoNothing({ target: tables.equipment.id });
    await tx.insert(tables.thresholds).values({ id: 1 }).onConflictDoNothing({ target: tables.thresholds.id });
    await tx.insert(tables.policies).values({
      id: demonstrationPolicy.id,
      name: demonstrationPolicy.name,
      machineryBreakdownCoverRequired: true,
      recordsRequiredText: demonstrationPolicy.requiredRecords.join("\n"),
      notes: `${demonstrationPolicy.reviewNote}\n\n${demonstrationPolicy.references}`,
      wording: demonstrationPolicy.wording,
      demonstrationLabel: demonstrationPolicy.label,
    }).onConflictDoNothing({ target: tables.policies.id });
    await tx.insert(tables.scenarios).values(scenarioCatalog.map((scenario) => ({
      id: scenario.id, name: scenario.name, description: scenario.description, category: scenario.category,
      // Retain the original worked-example summary fields for existing consumers.
      expectedJson: scenario.id === workedExample.scenarioId
        ? { ...workedExample.expected, ...scenario.expected }
        : { ...scenario.expected },
    }))).onConflictDoNothing({ target: tables.scenarios.id });
    await tx.insert(tables.batches).values(workedExample.batches).onConflictDoNothing({ target: tables.batches.id });
    // Chunked inserts keep comfortably below SQLite parameter limits.
    const readings = workedExampleReadings();
    for (let start = 0; start < readings.length; start += 50) {
      await tx.insert(tables.temperatureReadings).values(readings.slice(start, start + 50)).onConflictDoNothing({ target: tables.temperatureReadings.id });
    }
    await tx.insert(tables.incidents).values({ id: workedExample.incidentId, chamberId: "CH-1", title: "Fictional refrigeration interruption — worked example", status: "draft", abnormalStart: null, abnormalEnd: null, createdAt: workedExample.createdAt }).onConflictDoNothing({ target: tables.incidents.id });
    await tx.insert(tables.documents).values({ id: workedExample.documentId, incidentId: workedExample.incidentId, docType: "maintenance_report", filename: "fictional-maintenance-REF-01.txt", rawText: workedExample.maintenanceReport, uploadedAt: workedExample.createdAt, extractionJson: null, extractionSource: null }).onConflictDoNothing({ target: tables.documents.id });
    await tx.insert(tables.incidentEvents).values({ id: "demo-document-uploaded-01", incidentId: workedExample.incidentId, occurredAt: workedExample.createdAt, eventType: "document_uploaded", description: "Fictional maintenance report provided for review; extraction pending.", sourceType: "document", sourceRef: workedExample.documentId }).onConflictDoNothing({ target: tables.incidentEvents.id });
    await tx.insert(tables.auditLog).values({ id: "demo-seed-01", actor: "demo_seed", action: "seed_demo", entity: "scenario", entityId: workedExample.scenarioId, at: workedExample.createdAt, detail: "Inserted fictional source records. No interval analysis, extraction, claim, or review decision has been generated." }).onConflictDoNothing({ target: tables.auditLog.id });
}
