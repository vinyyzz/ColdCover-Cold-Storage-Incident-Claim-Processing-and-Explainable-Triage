import "server-only";
import { createHash } from "node:crypto";
import type { Database } from "../db/client";
import { claimIdentifier } from "../claims/contract";
import { getReviewerPacket } from "../reviews/service";
import { workflowFor } from "../reviews/contract";
import { MAX_REPORT_BYTES, REPORT_VERSION, reportFilename, reportQuerySchema } from "./contract";
import { prepareReport } from "./model";
import { renderReport } from "./render";
export class ReportError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = "ReportError"; }
}
export async function getClaimReport(db: Database, rawId: string, rawQuery: unknown = {}) {
  const id = claimIdentifier.parse(rawId), query = reportQuerySchema.parse(rawQuery);
  // The reviewer service owns one queue/transaction for packet + full history.
  const data = await getReviewerPacket(db, id);
  if (data.packet.status !== "available") throw new ReportError(409, "REPORT_UNAVAILABLE", "This earlier claim has no verified source snapshot. A report cannot be reconstructed from unverified evidence.");
  if (data.review.status !== "available") throw new ReportError(409, "REPORT_UNAVAILABLE", "The review history could not be verified. The report is withheld.");
  const last = data.review.history.at(-1);
  if (last ? data.review.workflow !== workflowFor(last.status) : !["claim_prepared", "submitted"].includes(data.review.workflow)) throw new ReportError(409, "REPORT_UNAVAILABLE", "The current review workflow could not be verified. The report is withheld.");
  const state = createHash("sha256").update(JSON.stringify({ version: REPORT_VERSION, state: data.review.state })).digest("hex");
  if (query.expected !== undefined && query.expected !== state) throw new ReportError(409, "REPORT_CHANGED", "The saved review state changed. Refresh the report before printing or downloading it.");
  const report = prepareReport(data, state), html = renderReport(report);
  if (Buffer.byteLength(html, "utf8") > MAX_REPORT_BYTES) throw new ReportError(409, "REPORT_LIMIT", "The complete report exceeds the supported download size. No evidence was truncated.");
  return { state, checkedAt: report.checkedAt, claimId: id, filename: reportFilename(id), html };
}
