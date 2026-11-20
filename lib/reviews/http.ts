import { z } from "zod";
import { claimIdentifier } from "../claims/contract";
import { ClaimError } from "../claims/service";
import type { Database } from "../db/client";
import { decisionInputSchema, reviewQuerySchema } from "./contract";
import { getReviewerIndex, getReviewState, recordDecision, ReviewError } from "./service";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const failure = (error: unknown) => error instanceof ReviewError || error instanceof ClaimError
  ? Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers })
  : error instanceof z.ZodError ? Response.json({ error: { code: "INVALID_REVIEW", message: "Use valid reviewed state, identifiers, status, fictional reviewer name and a nonblank comment of up to 2,000 characters." } }, { status: 400, headers })
  : Response.json({ error: { code: "REVIEW_UNCONFIRMED", message: "The review could not be verified or its save confirmed. If a request was sent, keep its saved details for an explicit retry." } }, { status: 500, headers });
async function readDecision(request: Request) {
  const url = new URL(request.url), origin = request.headers.get("origin");
  let expected: string;
  try { expected = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`).origin; }
  catch { throw new ReviewError(403, "ORIGIN_REJECTED", "The request origin could not be verified."); }
  if ((origin !== null && origin !== expected) || request.headers.get("sec-fetch-site") === "cross-site") throw new ReviewError(403, "ORIGIN_REJECTED", "Open the prepared packet before recording a review decision.");
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new ReviewError(415, "CONTENT_TYPE", "Send the confirmed review as JSON.");
  const reader = request.body?.getReader();
  if (!reader) throw new ReviewError(400, "INVALID_REVIEW", "Review and confirm the decision before saving.");
  let bytes = 0, text = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 16_384) { await reader.cancel(); throw new ReviewError(413, "BODY_TOO_LARGE", "The review request exceeds 16 KiB."); } text += decoder.decode(part.value, { stream: true }); }
    text += decoder.decode(); return decisionInputSchema.parse(JSON.parse(text));
  } catch (error) { if (error instanceof ReviewError || error instanceof z.ZodError) throw error; throw new ReviewError(400, "INVALID_REVIEW", "Send valid UTF-8 JSON review details."); }
  finally { reader.releaseLock(); }
}
export function reviewHandlers(getDb: () => Promise<Database>) {
  return {
    async INDEX(request: Request) {
      try {
        const params = new URL(request.url).searchParams;
        if ([...params.keys()].some((key) => key !== "after") || params.getAll("after").length > 1) throw new ReviewError(400, "INVALID_REVIEW", "Choose a valid reviewer page.");
        const query = reviewQuerySchema.parse(params.has("after") ? { after: params.get("after") } : {});
        return Response.json(await getReviewerIndex(await getDb(), query), { headers });
      } catch (error) { return failure(error); }
    },
    async STATE(id: string) { try { claimIdentifier.parse(id); return Response.json(await getReviewState(await getDb(), id), { headers }); } catch (error) { return failure(error); } },
    async POST(request: Request, id: string) {
      try { claimIdentifier.parse(id); const input = await readDecision(request), receipt = await recordDecision(await getDb(), id, input); return Response.json(receipt, { status: receipt.reused ? 200 : 201, headers }); }
      catch (error) { return failure(error); }
    },
  };
}
