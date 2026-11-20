import { describe, expect, it, vi } from "vitest";
import { fallbackOutput, parseAiInput, validateAiOutput } from "./contract";
import { extractionInput, questionsInput, rawText, summaryInput } from "./fixtures.test-support";
import { cacheIdentity, runAiTask, type AiAdapter, type AiCache } from "./runner";

vi.mock("server-only", () => ({}));
const adapter = (value: unknown): AiAdapter => ({ revision: "mock-contract-1", generate: vi.fn(async () => structuredClone(value)) });
function memoryCache() {
  const values = new Map<string, unknown>();
  const cache: AiCache = { get: vi.fn(async ({ key }) => values.get(key) ?? null), put: vi.fn(async ({ key }, value) => { values.set(key, structuredClone(value)); }) };
  return { cache, values };
}

describe("AI local contracts and independently supported output", () => {
  it.each([extractionInput, summaryInput, questionsInput])("validates a supported task and returns detached fallback data", (fixture) => {
    const input = fixture(), before = structuredClone(input), result = validateAiOutput(input, fallbackOutput(input).output);
    expect(result).toEqual(fallbackOutput(input)); expect(input).toEqual(before);
  });
  it.each(["unknown task", "extra input", "missing scope", "corrected extraction", "blank text"])("rejects %s before any adapter/cache access", async (kind) => {
    const value = structuredClone(extractionInput()) as unknown as Record<string, unknown>;
    if (kind === "unknown task") value.task = "triage";
    if (kind === "extra input") value.claim = { amount: 1 };
    if (kind === "missing scope") delete value.scope;
    if (kind === "corrected extraction") Object.assign(value.document!, { correctionId: "effective-correction" });
    if (kind === "blank text") Object.assign(value.document!, { rawText: " " });
    const mock = adapter(null), { cache } = memoryCache();
    await expect(runAiTask(value, { adapter: mock, cache })).rejects.toThrow();
    expect(mock.generate).not.toHaveBeenCalled(); expect(cache.get).not.toHaveBeenCalled();
  });
  it.each(["missing source", "foreign analysis", "duplicate fact", "duplicate reference", "duplicate document", "wrong correction", "wrong quote", "out-of-bounds quote", "wrong source ID", "wrong context"])("rejects local %s", (kind) => {
    const input = summaryInput();
    const quote = { field: "reported_fault", value: "compressor fault", quote: "Reported fault: compressor fault", start: rawText.indexOf("Reported fault"), end: rawText.indexOf("Reported fault") + "Reported fault: compressor fault".length, source_document_id: "report" } as const;
    input.documents.push({ id: "report", correctionId: "correction", rawText });
    input.facts.push({ source_id: "report-fact", kind: "report", text: "The maintenance report describes a compressor fault.", sources: [{ type: "document", id: "report", correctionId: "correction", quote: structuredClone(quote) }] });
    const source = input.facts.at(-1)!.sources[0]; if (source.type !== "document") throw new Error("fixture");
    if (kind === "missing source") input.references = [];
    if (kind === "foreign analysis") input.references.push({ type: "analysis", id: "foreign" });
    if (kind === "duplicate fact") input.facts.push(input.facts[0]);
    if (kind === "duplicate reference") input.references.push(input.references[0]);
    if (kind === "duplicate document") input.documents.push(input.documents[0]);
    if (kind === "wrong correction") source.correctionId = null;
    if (kind === "wrong quote") source.quote!.end--;
    if (kind === "out-of-bounds quote") Object.assign(source.quote!, { quote: rawText, start: 0, end: rawText.length + 1 });
    if (kind === "wrong source ID") source.quote!.source_document_id = "other";
    if (kind === "wrong context") source.quote!.time_zone_context = { quote: "All times UTC", start: 0, end: 13 };
    expect(() => parseAiInput(input)).toThrow();
  });
  it.each(["quote", "offset", "document ID", "fabricated value", "unrelated exact quote", "timezone", "null conflict", "extra field"])("rejects extraction with %s", (kind) => {
    const input = extractionInput(kind === "null conflict" ? `${rawText}\nEquipment ID: REF-02` : rawText);
    const valid = fallbackOutput(input); if (valid.task !== "extraction") throw new Error("fixture");
    const output = valid.output, quote = output.evidence_quotes[0];
    if (kind === "quote") quote.quote = "not in the source";
    if (kind === "offset") quote.start++;
    if (kind === "document ID") quote.source_document_id = "foreign";
    if (kind === "fabricated value") output.reported_fault = "a different cause";
    if (kind === "unrelated exact quote") { const fault = output.evidence_quotes.find((q) => q.field === "reported_fault")!; Object.assign(fault, { quote: "All times IST", start: 0, end: 13 }); }
    if (kind === "timezone") { const time = output.evidence_quotes.find((q) => q.field === "restart_time")!; time.time_zone_context!.quote = "All times UTC"; }
    if (kind === "null conflict") output.equipment_id = "REF-01";
    if (kind === "extra field") Object.assign(output, { readiness: "Ready for initial review" });
    expect(() => validateAiOutput(input, output)).toThrow();
  });
  it("preserves explicit-offset instants and nulls for unsupported written times", () => {
    for (const raw of ["Restart time: 2026-03-10T00:00:00Z", "Restart time: 04:00 on 10 March 2026"]) {
      const input = extractionInput(raw), result = validateAiOutput(input, fallbackOutput(input).output);
      if (result.task !== "extraction") throw new Error("fixture");
      expect(result.output.restart_time).toBe(raw.includes("Z") ? "2026-03-10T05:30:00+05:30" : null);
    }
  });
  it("accepts grouped/reordered supported facts while retaining exact paise and absence", () => {
    const input = summaryInput(), facts = [...input.facts].reverse();
    const result = validateAiOutput(input, facts.map((fact) => ({ text: fact.text, source_ids: [fact.source_id] })));
    expect(result.task).toBe("summary");
    // These two texts fit the bounded single-statement contract.
    const output = [{ text: facts.slice(0, 2).map((f) => f.text).join(" "), source_ids: facts.slice(0, 2).map((f) => f.source_id) }, ...facts.slice(2).map((f) => ({ text: f.text, source_ids: [f.source_id] }))];
    expect(validateAiOutput(input, output).output).toEqual(output);
    expect(JSON.stringify(output)).toContain("₹80,000.00"); expect(JSON.stringify(output)).toContain("Batch C: not present");
  });
  it.each(["foreign citation", "mispaired citation", "no citation", "duplicate citation", "omitted caveat", "invented amount", "payment conclusion", "extra property"])("rejects summary %s", (kind) => {
    const input = summaryInput(), valid = fallbackOutput(input); if (valid.task !== "summary") throw new Error("fixture"); const output = valid.output;
    if (kind === "foreign citation") output[0].source_ids = ["foreign"];
    if (kind === "mispaired citation") output[0].source_ids = output[1].source_ids;
    if (kind === "no citation") output[0].source_ids = [];
    if (kind === "duplicate citation") output[0].source_ids.push(output[0].source_ids[0]);
    if (kind === "omitted caveat") output.pop();
    if (kind === "invented amount") output[1].text = output[1].text.replace("80,000", "90,000");
    if (kind === "payment conclusion") output[0].text = "The stock is spoiled and the insurer must pay.";
    if (kind === "extra property") Object.assign(output[0], { priority: "High priority" });
    expect(() => validateAiOutput(input, output)).toThrow();
  });
  it("accepts only neutral supported questions with all missing/conflict targets", () => {
    const input = questionsInput(), valid = fallbackOutput(input); if (valid.task !== "questions") throw new Error("fixture");
    const output = valid.output.reverse(); output[0].text = `Please clarify the following: ${output[0].text}`;
    expect(validateAiOutput(input, output).output).toEqual(output);
    for (const invalid of [[output[0]], [{ ...output[0], target_id: "foreign" }, output[1]], [output[0], output[0]], [{ ...output[0], text: "Why did the insurer refuse payment?" }, output[1]]]) expect(() => validateAiOutput(input, invalid)).toThrow();
  });
});

