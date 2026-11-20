import { getDatabase } from "@/lib/db";
import { resetHandlers } from "@/lib/reset/http";

export async function GET(_request: Request, context: RouteContext<"/api/admin/backups/[id]">) {
  const { id } = await context.params;
  return resetHandlers(getDatabase).DOWNLOAD(id);
}
