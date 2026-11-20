export async function sendCaseJson<T>(path: string, body: unknown, method = "POST"): Promise<T> {
  const result = await fetch(path, {
    method, headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), cache: "no-store",
  });
  const data = await result.json();
  if (!result.ok) throw new Error(typeof data?.error === "string" ? data.error : "The operation could not be verified.");
  return data as T;
}
export const caseErrorMessage = (error: unknown) => error instanceof Error ? error.message : "The operation could not be verified.";
