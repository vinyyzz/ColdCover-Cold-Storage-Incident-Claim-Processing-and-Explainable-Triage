import { getDatabase } from "@/lib/db";
import { prepareSchema } from "@/lib/policy-cases/contract";
import { caseJson, caseResponse } from "@/lib/policy-cases/http";
import { prepareCase } from "@/lib/policy-cases/service";

export function POST(request: Request) {
  return caseResponse(async () => {
    const input = prepareSchema.parse(await caseJson(request));
    return prepareCase(await getDatabase(), input);
  }, 201);
}
