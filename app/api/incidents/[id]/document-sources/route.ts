import { getDatabase } from "@/lib/db";
import { copyHandlers } from "@/lib/documents/copy-http";
export async function GET(request: Request, context: RouteContext<"/api/incidents/[id]/document-sources">) {
  const { id } = await context.params;
  return copyHandlers(getDatabase).LIST(request, id);
}
