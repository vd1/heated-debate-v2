import { describe, expect, test } from "bun:test";

import type {
  AgentReply,
  TurnRequest,
} from "../../src/domain/agent";
import {
  parseCanonicalEvent,
  sanitizeFailure,
  serializeCanonicalEvent,
  validateCanonicalSequence,
  type CanonicalEvent,
} from "../../src/domain/events";
import { createDenyAllToolPolicy } from "../../src/domain/tool-policy";

const REQUEST: TurnRequest = {
  turnId: "run-1:round-1:proposer",
  role: { id: "proposer", version: "1", systemPrompt: "Propose" },
  creativity: {
    scheduleId: "linear-cooling",
    scheduleVersion: "1",
    level: 5,
    instruction: "Explore.",
  },
  context: {
    policyId: "last-exchange",
    policyVersion: "1",
    messages: [{ role: "user", content: "Topic:\nDesign a queue." }],
  },
  controls: {
    model: { providerId: "test", modelId: "model" },
    thinkingLevel: "high",
    maxOutputTokens: 128,
  },
  capabilities: createDenyAllToolPolicy({
    role: { id: "proposer", version: "1" },
    phase: "proposal",
  }),
};

const REPLY: AgentReply = {
  text: "Use a bounded queue.",
  durationMs: 10,
  model: { providerId: "test", modelId: "model" },
  controls: {
    model: {
      requested: { providerId: "test", modelId: "model" },
      forwarded: { providerId: "test", modelId: "model" },
    },
    thinkingLevel: { requested: "high", forwarded: "high" },
    maxOutputTokens: { requested: 128, forwarded: 128 },
  },
  usage: { inputTokens: 20, outputTokens: 0 },
  trace: { attempts: [] },
  toolCalls: [],
};

function events(): CanonicalEvent[] {
  return [
    {
      schemaVersion: 6,
      runId: "run-1",
      sequence: 0,
      type: "run.started",
      data: {
        debateId: "run-1",
        topic: "Design a queue.",
        roundCount: 1,
        controls: {
          policyId: "run-controls",
          policyVersion: "1",
          evidence: "recorded",
          turnTimeoutMs: null,
          wholeRunTimeoutMs: null,
          budget: null,
          monetary: null,
        },
      },
    },
    {
      schemaVersion: 6,
      runId: "run-1",
      sequence: 1,
      type: "turn.requested",
      data: { roundNumber: 1, request: REQUEST },
    },
    {
      schemaVersion: 6,
      runId: "run-1",
      sequence: 2,
      type: "adapter.attempt",
      data: {
        turnId: REQUEST.turnId,
        attempt: {
          attempt: 1,
          status: "succeeded",
          httpStatus: 200,
          usage: { inputTokens: 20, outputTokens: 0 },
          usageEvidence: {
            explicitlyReported: ["outputTokens"],
            source: "provider-usage",
          },
        },
      },
    },
    {
      schemaVersion: 6,
      runId: "run-1",
      sequence: 3,
      type: "turn.completed",
      data: {
        turnId: REQUEST.turnId,
        reply: {
          text: REPLY.text,
          durationMs: REPLY.durationMs,
          model: REPLY.model,
          controls: REPLY.controls,
        },
      },
    },
    {
      schemaVersion: 6,
      runId: "run-1",
      sequence: 4,
      type: "run.completed",
      data: { turnCount: 1 },
    },
  ];
}

