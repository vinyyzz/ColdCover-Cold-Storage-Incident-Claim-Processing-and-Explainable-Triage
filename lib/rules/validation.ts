import { z } from "zod";

// Rules own this pure boundary: no UI, database, environment or wall-clock input.
export const ruleInstantSchema = z.iso.datetime({ offset: true })
  .refine((value) => !/\.\d{4}/.test(value) && Number.isFinite(Date.parse(value)), "Use a valid offset timestamp with at most millisecond precision.")
  .transform((value) => new Date(Date.parse(value) + 330 * 60000).toISOString().replace(/\.000Z$/, "+05:30").replace(/Z$/, "+05:30"))
  .refine((value) => /^\d{4}-/.test(value), "The normalized IST timestamp must have a four-digit year.");

const identifier = z.string().min(1).max(120).refine((value) => value.trim().length > 0, "Reading IDs cannot be blank.");
const duration = z.number().int().positive().max(Math.floor(Number.MAX_SAFE_INTEGER / 60000));
export const temperatureRulesInputSchema = z.object({
  // Source metadata may accompany readings/settings; it is ignored, not mutated.
  readings: z.array(z.object({ id: identifier, recordedAt: ruleInstantSchema, temperatureC: z.number() })),
  settings: z.object({ abnormalAboveC: z.number(), minAbnormalMinutes: duration, maxGapMinutes: duration }),
}).superRefine(({ readings }, context) => {
  let previous = -Infinity;
  const ids = new Set<string>();
  readings.forEach((reading, index) => {
    const time = Date.parse(reading.recordedAt);
    if (time <= previous) context.addIssue({ code: "custom", path: ["readings", index, "recordedAt"], message: "Readings must be strictly ordered by instant with no duplicate timestamps, including equivalent offsets." });
    if (ids.has(reading.id)) context.addIssue({ code: "custom", path: ["readings", index, "id"], message: "Reading IDs must be unique for traceable evidence." });
    ids.add(reading.id); previous = time;
  });
});
