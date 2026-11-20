import { getDatabase } from "@/lib/db";
import { reviewHandlers } from "@/lib/reviews/http";
export async function GET(request: Request) { return reviewHandlers(getDatabase).INDEX(request); }
