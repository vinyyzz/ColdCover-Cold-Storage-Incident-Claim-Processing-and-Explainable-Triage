import { getDatabase } from "@/lib/db";
import { caseIdSchema, reviewInputSchema } from "@/lib/policy-cases/contract";
import { caseJson, caseResponse } from "@/lib/policy-cases/http";
import { appendPolicyCaseReview } from "@/lib/policy-cases/service";

export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return caseResponse(async () => {
    const id = caseIdSchema.parse((await params).id);
    const input = reviewInputSchema.parse(await caseJson(request));
    return appendPolicyCaseReview(await getDatabase(), id, input);
  }, 201);
}
