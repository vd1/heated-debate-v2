import {
  AgentFailure,
  type AgentPort,
  type AgentReply,
  type AgentTrace,
  type NormalizedUsage,
} from "./agent";
import type { ToolCallRecord } from "./tool-loop";
import {
  CANONICAL_SCHEMA_VERSION,
  sanitizeFailure,
  type CanonicalEvent,
  type CanonicalRunControls,
  type CanonicalTurnReply,
} from "./events";
import type { ExchangeParticipant, ExchangeResult } from "./exchange";
import { orderedTurnEvidence } from "./debate-events";
import {
  calculateUsageCost,
  definePricingSnapshot,
  findPricingEntry,
  pricingSnapshotHash,
  scaledCurrencyAmount,
  type PricingSnapshot,
} from "./pricing";
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

export interface DebateMonetaryBudget {
  /** Maximum spend in the snapshot's currency, derived only from observed attempt usage. */
  maxAmount: number;
  snapshot: PricingSnapshot;
  /**
   * When true, attempts whose usage cannot be priced fall back to token-only
   * accounting instead of failing the run closed.
   */
  permitTokenOnlyAccounting?: boolean;
}

export interface DebateBudget {
  maxTurns: number;
  /** Sum of observed input and output tokens across attempts. Reasoning is an output subset. */
  maxTokens: number;
  monetary?: DebateMonetaryBudget;
}

export type DebateFailureCode =
  | "cancelled"
  | "timeout"
  | "run_timeout"
  | "empty_output"
  | "provider_failure"
  | "turn_budget_exhausted"
  | "token_budget_exhausted"
  | "monetary_budget_exhausted"
  | "cost_unknown"
  | "protocol_failure";

type BudgetObservedUsage = Pick<
  NormalizedUsage,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
>;

export class DebateRunFailure extends Error {
  readonly name = "DebateRunFailure";
  readonly code: DebateFailureCode;
  readonly turnId: string | undefined;
  readonly trace: AgentTrace;
  readonly toolCalls: readonly ToolCallRecord[];
  /** Observed lower-bound usage; unavailable kinds remain absent. */
  readonly observedUsage: BudgetObservedUsage;

  constructor(input: {
    code: DebateFailureCode;
    message: string;
    turnId?: string;
    trace?: AgentTrace;
    toolCalls?: readonly ToolCallRecord[];
    observedUsage?: BudgetObservedUsage;
  }) {
    super(input.message);
    this.code = input.code;
    this.turnId = input.turnId;
    this.trace = structuredClone(input.trace ?? { attempts: [] });
    this.toolCalls = structuredClone(input.toolCalls ?? []);
    this.observedUsage = structuredClone(input.observedUsage ?? {});
  }
}

export interface RunDebateInput {
  debateId: string;
  topic: string;
  roundCount: number;
  proposer: ExchangeParticipant;
  reviewer: ExchangeParticipant;
  /** Immutable experiment-config identity recorded in run.started. */
  experiment?: { configHash: string; caseId?: string };
  /** Validated creativity-schedule selection; only linear-cooling@1 is implemented. */
  creativitySchedule?: { scheduleId: string; scheduleVersion: string };
  recording?: DebateRecording;
  signal?: AbortSignal;
  signalFailureCode?: "cancelled" | "run_timeout";
  turnTimeoutMs?: number;
  wholeRunTimeoutMs?: number;
  budget?: DebateBudget;
}

export interface DebateRound {
  readonly roundNumber: number;
  readonly exchange: ExchangeResult;
}

export interface DebateResult {
  readonly experiment: { configHash: string; caseId: string | null } | null;
  readonly debateId: string;
  readonly topic: string;
  readonly rounds: readonly DebateRound[];
  readonly controls: Extract<CanonicalRunControls, { evidence: "recorded" }>;
}