describe("Mock-only adapter retry, timeout and fallback", () => {
  it("requires no provider/configuration and never consults a cache", async () => {
    const { cache } = memoryCache();
    for (const input of [extractionInput(), summaryInput(), questionsInput()]) {
      const result = await runAiTask(input, { cache });
      expect(result).toMatchObject({ mode: "fallback", reason: "not_configured", attempts: 0, cache: "unused", ...fallbackOutput(input) });
    }
    expect(cache.get).not.toHaveBeenCalled(); expect(cache.put).not.toHaveBeenCalled();
  });
  it("makes no call when there are no missing items or conflicts", async () => {
    const input = questionsInput(); input.items = []; const mock = adapter([]);
    expect(await runAiTask(input, { adapter: mock })).toMatchObject({ task: "questions", output: [], attempts: 0, reason: "no_questions" });
    expect(mock.generate).not.toHaveBeenCalled();
  });
  it("retries one malformed output once, validates success and caches only that success", async () => {
    const input = summaryInput(), good = fallbackOutput(input).output, { cache } = memoryCache();
    const mock: AiAdapter = { revision: "mock", generate: vi.fn().mockResolvedValueOnce("not JSON").mockResolvedValueOnce(JSON.stringify(good)) };
    expect(await runAiTask(input, { adapter: mock, cache })).toMatchObject({ mode: "ai", reason: "validated", attempts: 2, output: good });
    expect(mock.generate).toHaveBeenCalledTimes(2); expect(cache.put).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(mock.generate).mock.calls;
    expect(calls[0][0]).toMatchObject({ temperature: 0, attempt: 1, validationFeedback: null });
    expect(calls[1][0]).toMatchObject({ temperature: 0, attempt: 2 }); expect(calls[1][0].validationFeedback).not.toContain("not JSON");
    expect(calls[0][0].outputSchema).toMatchObject({ type: "array" });
  });
  it.each([extractionInput, questionsInput])("retries invalid evidence once for each other task and retains its deterministic fallback", async (fixture) => {
    const input = fixture(), mock = adapter({}), { cache } = memoryCache();
    expect(await runAiTask(input, { adapter: mock, cache })).toMatchObject({ reason: "invalid_output", attempts: 2, ...fallbackOutput(input) });
    expect(mock.generate).toHaveBeenCalledTimes(2); expect(cache.put).not.toHaveBeenCalled();
  });
  it.each(["invalid JSON", "wrong shape", "foreign citation", "oversize", "cyclic object"])("falls back after exactly two %s responses and never caches them", async (kind) => {
    const input = summaryInput(); const circular: Record<string, unknown> = {}; circular.self = circular;
    const bad = kind === "invalid JSON" ? "{" : kind === "wrong shape" ? { statements: [] } : kind === "oversize" ? "x".repeat(1024 * 1024 + 1) : kind === "cyclic object" ? circular : [{ text: "Unsupported", source_ids: ["foreign"] }];
    const mock: AiAdapter = { revision: "mock", generate: vi.fn(async () => bad) }, { cache } = memoryCache();
    expect(await runAiTask(input, { adapter: mock, cache })).toMatchObject({ mode: "fallback", reason: "invalid_output", attempts: 2, ...fallbackOutput(input) });
    expect(mock.generate).toHaveBeenCalledTimes(2); expect(cache.put).not.toHaveBeenCalled();
  });
  it("falls back immediately on provider rejection without exposing error details", async () => {
    const mock: AiAdapter = { revision: "mock", generate: vi.fn(async () => { throw new Error("provider private diagnostic"); }) };
    const result = await runAiTask(extractionInput(), { adapter: mock });
    expect(result).toMatchObject({ mode: "fallback", reason: "provider_failed", attempts: 1 });
    expect(JSON.stringify(result)).not.toContain("private diagnostic"); expect(mock.generate).toHaveBeenCalledTimes(1);
  });
  it("handles a synchronous adapter throw and second-attempt rejection", async () => {
    const input = questionsInput(), sync: AiAdapter = { revision: "mock", generate() { throw new Error("sync failure"); } };
    expect(await runAiTask(input, { adapter: sync })).toMatchObject({ reason: "provider_failed", attempts: 1 });
    const retry: AiAdapter = { revision: "mock", generate: vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("failed")) };
    expect(await runAiTask(input, { adapter: retry })).toMatchObject({ mode: "fallback", reason: "provider_failed", attempts: 2 });
  });
  it("bounds a hung call, aborts it and ignores its later resolution", async () => {
    let resolve!: (value: unknown) => void; let signal: AbortSignal | undefined;
    const mock: AiAdapter = { revision: "mock", generate: vi.fn((_request, abort) => { signal = abort; return new Promise((r) => { resolve = r; }); }) };
    const { cache } = memoryCache(), input = summaryInput();
    expect(await runAiTask(input, { adapter: mock, cache, timeoutMs: 5 })).toMatchObject({ reason: "timed_out", attempts: 1, mode: "fallback" });
    expect(signal?.aborted).toBe(true); resolve(fallbackOutput(input).output); await Promise.resolve();
    expect(cache.put).not.toHaveBeenCalled(); expect(mock.generate).toHaveBeenCalledTimes(1);
  });
  it("sends only task data and fixed instructions, never local scope/registry or prior unsafe output", async () => {
    const input = summaryInput(); input.documents.push({ id: "unrelated", correctionId: null, rawText: "unrelated report not sent" });
    const mock = adapter(fallbackOutput(input).output); await runAiTask(input, { adapter: mock });
    const sent = vi.mocked(mock.generate).mock.calls[0][0], serialized = JSON.stringify(sent);
    expect(sent.payload).toEqual({ facts: input.facts });
    for (const hidden of [input.scope.sourceVersion, input.scope.incidentId, "unrelated report not sent", "mock-contract-1"]) expect(serialized).not.toContain(hidden);
    const initial = extractionInput(); const extractMock = adapter(fallbackOutput(initial).output); await runAiTask(initial, { adapter: extractMock });
    expect(vi.mocked(extractMock.generate).mock.calls[0][0].payload).toEqual({ raw_text: rawText, doc_type: "maintenance_report", source_document_id: "report" });
  });
  it("does not let adapters mutate the validation snapshot or caller data", async () => {
    const input = summaryInput(), before = structuredClone(input), mock: AiAdapter = { revision: "mock", generate: vi.fn(async (request) => { (request.payload as { facts: { text: string }[] }).facts[0].text = "Invented"; return [{ text: "Invented", source_ids: ["interval"] }]; }) };
    const result = await runAiTask(input, { adapter: mock }); expect(result).toMatchObject({ reason: "invalid_output", ...fallbackOutput(before) }); expect(input).toEqual(before);
  });
  it("retains the original source fingerprint if the caller changes inputs while awaiting output", async () => {
    const input = summaryInput(), before = structuredClone(input);
    let complete!: (value: unknown) => void;
    const mock: AiAdapter = { revision: "mock", generate: () => new Promise((resolve) => { complete = resolve; }) };
    const pending = runAiTask(input, { adapter: mock }); await Promise.resolve();
    input.scope.sourceVersion = "changed-while-awaiting"; input.facts[0].text = "changed";
    complete(fallbackOutput(before).output); const result = await pending;
    expect(result).toMatchObject({ mode: "ai", inputFingerprint: cacheIdentity(before, "mock").inputFingerprint, ...fallbackOutput(before) });
    expect(result.inputFingerprint).not.toBe(cacheIdentity(input, "mock").inputFingerprint);
  });
  it.skip("live smoke test: no free provider/adapter/configuration has been selected", () => {});
});

