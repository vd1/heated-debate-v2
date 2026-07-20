import {
  AgentFailure,
  type AgentPort,
  type AgentReply,
  type AgentTrace,
  type NormalizedUsage,
} from "./agent";
import {
  sanitizeFailure,
  type CanonicalEvent,
  type CanonicalTurnReply,
} from "./events";
import type { ExchangeParticipant, ExchangeResult } from "./exchange";
import { DebateScheduler } from "./scheduler";

/**
 * The runner flushes after run start, before each agent dispatch, after each
 * attempt/completion batch, and after the terminal event. A failed dispatch
 * therefore leaves a readable prefix ending at its committed turn request.
 */
export interface DebateEventSink {
  append(event: CanonicalEvent): Promise<void>;
  flush(): Promise<void>;
}

export interface DebateRecording {
  runId: string;
  sink: DebateEventSink;
  failureSecrets?: readonly string[];
}

export interface DebateBudget {
  maxTurns: number;
  /** Sum of observed input and output tokens across attempts. Reasoning is an output subset. */
  maxTokens: number;
}

export type DebateFailureCode =
  | "cancelled"
  | "timeout"
  | "empty_output"
  | "provider_failure"
  | "turn_budget_exhausted"
  | "token_budget_exhausted";

export class DebateRunFailure extends Error {
  readonly name = "DebateRunFailure";
  readonly code: DebateFailureCode;
  readonly turnId: string | undefined;
  readonly trace: AgentTrace;
  /** Observed lower-bound usage; unavailable kinds remain absent. */
  readonly observedUsage: Pick<NormalizedUsage, "inputTokens" | "outputTokens">;

  constructor(input: {
    code: DebateFailureCode;
    message: string;
    turnId?: string;
    trace?: AgentTrace;
    observedUsage?: Pick<NormalizedUsage, "inputTokens" | "outputTokens">;
  }) {
    super(input.message);
    this.code = input.code;
    this.turnId = input.turnId;
    this.trace = structuredClone(input.trace ?? { attempts: [] });
    this.observedUsage = structuredClone(input.observedUsage ?? {});
  }
}

export interface RunDebateInput {
  debateId: string;
  topic: string;
  roundCount: number;
  proposer: ExchangeParticipant;
  reviewer: ExchangeParticipant;
  recording?: DebateRecording;
  signal?: AbortSignal;
  turnTimeoutMs?: number;
  budget?: DebateBudget;
}

export interface DebateRound {
  readonly roundNumber: number;
  readonly exchange: ExchangeResult;
}

export interface DebateResult {
  readonly debateId: string;
  readonly topic: string;
  readonly rounds: readonly DebateRound[];
}

