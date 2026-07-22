import { describe, expect, test } from "bun:test";

import {
  authorizeToolCall,
  createDenyAllToolPolicy,
  createToolCallAccounting,
  resolveToolPolicy,
  type AllowedToolPolicy,
  type ToolCapabilityPolicy,
  type ToolPolicyBinding,
} from "../../src/domain/tool-policy";

const BINDING: ToolPolicyBinding = {
  role: { id: "proposer", version: "1" },
  phase: "proposal",
};

function policy(
  overrides: Partial<ToolCapabilityPolicy> = {},
): ToolCapabilityPolicy {
  return {
    policyId: "debate-tools",
    policyVersion: "1",
    evidence: "recorded",
    role: { id: "proposer", version: "1" },
    phase: "proposal",
    allowedTools: [
      { toolId: "web-search", schemaVersion: "1", maxCalls: 1 },
      { toolId: "calculator", schemaVersion: "2", maxCalls: 2 },
    ],
    aggregateCallLimit: 2,
    callTimeoutMs: 5_000,
    maxResultBytes: 16_384,
    deniedCallCharge: "none",
    ...overrides,
  };
}

describe("tool capability policy", () => {
  test("resolves an immutable policy for one exact role and protocol phase", () => {
    const input = policy();
    const resolved = resolveToolPolicy(input, BINDING);

    (input.allowedTools as AllowedToolPolicy[])[0] = {
      toolId: "mutated",
      schemaVersion: "9",
      maxCalls: 99,
    };

    expect(resolved).toEqual(policy());
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.role)).toBe(true);
    expect(Object.isFrozen(resolved.allowedTools)).toBe(true);
    expect(Object.isFrozen(resolved.allowedTools[0])).toBe(true);
  });

  test("rejects duplicate tool IDs and mismatched bindings", () => {
    expect(() => resolveToolPolicy(policy({
      allowedTools: [
        { toolId: "web-search", schemaVersion: "1", maxCalls: 1 },
        { toolId: "web-search", schemaVersion: "2", maxCalls: 1 },
      ],
    }), BINDING)).toThrow("duplicate allowed tool ID: web-search");

    expect(() => resolveToolPolicy(policy({
      role: { id: "reviewer", version: "1" },
    }), BINDING)).toThrow("tool policy role must match proposer@1");

    expect(() => resolveToolPolicy(policy({ phase: "review" }), BINDING)).toThrow(
      "tool policy phase must match proposal",
    );
  });

  test("validates identifiers, call limits, timeout, result bytes, and denial accounting", () => {
    const invalid: Array<{ mutate: (value: Record<string, unknown>) => void; message: string }> = [
      { mutate: (value) => { value.policyId = ""; }, message: "policyId must be non-empty" },
      { mutate: (value) => { value.policyVersion = ""; }, message: "policyVersion must be non-empty" },
      { mutate: (value) => { value.aggregateCallLimit = -1; }, message: "aggregateCallLimit" },
      { mutate: (value) => { value.aggregateCallLimit = 1.5; }, message: "aggregateCallLimit" },
      { mutate: (value) => { value.callTimeoutMs = 0; }, message: "callTimeoutMs" },
      { mutate: (value) => { value.callTimeoutMs = 1.5; }, message: "callTimeoutMs" },
      { mutate: (value) => { value.maxResultBytes = 0; }, message: "maxResultBytes" },
      { mutate: (value) => { value.maxResultBytes = 1.5; }, message: "maxResultBytes" },
      { mutate: (value) => { value.deniedCallCharge = "all"; }, message: "deniedCallCharge" },
      {
        mutate: (value) => {
          value.allowedTools = [{ toolId: "", schemaVersion: "1", maxCalls: 1 }];
        },
        message: "toolId must be non-empty",
      },
      {
        mutate: (value) => {
          value.allowedTools = [{ toolId: "web-search", schemaVersion: "", maxCalls: 1 }];
        },
        message: "schemaVersion must be non-empty",
      },
      {
        mutate: (value) => {
          value.allowedTools = [{ toolId: "web-search", schemaVersion: "1", maxCalls: -1 }];
        },
        message: "allowedTools[0].maxCalls",
      },
    ];

    for (const invalidCase of invalid) {
      const value = structuredClone(policy()) as unknown as Record<string, unknown>;
      invalidCase.mutate(value);
      expect(() => resolveToolPolicy(value as unknown as ToolCapabilityPolicy, BINDING)).toThrow(
        invalidCase.message,
      );
    }
  });

  test("treats zero call limits as disabled while requiring positive execution limits", () => {
    const aggregateDisabled = resolveToolPolicy(policy({ aggregateCallLimit: 0 }), BINDING);
    const aggregateDecision = authorizeToolCall(
      aggregateDisabled,
      createToolCallAccounting(aggregateDisabled),
      { toolId: "web-search", schemaVersion: "1" },
    );
    expect(aggregateDecision.decision).toEqual({
      status: "denied",
      reason: "aggregate_call_limit_exhausted",
    });

    const toolDisabled = resolveToolPolicy(policy({
      allowedTools: [{ toolId: "web-search", schemaVersion: "1", maxCalls: 0 }],
    }), BINDING);
    const toolDecision = authorizeToolCall(
      toolDisabled,
      createToolCallAccounting(toolDisabled),
      { toolId: "web-search", schemaVersion: "1" },
    );
    expect(toolDecision.decision).toEqual({
      status: "denied",
      reason: "tool_call_limit_exhausted",
    });
  });

  test("authorizes only declared tool and schema identities", () => {
    const resolved = resolveToolPolicy(policy(), BINDING);
    const initial = createToolCallAccounting(resolved);

    expect(authorizeToolCall(resolved, initial, {
      toolId: "web-search",
      schemaVersion: "1",
    }).decision).toEqual({
      status: "accepted",
      tool: { toolId: "web-search", schemaVersion: "1" },
    });
    expect(authorizeToolCall(resolved, initial, {
      toolId: "filesystem",
      schemaVersion: "1",
    }).decision).toEqual({ status: "denied", reason: "tool_not_allowed" });
    expect(authorizeToolCall(resolved, initial, {
      toolId: "web-search",
      schemaVersion: "2",
    }).decision).toEqual({ status: "denied", reason: "schema_version_not_allowed" });
  });

  test("charges accepted execution immediately and records uncharged denials", () => {
    const resolved = resolveToolPolicy(policy(), BINDING);
    const initial = createToolCallAccounting(resolved);
    const accepted = authorizeToolCall(resolved, initial, {
      toolId: "web-search",
      schemaVersion: "1",
    });
    const laterFailure = authorizeToolCall(resolved, accepted.accounting, {
      toolId: "web-search",
      schemaVersion: "1",
    });

    expect(accepted.accounting.aggregate).toEqual({
      acceptedCalls: 1,
      deniedCalls: 0,
      consumedCalls: 1,
    });
    expect(laterFailure.decision).toEqual({
      status: "denied",
      reason: "tool_call_limit_exhausted",
    });
    expect(laterFailure.accounting.aggregate).toEqual({
      acceptedCalls: 1,
      deniedCalls: 1,
      consumedCalls: 1,
    });
    expect(laterFailure.accounting.tools).toContainEqual({
      toolId: "web-search",
      schemaVersion: "1",
      acceptedCalls: 1,
      deniedCalls: 1,
    });
  });

  test("can explicitly charge denied calls against the aggregate budget", () => {
    const resolved = resolveToolPolicy(policy({
      aggregateCallLimit: 1,
      deniedCallCharge: "aggregate",
    }), BINDING);
    const denied = authorizeToolCall(
      resolved,
      createToolCallAccounting(resolved),
      { toolId: "filesystem", schemaVersion: "1" },
    );
    const afterDenial = authorizeToolCall(resolved, denied.accounting, {
      toolId: "web-search",
      schemaVersion: "1",
    });

    expect(denied.accounting.aggregate).toEqual({
      acceptedCalls: 0,
      deniedCalls: 1,
      consumedCalls: 1,
    });
    expect(afterDenial.decision).toEqual({
      status: "denied",
      reason: "aggregate_call_limit_exhausted",
    });
  });

  test("creates a bound deny-all policy without consulting tool availability", () => {
    expect(createDenyAllToolPolicy(BINDING)).toEqual({
      policyId: "deny-all-tools",
      policyVersion: "1",
      evidence: "recorded",
      role: BINDING.role,
      phase: "proposal",
      allowedTools: [],
      aggregateCallLimit: 0,
      callTimeoutMs: 30_000,
      maxResultBytes: 65_536,
      deniedCallCharge: "none",
    });
  });
});
