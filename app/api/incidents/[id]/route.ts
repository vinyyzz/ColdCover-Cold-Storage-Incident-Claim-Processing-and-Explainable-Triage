import { getDatabase } from "@/lib/db";
import { incidentHandlers } from "@/lib/incidents/http";

export async function GET(request: Request, context: RouteContext<"/api/incidents/[id]">) {
  const { id } = await context.params;
  return incidentHandlers(getDatabase).DETAIL(request, id);
}
