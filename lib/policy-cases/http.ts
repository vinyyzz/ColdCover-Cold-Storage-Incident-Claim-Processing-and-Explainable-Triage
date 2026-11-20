import { ZodError } from "zod";
import { CsvError } from "../temperature/csv";
import { PolicyCaseError } from "./service";

export const caseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function caseJson(request: Request): Promise<unknown> {
  const url = new URL(request.url);
  const origin = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`).origin;
  const supplied = request.headers.get("origin");
  if ((supplied !== null && supplied !== origin) || request.headers.get("sec-fetch-site") === "cross-site")
    throw new PolicyCaseError(403, "Use this application's forms to update policy cases.");
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new PolicyCaseError(415, "Send JSON policy case details.");
  const reader = request.body?.getReader();
  if (!reader) throw new PolicyCaseError(400, "Policy case details are required.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 512 * 1024) {
        await reader.cancel();
        throw new PolicyCaseError(413, "The request exceeds 512 KiB.");
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } catch (error) {
    if (error instanceof PolicyCaseError) throw error;
    throw new PolicyCaseError(400, "Send valid UTF-8 JSON policy case details.");
  } finally { reader.releaseLock(); }
}
export async function caseResponse(run: () => Promise<unknown>, status = 200) {
  try { return Response.json(await run(), { status, headers: caseHeaders }); }
  catch (error) {
    const errorStatus = error instanceof PolicyCaseError || error instanceof CsvError ? error.status : error instanceof ZodError ? 400 : 500;
    const message = error instanceof CsvError && error.issues.length
      ? error.issues.slice(0, 4).map(({ row, message }) => `Row ${row}: ${message}`).join(" ")
      : error instanceof PolicyCaseError || error instanceof CsvError ? error.message
        : error instanceof ZodError ? error.issues[0]?.message ?? "Check the policy case details."
          : "The result could not be verified. Try again with the same request.";
    return Response.json({ error: message }, { status: errorStatus, headers: caseHeaders });
  }
}
