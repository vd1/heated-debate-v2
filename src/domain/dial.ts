export type CreativityLevel = 1 | 2 | 3 | 4 | 5;

export interface CreativitySelection {
  readonly scheduleId: "linear-cooling";
  readonly scheduleVersion: "1";
  readonly level: CreativityLevel;
  readonly instruction: string;
}

const INSTRUCTIONS: Readonly<Record<CreativityLevel, string>> = Object.freeze({
  5: "Explore radical alternatives. Question the premise. Propose unconventional approaches even if risky.",
  4: "Suggest improvements and alternatives. Challenge assumptions. Consider non-obvious solutions.",
  3: "Mix new ideas with refinement. Address open questions. Weigh tradeoffs.",
  2: "Refine the current approach. Fix issues. Tighten the specification. Avoid introducing new directions.",
  1: "Converge and finalize the architectural decisions into a clear bulleted plan.",
});

export function selectCreativity(roundIndex: number, totalRounds: number): CreativitySelection {
  if (!Number.isInteger(totalRounds) || totalRounds <= 0) {
    throw new Error("totalRounds must be a positive integer");
  }
  if (!Number.isInteger(roundIndex) || roundIndex < 0 || roundIndex >= totalRounds) {
    throw new Error("roundIndex must be an integer in [0, totalRounds)");
  }

  const level = totalRounds === 1
    ? 5
    : Math.round(5 - (4 * roundIndex) / (totalRounds - 1)) as CreativityLevel;
  return Object.freeze({
    scheduleId: "linear-cooling",
    scheduleVersion: "1",
    level,
    instruction: INSTRUCTIONS[level],
  });
}
