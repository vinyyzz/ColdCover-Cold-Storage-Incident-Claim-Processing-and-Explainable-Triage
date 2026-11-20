import { getDatabase } from "@/lib/db";
import { correctionHandler } from "@/lib/documents/correction-http";

export async function PATCH(request: Request, context: RouteContext<"/api/documents/[id]/extraction">) {
  const { id } = await context.params;
  return correctionHandler(getDatabase)(request, id);
}
