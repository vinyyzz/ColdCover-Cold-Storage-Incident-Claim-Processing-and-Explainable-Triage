import { z } from "zod";
import { analysisResponseSchema } from "./contract";

const errorSchema = z.object({ error: z.object({ message: z.string().min(1).max(600) }) });

export async function requestStoredAnalysis(method: "GET" | "POST", signal: AbortSignal, fetcher: typeof fetch = fetch) {
  let response: Response;
  try { response = await fetcher("/api/analyze", { method, cache: "no-store", signal }); }
  catch (error) {
    if (signal.aborted) throw error;
    throw new Error("The stored-log analysis service could not be reached. Refresh analysis before retrying.");
  }
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new Error("The analysis response could not be read. Refresh analysis before retrying."); }
  if (!response.ok) {
    const error = errorSchema.safeParse(body);
    throw new Error(error.success ? error.data.error.message : "Analysis is unavailable. Refresh analysis before retrying.");
  }
  const parsed = analysisResponseSchema.safeParse(body);
  if (!parsed.success || (method === "POST" && parsed.data.status !== "current")) throw new Error("The analysis response could not be verified. Refresh analysis before retrying.");
  return parsed.data;
}
