import { getDatabase } from "@/lib/db";
import { copyHandlers } from "@/lib/documents/copy-http";
export async function GET(_request: Request, context: RouteContext<"/api/incidents/[id]/document-sources/[documentId]">) {
  const { id, documentId } = await context.params;
  return copyHandlers(getDatabase).PREVIEW(id, documentId);
}
