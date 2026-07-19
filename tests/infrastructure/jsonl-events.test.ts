import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { CanonicalEvent } from "../../src/domain/events";
import {
  JsonlEventWriter,
  readCanonicalJsonl,
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
      schemaVersion: 1,
      runId: "run-1",
      sequence: 0,
      type: "run.started",
      data: { debateId: "run-1", topic: "Test JSONL", roundCount: 1 },
    },
    {
      schemaVersion: 1,
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
    expect(await readCanonicalJsonl(path)).toEqual(fixture);
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

    expect(await readCanonicalJsonl(path)).toEqual([first]);
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

    expect(await readCanonicalJsonl(path)).toEqual([first]);
  });

  test("reads the complete prefix of an interrupted final write", async () => {
    const path = await temporaryPath();
    const writer = await JsonlEventWriter.create(path, { secrets: [] });
    const first = runEvents()[0];
    if (!first) throw new Error("bad fixture");

    await writer.append(first);
    await writer.flush();
    await appendFile(path, '{"schemaVersion":1,"runId":"run-1"');

    expect(await readCanonicalJsonl(path)).toEqual([first]);
    await writer.close();
  });

  test("close drains pending appends and prevents further writes", async () => {
    const path = await temporaryPath();
    const writer = await JsonlEventWriter.create(path, { secrets: [] });
    const fixture = runEvents();

    const pending = fixture.map((event) => writer.append(event));
    await writer.close();
    await Promise.all(pending);

    expect(await readCanonicalJsonl(path)).toEqual(fixture);
    const first = fixture[0];
    if (!first) throw new Error("bad fixture");
    expect(await rejectionMessage(writer.append(first))).toBe("JSONL writer is closed");
  });
});
