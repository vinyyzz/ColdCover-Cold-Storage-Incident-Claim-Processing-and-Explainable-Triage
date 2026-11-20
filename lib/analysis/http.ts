import { z } from "zod";
import type { Database } from "../db/client";
import { ExposureValueOverflowError } from "../rules";
import { analyzeStoredLog, latestStoredAnalysis } from "./service";
import { AnalysisError } from "./types";

const emptyInput = z.strictObject({});
const headers = { "Cache-Control": "no-store" };

async function validateRequest(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return;
  let size = 0, text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) { await reader.cancel(); throw new AnalysisError(413, "BODY_TOO_LARGE", "Analysis accepts an empty body or an empty JSON object, up to 1 KiB."); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof AnalysisError) throw error;
    throw new AnalysisError(400, "INVALID_REQUEST", "The analysis request could not be read as UTF-8.");
  } finally { reader.releaseLock(); }
  if (!text.trim()) return;
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new AnalysisError(415, "CONTENT_TYPE", "Use application/json for an empty JSON object, or send no body.");
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new AnalysisError(400, "INVALID_JSON", "Send an empty JSON object or no body."); }
  if (!emptyInput.safeParse(body).success) throw new AnalysisError(400, "INVALID_REQUEST", "Analysis uses stored CH-1 data only. Do not supply readings, settings or scenario overrides.");
}

function failure(error: unknown) {
  if (error instanceof AnalysisError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers });
  if (error instanceof z.ZodError) return Response.json({ error: { code: "INVALID_STORED_DATA", message: "Stored readings, inventory or rule settings are invalid. Correct them before analysis. No analysis was saved." } }, { status: 409, headers });
  if (error instanceof ExposureValueOverflowError) return Response.json({ error: { code: "VALUE_OVERFLOW", message: "The known inventory subtotal exceeds the exact supported range. No analysis was saved." } }, { status: 409, headers });
  let cause = error;
  for (let depth = 0; depth < 5 && cause instanceof Error; depth++, cause = cause.cause) {
    if (/SQLITE_BUSY|database is locked|UNIQUE constraint failed: analysis_runs\.chamber_id, analysis_runs\.revision/.test(cause.message)) return Response.json({ error: { code: "ANALYSIS_BUSY", message: "Another database operation is active. Refresh analysis before retrying." } }, { status: 409, headers });
  }
  return Response.json({ error: { code: "ANALYSIS_FAILED", message: "Analysis could not be confirmed. Refresh analysis before retrying." } }, { status: 500, headers });
}

export function analysisHandlers(getDatabase: () => Promise<Database>) {
  return {
    async POST(request: Request) {
      try {
        await validateRequest(request);
        return Response.json(await analyzeStoredLog(await getDatabase()), { headers });
      } catch (error) { return failure(error); }
    },
    async GET() {
      try { return Response.json(await latestStoredAnalysis(await getDatabase()), { headers }); }
      catch (error) { return failure(error); }
    },
  };
}
