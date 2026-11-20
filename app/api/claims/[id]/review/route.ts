import { getDatabase } from "@/lib/db";
import { reviewHandlers } from "@/lib/reviews/http";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { return reviewHandlers(getDatabase).STATE((await context.params).id); }
