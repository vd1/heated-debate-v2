import { open, readFile, type FileHandle } from "node:fs/promises";

import {
  parseCanonicalEvent,
  serializeCanonicalEvent,
  validateCanonicalSequence,
  type CanonicalEvent,
} from "../domain/events";

export interface JsonlEventWriterOptions {
  secrets: readonly string[];
}

type WriterState = "open" | "closing" | "closed";

export class JsonlEventWriter {
  private state: WriterState = "open";
  private queue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private runId: string | undefined;
  private nextSequence = 0;

  private constructor(
    private readonly handle: FileHandle,
    private readonly secrets: readonly string[],
  ) {}

  static async create(path: string, options: JsonlEventWriterOptions): Promise<JsonlEventWriter> {
    const handle = await open(path, "ax");
    return new JsonlEventWriter(handle, [...options.secrets]);
  }

  append(event: CanonicalEvent): Promise<void> {
    if (this.state !== "open") return Promise.reject(new Error("JSONL writer is closed"));

    let serialized: string;
    let snapshot: CanonicalEvent;
    try {
      serialized = serializeCanonicalEvent(event, { secrets: this.secrets });
      snapshot = parseCanonicalEvent(serialized);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }

    return this.enqueue(async () => {
      if (snapshot.sequence !== this.nextSequence) {
        throw new Error(
          `expected sequence ${String(this.nextSequence)}, received ${String(snapshot.sequence)}`,
        );
      }
      if (this.runId !== undefined && snapshot.runId !== this.runId) {
        throw new Error(`event runId ${snapshot.runId} does not match ${this.runId}`);
      }

      await this.handle.appendFile(`${serialized}\n`, "utf8");
      this.runId ??= snapshot.runId;
      this.nextSequence += 1;
    });
  }

  flush(): Promise<void> {
    if (this.state !== "open") return Promise.reject(new Error("JSONL writer is closed"));
    return this.enqueue(async () => {
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
}

export async function readCanonicalJsonl(path: string): Promise<CanonicalEvent[]> {
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");
  if (text.endsWith("\n")) {
    lines.pop();
  } else {
    // A non-newline-terminated tail may be a process-interrupted append. Only
    // newline-committed records are part of the readable canonical prefix.
    lines.pop();
  }

  const events = lines.map((line, index) => {
    if (line.length === 0) throw new Error(`empty JSONL record at line ${String(index + 1)}`);
    try {
      return parseCanonicalEvent(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid JSONL record at line ${String(index + 1)}: ${message}`);
    }
  });
  validateCanonicalSequence(events);
  return events;
}
