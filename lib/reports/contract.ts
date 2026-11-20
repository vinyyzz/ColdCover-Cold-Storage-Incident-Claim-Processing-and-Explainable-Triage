import { z } from "zod";
import { claimIdentifier, hashSchema } from "../claims/contract";
export const REPORT_VERSION = "claim-report-v1";
export const MAX_REPORT_BYTES = 64 * 1024 * 1024;
export const reportQuerySchema = z.object({ expected: hashSchema.optional(), download: z.literal("1").optional() }).strict();
export const reportFilename = (id: string) => `coldcover-${claimIdentifier.parse(id)}-report.html`;
export const reportUrl = (id: string, state: string, download = false) => `/api/claims/${encodeURIComponent(claimIdentifier.parse(id))}/report?expected=${hashSchema.parse(state)}${download ? "&download=1" : ""}`;
export const REPORT_DOCUMENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
export const REPORT_CSP = `${REPORT_DOCUMENT_CSP}; frame-ancestors 'self'`;
