import type {
  AttemptTrace,
  ControlTrace,
  ModelIdentity,
  ThinkingLevel,
  TurnRequest,
} from "./agent";
import {
  validateCanonicalSequence,
  type CanonicalEvent,
  type CanonicalTurnReply,
  type SanitizedFailure,
} from "./events";

interface TranscriptTurn {
  roundNumber: number;
  request: TurnRequest;
  attempts: AttemptTrace[];
  reply?: CanonicalTurnReply;
  failure?: SanitizedFailure;
}

export function renderDebateMarkdown(events: readonly CanonicalEvent[]): string {
  validateCanonicalSequence(events);
  const start = events[0];
  if (start?.type !== "run.started") {
    throw new Error("Markdown projection requires an initial run.started event");
  }

  const turns: TranscriptTurn[] = [];
  const turnsById = new Map<string, TranscriptTurn>();
  let runOutcome: Extract<CanonicalEvent, { type: "run.completed" | "run.failed" }> | undefined;

  for (const event of events.slice(1)) {
    switch (event.type) {
      case "turn.requested": {
        const turnId = event.data.request.turnId;
        if (turnsById.has(turnId)) throw new Error(`duplicate transcript turn: ${turnId}`);
        const turn: TranscriptTurn = {
          roundNumber: event.data.roundNumber,
          request: structuredClone(event.data.request),
          attempts: [],
        };
        turns.push(turn);
        turnsById.set(turnId, turn);
        break;
      }
      case "adapter.attempt":
        requireTurn(turnsById, event.data.turnId).attempts.push(structuredClone(event.data.attempt));
        break;
      case "turn.completed": {
        const turn = requireTurn(turnsById, event.data.turnId);
        if (turn.reply || turn.failure) throw new Error(`duplicate transcript outcome: ${event.data.turnId}`);
        turn.reply = structuredClone(event.data.reply);
        break;
      }
      case "turn.failed": {
        const turn = requireTurn(turnsById, event.data.turnId);
        if (turn.reply || turn.failure) throw new Error(`duplicate transcript outcome: ${event.data.turnId}`);
        turn.failure = structuredClone(event.data.failure);
        break;
      }
      case "run.completed":
      case "run.failed":
        if (runOutcome) throw new Error("duplicate transcript run outcome");
        runOutcome = event;
        break;
      case "run.started":
        throw new Error("duplicate run.started event");
    }
  }

  const lines: string[] = [
    "# Debate Transcript",
    "",
    `- Artifact run: ${inlineCode(start.runId)}`,
    `- Debate ID: ${inlineCode(start.data.debateId)}`,
    `- Planned rounds: ${String(start.data.roundCount)}`,
    `- Run controls: ${inlineCode(`${start.data.controls.policyId}@${start.data.controls.policyVersion}`)}`,
    `- Turn timeout: ${start.data.controls.turnTimeoutMs === null ? "_not configured_" : `${String(start.data.controls.turnTimeoutMs)} ms`}`,
    `- Turn budget: ${start.data.controls.budget === null ? "_not configured_" : String(start.data.controls.budget.maxTurns)}`,
    `- Token budget: ${start.data.controls.budget === null ? "_not configured_" : String(start.data.controls.budget.maxTokens)}`,
    "",
    "## Topic",
    "",
    fencedText(start.data.topic),
  ];

  let renderedRound: number | undefined;
  for (const turn of turns) {
    if (renderedRound !== turn.roundNumber) {
      lines.push("", `## Round ${String(turn.roundNumber)}`);
      renderedRound = turn.roundNumber;
    }
    renderTurn(lines, turn);
  }

  lines.push("", "## Run outcome", "");
  if (runOutcome?.type === "run.completed") {
    const count = runOutcome.data.turnCount;
    lines.push(`Completed ${String(count)} ${count === 1 ? "turn" : "turns"}.`);
  } else if (runOutcome?.type === "run.failed") {
    lines.push(
      `**Run failed — ${inlineCode(runOutcome.data.failure.code)}**`,
      "",
      fencedText(runOutcome.data.failure.message),
    );
  } else {
    lines.push("Incomplete canonical event prefix; no run outcome was recorded.");
  }

  return `${lines.join("\n")}\n`;
}

