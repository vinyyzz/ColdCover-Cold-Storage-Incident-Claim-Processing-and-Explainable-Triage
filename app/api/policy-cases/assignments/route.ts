import { getDatabase } from "@/lib/db";
import { assignmentSchema } from "@/lib/policy-cases/contract";
import { caseJson, caseResponse } from "@/lib/policy-cases/http";
import { assignSchedule } from "@/lib/policy-cases/service";

export function PUT(request: Request) {
  return caseResponse(async () => {
    const input = assignmentSchema.parse(await caseJson(request));
    return assignSchedule(await getDatabase(), input);
  });
}
