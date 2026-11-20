import { z } from "zod";
import { AnalysisError } from "../analysis/types";
import type { Database } from "../db/client";
import { getIncident, IncidentError, incidentIdSchema, listIncidents } from "./service";

const headers = { "Cache-Control": "no-store" };
function failure(error: unknown) {
  if (error instanceof IncidentError || error instanceof AnalysisError) return Response.json({ error: { code: error.code, message: error instanceof AnalysisError ? "Incident freshness could not be checked. Check the chamber configuration and refresh." : error.message } }, { status: error.status, headers });
  return Response.json({ error: { code: "INCIDENTS_UNAVAILABLE", message: "Incident evidence could not be loaded or verified. Refresh before continuing." } }, { status: 500, headers });
}
export function incidentHandlers(getDb: () => Promise<Database>) {
  return {
    async GET() {
      try { return Response.json(await listIncidents(await getDb()), { headers }); }
      catch (error) { return failure(error); }
    },
    async DETAIL(request: Request, id: string) {
      let revision: string | undefined;
      try {
        incidentIdSchema.parse(id);
        const values = new URL(request.url).searchParams.getAll("revision");
        if (values.length > 1) throw new Error("Choose one revision");
        revision = values.length ? incidentIdSchema.parse(values[0]) : undefined;
      } catch (error) {
        return Response.json({ error: { code: "INVALID_ID", message: error instanceof z.ZodError ? "Use a valid incident and optional revision identifier." : "Choose one revision identifier." } }, { status: 400, headers });
      }
      try { return Response.json(await getIncident(await getDb(), id, revision), { headers }); }
      catch (error) { return failure(error); }
    },
  };
}
