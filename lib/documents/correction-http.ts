import { z } from "zod";
import { AnalysisError } from "../analysis/types";
import type { Database } from "../db/client";
import { correctionIdentifier, correctionInputSchema } from "./corrections";
import { correctDocument } from "./correction-service";
import { readDocumentJson } from "./http";
import { DocumentError } from "./service";

export function correctionHandler(getDb: () => Promise<Database>) {
  return async function PATCH(request: Request, id: string) {
    const headers = { "Cache-Control": "no-store" };
    try {
      correctionIdentifier.parse(id);
      const input = correctionInputSchema.parse(await readDocumentJson(request));
      return Response.json(await correctDocument(await getDb(), id, input), { headers });
    } catch (error) {
      if (error instanceof z.ZodError) return Response.json({ error: { code: "INVALID_CORRECTION", message: "Choose one field, a reason, current analysis/previous correction, and one exact source passage per value. Confirm its relevance. Use null or an empty array to clear a field." } }, { status: 400, headers });
      if (error instanceof DocumentError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers });
      if (error instanceof AnalysisError) return Response.json({ error: { code: "FRESHNESS_UNAVAILABLE", message: "Freshness could not be verified. Refresh the incident before correcting evidence." } }, { status: 409, headers });
      return Response.json({ error: { code: "CORRECTION_UNCONFIRMED", message: "The correction could not be confirmed. Inspect revision history or retry the same submission safely." } }, { status: 500, headers });
    }
  };
}
