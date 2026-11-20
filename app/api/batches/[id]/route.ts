import { getDatabase } from "@/lib/db";
import { batchHandlers } from "@/lib/inventory/http";

const handlers = batchHandlers(getDatabase);

export async function PATCH(request: Request, context: RouteContext<"/api/batches/[id]">) {
  const { id } = await context.params;
  return handlers.PATCH(request, id);
}
