import { z } from "zod";
import { instantSchema } from "../inventory/validation";

export const simulatorControls = [
  { id: "scenario-01", label: "Normal operation", hint: "Readings around 3 °C" },
  { id: "worked-example", label: "Prolonged temperature rise", hint: "The worked-example source records" },
  { id: "scenario-11", label: "Missing readings", hint: "A gap within the rise" },
  { id: "scenario-14", label: "Conflicting report", hint: "A report with a 04:00 restart" },
  { id: "scenario-08", label: "Brief spike", hint: "The 15-minute source fixture" },
  { id: "scenario-18", label: "Ongoing failure", hint: "High readings at the end of the log" },
  { id: "scenario-22", label: "Late-arriving batch", hint: "B enters at 05:40; C at 06:00" },
  { id: "scenario-21", label: "Early-departing batch", hint: "B leaves at the first high reading" },
] as const;

// Fixture settings are independent of edits to the operator's persisted settings.
export const simulatorSettings = { normalMinC: 2, normalMaxC: 5, abnormalAboveC: 5, maxGapMinutes: 30 } as const;

export const simulatorPreviewSchema = z.strictObject({
  mode: z.literal("preview"), persisted: z.literal(false),
  id: z.string().min(1), label: z.string().min(1), name: z.string().min(1), description: z.string(),
  settings: z.strictObject({ normalMinC: z.literal(simulatorSettings.normalMinC), normalMaxC: z.literal(simulatorSettings.normalMaxC), abnormalAboveC: z.literal(simulatorSettings.abnormalAboveC), maxGapMinutes: z.literal(simulatorSettings.maxGapMinutes) }),
  readings: z.array(z.strictObject({ id: z.string(), recordedAt: instantSchema, temperatureC: z.number(), scenarioId: z.string() })).min(1).max(20_000),
  batches: z.array(z.strictObject({ id: z.string(), batchCode: z.string(), ownerName: z.string(), quantityKg: z.number().positive(), recordedValueInr: z.number().nonnegative().nullable(), enteredAt: instantSchema, exitedAt: instantSchema.nullable() })),
  documents: z.array(z.strictObject({ id: z.string(), docType: z.enum(["maintenance_report", "stock_inspection_report"]), filename: z.string(), rawText: z.string() })),
}).superRefine((preview, context) => {
  let previous = -Infinity;
  preview.readings.forEach((reading, index) => {
    const time = Date.parse(reading.recordedAt);
    if (time <= previous || reading.scenarioId !== preview.id) context.addIssue({ code: "custom", path: ["readings", index], message: "Preview readings must be ordered, unique and belong to this fixture." });
    previous = time;
  });
});
export type SimulatorPreview = z.infer<typeof simulatorPreviewSchema>;
