import { z } from "zod";
import { AnalysisError } from "../analysis/types";
import type { Database } from "../db/client";
import { incidentIdSchema } from "../incidents/service";
import { documentInputSchema, MAX_DOCUMENT_BYTES } from "./contract";
import { addDocument, DocumentError } from "./service";

export async function readDocumentJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new DocumentError(415, "CONTENT_TYPE", "Send report text as application/json.");
  const reader = request.body?.getReader();
  if (!reader) throw new DocumentError(400, "INVALID_INPUT", "Paste report text before submitting.");
  let size = 0, text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DOCUMENT_BYTES) { await reader.cancel(); throw new DocumentError(413, "BODY_TOO_LARGE", "Report submissions must be 256 KiB or smaller."); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof DocumentError || error instanceof z.ZodError) throw error;
    throw new DocumentError(400, "INVALID_INPUT", "Use valid UTF-8 JSON report text.");
  } finally { reader.releaseLock(); }
}
export function documentHandler(getDb: () => Promise<Database>) {
  return async function POST(request: Request, id: string) {
    const headers = { "Cache-Control": "no-store" };
    try {
      incidentIdSchema.parse(id);
      const input = documentInputSchema.parse(await readDocumentJson(request));
      const receipt = await addDocument(await getDb(), id, input);
      return Response.json(receipt, { status: receipt.reused ? 200 : 201, headers });
    } catch (error) {
      if (error instanceof z.ZodError) return Response.json({ error: { code: "INVALID_INPUT", message: "Choose a report type, display filename, nonblank text (up to 50,000 characters), submission UUID and current analysis ID." } }, { status: 400, headers });
      if (error instanceof DocumentError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers });
      if (error instanceof AnalysisError) return Response.json({ error: { code: "FRESHNESS_UNAVAILABLE", message: "Incident freshness could not be verified. Refresh evidence before submitting." } }, { status: 409, headers });
      return Response.json({ error: { code: "DOCUMENT_UNCONFIRMED", message: "The save could not be confirmed. Refresh evidence, or retry the same submission; its identifier prevents duplicates." } }, { status: 500, headers });
    }
  };
}