export async function runDebate(input: RunDebateInput): Promise<DebateResult> {
  validateLimits(input);
  const proposerAgent = input.proposer.agent;
  const reviewerAgent = input.reviewer.agent;
  const scheduler = new DebateScheduler({
    debateId: input.debateId,
    topic: input.topic,
    roundCount: input.roundCount,
    proposer: input.proposer,
    reviewer: input.reviewer,
  });
  let sequence = 0;
  let terminalEmitted = false;
  let dispatchedTurns = 0;
  const observedUsage: Pick<NormalizedUsage, "inputTokens" | "outputTokens"> = {};

  const emit = async (event: CanonicalEvent, flush: boolean): Promise<void> => {
    if (!input.recording) return;
    await input.recording.sink.append(event);
    sequence += 1;
    if (flush) await input.recording.sink.flush();
  };

  const emitAttempts = async (turnId: string, trace: AgentTrace): Promise<void> => {
    for (const attempt of trace.attempts) {
      if (input.recording) {
        await emit({
          schemaVersion: 1,
          runId: input.recording.runId,
          sequence,
          type: "adapter.attempt",
          data: { turnId, attempt: structuredClone(attempt) },
        }, false);
      }
      addObservedUsage(observedUsage, attempt.usage);
    }
  };

  const endWithFailure = async (failure: DebateRunFailure): Promise<never> => {
    if (terminalEmitted) throw failure;
    if (input.recording) {
      const sanitized = sanitizeFailure(failure, {
        code: failure.code,
        secrets: input.recording.failureSecrets ?? [],
      });
      if (failure.turnId !== undefined) {
        await emit({
          schemaVersion: 1,
          runId: input.recording.runId,
          sequence,
          type: "turn.failed",
          data: { turnId: failure.turnId, failure: sanitized },
        }, false);
      }
      await emit({
        schemaVersion: 1,
        runId: input.recording.runId,
        sequence,
        type: "run.failed",
        data: { failure: sanitized },
      }, true);
    }
    terminalEmitted = true;
    throw failure;
  };

  let primaryError: unknown;
  let completedResult: DebateResult | undefined;
  try {
    if (input.recording) {
      await emit({
        schemaVersion: 1,
        runId: input.recording.runId,
        sequence,
        type: "run.started",
        data: {
          debateId: input.debateId,
          topic: input.topic,
          roundCount: input.roundCount,
        },
      }, true);
    }

    for (let turn = scheduler.nextTurn(); turn !== undefined; turn = scheduler.nextTurn()) {
      if (input.signal?.aborted) {
        await endWithFailure(new DebateRunFailure({
          code: "cancelled",
          message: "debate was cancelled",
          observedUsage,
        }));
      }
      if (input.budget && dispatchedTurns >= input.budget.maxTurns) {
        await endWithFailure(new DebateRunFailure({
          code: "turn_budget_exhausted",
          message: `turn budget exhausted before dispatch ${String(dispatchedTurns + 1)}`,
          observedUsage,
        }));
      }

      if (input.recording) {
        await emit({
          schemaVersion: 1,
          runId: input.recording.runId,
          sequence,
          type: "turn.requested",
          data: {
            roundNumber: turn.roundNumber,
            request: structuredClone(turn.request),
          },
        }, true);
      }
      dispatchedTurns += 1;
      const agent = turn.side === "proposer" ? proposerAgent : reviewerAgent;
      const reply = await dispatchReply(
        agent,
        structuredClone(turn.request),
        input.signal,
        input.turnTimeoutMs,
      ).catch(async (error: unknown) => {
        const normalized = normalizeDispatchFailure(error, turn.request.turnId, observedUsage);
        await emitAttempts(turn.request.turnId, normalized.trace);
        return endWithFailure(new DebateRunFailure({
          code: normalized.code,
          message: normalized.message,
          ...(normalized.turnId === undefined ? {} : { turnId: normalized.turnId }),
          trace: normalized.trace,
          observedUsage,
        }));
      });

      await emitAttempts(turn.request.turnId, reply.trace);
      if (input.budget && observedTokenLowerBound(observedUsage) > input.budget.maxTokens) {
        await endWithFailure(new DebateRunFailure({
          code: "token_budget_exhausted",
          message: `observed token budget exceeded after ${turn.request.turnId}`,
          turnId: turn.request.turnId,
          trace: reply.trace,
          observedUsage,
        }));
      }
      if (reply.text.trim().length === 0) {
        await endWithFailure(new DebateRunFailure({
          code: "empty_output",
          message: `agent returned whitespace-only output for ${turn.request.turnId}`,
          turnId: turn.request.turnId,
          trace: reply.trace,
          observedUsage,
        }));
      }

      scheduler.acceptReply(reply);
      if (input.recording) {
        const canonicalReply: CanonicalTurnReply = {
          text: reply.text,
          durationMs: reply.durationMs,
          model: structuredClone(reply.model),
          controls: structuredClone(reply.controls),
        };
        await emit({
          schemaVersion: 1,
          runId: input.recording.runId,
          sequence,
          type: "turn.completed",
          data: { turnId: turn.request.turnId, reply: canonicalReply },
        }, true);
      }
    }

    const result = scheduler.result();
    if (input.recording) {
      await emit({
        schemaVersion: 1,
        runId: input.recording.runId,
        sequence,
        type: "run.completed",
        data: { turnCount: dispatchedTurns },
      }, true);
    }
    terminalEmitted = true;
    completedResult = result;
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: Error[] = [];
  for (const agent of new Set([reviewerAgent, proposerAgent])) {
    try {
      await agent.dispose();
    } catch (error) {
      cleanupErrors.push(toError(error));
    }
  }
  if (cleanupErrors.length > 0) {
    const errors = [primaryError, ...cleanupErrors]
      .filter((error) => error !== undefined)
      .map(toError);
    throw new AggregateError(errors, "debate execution or cleanup failed");
  }
  if (primaryError !== undefined) throw toError(primaryError);
  if (!completedResult) throw new Error("debate completed without a result");
  return completedResult;
}

class DispatchInterruption extends Error {
  constructor(
    readonly kind: "cancelled" | "timeout",
    message: string,
    readonly trace: AgentTrace,
  ) {
    super(message);
  }
}

async function dispatchReply(
  agent: AgentPort,
  request: Parameters<AgentPort["reply"]>[0],
  externalSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<AgentReply> {
  if (externalSignal?.aborted) {
    throw new DispatchInterruption("cancelled", "debate was cancelled", { attempts: [] });
  }
  const local = new AbortController();
  const signal = externalSignal === undefined
    ? local.signal
    : AbortSignal.any([externalSignal, local.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interruptionKind: "cancelled" | "timeout" | undefined;
  let partialTrace: AgentTrace = { attempts: [] };
  let removeExternalListener: (() => void) | undefined;
  let rejectHardInterruption: ((error: DispatchInterruption) => void) | undefined;
  const hardInterruption = new Promise<never>((_resolve, reject) => {
    rejectHardInterruption = reject;
  });
  const interrupt = (kind: "cancelled" | "timeout"): void => {
    if (interruptionKind !== undefined) return;
    interruptionKind = kind;
    local.abort();
    queueMicrotask(() => {
      rejectHardInterruption?.(dispatchInterruption(kind, timeoutMs, partialTrace));
    });
  };
  if (externalSignal) {
    const onAbort = (): void => {
      interrupt("cancelled");
    };
    externalSignal.addEventListener("abort", onAbort, { once: true });
    removeExternalListener = () => {
      externalSignal.removeEventListener("abort", onAbort);
    };
  }
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      interrupt("timeout");
    }, timeoutMs);
  }
  const operation = agent.reply(request, { signal }).catch((error: unknown) => {
    if (error instanceof AgentFailure) partialTrace = error.trace;
    if (interruptionKind !== undefined) {
      throw dispatchInterruption(interruptionKind, timeoutMs, partialTrace);
    }
    throw error;
  });
  try {
    const reply = await Promise.race([operation, hardInterruption]);
    if (interruptionKind !== undefined) {
      throw dispatchInterruption(interruptionKind, timeoutMs, partialTrace);
    }
    return reply;
  } finally {
    if (timer) clearTimeout(timer);
    removeExternalListener?.();
    void operation.catch(() => {
      // A hard interruption may win before a non-cooperative port settles.
    });
  }
}

function dispatchInterruption(
  kind: "cancelled" | "timeout",
  timeoutMs: number | undefined,
  trace: AgentTrace,
): DispatchInterruption {
  return new DispatchInterruption(
    kind,
    kind === "timeout" ? `turn timed out after ${String(timeoutMs)}ms` : "debate was cancelled",
    trace,
  );
}

function normalizeDispatchFailure(
  error: unknown,
  turnId: string,
  observedUsage: Pick<NormalizedUsage, "inputTokens" | "outputTokens">,
): DebateRunFailure {
  if (error instanceof DispatchInterruption) {
    return new DebateRunFailure({
      code: error.kind,
      message: error.message,
      turnId,
      trace: error.trace,
      observedUsage,
    });
  }
  if (error instanceof AgentFailure) {
    return new DebateRunFailure({
      code: error.code === "cancelled" ? "cancelled" : "provider_failure",
      message: error.message,
      turnId,
      trace: error.trace,
      observedUsage,
    });
  }
  return new DebateRunFailure({
    code: "provider_failure",
    message: toError(error).message,
    turnId,
    observedUsage,
  });
}

function addObservedUsage(
  total: Pick<NormalizedUsage, "inputTokens" | "outputTokens">,
  usage: NormalizedUsage,
): void {
  if (usage.inputTokens !== undefined) {
    total.inputTokens = (total.inputTokens ?? 0) + usage.inputTokens;
  }
  if (usage.outputTokens !== undefined) {
    total.outputTokens = (total.outputTokens ?? 0) + usage.outputTokens;
  }
}

function observedTokenLowerBound(
  usage: Pick<NormalizedUsage, "inputTokens" | "outputTokens">,
): number {
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

function validateLimits(input: RunDebateInput): void {
  if (input.turnTimeoutMs !== undefined
    && (!Number.isFinite(input.turnTimeoutMs) || input.turnTimeoutMs <= 0)) {
    throw new Error("turnTimeoutMs must be a finite positive number");
  }
  if (input.budget) {
    if (!Number.isInteger(input.budget.maxTurns) || input.budget.maxTurns < 0) {
      throw new Error("budget.maxTurns must be a non-negative integer");
    }
    if (!Number.isFinite(input.budget.maxTokens) || input.budget.maxTokens < 0) {
      throw new Error("budget.maxTokens must be a finite non-negative number");
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