export async function runDebate(input: RunDebateInput): Promise<DebateResult> {
  validateLimits(input);
  const proposerAgent = input.proposer.agent;
  const reviewerAgent = input.reviewer.agent;
  const monetary = input.budget?.monetary === undefined
    ? undefined
    : Object.freeze({
        maxAmountScaled: scaledCurrencyAmount(
          input.budget.monetary.maxAmount,
          "budget.monetary.maxAmount",
        ),
        snapshot: definePricingSnapshot(input.budget.monetary.snapshot),
        permitTokenOnlyAccounting: input.budget.monetary.permitTokenOnlyAccounting === true,
      });
  let observedCostScaled = 0n;
  let costIssue: string | undefined;
  const runControls = canonicalRunControls(input, monetary === undefined
    ? null
    : Object.freeze({
        maxAmount: input.budget?.monetary?.maxAmount ?? 0,
        currency: monetary.snapshot.currency,
        snapshotId: monetary.snapshot.snapshotId,
        snapshotVersion: monetary.snapshot.snapshotVersion,
        snapshotHash: pricingSnapshotHash(monetary.snapshot),
        permitTokenOnlyAccounting: monetary.permitTokenOnlyAccounting,
      }));
  if (input.creativitySchedule !== undefined
    && (input.creativitySchedule.scheduleId !== "linear-cooling"
      || input.creativitySchedule.scheduleVersion !== "1")) {
    throw new Error("creativitySchedule must be linear-cooling@1");
  }
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
  const observedUsage: BudgetObservedUsage = {};

  const emit = async (event: CanonicalEvent, flush: boolean): Promise<void> => {
    if (!input.recording) return;
    await input.recording.sink.append(event);
    sequence += 1;
    if (flush) await input.recording.sink.flush();
  };

  const emitTurnEvidence = async (
    turnId: string,
    model: AgentReply["model"],
    trace: AgentTrace,
    toolCalls: readonly ToolCallRecord[],
  ): Promise<void> => {
    const ordered = orderedTurnEvidence(trace.attempts, toolCalls);
    for (const evidence of ordered) {
      if (evidence.kind === "attempt") {
        if (input.recording) {
          await emit({
            schemaVersion: CANONICAL_SCHEMA_VERSION,
            runId: input.recording.runId,
            sequence,
            type: "adapter.attempt",
            data: { turnId, attempt: structuredClone(evidence.attempt) },
          }, false);
        }
        addObservedUsage(observedUsage, evidence.attempt.usage);
        if (monetary) {
          try {
            const cost = calculateUsageCost(monetary.snapshot, model, evidence.attempt.usage);
            if (cost.status === "known") {
              observedCostScaled += cost.amountScaled;
            } else {
              costIssue ??= `missing ${cost.missing.join(", ")}`;
            }
          } catch (error) {
            costIssue ??= toError(error).message;
          }
        }
      } else if (input.recording) {
        await emit({
          schemaVersion: CANONICAL_SCHEMA_VERSION,
          runId: input.recording.runId,
          sequence,
          type: "turn.tool_call",
          data: { turnId, record: structuredClone(evidence.record) },
        }, false);
      }
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
          schemaVersion: CANONICAL_SCHEMA_VERSION,
          runId: input.recording.runId,
          sequence,
          type: "turn.failed",
          data: { turnId: failure.turnId, failure: sanitized },
        }, false);
      }
      await emit({
        schemaVersion: CANONICAL_SCHEMA_VERSION,
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
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        runId: input.recording.runId,
        sequence,
        type: "run.started",
        data: {
          debateId: input.debateId,
          topic: input.topic,
          roundCount: input.roundCount,
          controls: structuredClone(runControls),
          experiment: input.experiment === undefined
            ? null
            : { configHash: input.experiment.configHash, caseId: input.experiment.caseId ?? null },
        },
      }, true);
    }

    for (let turn = scheduler.nextTurn(); turn !== undefined; turn = scheduler.nextTurn()) {
      if (input.signal?.aborted) {
        await endWithFailure(new DebateRunFailure({
          code: input.signalFailureCode ?? "cancelled",
          message: input.signalFailureCode === "run_timeout"
            ? "whole-run deadline exceeded"
            : "debate was cancelled",
          observedUsage,
        }));
      }
      if (runControls.budget
        && observedTokenLowerBound(observedUsage) >= runControls.budget.maxTokens) {
        await endWithFailure(new DebateRunFailure({
          code: "token_budget_exhausted",
          message: `token budget exhausted before dispatch ${String(dispatchedTurns + 1)}`,
          observedUsage,
        }));
      }
      if (monetary && observedCostScaled >= monetary.maxAmountScaled) {
        await endWithFailure(new DebateRunFailure({
          code: "monetary_budget_exhausted",
          message: `monetary budget exhausted before dispatch ${String(dispatchedTurns + 1)}`,
          observedUsage,
        }));
      }
      if (runControls.budget && dispatchedTurns >= runControls.budget.maxTurns) {
        await endWithFailure(new DebateRunFailure({
          code: "turn_budget_exhausted",
          message: `turn budget exhausted before dispatch ${String(dispatchedTurns + 1)}`,
          observedUsage,
        }));
      }

      if (input.recording) {
        await emit({
          schemaVersion: CANONICAL_SCHEMA_VERSION,
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
        runControls.turnTimeoutMs ?? undefined,
        input.signalFailureCode ?? "cancelled",
      ).catch(async (error: unknown) => {
        const normalized = normalizeDispatchFailure(error, turn.request.turnId, observedUsage);
        try {
          await emitTurnEvidence(
            turn.request.turnId,
            turn.request.controls.model,
            normalized.trace,
            normalized.toolCalls,
          );
        } catch {
          // Contradictory evidence is dropped; the original failure still terminates the run.
        }
        return endWithFailure(new DebateRunFailure({
          code: normalized.code,
          message: normalized.message,
          ...(normalized.turnId === undefined ? {} : { turnId: normalized.turnId }),
          trace: normalized.trace,
          toolCalls: normalized.toolCalls,
          observedUsage,
        }));
      });

      // Successful evidence is priced by the identity the provider returned.
      try {
        await emitTurnEvidence(
          turn.request.turnId,
          reply.model,
          reply.trace,
          reply.toolCalls,
        );
      } catch (error) {
        await endWithFailure(new DebateRunFailure({
          code: "protocol_failure",
          message: toError(error).message,
          turnId: turn.request.turnId,
          observedUsage,
        }));
      }
      if (monetary && costIssue !== undefined && !monetary.permitTokenOnlyAccounting) {
        await endWithFailure(new DebateRunFailure({
          code: "cost_unknown",
          message: `observed usage cannot be priced (${costIssue}) for ${turn.request.turnId}`,
          turnId: turn.request.turnId,
          trace: reply.trace,
          observedUsage,
        }));
      }
      if (monetary && observedCostScaled > monetary.maxAmountScaled) {
        await endWithFailure(new DebateRunFailure({
          code: "monetary_budget_exhausted",
          message: `observed monetary budget exceeded after ${turn.request.turnId}`,
          turnId: turn.request.turnId,
          trace: reply.trace,
          observedUsage,
        }));
      }
      if (runControls.budget
        && observedTokenLowerBound(observedUsage) > runControls.budget.maxTokens) {
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
          schemaVersion: CANONICAL_SCHEMA_VERSION,
          runId: input.recording.runId,
          sequence,
          type: "turn.completed",
          data: { turnId: turn.request.turnId, reply: canonicalReply },
        }, true);
      }
    }

    const scheduledResult = scheduler.result();
    const result: DebateResult = Object.freeze({
      ...scheduledResult,
      controls: runControls,
      experiment: input.experiment === undefined
        ? null
        : Object.freeze({
            configHash: input.experiment.configHash,
            caseId: input.experiment.caseId ?? null,
          }),
    });
    if (input.recording) {
      await emit({
        schemaVersion: CANONICAL_SCHEMA_VERSION,
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
    readonly kind: "cancelled" | "timeout" | "run_timeout",
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
  externalFailureCode: "cancelled" | "run_timeout",
): Promise<AgentReply> {
  if (externalSignal?.aborted) {
    throw dispatchInterruption(externalFailureCode, timeoutMs, { attempts: [] });
  }
  const local = new AbortController();
  const signal = externalSignal === undefined
    ? local.signal
    : AbortSignal.any([externalSignal, local.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interruptionKind: "cancelled" | "timeout" | "run_timeout" | undefined;
  let partialTrace: AgentTrace = { attempts: [] };
  let removeExternalListener: (() => void) | undefined;
  let rejectHardInterruption: ((error: DispatchInterruption) => void) | undefined;
  const hardInterruption = new Promise<never>((_resolve, reject) => {
    rejectHardInterruption = reject;
  });
  const interrupt = (kind: "cancelled" | "timeout" | "run_timeout"): void => {
    if (interruptionKind !== undefined) return;
    interruptionKind = kind;
    local.abort();
    queueMicrotask(() => {
      rejectHardInterruption?.(dispatchInterruption(kind, timeoutMs, partialTrace));
    });
  };
  if (externalSignal) {
    const onAbort = (): void => {
      interrupt(externalFailureCode);
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
  kind: "cancelled" | "timeout" | "run_timeout",
  timeoutMs: number | undefined,
  trace: AgentTrace,
): DispatchInterruption {
  return new DispatchInterruption(
    kind,
    kind === "timeout"
      ? `turn timed out after ${String(timeoutMs)}ms`
      : kind === "run_timeout"
        ? "whole-run deadline exceeded"
        : "debate was cancelled",
    trace,
  );
}

function normalizeDispatchFailure(
  error: unknown,
  turnId: string,
  observedUsage: BudgetObservedUsage,
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
      code: error.code === "cancelled"
        ? "cancelled"
        : error.code === "protocol_failure"
          ? "protocol_failure"
          : "provider_failure",
      message: error.message,
      turnId,
      trace: error.trace,
      toolCalls: error.toolCalls,
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
  total: BudgetObservedUsage,
  usage: NormalizedUsage,
): void {
  if (usage.inputTokens !== undefined) {
    total.inputTokens = (total.inputTokens ?? 0) + usage.inputTokens;
  }
  if (usage.outputTokens !== undefined) {
    total.outputTokens = (total.outputTokens ?? 0) + usage.outputTokens;
  }
  if (usage.cacheReadTokens !== undefined) {
    total.cacheReadTokens = (total.cacheReadTokens ?? 0) + usage.cacheReadTokens;
  }
  if (usage.cacheWriteTokens !== undefined) {
    total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
  }
}

function observedTokenLowerBound(usage: BudgetObservedUsage): number {
  return (usage.inputTokens ?? 0)
    + (usage.outputTokens ?? 0)
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0);
}

function canonicalRunControls(
  input: RunDebateInput,
  monetary: Extract<CanonicalRunControls, { evidence: "recorded" }>["monetary"],
): Extract<CanonicalRunControls, { evidence: "recorded" }> {
  const budget = input.budget === undefined
    ? null
    : Object.freeze({
        maxTurns: input.budget.maxTurns,
        maxTokens: input.budget.maxTokens,
      });
  return Object.freeze({
    policyId: "run-controls",
    policyVersion: "1",
    evidence: "recorded",
    turnTimeoutMs: input.turnTimeoutMs ?? null,
    wholeRunTimeoutMs: input.wholeRunTimeoutMs ?? null,
    budget,
    monetary,
  });
}

function validateLimits(input: RunDebateInput): void {
  if (input.signalFailureCode === "run_timeout" && input.wholeRunTimeoutMs === undefined) {
    throw new Error("run_timeout cancellation requires wholeRunTimeoutMs");
  }
  if (input.turnTimeoutMs !== undefined
    && (!Number.isFinite(input.turnTimeoutMs) || input.turnTimeoutMs <= 0)) {
    throw new Error("turnTimeoutMs must be a finite positive number");
  }
  if (input.wholeRunTimeoutMs !== undefined
    && (!Number.isFinite(input.wholeRunTimeoutMs) || input.wholeRunTimeoutMs <= 0)) {
    throw new Error("wholeRunTimeoutMs must be a finite positive number");
  }
  if (input.budget) {
    if (!Number.isInteger(input.budget.maxTurns) || input.budget.maxTurns < 0) {
      throw new Error("budget.maxTurns must be a non-negative integer");
    }
    if (!Number.isFinite(input.budget.maxTokens) || input.budget.maxTokens < 0) {
      throw new Error("budget.maxTokens must be a finite non-negative number");
    }
    if (input.budget.monetary) {
      const monetary = input.budget.monetary;
      if (!Number.isFinite(monetary.maxAmount) || monetary.maxAmount < 0) {
        throw new Error("budget.monetary.maxAmount must be a finite non-negative number");
      }
      for (const participant of [input.proposer, input.reviewer]) {
        const model = participant.controls.model;
        if (!findPricingEntry(monetary.snapshot, model)) {
          throw new Error(`no pricing entry for ${model.providerId}/${model.modelId}`);
        }
      }
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
