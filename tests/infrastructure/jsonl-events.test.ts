import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  serializeCanonicalEvent,
  type CanonicalEvent,
} from "../../src/domain/events";
import {
  JsonlEventWriter,
  readCanonicalJsonl,
  type JsonlEventWriterDependencies,
  type JsonlWritable,
} from "../../src/infrastructure/jsonl-events";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

function runEvents(): CanonicalEvent[] {
  return [
    {
      schemaVersion: 7,
      runId: "run-1",
      sequence: 0,
      type: "run.started",
      data: {
        debateId: "run-1",
        topic: "Test JSONL",
        roundCount: 1,
        controls: {
          policyId: "run-controls",
          policyVersion: "1",
          evidence: "recorded",
          turnTimeoutMs: null,
          wholeRunTimeoutMs: null,
          budget: null,
          monetary: null,
        },
        experiment: null,
      },
    },
    {
      schemaVersion: 7,
      runId: "run-1",
      sequence: 1,
      type: "run.completed",
      data: { turnCount: 0 },
    },
  ];
}

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "heated-debate-jsonl-"));
  temporaryDirectories.push(directory);
  return join(directory, "run.jsonl");
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected promise to reject");
}

describe("JsonlEventWriter", () => {
  test("appends concurrent calls in invocation order and flushes complete JSON lines", async () => {
    const path = await temporaryPath();
    const writer = await JsonlEventWriter.create(path, { secrets: [] });
    const fixture = runEvents();

    await Promise.all(fixture.map(async (event) => writer.append(event)));
    await writer.flush();

    const text = await readFile(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimEnd().split("\n")).toHaveLength(2);
    expect(await readCanonicalJsonl(path)).toEqual({
      events: fixture,
      tail: { status: "clean" },
    });
    await writer.close();
  });

  test("rejects a non-monotonic event without appending it", async () => {
    const path = await temporaryPath();
    const writer = await JsonlEventWriter.create(path, { secrets: [] });
    const fixture = runEvents();
    const first = fixture[0];
    const second = fixture[1];
    if (!first || !second) throw new Error("bad fixture");

    await writer.append(first);
    expect(await rejectionMessage(writer.append({ ...second, sequence: 2 }))).toBe(
      "expected sequence 1, received 2",
    );
    await writer.close();

    expect((await readCanonicalJsonl(path)).events).toEqual([first]);
  });

  test("rejects a changed run ID without appending it", async () => {
    const path = await temporaryPath();
    const writer = await JsonlEventWriter.create(path, { secrets: [] });
    const fixture = runEvents();
    const first = fixture[0];
    const second = fixture[1];
    if (!first || !second) throw new Error("bad fixture");

    await writer.append(first);
    expect(await rejectionMessage(writer.append({ ...second, runId: "other" }))).toBe(
      "event runId other does not match run-1",
    );
    await writer.close();

    expect((await readCanonicalJsonl(path)).events).toEqual([first]);
  });

  test("reads the complete prefix of an interrupted final write", async () => {
    const path = await temporaryPath();
    const writer = await JsonlEventWriter.create(path, { secrets: [] });
    const first = runEvents()[0];
    if (!first) throw new Error("bad fixture");

    await writer.append(first);
    await writer.flush();
    const partial = '{"schemaVersion":1,"runId":"run-1"';
    await appendFile(path, partial);

    expect(await readCanonicalJsonl(path)).toEqual({
      events: [first],
      tail: {
        status: "interrupted",
        classification: "invalid-json",
        byteLength: Buffer.byteLength(partial),
      },
    });
    await writer.close();
  });

  test("reports a valid canonical event without a newline as an uncommitted tail", async () => {
    const path = await temporaryPath();
    const writer = await JsonlEventWriter.create(path, { secrets: [] });
    const fixture = runEvents();
    const first = fixture[0];
    const second = fixture[1];
    if (!first || !second) throw new Error("bad fixture");
    await writer.append(first);
    await writer.close();

    const tail = serializeCanonicalEvent(second, { secrets: [] });
    await appendFile(path, tail);

    expect(await readCanonicalJsonl(path)).toEqual({
      events: [first],
      tail: {
        status: "interrupted",
        classification: "valid-uncommitted-event",
        byteLength: Buffer.byteLength(tail),
      },
    });
  });

  test("throws line-located errors for newline-committed middle corruption", async () => {
    const path = await temporaryPath();
    const writer = await JsonlEventWriter.create(path, { secrets: [] });
    const first = runEvents()[0];
    if (!first) throw new Error("bad fixture");
    await writer.append(first);
    await writer.close();
    await appendFile(path, "{not-json}\n");

    expect(await rejectionMessage(readCanonicalJsonl(path))).toContain(
      "invalid JSONL record at line 2",
    );
  });

  test("rejects invalid UTF-8 in a committed record with its line number", async () => {
    const path = await temporaryPath();
    const first = runEvents()[0];
    if (!first) throw new Error("bad fixture");
    const valid = Buffer.from(`${serializeCanonicalEvent(first, { secrets: [] })}\n`);
    const marker = Buffer.from("Test JSONL");
    const markerIndex = valid.indexOf(marker);
    if (markerIndex < 0) throw new Error("bad fixture");
    valid[markerIndex] = 0xc3;
    await writeFile(path, valid);

    expect(await rejectionMessage(readCanonicalJsonl(path))).toContain(
      "invalid UTF-8 at JSONL line 1",
    );
  });

  test("reports a tail truncated inside a UTF-8 code point using its byte length", async () => {
    const path = await temporaryPath();
    const writer = await JsonlEventWriter.create(path, { secrets: [] });
    const first = runEvents()[0];
    if (!first) throw new Error("bad fixture");
    await writer.append(first);
    await writer.close();
    await appendFile(path, Buffer.from([0xe2, 0x82]));

    expect(await readCanonicalJsonl(path)).toEqual({
      events: [first],
      tail: {
        status: "interrupted",
        classification: "invalid-utf8",
        byteLength: 2,
      },
    });
  });

  test("flush drains a pending append before sync and close is idempotent", async () => {
    const log: string[] = [];
    const gate = deferred();
    const writable: JsonlWritable = {
      append: async () => {
        log.push("append:start");
        await gate.promise;
        log.push("append:end");
      },
      sync: () => {
        log.push("sync");
        return Promise.resolve();
      },
      close: () => {
        log.push("close");
        return Promise.resolve();
      },
    };
    const writer = await JsonlEventWriter.create("unused", { secrets: [] }, dependencies(writable));
    const first = runEvents()[0];
    if (!first) throw new Error("bad fixture");

    const append = writer.append(first);
    const flush = writer.flush();
    await Promise.resolve();
    expect(log).toEqual(["append:start"]);
    gate.resolve();
    await Promise.all([append, flush]);
    expect(log).toEqual(["append:start", "append:end", "sync"]);

    const firstClose = writer.close();
    const secondClose = writer.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
    expect(log).toEqual(["append:start", "append:end", "sync", "sync", "close"]);
  });

  test("poisons the writer after a partial append failure but still closes cleanly", async () => {
    const path = await temporaryPath();
    const fixture = runEvents();
    const first = fixture[0];
    const second = fixture[1];
    if (!first || !second) throw new Error("bad fixture");
    const partial = '{"schemaVers';
    let writes = 0;
    const log: string[] = [];
    const writable: JsonlWritable = {
      append: async (data) => {
        writes += 1;
        if (writes === 1) {
          await appendFile(path, data);
          return;
        }
        await appendFile(path, partial);
        throw new Error("injected disk failure");
      },
      sync: () => {
        log.push("sync");
        return Promise.resolve();
      },
      close: () => {
        log.push("close");
        return Promise.resolve();
      },
    };
    const writer = await JsonlEventWriter.create(path, { secrets: [] }, dependencies(writable));

    await writer.append(first);
    expect(await rejectionMessage(writer.append(second))).toBe("injected disk failure");
    expect(await rejectionMessage(writer.append(second))).toBe(
      "JSONL writer is poisoned by a prior append failure: injected disk failure",
    );
    await writer.close();

    expect(writes).toBe(2);
    expect(log).toEqual(["sync", "close"]);
    expect(await readCanonicalJsonl(path)).toEqual({
      events: [first],
      tail: {
        status: "interrupted",
        classification: "invalid-json",
        byteLength: Buffer.byteLength(partial),
      },
    });
  });

  test("close drains pending appends and prevents further writes", async () => {
    const path = await temporaryPath();
    const writer = await JsonlEventWriter.create(path, { secrets: [] });
    const fixture = runEvents();

    const pending = fixture.map((event) => writer.append(event));
    await writer.close();
    await Promise.all(pending);

    expect((await readCanonicalJsonl(path)).events).toEqual(fixture);
    const first = fixture[0];
    if (!first) throw new Error("bad fixture");
    expect(await rejectionMessage(writer.append(first))).toBe("JSONL writer is closed");
  });
});

function dependencies(writable: JsonlWritable): JsonlEventWriterDependencies {
  return {
    openExclusiveAppend: () => Promise.resolve(writable),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolvePromise?.();
    },
  };
}
