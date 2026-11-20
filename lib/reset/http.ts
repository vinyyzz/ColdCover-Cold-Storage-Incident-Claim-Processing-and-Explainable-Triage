import type { Database } from "../db/client";
import { backupIdSchema, operationInputSchema, statusQuerySchema } from "./contract";
import { ResetError } from "./errors";
import { downloadDemoBackup, getResetStatus, runDemoOperation } from "./service";

const headers = { "Cache-Control": "no-store" };
const failure = (error: unknown) => error instanceof ResetError
  ? Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers })
  : Response.json({ error: { code: "RESET_UNCONFIRMED", message: "The operation result could not be confirmed. If a request was sent, keep its saved details and retry that same request." } }, { status: 500, headers });
async function readOperation(request: Request) {
  const origin = request.headers.get("origin");
  // NextURL normalises loopback URL hosts to localhost. The browser's Origin
  // instead follows the actual incoming Host, which is forbidden to page JS.
  // Do not trust forwarded-host/protocol headers from arbitrary callers.
  const url = new URL(request.url);
  let expectedOrigin: string;
  try { expectedOrigin = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`).origin; }
  catch { throw new ResetError(403, "ORIGIN_REJECTED", "The request origin could not be verified."); }
  if ((origin !== null && origin !== expectedOrigin) || request.headers.get("sec-fetch-site") === "cross-site") throw new ResetError(403, "ORIGIN_REJECTED", "Open this application's admin page before confirming a workspace replacement.");
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new ResetError(415, "CONTENT_TYPE", "Use a confirmed JSON operation request.");
  const reader = request.body?.getReader();
  if (!reader) throw new ResetError(400, "INVALID_REQUEST", "Review and confirm the workspace before continuing.");
  const decoder = new TextDecoder("utf-8", { fatal: true }); let bytes = 0, text = "";
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4096) { await reader.cancel(); throw new ResetError(413, "BODY_TOO_LARGE", "The operation request exceeds 4 KiB."); }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) { if (error instanceof ResetError) throw error; throw new ResetError(400, "INVALID_REQUEST", "Send valid UTF-8 JSON operation details."); }
  finally { reader.releaseLock(); }
  try { return operationInputSchema.parse(JSON.parse(text)); }
  catch { throw new ResetError(400, "INVALID_REQUEST", "Use the reviewed state, a request identifier and the exact confirmation phrase for this operation."); }
}

export function resetHandlers(getDb: () => Promise<Database>) {
  return {
    async GET(request: Request) {
      let before: number | undefined;
      try {
        const url = new URL(request.url);
        if ([...url.searchParams.keys()].some((key) => key !== "before") || url.searchParams.getAll("before").length > 1) throw new Error("Invalid query");
        before = statusQuerySchema.parse(url.searchParams.has("before") ? { before: url.searchParams.get("before") } : {}).before;
      } catch { return Response.json({ error: { code: "INVALID_REQUEST", message: "Choose a valid backup page." } }, { status: 400, headers }); }
      try { return Response.json(await getResetStatus(await getDb(), before), { headers }); }
      catch (error) { return failure(error); }
    },
    async POST(request: Request) {
      try { const input = await readOperation(request); return Response.json(await runDemoOperation(await getDb(), input), { headers }); }
      catch (error) { return failure(error); }
    },
    async DOWNLOAD(id: string) {
      if (!backupIdSchema.safeParse(id).success) return Response.json({ error: { code: "INVALID_REQUEST", message: "Choose a valid backup identifier." } }, { status: 400, headers });
      try {
        const result = await downloadDemoBackup(await getDb(), id);
        return Response.json(result, { headers: { ...headers, "Content-Disposition": `attachment; filename="coldcover-backup-${result.id}.json"`, "X-Content-Type-Options": "nosniff" } });
      } catch (error) { return failure(error); }
    },
  };
}
