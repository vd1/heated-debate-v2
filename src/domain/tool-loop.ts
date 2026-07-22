import { sanitizeFailure, type SanitizedFailure } from "./events";
import {
  authorizeToolCall,
  createToolCallAccounting,
  type ToolAuthorizationDecision,
  type ToolCallAccounting,
  type ToolCapabilityPolicy,
} from "./tool-policy";

export type ToolCallArguments = unknown;

export interface ToolExecutionContext {
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ToolExecutor {
  toolId: string;
  schemaVersion: string;
  execute(args: ToolCallArguments, context: ToolExecutionContext): Promise<string>;
}

export interface ToolCallRequest {
  toolId: string;
  schemaVersion: string;
  arguments: ToolCallArguments;
}

export interface ToolCallTruncation {
  originalBytes: number;
  retainedBytes: number;
}

export type ToolCallOutcome =
  | {
      status: "succeeded";
      output: string;
      outputBytes: number;
      truncation: ToolCallTruncation | null;
    }
  | {
      status: "failed";
      error: SanitizedFailure;
    };

export type ToolCallDisposition =
  | { status: "accepted" }
  | {
      status: "denied";
      reason: Extract<ToolAuthorizationDecision, { status: "denied" }>["reason"];
    };

export interface ToolCallRecord {
  callId: string;
  ordinal: number;
  toolId: string;
  schemaVersion: string;
  arguments: ToolCallArguments;
  disposition: ToolCallDisposition;
  outcome: ToolCallOutcome | null;
  durationMs: number;
}

export interface ToolDispatcherOptions {
  dispatchId: string;
  policy: ToolCapabilityPolicy;
  executors: readonly ToolExecutor[];
  secrets?: readonly string[];
  now?: () => number;
}

export interface ToolDispatchOptions {
  signal?: AbortSignal;
}

export interface ToolDispatcher {
  dispatch(request: ToolCallRequest, options?: ToolDispatchOptions): Promise<ToolCallRecord>;
  trace(): readonly ToolCallRecord[];
  accounting(): ToolCallAccounting;
}

export function createToolDispatcher(options: ToolDispatcherOptions): ToolDispatcher {
  const now = options.now ?? Date.now;
  const secrets = options.secrets ?? [];
  const failure = (error: unknown, code: string): ToolCallOutcome => ({
    status: "failed",
    error: sanitizeFailure(error, { code, secrets }),
  });
  const executors = new Map(
    options.executors.map((executor) => [
      executorKey(executor.toolId, executor.schemaVersion),
      executor,
    ]),
  );
  const records: ToolCallRecord[] = [];
  let accounting = createToolCallAccounting(options.policy);

  function finishRecord(
    request: ToolCallRequest,
    startedAt: number,
    disposition: ToolCallDisposition,
    outcome: ToolCallOutcome | null,
  ): ToolCallRecord {
    const record = deepFreeze({
      callId: `${options.dispatchId}:call-${String(records.length + 1)}`,
      ordinal: records.length + 1,
      toolId: request.toolId,
      schemaVersion: request.schemaVersion,
      arguments: jsonProjection(request.arguments).projected,
      disposition,
      outcome,
      durationMs: now() - startedAt,
    });
    records.push(record);
    return record;
  }

  async function dispatch(
    request: ToolCallRequest,
    dispatchOptions: ToolDispatchOptions = {},
  ): Promise<ToolCallRecord> {
    const startedAt = now();
    const externalSignal = dispatchOptions.signal;
    const authorization = authorizeToolCall(options.policy, accounting, {
      toolId: request.toolId,
      schemaVersion: request.schemaVersion,
    });
    accounting = authorization.accounting;
    if (authorization.decision.status === "denied") {
      return finishRecord(request, startedAt, {
        status: "denied",
        reason: authorization.decision.reason,
      }, null);
    }

    const executor = executors.get(executorKey(request.toolId, request.schemaVersion));
    if (!executor) {
      return finishRecord(request, startedAt, { status: "accepted" }, failure(
        new Error(`tool is unavailable in environment: ${request.toolId}@${request.schemaVersion}`),
        "tool_unavailable",
      ));
    }
    if (!jsonProjection(request.arguments).faithful) {
      return finishRecord(request, startedAt, { status: "accepted" }, failure(
        new Error("tool call arguments must be JSON-representable"),
        "malformed_arguments",
      ));
    }
    const cancelledOutcome = (): ToolCallOutcome => failure(
      new Error("tool call was cancelled"),
      "cancelled",
    );
    if (externalSignal?.aborted) {
      return finishRecord(request, startedAt, { status: "accepted" }, cancelledOutcome());
    }
    const timeoutMs = options.policy.callTimeoutMs;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    const execution = executor.execute(structuredClone(request.arguments), {
      signal: controller.signal,
      timeoutMs,
    });
    const timedOut = Symbol("tool-call-timeout");
    const cancelled = Symbol("tool-call-cancelled");
    try {
      const raced = await Promise.race([
        execution,
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(timedOut);
          }, timeoutMs);
        }),
        new Promise<typeof cancelled>((resolve) => {
          if (!externalSignal) return;
          const onAbort = (): void => {
            controller.abort();
            resolve(cancelled);
          };
          externalSignal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => {
            externalSignal.removeEventListener("abort", onAbort);
          };
        }),
      ]);
      if (raced === timedOut) {
        return finishRecord(request, startedAt, { status: "accepted" }, failure(
          new Error(`tool call timed out after ${String(timeoutMs)}ms`),
          "timeout",
        ));
      }
      if (raced === cancelled) {
        return finishRecord(request, startedAt, { status: "accepted" }, cancelledOutcome());
      }
      return finishRecord(request, startedAt, { status: "accepted" }, successOutcome(
        raced,
        options.policy.maxResultBytes,
      ));
    } catch (error) {
      return finishRecord(request, startedAt, { status: "accepted" }, failure(error, "tool_error"));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbortListener?.();
      execution.catch(() => undefined);
    }
  }

  return {
    dispatch,
    trace: () => Object.freeze([...records]),
    accounting: () => accounting,
  };
}

function executorKey(toolId: string, schemaVersion: string): string {
  return JSON.stringify([toolId, schemaVersion]);
}

function successOutcome(output: string, maxResultBytes: number): ToolCallOutcome {
  const encoded = new TextEncoder().encode(output);
  if (encoded.byteLength <= maxResultBytes) {
    return {
      status: "succeeded",
      output,
      outputBytes: encoded.byteLength,
      truncation: null,
    };
  }
  let end = maxResultBytes;
  while (end > 0 && ((encoded[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  return {
    status: "succeeded",
    output: new TextDecoder().decode(encoded.subarray(0, end)),
    outputBytes: end,
    truncation: { originalBytes: encoded.byteLength, retainedBytes: end },
  };
}

function jsonProjection(value: ToolCallArguments): {
  projected: ToolCallArguments;
  faithful: boolean;
} {
  // JSON.stringify returns undefined at runtime for undefined/function/symbol roots.
  let serialized: unknown;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { projected: null, faithful: false };
  }
  if (typeof serialized !== "string") return { projected: null, faithful: false };
  const projected: unknown = JSON.parse(serialized);
  return { projected, faithful: deepEqual(projected, value) };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key)
    && deepEqual(Reflect.get(left, key), Reflect.get(right, key)));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
}
