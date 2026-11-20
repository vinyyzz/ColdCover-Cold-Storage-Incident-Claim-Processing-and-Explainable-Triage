import { simulatorPreviewResponse } from "@/lib/simulator/http";

export async function POST(_request: Request, context: RouteContext<"/api/simulator/[scenarioId]">) {
  const { scenarioId } = await context.params;
  return simulatorPreviewResponse(scenarioId);
}
