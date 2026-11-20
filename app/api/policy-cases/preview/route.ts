import { getDatabase } from "@/lib/db";
import { caseDraftSchema } from "@/lib/policy-cases/contract";
import { caseJson, caseResponse } from "@/lib/policy-cases/http";
import { previewCase } from "@/lib/policy-cases/service";

export function POST(request: Request) {
  return caseResponse(async () => {
    const input = caseDraftSchema.parse(await caseJson(request));
    return previewCase(await getDatabase(), input);
  });
}