describe("canonical event schema v3", () => {
  test("round-trips every successful-run event without losing absent usage", () => {
    for (const event of events()) {
      expect(parseCanonicalEvent(serializeCanonicalEvent(event, { secrets: [] }))).toEqual(event);
    }
    const attempt = events()[2];
    if (attempt?.type !== "adapter.attempt") throw new Error("bad fixture");
    expect(attempt.data.attempt.usage.cacheReadTokens).toBeUndefined();
  });

  test("round-trips both failure discriminants with sanitized failures", () => {
    const failure = sanitizeFailure(
      new Error("request failed with token secret-123"),
      { code: "provider_error", secrets: ["secret-123"] },
    );
    const failureEvents: CanonicalEvent[] = [
      {
        schemaVersion: 6,
        runId: "run-1",
        sequence: 0,
        type: "turn.failed",
        data: { turnId: REQUEST.turnId, failure },
      },
      {
        schemaVersion: 6,
        runId: "run-1",
        sequence: 0,
        type: "run.failed",
        data: { failure },
      },
    ];

    for (const event of failureEvents) {
      const serialized = serializeCanonicalEvent(event, { secrets: ["secret-123"] });
      expect(serialized).not.toContain("secret-123");
      expect(serialized).not.toContain("stack");
      expect(parseCanonicalEvent(serialized)).toEqual(event);
    }
  });

  test("redacts configured secrets from a directly constructed failure", () => {
    const event: CanonicalEvent = {
      schemaVersion: 6,
      runId: "run-1",
      sequence: 0,
      type: "run.failed",
      data: {
        failure: {
          code: "configured-secret-123_error",
          message: "leaked configured-secret-123",
        },
      },
    };

    const serialized = serializeCanonicalEvent(event, { secrets: ["configured-secret-123"] });
    expect(serialized).not.toContain("configured-secret-123");
    expect(parseCanonicalEvent(serialized)).toMatchObject({
      data: { failure: { code: "[REDACTED]_error", message: "leaked [REDACTED]" } },
    });
  });

  test("does not claim to redact free-form user or model text", () => {
    const event = events()[1];
    if (event?.type !== "turn.requested") throw new Error("bad fixture");
    const withSentinel: CanonicalEvent = {
      ...event,
      data: {
        ...event.data,
        request: {
          ...event.data.request,
          context: {
            ...event.data.request.context,
            messages: [{ role: "user", content: "User deliberately wrote secret-123" }],
          },
        },
      },
    };

    expect(serializeCanonicalEvent(withSentinel, { secrets: ["secret-123"] })).toContain("secret-123");
  });


  test("round-trips a recorded monetary budget and rejects an invalid hash", () => {
    const event = events()[0];
    if (event?.type !== "run.started" || event.data.controls.evidence !== "recorded") {
      throw new Error("bad fixture");
    }
    const monetary = {
      maxAmount: 12.5,
      currency: "USD",
      snapshotId: "pricing-test",
      snapshotVersion: "1",
      snapshotHash: "a".repeat(64),
      permitTokenOnlyAccounting: false,
    };
    const withMonetary: CanonicalEvent = {
      ...event,
      data: { ...event.data, controls: { ...event.data.controls, monetary } },
    };

    expect(parseCanonicalEvent(serializeCanonicalEvent(withMonetary, { secrets: [] })))
      .toEqual(withMonetary);

    const invalid: CanonicalEvent = {
      ...event,
      data: {
        ...event.data,
        controls: {
          ...event.data.controls,
          monetary: { ...monetary, snapshotHash: "not-a-hash" },
        },
      },
    };
    expect(() => serializeCanonicalEvent(invalid, { secrets: [] })).toThrow(
      "controls.monetary.snapshotHash must be a sha256 hex digest",
    );
  });

  test("migrates historical recorded controls to an absent monetary budget", () => {
    const historical = structuredClone(events()[0]) as unknown as Record<string, unknown>;
    historical.schemaVersion = 5;
    const data = historical.data as { controls: Record<string, unknown> };
    delete data.controls.monetary;

    const migrated = parseCanonicalEvent(JSON.stringify(historical));

    expect(migrated.schemaVersion).toBe(6);
    if (migrated.type !== "run.started" || migrated.data.controls.evidence !== "recorded") {
      throw new Error("migration failed");
    }
    expect(migrated.data.controls.monetary).toBeNull();
  });

  test("migrates a historical schema-v1 run start without inventing absent controls", () => {
    const historical = JSON.stringify({
      schemaVersion: 1,
      runId: "historical-artifact",
      sequence: 0,
      type: "run.started",
      data: { debateId: "debate-1", topic: "Historical", roundCount: 1 },
    });

    const migrated = parseCanonicalEvent(historical);

    expect(migrated.schemaVersion).toBe(6);
    expect(migrated.type).toBe("run.started");
    if (migrated.type !== "run.started") throw new Error("migration failed");
    expect(migrated.data.controls).toEqual({
      policyId: "run-controls",
      policyVersion: "1",
      evidence: "unrecorded",
    });
    expect(JSON.parse(serializeCanonicalEvent(migrated, { secrets: [] }))).toMatchObject({
      schemaVersion: 6,
    });
  });

  test("migrates schema-v2 name allowlists without inventing policy evidence", () => {
    const requested = events()[1];
    if (requested?.type !== "turn.requested") throw new Error("bad fixture");
    const historical = structuredClone(requested) as unknown as Record<string, unknown>;
    historical.schemaVersion = 2;
    const data = historical.data as { request: { capabilities: unknown } };
    data.request.capabilities = { toolNames: ["web-search"] };

    const migrated = parseCanonicalEvent(JSON.stringify(historical));

    expect(migrated.schemaVersion).toBe(6);
    expect(migrated.type).toBe("turn.requested");
    if (migrated.type !== "turn.requested") throw new Error("migration failed");
    expect(migrated.data.request.capabilities).toEqual({
      policyId: "legacy-tool-names",
      policyVersion: "1",
      evidence: "unrecorded",
      toolNames: ["web-search"],
    });
  });

  test("rejects unknown schema versions, event types, and fields", () => {
    const first = events()[0];
    if (!first) throw new Error("bad fixture");
    const valid = JSON.parse(serializeCanonicalEvent(first, { secrets: [] })) as Record<string, unknown>;

    expect(() => parseCanonicalEvent(JSON.stringify({ ...valid, schemaVersion: 7 }))).toThrow(
      "unsupported schema version: 7",
    );
    expect(() => parseCanonicalEvent(JSON.stringify({ ...valid, type: "future.event" }))).toThrow(
      "unknown event type: future.event",
    );
    expect(() => parseCanonicalEvent(JSON.stringify({ ...valid, credentials: "secret" }))).toThrow(
      "unknown field at event: credentials",
    );
    expect(() => parseCanonicalEvent(JSON.stringify({
      ...valid,
      data: { ...(valid.data as object), headers: { authorization: "secret" } },
    }))).toThrow("unknown field at run.started.data: headers");
  });

  test("rejects inherited envelopes and inherited toJSON before serialization", () => {
    const first = events()[0];
    if (!first) throw new Error("bad fixture");
    const inheritedEnvelope = Object.create(first) as CanonicalEvent;
    expect(() => serializeCanonicalEvent(inheritedEnvelope, {
      secrets: ["configured-secret-123"],
    })).toThrow("event must be a plain object");

    const inheritedToJson = Object.assign(
      Object.create({
        toJSON: () => ({ credentials: "configured-secret-123" }),
      }),
      first,
    ) as CanonicalEvent;
    expect(() => serializeCanonicalEvent(inheritedToJson, {
      secrets: ["configured-secret-123"],
    })).toThrow("event must be a plain object");
  });

  test("rejects creativity identities outside canonical schema v3", () => {
    const requested = events()[1];
    if (requested?.type !== "turn.requested") throw new Error("bad fixture");
    const serialized = serializeCanonicalEvent(requested, { secrets: [] });
    const value = JSON.parse(serialized) as {
      data: { request: { creativity: { scheduleId: string; scheduleVersion: string } } };
    };
    value.data.request.creativity.scheduleId = "unknown";
    value.data.request.creativity.scheduleVersion = "999";

    expect(() => parseCanonicalEvent(JSON.stringify(value))).toThrow(
      "canonical creativity schedule must be linear-cooling@1",
    );
  });

  test("rejects a recorded tool policy bound to a different request role", () => {
    const requested = events()[1];
    if (requested?.type !== "turn.requested") throw new Error("bad fixture");
    if (requested.data.request.capabilities.evidence !== "recorded") {
      throw new Error("bad capability fixture");
    }
    const invalid: CanonicalEvent = {
      ...requested,
      data: {
        ...requested.data,
        request: {
          ...requested.data.request,
          capabilities: {
            ...requested.data.request.capabilities,
            role: { id: "reviewer", version: "1" },
          },
        },
      },
    };

    expect(() => serializeCanonicalEvent(invalid, { secrets: [] })).toThrow(
      "tool policy role does not match turn request role",
    );
  });

  test("rejects contradictory or silently changed control traces", () => {
    const base = events()[3];
    if (base?.type !== "turn.completed") throw new Error("bad fixture");

    expectInvalidModelTrace(base, {
      requested: REPLY.model,
      forwarded: REPLY.model,
      unsupported: { reason: "contradiction" },
    }, "unsupported control cannot be forwarded, adjusted, or provider-verified");
    expectInvalidModelTrace(base, {
      requested: REPLY.model,
      adjusted: { value: { providerId: "test", modelId: "other" }, reason: "changed" },
      forwarded: REPLY.model,
    }, "adjusted control must forward the adjusted value");
    expectInvalidModelTrace(base, {
      requested: REPLY.model,
      forwarded: { providerId: "test", modelId: "other" },
    }, "changed forwarded control requires an adjustment");
    expectInvalidModelTrace(base, {
      requested: REPLY.model,
    }, "supported control must be forwarded");
  });

  test("rejects an ambiguous zero in attempt usage", () => {
    const attempt = events()[2];
    if (attempt?.type !== "adapter.attempt") throw new Error("bad fixture");
    const invalid: CanonicalEvent = {
      ...attempt,
      data: {
        ...attempt.data,
        attempt: {
          ...attempt.data.attempt,
          usageEvidence: { explicitlyReported: [], source: "no evidence" },
        },
      },
    };

    expect(() => serializeCanonicalEvent(invalid, { secrets: [] })).toThrow(
      "zero outputTokens requires explicit reporting evidence",
    );
  });

  test("validates one run's monotonic sequence", () => {
    const fixture = events();
    const first = fixture[0];
    const second = fixture[1];
    if (!first || !second) throw new Error("bad fixture");

    expect(() => {
      validateCanonicalSequence(fixture);
    }).not.toThrow();
    expect(() => {
      validateCanonicalSequence([first, { ...second, sequence: 2 }]);
    }).toThrow("expected sequence 1, received 2");
    expect(() => {
      validateCanonicalSequence([first, { ...second, runId: "other" }]);
    }).toThrow("event runId other does not match run-1");
  });
});

