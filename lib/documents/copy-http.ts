import { z } from "zod";
import { AnalysisError } from "../analysis/types";
import type { Database } from "../db/client";
import { copyIdentifier, copyInputSchema } from "./copy-contract";
import { copyDocument, listDocumentSources, previewDocumentSource } from "./copy-service";
import { DocumentError } from "./errors";
import { readDocumentJson } from "./http";

const headers = { "Cache-Control": "no-store" };
function failure(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: { code: "INVALID_COPY", message: "Choose valid source/target identifiers, the reviewed source version, current analysis and explicit association confirmation." } }, { status: 400, headers });
  if (error instanceof DocumentError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers });
  if (error instanceof AnalysisError) return Response.json({ error: { code: "FRESHNESS_UNAVAILABLE", message: "Incident freshness could not be checked. Refresh evidence before copying." } }, { status: 409, headers });
  return Response.json({ error: { code: "COPY_UNCONFIRMED", message: "Report reuse could not be loaded or confirmed. Refresh evidence or retry the same copy submission safely." } }, { status: 500, headers });
}
export function copyHandlers(getDb: () => Promise<Database>) {
  return {
    async LIST(request: Request, id: string) {
      try {
        copyIdentifier.parse(id);
        const url = new URL(request.url), cursors = url.searchParams.getAll("after");
        if (cursors.length > 1 || [...url.searchParams.keys()].some((key) => key !== "after")) throw new DocumentError(400, "INVALID_CURSOR", "Use at most one source cursor.");
        const after = cursors.length ? copyIdentifier.parse(cursors[0]) : undefined;
        return Response.json(await listDocumentSources(await getDb(), id, after), { headers });
      } catch (error) { return failure(error); }
    },
    async PREVIEW(id: string, sourceId: string) {
      try { copyIdentifier.parse(id); copyIdentifier.parse(sourceId); return Response.json(await previewDocumentSource(await getDb(), id, sourceId), { headers }); }
      catch (error) { return failure(error); }
    },
    async POST(request: Request, id: string) {
      try {
        copyIdentifier.parse(id);
        const input = copyInputSchema.parse(await readDocumentJson(request)), receipt = await copyDocument(await getDb(), id, input);
        return Response.json(receipt, { status: receipt.reused ? 200 : 201, headers });
      } catch (error) { return failure(error); }
    },
  };
}
