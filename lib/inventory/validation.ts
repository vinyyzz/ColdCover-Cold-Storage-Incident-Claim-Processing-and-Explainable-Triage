import { z } from "zod";
import { scheduleIds } from "../policy-cases/catalogue";
import { toIstIso } from "./format";

export const instantSchema = z.iso.datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)), "Enter a valid timestamp with a timezone.")
  .transform(toIstIso);

const fields = z.strictObject({
  batchCode: z.string().trim().min(1, "Enter a batch code.").max(40).toUpperCase(),
  ownerName: z.string().trim().min(1, "Enter the owner name.").max(120),
  quantityKg: z.number().positive("Quantity must be greater than zero."),
  recordedValueInr: z.number().nonnegative("Value cannot be negative.").max(Number.MAX_SAFE_INTEGER / 100)
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001, "Use at most two decimal places for INR.").nullable(),
  enteredAt: instantSchema,
  exitedAt: instantSchema.nullable(),
});

export const batchInputSchema = fields.extend({
  scheduleId: z.enum(scheduleIds).optional(),
  recordedValueInr: fields.shape.recordedValueInr.default(null),
  exitedAt: fields.shape.exitedAt.default(null),
}).superRefine((value, ctx) => {
  if (value.exitedAt !== null && Date.parse(value.exitedAt) < Date.parse(value.enteredAt)) {
    ctx.addIssue({ code: "custom", path: ["exitedAt"], message: "Exit must be at or after entry." });
  }
});

export const batchPatchSchema = fields.partial().refine((value) => Object.keys(value).length > 0, "Provide at least one editable field.");
export const batchIdSchema = z.string().min(1).max(120);
export type BatchInput = z.infer<typeof batchInputSchema>;
