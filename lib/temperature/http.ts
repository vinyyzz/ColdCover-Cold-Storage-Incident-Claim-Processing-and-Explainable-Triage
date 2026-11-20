import type { Database } from "../db/client";
import { CsvError, MAX_CSV_BYTES, parseTemperatureCsv } from "./csv";
import { importReadings } from "./service";

async function readCsv(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "text/csv") throw new CsvError(415, "CONTENT_TYPE", "Send the CSV file as the request body with Content-Type: text/csv.");
  const reader = request.body?.getReader();
  if (!reader) throw new CsvError(400, "INVALID_CSV", "Choose a CSV file containing readings.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CSV_BYTES) { await reader.cancel(); throw new CsvError(413, "FILE_TOO_LARGE", "CSV files must be 2 MiB or smaller."); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof CsvError) throw error;
    throw new CsvError(400, "INVALID_ENCODING", "The CSV could not be read. Save it as UTF-8 and try again.");
  } finally { reader.releaseLock(); }
  return text;
}

export function temperatureUploadHandler(getDatabase: () => Promise<Database>) {
  return async function POST(request: Request) {
    try {
      const readings = parseTemperatureCsv(await readCsv(request));
      return Response.json(await importReadings(await getDatabase(), readings), { status: 201, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof CsvError) return Response.json({ error: { code: error.code, message: error.message, issues: error.issues } }, { status: error.status });
      // A concurrent connection can win the unique index after validation.
      let cause = error;
      for (let depth = 0; depth < 5 && cause instanceof Error; depth++, cause = cause.cause) {
        if (/UNIQUE constraint failed: temperature_readings\.chamber_id, temperature_readings\.recorded_at/.test(cause.message)) return Response.json({ error: { code: "TIMESTAMP_CONFLICT", message: "No readings imported. A timestamp already exists; refresh before retrying.", issues: [] } }, { status: 409 });
      }
      return Response.json({ error: { code: "IMPORT_FAILED", message: "The import could not be confirmed. Refresh the temperature records before retrying.", issues: [] } }, { status: 500 });
    }
  };
}
