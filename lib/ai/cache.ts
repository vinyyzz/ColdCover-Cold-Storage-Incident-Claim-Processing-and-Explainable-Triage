import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { withDatabase } from "../db/access";
import type { Database } from "../db/client";
import { aiResultCache } from "../db/schema";
import { extractionSchema } from "../documents/contract";
import { toIstIso } from "../inventory/format";
import { ruleInstantSchema } from "../rules/validation";
import { summaryStatementSchema } from "../summaries/contract";
import { questionOutputSchema } from "./contract";
import type { AiCache, AiCacheIdentity } from "./runner";

const identitySchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/), inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  boundaryVersion: z.string().min(1).max(200), task: z.enum(["extraction", "summary", "questions"]),
  adapterRevision: z.string().min(1).max(200),
}).strict();

function cacheValue(identity: AiCacheIdentity, value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") > 1024 * 1024) throw new Error("Cache output is too large.");
  return identity.task === "extraction" ? extractionSchema.parse(value)
    : identity.task === "summary" ? z.array(summaryStatementSchema).min(1).max(2000).parse(value)
      : z.array(questionOutputSchema).max(2000).parse(value);
}

const caches = new WeakMap<Database, AiCache>();

/** Owns short queues, never a transaction around provider work. */
export function createDatabaseAiCache(db: Database): AiCache {
  const existing = caches.get(db);
  if (existing) return existing;
  const cache: AiCache = {
    async get(rawIdentity) {
      const identity = identitySchema.parse(rawIdentity);
      return withDatabase(db, async () => {
        const [row] = await db.select().from(aiResultCache).where(eq(aiResultCache.key, identity.key));
        if (!row) return null;
        if (row.inputFingerprint !== identity.inputFingerprint || row.boundaryVersion !== identity.boundaryVersion || row.task !== identity.task || row.adapterRevision !== identity.adapterRevision || !ruleInstantSchema.safeParse(row.createdAt).success) return null;
        // The runner separately revalidates support/citations for every hit.
        return cacheValue(identity, row.outputJson);
      });
    },
    async put(rawIdentity, value) {
      const identity = identitySchema.parse(rawIdentity), outputJson = cacheValue(identity, value);
      await withDatabase(db, async () => {
        const row = { ...identity, outputJson, createdAt: toIstIso(new Date().toISOString()) };
        // `key` is the sole conflict target; replacement repairs disposable cache
        // only. No evidence, extraction, annotation, audit or packet is changed.
        await db.insert(aiResultCache).values(row).onConflictDoUpdate({ target: aiResultCache.key, set: row });
      });
    },
  };
  caches.set(db, cache);
  return cache;
}
