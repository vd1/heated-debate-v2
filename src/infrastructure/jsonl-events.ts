import { open, readFile } from "node:fs/promises";

import {
  parseCanonicalEvent,
  serializeCanonicalEvent,
  validateCanonicalSequence,
  type CanonicalEvent,
} from "../domain/events";

export interface JsonlEventWriterOptions {
  secrets: readonly string[];
}

export interface JsonlWritable {
  append(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface JsonlEventWriterDependencies {
  openExclusiveAppend(path: string): Promise<JsonlWritable>;
}

export type JsonlTailStatus =
  | { status: "clean" }
  | {
      status: "interrupted";
      classification: "valid-uncommitted-event" | "invalid-event" | "invalid-json";
      byteLength: number;
    };

export interface CanonicalJsonlReadResult {
  events: CanonicalEvent[];
  tail: JsonlTailStatus;
}

type WriterState = "open" | "closing" | "closed";

const NODE_DEPENDENCIES: JsonlEventWriterDependencies = {
  openExclusiveAppend: async (path) => {
    const handle = await open(path, "ax");
    return {
      append: async (data) => {
        await handle.appendFile(data, "utf8");
      },
      sync: async () => {
        await handle.sync();
      },
      close: async () => {
        await handle.close();
      },
    };
  },
};

export class JsonlEventWriter {
  private state: WriterState = "open";
  private queue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private appendFailure: Error | undefined;
  private runId: string | undefined;
  private nextSequence = 0;

  private constructor(
    private readonly handle: JsonlWritable,
    private readonly secrets: readonly string[],
  ) {}

  static async create(
    path: string,
    options: JsonlEventWriterOptions,
    dependencies: JsonlEventWriterDependencies = NODE_DEPENDENCIES,
  ): Promise<JsonlEventWriter> {
    const handle = await dependencies.openExclusiveAppend(path);
    return new JsonlEventWriter(handle, [...options.secrets]);
  }

  append(event: CanonicalEvent): Promise<void> {
    if (this.state !== "open") return Promise.reject(new Error("JSONL writer is closed"));
    if (this.appendFailure) return Promise.reject(this.poisonedError());

    let serialized: string;
    let snapshot: CanonicalEvent;
    try {
      serialized = serializeCanonicalEvent(event, { secrets: this.secrets });
      snapshot = parseCanonicalEvent(serialized);
    } catch (error) {
      return Promise.reject(toError(error));
    }

    return this.enqueue(async () => {
      if (this.appendFailure) throw this.poisonedError();
      if (snapshot.sequence !== this.nextSequence) {
        throw new Error(
          `expected sequence ${String(this.nextSequence)}, received ${String(snapshot.sequence)}`,
        );
      }
      if (this.runId !== undefined && snapshot.runId !== this.runId) {
        throw new Error(`event runId ${snapshot.runId} does not match ${this.runId}`);
      }

      try {
        await this.handle.append(`${serialized}\n`);
      } catch (error) {
        this.appendFailure = toError(error);
        throw this.appendFailure;
      }
      this.runId ??= snapshot.runId;
      this.nextSequence += 1;
    });
  }

  flush(): Promise<void> {
    if (this.state !== "open") return Promise.reject(new Error("JSONL writer is closed"));
    return this.enqueue(async () => {
      if (this.appendFailure) throw this.poisonedError();
      await this.handle.sync();
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.state = "closing";
    this.closePromise = this.enqueue(async () => {
      try {
        await this.handle.sync();
      } finally {
        await this.handle.close();
        this.state = "closed";
      }
    });
    return this.closePromise;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.queue.then(operation);
    this.queue = queued.catch(() => undefined);
    return queued;
  }

  private poisonedError(): Error {
    return new Error(
      `JSONL writer is poisoned by a prior append failure: ${this.appendFailure?.message ?? "unknown failure"}`,
    );
  }
}

export async function readCanonicalJsonl(path: string): Promise<CanonicalJsonlReadResult> {
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");
  let tail: JsonlTailStatus = { status: "clean" };

  if (text.length === 0 || text.endsWith("\n")) {
    lines.pop();
  } else {
    const uncommitted = lines.pop() ?? "";
    tail = classifyTail(uncommitted);
  }

  const events = lines.map((line, index) => {
    if (line.length === 0) throw new Error(`empty JSONL record at line ${String(index + 1)}`);
    try {
      return parseCanonicalEvent(line);
    } catch (error) {
      throw new Error(
        `invalid JSONL record at line ${String(index + 1)}: ${toError(error).message}`,
      );
    }
  });
  validateCanonicalSequence(events);
  return { events, tail };
}

function classifyTail(value: string): JsonlTailStatus {
  const base = {
    status: "interrupted" as const,
    byteLength: Buffer.byteLength(value),
  };
  try {
    JSON.parse(value) as unknown;
  } catch {
    return { ...base, classification: "invalid-json" };
  }
  try {
    parseCanonicalEvent(value);
  } catch {
    return { ...base, classification: "invalid-event" };
  }
  return { ...base, classification: "valid-uncommitted-event" };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
