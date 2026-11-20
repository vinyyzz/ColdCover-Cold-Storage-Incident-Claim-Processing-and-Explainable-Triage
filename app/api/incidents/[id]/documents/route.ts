import { getDatabase } from "@/lib/db";
import { documentHandler } from "@/lib/documents/http";

export async function POST(request: Request, context: RouteContext<"/api/incidents/[id]/documents">) {
  const { id } = await context.params;
  return documentHandler(getDatabase)(request, id);
}