function expectInvalidModelTrace(
  event: Extract<CanonicalEvent, { type: "turn.completed" }>,
  model: AgentReply["controls"]["model"],
  message: string,
): void {
  const invalid: CanonicalEvent = {
    ...event,
    data: {
      ...event.data,
      reply: {
        ...event.data.reply,
        controls: { ...event.data.reply.controls, model },
      },
    },
  };
  expect(() => serializeCanonicalEvent(invalid, { secrets: [] })).toThrow(message);
}

describe("canonical tool call events", () => {
  const toolCallEvent = (): CanonicalEvent => ({
    schemaVersion: 6,
    runId: "run-1",
    sequence: 2,
    type: "turn.tool_call",
    data: {
      turnId: REQUEST.turnId,
      record: {
        callId: "run-1:round-1:proposer:call-1",
        ordinal: 1,
        toolId: "web-search",
        schemaVersion: "1",
        arguments: { query: "bounded queues" },
        disposition: { status: "accepted" },
        outcome: {
          status: "succeeded",
          output: "queue results",
          outputBytes: 13,
          truncation: null,
        },
        durationMs: 40,
      },
    },
  });

  test("round-trips accepted, truncated, failed, and denied tool call records", () => {
    const accepted = toolCallEvent();

    const truncated = structuredClone(accepted);
    if (truncated.type !== "turn.tool_call") throw new Error("bad fixture");
    truncated.data.record.outcome = {
      status: "succeeded",
      output: "partial",
      outputBytes: 7,
      truncation: { originalBytes: 32, retainedBytes: 7 },
    };

    const failed = structuredClone(accepted);
    if (failed.type !== "turn.tool_call") throw new Error("bad fixture");
    failed.data.record.outcome = {
      status: "failed",
      error: { code: "timeout", message: "tool call timed out after 20ms" },
    };

    const denied = structuredClone(accepted);
    if (denied.type !== "turn.tool_call") throw new Error("bad fixture");
    denied.data.record.disposition = { status: "denied", reason: "tool_not_allowed" };
    denied.data.record.outcome = null;

    for (const event of [accepted, truncated, failed, denied]) {
      expect(parseCanonicalEvent(serializeCanonicalEvent(event, { secrets: [] }))).toEqual(event);
    }
  });

  test("rejects structurally inconsistent tool call records", () => {
    const cases: Array<{ mutate: (record: Record<string, unknown>) => void; message: string }> = [
      {
        mutate: (record) => { record.outcome = null; },
        message: "accepted tool call must record an outcome",
      },
      {
        mutate: (record) => {
          record.disposition = { status: "denied", reason: "tool_not_allowed" };
        },
        message: "denied tool call cannot record an outcome",
      },
      {
        mutate: (record) => {
          record.outcome = {
            status: "succeeded",
            output: "partial",
            outputBytes: 7,
            truncation: { originalBytes: 7, retainedBytes: 7 },
          };
        },
        message: "truncation must retain fewer bytes than the original",
      },
      {
        mutate: (record) => {
          record.outcome = {
            status: "succeeded",
            output: "partial",
            outputBytes: 7,
            truncation: { originalBytes: 32, retainedBytes: 6 },
          };
        },
        message: "truncated output bytes must equal retained bytes",
      },
      {
        mutate: (record) => {
          record.outcome = {
            status: "succeeded",
            output: "queue results",
            outputBytes: 12,
            truncation: null,
          };
        },
        message: "output bytes must equal the UTF-8 length of output",
      },
      {
        mutate: (record) => {
          record.outcome = {
            status: "succeeded",
            output: "partial",
            outputBytes: 6,
            truncation: { originalBytes: 32, retainedBytes: 6 },
          };
        },
        message: "output bytes must equal the UTF-8 length of output",
      },
      {
        mutate: (record) => { record.arguments = { query: undefined }; },
        message: "record.arguments must be a JSON value",
      },
      {
        mutate: (record) => { record.durationMs = -1; },
        message: "record.durationMs",
      },
    ];

    for (const invalid of cases) {
      const event = toolCallEvent();
      if (event.type !== "turn.tool_call") throw new Error("bad fixture");
      invalid.mutate(event.data.record as unknown as Record<string, unknown>);
      expect(() => serializeCanonicalEvent(event, { secrets: [] })).toThrow(invalid.message);
    }
  });


  test("redacts configured secrets from failed tool call outcomes", () => {
    const event = toolCallEvent();
    if (event.type !== "turn.tool_call") throw new Error("bad fixture");
    event.data.record.outcome = {
      status: "failed",
      error: {
        code: "tool_error",
        message: "backend rejected configured-secret-123",
      },
    };

    const serialized = serializeCanonicalEvent(event, { secrets: ["configured-secret-123"] });

    expect(serialized).not.toContain("configured-secret-123");
    expect(parseCanonicalEvent(serialized)).toMatchObject({
      data: {
        record: {
          outcome: { error: { message: "backend rejected [REDACTED]" } },
        },
      },
    });
  });


  test("round-trips optional shared turn sequences on attempts and tool calls", () => {
    const attemptEvent = structuredClone(events()[2]);
    if (attemptEvent?.type !== "adapter.attempt") throw new Error("bad fixture");
    attemptEvent.data.attempt.turnSequence = 1;

    const callEvent = toolCallEvent();
    if (callEvent.type !== "turn.tool_call") throw new Error("bad fixture");
    callEvent.data.record.turnSequence = 2;
    callEvent.sequence = 0;

    for (const event of [attemptEvent, callEvent]) {
      expect(parseCanonicalEvent(serializeCanonicalEvent(event, { secrets: [] }))).toEqual(event);
    }

    callEvent.data.record.turnSequence = -1;
    expect(() => serializeCanonicalEvent(callEvent, { secrets: [] })).toThrow(
      "record.turnSequence must be a positive integer",
    );
  });

  test("migrates schema-v3 events forward without inventing tool call evidence", () => {
    const historical = structuredClone(events()[0]) as unknown as Record<string, unknown>;
    historical.schemaVersion = 3;

    const migrated = parseCanonicalEvent(JSON.stringify(historical));

    expect(migrated.schemaVersion).toBe(6);
    expect(migrated.type).toBe("run.started");
  });
});

