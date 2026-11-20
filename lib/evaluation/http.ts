import { z } from "zod";
import { runAllScenarios } from "./evaluate";

const headers = { "Cache-Control": "no-store" };
const empty = z.strictObject({});
class InputError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
async function readInput(request: Request) {
  const reader = request.body?.getReader(); if (!reader) return;
  const decoder = new TextDecoder("utf-8", { fatal: true }); let bytes = 0, text = "";
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1024) { await reader.cancel(); throw new InputError(413, "BODY_TOO_LARGE", "Scenario checks accept only an empty request, up to 1 KiB."); }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) { if (error instanceof InputError) throw error; throw new InputError(400, "INVALID_UTF8", "The request must contain valid UTF-8 text."); }
  finally { reader.releaseLock(); }
  if (!text.trim()) return;
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new InputError(415, "CONTENT_TYPE", "Use an empty JSON object or send no body.");
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new InputError(400, "INVALID_JSON", "Send an empty JSON object or no body."); }
  if (!empty.safeParse(body).success) throw new InputError(400, "INVALID_REQUEST", "Scenario checks use fixed fictional fixtures. Do not supply settings, readings or expected outcomes.");
}
// No database, provider or persisted scenario activation/reset dependency.
export function evaluationHandler(run = runAllScenarios) {
  return async (request: Request) => {
    try { await readInput(request); return Response.json(run(new Date().toISOString()), { headers }); }
    catch (error) {
      return Response.json({ error: error instanceof InputError ? { code: error.code, message: error.message } : { code: "EVALUATION_UNAVAILABLE", message: "Scenario checks could not be completed. Try again; no stored evidence was changed." } }, { status: error instanceof InputError ? error.status : 500, headers });
    }
  };
}