describe("Source/version-aware cache validation", () => {
  it("reuses a validated result without a second adapter call and returns detached data", async () => {
    const input = summaryInput(), mock = adapter(fallbackOutput(input).output), { cache } = memoryCache();
    const first = await runAiTask(input, { adapter: mock, cache });
    expect(first.cache).toBe("miss"); (first.output as { text: string }[])[0].text = "changed by caller";
    const second = await runAiTask(input, { adapter: mock, cache }); expect(second).toMatchObject({ cache: "hit", attempts: 0, ...fallbackOutput(input) }); expect(mock.generate).toHaveBeenCalledTimes(1);
  });
  it.each(["scope", "analysis", "interval", "document text", "correction", "copy ancestry", "fact text", "reference", "adapter"])("changes the key for changed %s", (kind) => {
    const input = summaryInput(); input.documents.push({ id: "report", correctionId: null, rawText });
    const original = cacheIdentity(input, "mock"), changed = structuredClone(input);
    if (kind === "scope") changed.scope.incidentId = "other";
    if (kind === "analysis") changed.scope.analysisId = "other-analysis";
    if (kind === "interval") changed.scope.intervalId = "other-window";
    if (kind === "document text") changed.documents[0].rawText += "\nUncited update";
    if (kind === "correction") changed.documents[0].correctionId = "new-correction";
    if (kind === "copy ancestry") changed.scope.sourceVersion = "new-copy-ancestor-version";
    if (kind === "fact text") changed.facts[0].text += " Updated.";
    if (kind === "reference") changed.references.push({ type: "policy", id: "new-policy" });
    const next = cacheIdentity(changed, kind === "adapter" ? "mock-next" : "mock"); expect(next.key).not.toBe(original.key);
    if (kind !== "adapter") expect(next.inputFingerprint).not.toBe(original.inputFingerprint);
  });
  it("has stable object keys while keeping task and document identity significant", () => {
    const input = extractionInput(); if (input.task !== "extraction") throw new Error("fixture");
    expect(cacheIdentity({ ...input, scope: { sourceVersion: input.scope.sourceVersion, intervalId: input.scope.intervalId, analysisId: input.scope.analysisId, incidentId: input.scope.incidentId } }, "mock")).toEqual(cacheIdentity(input, "mock"));
    expect(cacheIdentity({ ...input, document: { ...input.document, id: "copy" } }, "mock").key).not.toBe(cacheIdentity(input, "mock").key);
    expect(cacheIdentity(questionsInput(), "mock").key).not.toBe(cacheIdentity(summaryInput(), "mock").key);
  });
  it("revalidates cache support and repairs a foreign output through the adapter", async () => {
    const input = summaryInput(), { cache, values } = memoryCache(), mock = adapter(fallbackOutput(input).output);
    values.set(cacheIdentity(input, mock.revision).key, [{ text: "Insurer must pay", source_ids: ["foreign"] }]);
    expect(await runAiTask(input, { adapter: mock, cache })).toMatchObject({ mode: "ai", cache: "miss", attempts: 1 });
    expect(mock.generate).toHaveBeenCalledTimes(1); expect(cache.put).toHaveBeenCalledTimes(1);
  });
  it("survives cache read/write errors without extra provider attempts", async () => {
    const input = summaryInput(), mock = adapter(fallbackOutput(input).output);
    const cache: AiCache = { async get() { throw new Error("read failed"); }, async put() { throw new Error("write failed"); } };
    expect(await runAiTask(input, { adapter: mock, cache })).toMatchObject({ mode: "ai", cache: "unavailable", attempts: 1 }); expect(mock.generate).toHaveBeenCalledTimes(1);
  });
  it("does not cache failure or missing configuration, allowing a later working adapter", async () => {
    const input = extractionInput(), { cache, values } = memoryCache();
    await runAiTask(input, { cache }); await runAiTask(input, { cache, adapter: adapter({}) }); expect(values.size).toBe(0);
    const mock = adapter(fallbackOutput(input).output); expect(await runAiTask(input, { cache, adapter: mock })).toMatchObject({ mode: "ai", cache: "miss" }); expect(values.size).toBe(1);
  });
  it("shares concurrent identical work and detaches each returned result", async () => {
    const input = summaryInput(), { cache } = memoryCache(), mock = adapter(fallbackOutput(input).output);
    const [a, b] = await Promise.all([runAiTask(input, { adapter: mock, cache }), runAiTask(input, { adapter: mock, cache })]);
    expect(mock.generate).toHaveBeenCalledTimes(1); expect(cache.put).toHaveBeenCalledTimes(1); expect(a).toEqual(b);
    if (a.task !== "summary") throw new Error("fixture"); a.output[0].text = "changed"; expect(b.output).toEqual(fallbackOutput(input).output);
  });
  it("releases failed concurrent work so a subsequent call can succeed", async () => {
    const input = summaryInput(), { cache } = memoryCache(), mock: AiAdapter = { revision: "mock", generate: vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue(fallbackOutput(input).output) };
    const results = await Promise.all([runAiTask(input, { adapter: mock, cache }), runAiTask(input, { adapter: mock, cache })]);
    expect(results.every((r) => r.reason === "provider_failed")).toBe(true); expect(mock.generate).toHaveBeenCalledTimes(1);
    expect(await runAiTask(input, { adapter: mock, cache })).toMatchObject({ mode: "ai", attempts: 1 }); expect(mock.generate).toHaveBeenCalledTimes(2);
  });
});
