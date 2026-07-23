import { createHash } from "node:crypto";

export interface BenchmarkCase {
  caseVersion: "1";
  caseId: string;
  topic: string;
  /** Optional source material the debate may reference; absent means none. */
  sourceContext?: string;
  /** Opaque versioned rubric reference, resolved only when evaluation begins. */
  rubric: { rubricId: string; rubricVersion: string };
  provenance: string;
}

/** Parses untrusted JSON into a validated, frozen benchmark case. */
export function parseBenchmarkCase(value: unknown): BenchmarkCase {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("case must be a JSON object");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["caseVersion", "caseId", "topic", "sourceContext", "rubric", "provenance"].includes(key)) {
      throw new Error(`unknown field at case: ${key}`);
    }
  }
  if (raw.caseVersion !== "1") {
    throw new Error(`unsupported caseVersion: ${String(raw.caseVersion)}`);
  }
  const requireString = (field: string, item: unknown): string => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`${field} must be a non-empty string`);
    }
    return item;
  };
  const rubricRaw = raw.rubric;
  if (typeof rubricRaw !== "object" || rubricRaw === null || Array.isArray(rubricRaw)) {
    throw new Error("rubric must be a JSON object");
  }
  for (const key of Object.keys(rubricRaw)) {
    if (!["rubricId", "rubricVersion"].includes(key)) {
      throw new Error(`unknown field at case.rubric: ${key}`);
    }
  }
  const rubric = rubricRaw as Record<string, unknown>;

  return Object.freeze({
    caseVersion: "1",
    caseId: requireString("caseId", raw.caseId),
    topic: requireString("topic", raw.topic),
    ...(raw.sourceContext === undefined
      ? {}
      : { sourceContext: requireString("sourceContext", raw.sourceContext) }),
    rubric: Object.freeze({
      rubricId: requireString("rubricId", rubric.rubricId),
      rubricVersion: requireString("rubricVersion", rubric.rubricVersion),
    }),
    provenance: requireString("provenance", raw.provenance),
  });
}

export function benchmarkCaseHash(benchmarkCase: BenchmarkCase): string {
  const canonical = (input: unknown): string => {
    if (input === null || typeof input !== "object") return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    return `{${Object.keys(input).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(Reflect.get(input, key))}`,
    ).join(",")}}`;
  };
  return createHash("sha256").update(canonical(benchmarkCase)).digest("hex");
}

/** Tiny deterministic fixtures; not a production corpus. */
export const FIXTURE_CASES: readonly BenchmarkCase[] = Object.freeze([
  parseBenchmarkCase({
    caseVersion: "1",
    caseId: "fixture-bounded-queue",
    topic: "Design a bounded in-memory queue with backpressure for a realtime ingest pipeline.",
    rubric: { rubricId: "debate-quality", rubricVersion: "1" },
    provenance: "hand-written fixture, 2026-07-23",
  }),
  parseBenchmarkCase({
    caseVersion: "1",
    caseId: "fixture-retry-policy",
    topic: "Choose a retry policy for an idempotent payment-status poller.",
    sourceContext: "The upstream API rate-limits at 10 requests per second per key.",
    rubric: { rubricId: "debate-quality", rubricVersion: "1" },
    provenance: "hand-written fixture, 2026-07-23",
  }),
  parseBenchmarkCase({
    caseVersion: "1",
    caseId: "fixture-schema-migration",
    topic: "Plan a zero-downtime schema migration for a heavily written table.",
    rubric: { rubricId: "debate-quality", rubricVersion: "1" },
    provenance: "hand-written fixture, 2026-07-23",
  }),
]);
