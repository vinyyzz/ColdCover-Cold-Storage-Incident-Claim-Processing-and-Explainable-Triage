import { SAMPLE_CSV } from "@/lib/temperature/csv";

export function GET() {
  return new Response(SAMPLE_CSV, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="coldcover-temperature-sample.csv"', "X-Content-Type-Options": "nosniff" } });
}