describe("shared turn sequence validation", () => {
  function annotatedRun(
    firstAttemptSeq: number | undefined,
    callSeq: number | undefined,
    secondAttemptSeq: number | undefined,
  ): CanonicalEvent[] {
    const base = events();
    const start = base[0];
    const requested = base[1];
    const completed = base[3];
    const runCompleted = base[4];
    if (start?.type !== "run.started" || requested?.type !== "turn.requested"
      || completed?.type !== "turn.completed" || runCompleted?.type !== "run.completed") {
      throw new Error("bad fixture");
    }
    const attempt = (turnSequence: number | undefined, n: number): CanonicalEvent => ({
      schemaVersion: 6,
      runId: "run-1",
      sequence: 0,
      type: "adapter.attempt",
      data: {
        turnId: REQUEST.turnId,
        attempt: {
          attempt: n,
          status: "succeeded",
          httpStatus: 200,
          usage: {},
          usageEvidence: { explicitlyReported: [], source: "test" },
          ...(turnSequence === undefined ? {} : { turnSequence }),
        },
      },
    });
    const call: CanonicalEvent = {
      schemaVersion: 6,
      runId: "run-1",
      sequence: 0,
      type: "turn.tool_call",
      data: {
        turnId: REQUEST.turnId,
        record: {
          callId: `${REQUEST.turnId}:call-1`,
          ordinal: 1,
          toolId: "web-search",
          schemaVersion: "1",
          arguments: { query: "q" },
          disposition: { status: "accepted" },
          outcome: { status: "succeeded", output: "r", outputBytes: 1, truncation: null },
          durationMs: 5,
          ...(callSeq === undefined ? {} : { turnSequence: callSeq }),
        },
      },
    };
    return [
      start,
      requested,
      attempt(firstAttemptSeq, 1),
      call,
      attempt(secondAttemptSeq, 2),
      completed,
      runCompleted,
    ].map((event, sequence) => ({ ...event, sequence }));
  }

  test("accepts a unique consecutive shared sequence in event order", () => {
    expect(() => {
      validateCanonicalSequence(annotatedRun(1, 2, 3));
    }).not.toThrow();
    expect(() => {
      validateCanonicalSequence(annotatedRun(undefined, undefined, undefined));
    }).not.toThrow();
  });

  test("rejects duplicate, gapped, or out-of-order shared sequences", () => {
    expect(() => {
      validateCanonicalSequence(annotatedRun(1, 1, 2));
    }).toThrow(`turn ${REQUEST.turnId} shared turn sequence expected 2, received 1`);
    expect(() => {
      validateCanonicalSequence(annotatedRun(1, 3, 4));
    }).toThrow(`turn ${REQUEST.turnId} shared turn sequence expected 2, received 3`);
    expect(() => {
      validateCanonicalSequence(annotatedRun(2, 1, 3));
    }).toThrow(`turn ${REQUEST.turnId} shared turn sequence expected 1, received 2`);
  });

  test("rejects mixing sequenced and unsequenced evidence in one turn", () => {
    expect(() => {
      validateCanonicalSequence(annotatedRun(1, undefined, 2));
    }).toThrow(`turn ${REQUEST.turnId} mixes sequenced and unsequenced evidence`);
  });
});
