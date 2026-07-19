export interface RoleDefinition {
  readonly id: string;
  readonly version: string;
  readonly systemPrompt: string;
}

const PROPOSER_SYSTEM_PROMPT = "You are the proposing side in a structured debate. Argue your position with clarity and conviction. Be concise. Output bulleted arguments, tradeoffs, and concrete proposals.";
const REVIEWER_SYSTEM_PROMPT = "You are the opposing side in a structured debate. Challenge proposals, find flaws, and push for better alternatives. Be concise. Output counterarguments, risks, and improvements.";

export function defineRole(role: RoleDefinition): RoleDefinition {
  return Object.freeze({
    id: role.id,
    version: role.version,
    systemPrompt: role.systemPrompt,
  });
}

export const PROPOSER_ROLE = defineRole({
  id: "proposer",
  version: "1",
  systemPrompt: PROPOSER_SYSTEM_PROMPT,
});

export const REVIEWER_ROLE = defineRole({
  id: "reviewer",
  version: "1",
  systemPrompt: REVIEWER_SYSTEM_PROMPT,
});
