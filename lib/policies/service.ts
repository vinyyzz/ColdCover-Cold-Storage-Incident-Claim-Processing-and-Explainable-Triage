import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { withDatabase } from "../db/access";
import type { Database } from "../db/client";
import { policies } from "../db/schema";
import { demonstrationPolicy } from "../demo/policy";
import { toIstIso } from "../inventory/format";

// Validate without trimming away the wording held in the source record.
const text = z.string().refine((value) => value.trim().length > 0 && value.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
const storedPolicySchema = z.object({ id: z.literal(demonstrationPolicy.id), name: text, machineryBreakdownCoverRequired: z.boolean(), recordsRequiredText: text, notes: text, wording: text, demonstrationLabel: text }).strict();
type StoredPolicy = z.infer<typeof storedPolicySchema>;
export type PolicyView = { checkedAt: string } & (
  | { status: "available"; policy: StoredPolicy; requiredRecords: string[] }
  | { status: "unavailable"; reason: "missing" | "invalid" }
);

/** One queued SELECT; callers must not hold another withDatabase operation. */
export function getCurrentPolicy(db: Database): Promise<PolicyView> {
  return withDatabase(db, async () => {
    const [row] = await db.select().from(policies).where(eq(policies.id, demonstrationPolicy.id));
    const checkedAt = toIstIso(new Date().toISOString());
    if (!row) return { status: "unavailable", reason: "missing", checkedAt };
    const parsed = storedPolicySchema.safeParse(row);
    if (!parsed.success) return { status: "unavailable", reason: "invalid", checkedAt };
    return { status: "available", checkedAt, policy: parsed.data, requiredRecords: parsed.data.recordsRequiredText.split(/\r\n|\n|\r/u).filter((line) => line.trim().length > 0) };
  });
}
