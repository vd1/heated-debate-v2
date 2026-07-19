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
      classification:
        | "valid-uncommitted-event"
        | "invalid-event"
        | "invalid-json"
        | "invalid-utf8";
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
  const bytes = await readFile(path);
  const committed: Uint8Array[] = [];
  let recordStart = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    committed.push(bytes.subarray(recordStart, index));
    recordStart = index + 1;
  }
  const tail = recordStart === bytes.length
    ? { status: "clean" as const }
    : classifyTail(bytes.subarray(recordStart));

  const events = committed.map((record, index) => {
    const lineNumber = index + 1;
    let line: string;
    try {
      line = decodeUtf8(record);
    } catch {
      throw new Error(`invalid UTF-8 at JSONL line ${String(lineNumber)}`);
    }
    if (line.length === 0) throw new Error(`empty JSONL record at line ${String(lineNumber)}`);
    try {
      return parseCanonicalEvent(line);
    } catch (error) {
      throw new Error(
        `invalid JSONL record at line ${String(lineNumber)}: ${toError(error).message}`,
      );
    }
  });
  validateCanonicalSequence(events);
  return { events, tail };
}

function classifyTail(value: Uint8Array): JsonlTailStatus {
  const base = {
    status: "interrupted" as const,
    byteLength: value.byteLength,
  };
  let decoded: string;
  try {
    decoded = decodeUtf8(value);
  } catch {
    return { ...base, classification: "invalid-utf8" };
  }
  try {
    JSON.parse(decoded) as unknown;
  } catch {
    return { ...base, classification: "invalid-json" };
  }
  try {
    parseCanonicalEvent(decoded);
  } catch {
    return { ...base, classification: "invalid-event" };
  }
  return { ...base, classification: "valid-uncommitted-event" };
}

function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
