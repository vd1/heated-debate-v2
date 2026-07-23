import { parseEngineOutput, type EngineInput, type EngineOutput } from "../domain/engine-schema";

export interface EngineTrialOptions {
  /** Command line for the engine executable, e.g. ["bun", "src/cli/engine.ts", ...]. */
  command: readonly string[];
  input: EngineInput;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface EngineTrialResult {
  output: EngineOutput;
  exitCode: number;
  stderr: string;
}

/**
 * Spawns one engine invocation across the F-SCHEMA process boundary: the input
 * is written to stdin, stdout must contain exactly one contract line, stderr is
 * captured as diagnostics, and malformed or missing output is a typed error.
 */
export async function runEngineTrial(options: EngineTrialOptions): Promise<EngineTrialResult> {
  const [executable, ...args] = options.command;
  if (executable === undefined) throw new Error("engine command must not be empty");
  const proc = Bun.spawn({
    cmd: [executable, ...args],
    stdin: new TextEncoder().encode(JSON.stringify(options.input)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });
  const timeoutMs = options.timeoutMs ?? 300_000;
  const timer = setTimeout(() => {
    proc.kill("SIGTERM");
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    let output: EngineOutput;
    try {
      output = parseEngineOutput(stdout);
    } catch (error) {
      throw new Error(
        `engine emitted no valid contract output (exit ${String(exitCode)}): `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
    return { output, exitCode, stderr };
  } finally {
    clearTimeout(timer);
  }
}
