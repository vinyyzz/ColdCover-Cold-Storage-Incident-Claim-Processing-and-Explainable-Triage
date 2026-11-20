import { getDatabase } from "@/lib/db";
import { resetHandlers } from "@/lib/reset/http";

const handlers = resetHandlers(getDatabase);
export const GET = handlers.GET;
export const POST = handlers.POST;
