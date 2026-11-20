import { z } from "zod";
import type { Database } from "../db/client";
import { claimIdentifier } from "../claims/contract";
import { ClaimError } from "../claims/service";
import { REPORT_CSP, reportQuerySchema } from "./contract";
import { getClaimReport, ReportError } from "./service";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
export function reportHandler(getDb: () => Promise<Database>) {
  return async function GET(request: Request, id: string) {
    try {
      claimIdentifier.parse(id); const params = new URL(request.url).searchParams;
      if ([...params.keys()].some((key) => !["expected", "download"].includes(key)) || params.getAll("expected").length > 1 || params.getAll("download").length > 1) throw new ReportError(400, "INVALID_REPORT", "Choose a valid report view or download.");
      const query = reportQuerySchema.parse(Object.fromEntries(params));
      const report = await getClaimReport(await getDb(), id, query);
      return new Response(report.html, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": REPORT_CSP, "Content-Disposition": `${query.download ? "attachment" : "inline"}; filename="${report.filename}"`, "X-ColdCover-Report-State": report.state } });
    } catch (error) {
      if (error instanceof z.ZodError) return Response.json({ error: { code: "INVALID_REPORT", message: "Use a valid claim identifier and report view." } }, { status: 400, headers });
      if (error instanceof ClaimError || error instanceof ReportError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers });
      return Response.json({ error: { code: "REPORT_UNAVAILABLE", message: "The frozen packet or review history could not be verified. The report is withheld." } }, { status: 500, headers });
    }
  };
}
