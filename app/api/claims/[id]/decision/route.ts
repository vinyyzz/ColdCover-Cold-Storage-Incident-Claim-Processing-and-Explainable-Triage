import { getDatabase } from "@/lib/db";
import { reviewHandlers } from "@/lib/reviews/http";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return reviewHandlers(getDatabase).POST(request, (await context.params).id); }
