import { copyProvenanceSchema, reportSourceHref, type CopyProvenance } from "../../../lib/documents/copy-contract";
import { incidentDate } from "../../../lib/incidents/presentation";

export default function CopyOrigin({ value }: { value: CopyProvenance | null }) {
  if (!value) return null;
  const parsed = copyProvenanceSchema.safeParse(value);
  if (!parsed.success) return <p role="alert" className="mt-4 rounded-lg bg-amber-50 p-4 text-sm">Copy origin could not be verified. Inspect the original report before using its facts.</p>;
  const origin = parsed.data;
  return <section aria-label="Copied report origin" className="mt-4 min-w-0 rounded-xl bg-surface p-4">
    <h3 className="text-sm font-semibold">Copied report · original preserved</h3>
    <p className="mt-2 break-words text-xs leading-6"><a className="text-teal underline underline-offset-4" href={reportSourceHref(origin.sourceIncidentId, origin.sourceDocumentId)}>Open source report: {origin.sourceFilename}</a><br />Source upload: {incidentDate(origin.sourceUploadedAt)}. Copied here {incidentDate(origin.copiedAt)} after explicit operator association.</p>
    <p className="mt-2 text-xs leading-6">Original text was copied with independent fallback extraction. {origin.sourceCorrectionRevision > 0 ? `The source had ${origin.sourceCorrectionRevision} operator correction${origin.sourceCorrectionRevision === 1 ? "" : "s"}; those corrections were not copied.` : "The source had no operator corrections at the time of copying."} This association does not establish that both records describe the same event.</p>
    <details className="mt-3 text-xs"><summary className="cursor-pointer font-medium">Copy provenance</summary><dl className="mt-3 space-y-2 break-all leading-6"><div><dt>Source document</dt><dd>{origin.sourceDocumentId}</dd></div><div><dt>Source incident</dt><dd>{origin.sourceIncidentId}</dd></div><div><dt>Reviewed source correction</dt><dd>{origin.sourceCorrectionId ?? "None"}</dd></div><div><dt>Frozen original fingerprint</dt><dd className="font-mono">{origin.sourceFingerprint}</dd></div><div><dt>Selected target analysis</dt><dd>{origin.targetAnalysisId}</dd></div></dl></details>
  </section>;
}
