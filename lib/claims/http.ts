import { z } from "zod";
import type { Database } from "../db/client";
import { IncidentError } from "../incidents/service";
import { claimIdentifier, prepareInputSchema } from "./contract";
import { ClaimError, getClaim, prepareClaim, previewClaim } from "./service";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const failure = (error: unknown) => error instanceof ClaimError || error instanceof IncidentError
  ? Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers })
  : error instanceof z.ZodError ? Response.json({ error: { code: "INVALID_REQUEST", message: "Use valid identifiers and the reviewed packet details." } }, { status: 400, headers })
  : Response.json({ error: { code: "CLAIM_UNCONFIRMED", message: "The packet could not be verified or its preparation confirmed. Keep the same saved request for an explicit retry." } }, { status: 500, headers });
async function readPreparation(request: Request) {
  const url = new URL(request.url), origin = request.headers.get("origin");
  let expected: string;
  try { expected = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`).origin; }
  catch { throw new ClaimError(403, "ORIGIN_REJECTED", "The request origin could not be verified."); }
  if ((origin !== null && origin !== expected) || request.headers.get("sec-fetch-site") === "cross-site") throw new ClaimError(403, "ORIGIN_REJECTED", "Open the incident workspace before preparing a packet.");
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new ClaimError(415, "CONTENT_TYPE", "Send reviewed packet details as JSON.");
  const reader = request.body?.getReader();
  if (!reader) throw new ClaimError(400, "INVALID_REQUEST", "Review the packet before preparation.");
  const decoder = new TextDecoder("utf-8", { fatal: true }); let bytes = 0, text = "";
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 4096) { await reader.cancel(); throw new ClaimError(413, "BODY_TOO_LARGE", "The preparation request exceeds 4 KiB."); }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return prepareInputSchema.parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof ClaimError || error instanceof z.ZodError) throw error;
    throw new ClaimError(400, "INVALID_REQUEST", "Send valid UTF-8 JSON packet details.");
  } finally { reader.releaseLock(); }
}
export function claimHandlers(getDb: () => Promise<Database>) {
  return {
    async PREVIEW(request: Request, id: string) {
      try {
        claimIdentifier.parse(id);
        const params = new URL(request.url).searchParams;
        if ([...params.keys()].some((key) => key !== "revision") || params.getAll("revision").length !== 1) throw new ClaimError(400, "INVALID_REQUEST", "Select one explicit analysis revision.");
        const revision = claimIdentifier.parse(params.get("revision"));
        return Response.json(await previewClaim(await getDb(), id, revision), { headers });
      } catch (error) { return failure(error); }
    },
    async PREPARE(request: Request, id: string) {
      try {
        claimIdentifier.parse(id); const input = await readPreparation(request);
        const receipt = await prepareClaim(await getDb(), id, input);
        return Response.json(receipt, { status: receipt.reused ? 200 : 201, headers });
      } catch (error) { return failure(error); }
    },
    async DETAIL(id: string) {
      try { claimIdentifier.parse(id); return Response.json(await getClaim(await getDb(), id), { headers }); }
      catch (error) { return failure(error); }
    },
  };
}
