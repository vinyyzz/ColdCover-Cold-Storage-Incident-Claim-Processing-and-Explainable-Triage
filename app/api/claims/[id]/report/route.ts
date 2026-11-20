import { getDatabase } from "@/lib/db";
import { reportHandler } from "@/lib/reports/http";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return reportHandler(getDatabase)(request, (await context.params).id); }
