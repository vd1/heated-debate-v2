import { describe, expect, test } from "bun:test";

import {
  selectCreativity,
  type CreativityLevel,
} from "../../src/domain/dial";

const EXPECTED_INSTRUCTIONS: Record<CreativityLevel, string> = {
  5: "Explore radical alternatives. Question the premise. Propose unconventional approaches even if risky.",
  4: "Suggest improvements and alternatives. Challenge assumptions. Consider non-obvious solutions.",
  3: "Mix new ideas with refinement. Address open questions. Weigh tradeoffs.",
  2: "Refine the current approach. Fix issues. Tighten the specification. Avoid introducing new directions.",
  1: "Converge and finalize the architectural decisions into a clear bulleted plan.",
};

describe("linear creativity schedule v1", () => {
  test.each([
    [1, [5]],
    [2, [5, 1]],
    [3, [5, 3, 1]],
    [5, [5, 4, 3, 2, 1]],
  ] as const)("locks the %i-round schedule", (totalRounds, expected) => {
    const levels = Array.from(
      { length: totalRounds },
      (_, roundIndex) => selectCreativity(roundIndex, totalRounds).level,
    );

    expect(levels).toEqual([...expected]);
  });

  test("records level, schedule identity, and exact instruction separately", () => {
    const selection = selectCreativity(1, 3);

    expect(selection).toEqual({
      scheduleId: "linear-cooling",
      scheduleVersion: "1",
      level: 3,
      instruction: EXPECTED_INSTRUCTIONS[3],
    });
    expect(Object.isFrozen(selection)).toBe(true);
  });

  test.each([1, 2, 3, 4, 5] as const)("locks the level-%i instruction", (level) => {
    const selection = selectCreativity(5 - level, 5);
    expect(selection.level).toBe(level);
    expect(selection.instruction).toBe(EXPECTED_INSTRUCTIONS[level]);
  });

  test("rejects invalid round counts and indexes", () => {
    expect(() => selectCreativity(0, 0)).toThrow("totalRounds must be a positive integer");
    expect(() => selectCreativity(0, 1.5)).toThrow("totalRounds must be a positive integer");
    expect(() => selectCreativity(-1, 3)).toThrow("roundIndex must be an integer in [0, totalRounds)");
    expect(() => selectCreativity(3, 3)).toThrow("roundIndex must be an integer in [0, totalRounds)");
    expect(() => selectCreativity(0.5, 3)).toThrow("roundIndex must be an integer in [0, totalRounds)");
  });
});
