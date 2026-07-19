import { describe, expect, test } from "bun:test";

import { selectLastExchangeContext } from "../../src/domain/context";

describe("last-exchange context policy", () => {
  test("selects the first proposer input", () => {
    expect(selectLastExchangeContext({
      role: "proposer",
      topic: "Design a queue.",
    })).toEqual({
      policyId: "last-exchange",
      policyVersion: "1",
      messages: [
        { role: "user", content: "Topic:\nDesign a queue." },
      ],
    });
  });

  test("selects topic, own proposal, and counterparty review for a later proposer turn", () => {
    const decision = selectLastExchangeContext({
      role: "proposer",
      topic: "Design a queue.",
      ownPriorResponse: "Use bounded FIFO.",
      counterpartyResponse: "Backpressure is underspecified.",
    });

    expect(decision.messages).toEqual([
      {
        role: "user",
        content: [
          "Topic:",
          "Design a queue.",
          "",
          "Previous proposal:",
          "Use bounded FIFO.",
          "",
          "Review:",
          "Backpressure is underspecified.",
        ].join("\n"),
      },
    ]);
  });

  test("selects all declared reviewer inputs in stable order", () => {
    const decision = selectLastExchangeContext({
      role: "reviewer",
      topic: "Design a queue.",
      ownPriorResponse: "Specify overload behavior.",
      counterpartyResponse: "Use bounded FIFO.",
      currentProposal: "Drop oldest jobs at the bound.",
    });

    expect(decision.messages).toEqual([
      {
        role: "user",
        content: [
          "Topic:",
          "Design a queue.",
          "",
          "Previous review:",
          "Specify overload behavior.",
          "",
          "Previous proposal:",
          "Use bounded FIFO.",
          "",
          "Current proposal:",
          "Drop oldest jobs at the bound.",
        ].join("\n"),
      },
    ]);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.messages)).toBe(true);
    expect(Object.isFrozen(decision.messages[0])).toBe(true);
  });

  test("selects the first reviewer input without inventing prior responses", () => {
    expect(selectLastExchangeContext({
      role: "reviewer",
      topic: "Design a queue.",
      currentProposal: "Use bounded FIFO.",
    }).messages).toEqual([
      {
        role: "user",
        content: "Topic:\nDesign a queue.\n\nCurrent proposal:\nUse bounded FIFO.",
      },
    ]);
  });
});
