import type { CreativitySelection } from "./dial";

export interface ModelInputMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ContextDecision {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly messages: readonly ModelInputMessage[];
}

interface CommonContextInput {
  topic: string;
  creativity?: CreativitySelection;
  ownPriorResponse?: string;
  counterpartyResponse?: string;
}

export interface ProposerContextInput extends CommonContextInput {
  role: "proposer";
}

export interface ReviewerContextInput extends CommonContextInput {
  role: "reviewer";
  currentProposal: string;
}

export type LastExchangeContextInput = ProposerContextInput | ReviewerContextInput;

export function selectLastExchangeContext(input: LastExchangeContextInput): ContextDecision {
  const sections: string[] = [section("Topic", input.topic)];

  if (input.role === "proposer") {
    if (input.ownPriorResponse !== undefined) {
      sections.push(section("Previous proposal", input.ownPriorResponse));
    }
    if (input.counterpartyResponse !== undefined) {
      sections.push(section("Review", input.counterpartyResponse));
    }
  } else {
    if (input.ownPriorResponse !== undefined) {
      sections.push(section("Previous review", input.ownPriorResponse));
    }
    if (input.counterpartyResponse !== undefined) {
      sections.push(section("Previous proposal", input.counterpartyResponse));
    }
    sections.push(section("Current proposal", input.currentProposal));
  }

  const selectedContent = sections.join("\n\n");
  const content = input.creativity === undefined
    ? selectedContent
    : `[Creativity: ${String(input.creativity.level)}/5] ${input.creativity.instruction}\n\n${selectedContent}`;
  const message = Object.freeze({
    role: "user" as const,
    content,
  });
  return Object.freeze({
    policyId: "last-exchange" as const,
    policyVersion: "1" as const,
    messages: Object.freeze([message]),
  });
}

function section(label: string, content: string): string {
  return `${label}:\n${content}`;
}
