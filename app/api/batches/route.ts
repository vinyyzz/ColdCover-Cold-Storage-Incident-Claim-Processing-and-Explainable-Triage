import { getDatabase } from "@/lib/db";
import { batchHandlers } from "@/lib/inventory/http";

const handlers = batchHandlers(getDatabase);
export const GET = handlers.GET;
export const POST = handlers.POST;
