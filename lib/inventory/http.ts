import { z } from "zod";
import type { Database } from "../db/client";
import { stockPresence } from "./format";
import { createBatch, InventoryError, listBatches, updateBatch } from "./service";
import { instantSchema } from "./validation";

function batchCodeConflict(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (/UNIQUE constraint failed: batches\.batch_code/.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

function errorResponse(error: unknown) {
  if (error instanceof z.ZodError) {
    return Response.json({ error: { code: "VALIDATION_ERROR", message: error.issues[0]?.message ?? "Check the supplied fields.", fields: z.flattenError(error).fieldErrors } }, { status: 400 });
  }
  if (error instanceof InventoryError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  if (batchCodeConflict(error)) return Response.json({ error: { code: "CONFLICT", message: "That batch code already exists. Choose a different code.", fields: { batchCode: ["This code is already in use."] } } }, { status: 409 });
  return Response.json({ error: { code: "INTERNAL_ERROR", message: "Inventory could not be saved or loaded. Please try again." } }, { status: 500 });
}

async function readJson(request: Request) {
  try { return await request.json() as unknown; }
  catch { throw new InventoryError(400, "INVALID_JSON", "Send a valid JSON request body."); }
}

export function batchHandlers(getDb: () => Promise<Database>) {
  return {
    async GET(request: Request) {
      try {
        const value = new URL(request.url).searchParams.get("at");
        const at = value === null ? null : instantSchema.parse(value);
        const records = await listBatches(await getDb());
        return Response.json({ batches: records, at, presentBatchIds: at === null ? null : records.filter((batch) => stockPresence(batch, at) === "present").map((batch) => batch.id) }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) { return errorResponse(error); }
    },
    async POST(request: Request) {
      try {
        const input = await readJson(request);
        return Response.json({ batch: await createBatch(await getDb(), input) }, { status: 201 });
      } catch (error) { return errorResponse(error); }
    },
    async PATCH(request: Request, id: string) {
      try {
        const input = await readJson(request);
        return Response.json({ batch: await updateBatch(await getDb(), id, input) });
      } catch (error) { return errorResponse(error); }
    },
  };
}
