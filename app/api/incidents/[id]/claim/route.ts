import { getDatabase } from "@/lib/db";
import { claimHandlers } from "@/lib/claims/http";
const handlers = claimHandlers(getDatabase);
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) { return handlers.PREVIEW(request, (await context.params).id); }
export async function POST(request: Request, context: Context) { return handlers.PREPARE(request, (await context.params).id); }
