import { describe, expect, test } from "bun:test";

import {
  PROPOSER_ROLE,
  REVIEWER_ROLE,
  defineRole,
} from "../../src/domain/roles";

const PROPOSER_PROMPT = "You are the proposing side in a structured debate. Argue your position with clarity and conviction. Be concise. Output bulleted arguments, tradeoffs, and concrete proposals.";
const REVIEWER_PROMPT = "You are the opposing side in a structured debate. Challenge proposals, find flaws, and push for better alternatives. Be concise. Output counterarguments, risks, and improvements.";

describe("versioned debate roles", () => {
  test("locks the proposer role identity and exact v1 prompt", () => {
    expect(PROPOSER_ROLE).toEqual({
      id: "proposer",
      version: "1",
      systemPrompt: PROPOSER_PROMPT,
    });
    expect(Object.isFrozen(PROPOSER_ROLE)).toBe(true);
  });

  test("locks the reviewer role identity and exact v1 prompt", () => {
    expect(REVIEWER_ROLE).toEqual({
      id: "reviewer",
      version: "1",
      systemPrompt: REVIEWER_PROMPT,
    });
    expect(Object.isFrozen(REVIEWER_ROLE)).toBe(true);
  });

  test("defensively snapshots custom role input", () => {
    const input = {
      id: "skeptic",
      version: "2",
      systemPrompt: "Find the strongest counterexample.",
    };

    const role = defineRole(input);
    input.systemPrompt = "Mutated later";

    expect(role.systemPrompt).toBe("Find the strongest counterexample.");
    expect(Object.isFrozen(role)).toBe(true);
  });
});
