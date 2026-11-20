import { getDatabase } from "@/lib/db";
import { claimHandlers } from "@/lib/claims/http";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { return claimHandlers(getDatabase).DETAIL((await context.params).id); }
