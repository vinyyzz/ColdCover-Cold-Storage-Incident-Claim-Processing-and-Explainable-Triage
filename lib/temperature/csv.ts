import { instantSchema } from "../inventory/validation";

export const MAX_CSV_ROWS = 20_000;
export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export type CsvIssue = { row: number; message: string };
export type CsvReading = { row: number; recordedAt: string; temperatureC: number };
export class CsvError extends Error {
  constructor(public status: number, public code: string, message: string, public issues: CsvIssue[] = []) { super(message); }
}

// A timestamp/number cannot contain a newline. Quoted scalar cells and escaped
// quotes are supported; malformed quoting is rejected instead of guessed.
function cells(line: string): string[] | null {
  const result: string[] = [];
  let value = "", quoted = false, closed = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closed = true; }
      } else value += char;
    } else if (char === ",") { result.push(value.trim()); value = ""; closed = false; }
    else if (char === '"') {
      if (value.trim() || closed) return null;
      value = ""; quoted = true;
    } else if (closed && char.trim()) return null;
    else value += char;
  }
  if (quoted) return null;
  result.push(value.trim());
  return result;
}

export function parseTemperatureCsv(text: string): CsvReading[] {
  if (new TextEncoder().encode(text).byteLength > MAX_CSV_BYTES) throw new CsvError(413, "FILE_TOO_LARGE", "CSV files must be 2 MiB or smaller.");
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  while (lines.length && lines.at(-1)?.trim() === "") lines.pop();
  const header = cells(lines[0] ?? "");
  if (!header || header.length !== 2 || !header.includes("timestamp") || !header.includes("temperature_c")) {
    throw new CsvError(400, "INVALID_CSV", "Use exactly the columns timestamp and temperature_c.", [{ row: 1, message: "Expected timestamp,temperature_c (either column order is accepted)." }]);
  }
  if (lines.length === 1) throw new CsvError(400, "INVALID_CSV", "Include at least one temperature reading.");
  if (lines.length - 1 > MAX_CSV_ROWS) throw new CsvError(400, "ROW_LIMIT", "CSV files may contain at most 20,000 readings.");
  const timeIndex = header.indexOf("timestamp"), temperatureIndex = header.indexOf("temperature_c");
  const readings: CsvReading[] = [], issues: CsvIssue[] = [], seen = new Set<number>();
  let previous = -Infinity;
  const add = (row: number, message: string) => { if (issues.length < 20) issues.push({ row, message }); };
  for (let i = 1; i < lines.length; i++) {
    const row = i + 1, fields = cells(lines[i]);
    if (!fields || fields.length !== 2) { add(row, "Each row needs two CSV cells with valid quoting; remove blank rows."); continue; }
    const rawTime = fields[timeIndex], rawTemperature = fields[temperatureIndex];
    // Millisecond precision matches JavaScript instants and avoids silently
    // merging distinct sub-millisecond source timestamps.
    const time = /\.\d{4}/.test(rawTime) ? null : instantSchema.safeParse(rawTime);
    const temperature = Number(rawTemperature);
    if (!time?.success) add(row, "Use a valid ISO timestamp with Z or an explicit offset, at most millisecond precision.");
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(rawTemperature) || !Number.isFinite(temperature)) add(row, "temperature_c must be a finite number; blank values are not zero.");
    if (!time?.success) continue;
    const at = Date.parse(time.data);
    if (seen.has(at)) add(row, "Duplicate timestamp: each instant can appear only once, including equivalent timezone offsets.");
    else if (at < previous) add(row, "Readings must be ordered from earliest to latest; rows are not sorted automatically.");
    seen.add(at); previous = at;
    readings.push({ row, recordedAt: time.data, temperatureC: temperature });
  }
  if (issues.length) throw new CsvError(400, "INVALID_CSV", "No readings imported. Correct the CSV errors and try again (up to 20 shown).", issues);
  return readings;
}

export const SAMPLE_CSV = "timestamp,temperature_c\n2026-03-11T00:00:00+05:30,3.1\n2026-03-11T00:10:00+05:30,3.0\n2026-03-11T00:20:00+05:30,3.2\n";
