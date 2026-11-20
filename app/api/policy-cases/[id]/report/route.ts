import { getDatabase } from "@/lib/db";
import { REPORT_CSP } from "@/lib/reports/contract";
import { caseIdSchema } from "@/lib/policy-cases/contract";
import { caseHeaders, caseResponse } from "@/lib/policy-cases/http";
import { renderPolicyReport } from "@/lib/policy-cases/report";
import { getCase, PolicyCaseError } from "@/lib/policy-cases/service";

export async function GET(request: Request, { params }: { params: Promise<{id: string}> }) {
  try {
    const id = caseIdSchema.parse((await params).id);
    const query = new URL(request.url).searchParams;
    if ([...query].some(([key, value]) => key !== "download" || value !== "1") || query.getAll("download").length > 1)
      throw new PolicyCaseError(400, "Invalid report option.");
    const data = await getCase(await getDatabase(), id);
    const headers = {
      ...caseHeaders, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": REPORT_CSP,
      ...(query.has("download") ? { "Content-Disposition": `attachment; filename="coldcover-policy-${id}.html"` } : {}),
    };
    return new Response(renderPolicyReport(data), { headers });
  } catch (error) { return caseResponse(async () => { throw error; }); }
}
