import type { ModelIdentity } from "../../src/domain/agent";

export const LIVE_ENABLED = process.env.HEATED_DEBATE_LIVE === "1";
export const LIVE_TURN_TIMEOUT_MS = 60_000;
export const LIVE_DEBATE_TIMEOUT_MS = 180_000;
// Requested for auditability. The default Codex subscription route reports
// this provider control as unsupported; timeout is the live smoke's hard bound.
export const LIVE_MAX_OUTPUT_TOKENS = 4_096;

export const LIVE_MODEL: ModelIdentity = Object.freeze({
  providerId: process.env.HEATED_DEBATE_PROVIDER ?? "openai-codex",
  modelId: process.env.HEATED_DEBATE_MODEL ?? "gpt-5.6-sol",
});

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