function renderTurn(lines: string[], turn: TranscriptTurn): void {
  const request = turn.request;
  const tools = request.capabilities.toolNames.length === 0
    ? "none"
    : request.capabilities.toolNames.map(inlineCode).join(", ");
  lines.push(
    "",
    `### ${headingText(titleCase(request.role.id))} — ${inlineCode(request.turnId)}`,
    "",
    `- Role: ${inlineCode(`${request.role.id}@${request.role.version}`)}`,
    `- Creativity: ${inlineCode(`${request.creativity.scheduleId}@${request.creativity.scheduleVersion}`)}, level ${String(request.creativity.level)}/5`,
    `- Context policy: ${inlineCode(`${request.context.policyId}@${request.context.policyVersion}`)}`,
    `- Requested model: ${inlineCode(`${request.controls.model.providerId}/${request.controls.model.modelId}`)}`,
    `- Requested thinking: ${inlineCode(request.controls.thinkingLevel)}`,
  );
  if (request.controls.temperature !== undefined) {
    lines.push(`- Requested temperature: ${String(request.controls.temperature)}`);
  }
  if (request.controls.maxOutputTokens !== undefined) {
    lines.push(`- Requested max output tokens: ${String(request.controls.maxOutputTokens)}`);
  }
  lines.push(
    `- Tools: ${tools}`,
    "",
    "#### System prompt",
    "",
    fencedText(request.role.systemPrompt),
  );

  request.context.messages.forEach((message, index) => {
    lines.push(
      "",
      `#### Exact model input ${String(index + 1)} — ${message.role}`,
      "",
      fencedText(message.content),
    );
  });

  if (turn.reply) {
    lines.push(
      "",
      "#### Response",
      "",
      fencedText(turn.reply.text),
      "",
      `- Response model: ${inlineCode(`${turn.reply.model.providerId}/${turn.reply.model.modelId}`)}`,
      `- Duration: ${String(turn.reply.durationMs)} ms`,
      "",
      "#### Observed control report",
    );
    renderControl(lines, "Model", turn.reply.controls.model, formatModel);
    renderControl(lines, "Thinking level", turn.reply.controls.thinkingLevel, formatThinking);
    if (turn.reply.controls.temperature !== undefined) {
      renderControl(lines, "Temperature", turn.reply.controls.temperature, String);
    }
    if (turn.reply.controls.maxOutputTokens !== undefined) {
      renderControl(lines, "Max output tokens", turn.reply.controls.maxOutputTokens, String);
    }
  } else if (turn.failure) {
    lines.push(
      "",
      `**Turn failed — ${inlineCode(turn.failure.code)}**`,
      "",
      fencedText(turn.failure.message),
    );
  } else {
    lines.push("", "_No turn outcome was recorded._");
  }

  if (turn.attempts.length > 0) renderAttempts(lines, turn.attempts);
}

function renderAttempts(lines: string[], attempts: readonly AttemptTrace[]): void {
  lines.push(
    "",
    "#### Attempts",
    "",
    "| # | Status | HTTP | Input | Output | Cache read | Cache write | Reasoning | Explicitly reported | Evidence source |",
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  );
  for (const attempt of attempts) {
    lines.push([
      `| ${String(attempt.attempt)}`,
      attempt.status,
      displayNumber(attempt.httpStatus),
      displayNumber(attempt.usage.inputTokens),
      displayNumber(attempt.usage.outputTokens),
      displayNumber(attempt.usage.cacheReadTokens),
      displayNumber(attempt.usage.cacheWriteTokens),
      displayNumber(attempt.usage.reasoningTokens),
      escapeTableCell(attempt.usageEvidence.explicitlyReported.join(", ") || "none"),
      `${escapeTableCell(attempt.usageEvidence.source)} |`,
    ].join(" | "));
  }
}

function renderControl<T>(
  lines: string[],
  label: string,
  trace: ControlTrace<T>,
  format: (value: T) => string,
): void {
  lines.push(
    "",
    `##### ${label}`,
    "",
    `- Requested: ${inlineCode(format(trace.requested))}`,
    `- Forwarded: ${trace.forwarded === undefined ? "_not recorded_" : inlineCode(format(trace.forwarded))}`,
    `- Adjusted: ${trace.adjusted === undefined ? "_not recorded_" : inlineCode(format(trace.adjusted.value))}`,
  );
  if (trace.adjusted !== undefined) {
    lines.push("- Adjustment reason:", "", fencedText(trace.adjusted.reason));
  }
  lines.push(`- Unsupported: ${trace.unsupported === undefined ? "_not recorded_" : "recorded"}`);
  if (trace.unsupported !== undefined) {
    lines.push("- Unsupported reason:", "", fencedText(trace.unsupported.reason));
  }
  lines.push(
    `- Provider verified: ${trace.providerVerified === undefined ? "_not recorded_" : inlineCode(format(trace.providerVerified))}`,
  );
}

function formatModel(value: ModelIdentity): string {
  return `${value.providerId}/${value.modelId}`;
}

function formatThinking(value: ThinkingLevel): string {
  return value;
}

function requireTurn(turns: ReadonlyMap<string, TranscriptTurn>, turnId: string): TranscriptTurn {
  const turn = turns.get(turnId);
  if (!turn) throw new Error(`event references unknown transcript turn: ${turnId}`);
  return turn;
}

function fencedText(value: string): string {
  const runs = value.match(/`+/g) ?? [];
  const longest = runs.reduce((length, run) => Math.max(length, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${value}\n${fence}`;
}

function inlineCode(value: string): string {
  const singleLine = value.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
  const runs = singleLine.match(/`+/g) ?? [];
  const longest = runs.reduce((length, run) => Math.max(length, run.length), 0);
  const fence = "`".repeat(Math.max(1, longest + 1));
  return `${fence}${singleLine}${fence}`;
}

function escapeTableCell(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

function headingText(value: string): string {
  return value
    .replaceAll(/[\r\n]+/g, " ")
    .replaceAll(/([\\`*_{}[\]<>#+.!|])/g, "\\$1");
}

function displayNumber(value: number | undefined): string {
  return value === undefined ? "—" : String(value);
}

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
