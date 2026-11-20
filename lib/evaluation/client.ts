import { parseEvaluationReport, type EvaluationReport } from "./contract";

export async function requestScenarioEvaluation(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<EvaluationReport> {
  let response: Response;
  try { response = await fetcher("/api/admin/run-scenarios", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: "{}", signal }); }
  catch (error) {
    if (signal.aborted) throw error;
    throw new Error("Scenario checks could not be completed. Check the connection and try again.");
  }
  if (!response.ok) throw new Error("Scenario checks could not be completed. Try again.");
  try { return parseEvaluationReport(await response.json()); }
  catch { throw new Error("The scenario response could not be verified. Run the checks again."); }
}
