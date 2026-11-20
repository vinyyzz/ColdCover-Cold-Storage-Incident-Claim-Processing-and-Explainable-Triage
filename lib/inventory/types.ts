import type { batches } from "../db/schema";

export type Batch = typeof batches.$inferSelect;
export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string[]> };
}
