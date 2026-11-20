import { getDatabase } from "@/lib/db";
import { copyHandlers } from "@/lib/documents/copy-http";
export async function POST(request: Request, context: RouteContext<"/api/incidents/[id]/document-copies">) {
  const { id } = await context.params;
  return copyHandlers(getDatabase).POST(request, id);
}
