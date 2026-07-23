import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DebateEventSink } from "../domain/debate";
import { serializeCanonicalEvent, type CanonicalEvent } from "../domain/events";
import { artifactPathForRun } from "../domain/executor";
import type { RunSpecification } from "../domain/matrix";
import { readCanonicalJsonl } from "./jsonl-events";
import type { StudyArtifactHandle, StudyArtifactStore } from "./study-runner";

export interface FilesystemStoreOptions {
  /** Leases older than this may be reclaimed by another worker. */
  staleLeaseMs?: number;
  /**
   * Locator override for tests. The locator only names a path; artifact
   * acceptance always rests on the stored full identity, so an overlapping
   * locator fails closed at validation instead of resuming a foreign run.
   */
  pathForRun?: (run: RunSpecification) => string;
  secrets?: readonly string[];
}

/** Bounded, filesystem-safe lease name; the digest disambiguates truncation. */
function leaseName(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9_.,=-]/g, "_").slice(0, 80);
  const digest = createHash("sha256").update(runId).digest("hex").slice(0, 16);
  return `${safe}-${digest}.lease`;
}

/**
 * The v2 study artifact store: deterministic locators, per-process leases,
 * temporary output with fsync before an atomic rename, and read-back through
 * the canonical JSONL parser.
 *
 * SCOPE: this store is SINGLE-WORKER. Stale-lease recovery only unblocks a
 * crashed local process; it is not a distributed coordination protocol, and
 * concurrent workers on shared storage are not supported.
 */
export class FilesystemStudyArtifactStore implements StudyArtifactStore {
  private readonly staleLeaseMs: number;
  private readonly pathFor: (run: RunSpecification) => string;
  private readonly secrets: readonly string[];

  constructor(
    private readonly root: string,
    options: FilesystemStoreOptions = {},
  ) {
    this.staleLeaseMs = options.staleLeaseMs ?? 15 * 60 * 1000;
    const override = options.pathForRun;
    this.pathFor = override === undefined
      ? (run): string => artifactPathForRun(run)
      : (run): string => override(run);
    this.secrets = options.secrets ?? [];
  }

  leasePathFor(runId: string): string {
    return join(this.root, ".leases", leaseName(runId));
  }

  async claim(runId: string): Promise<boolean> {
    const leasePath = this.leasePathFor(runId);
    await mkdir(dirname(leasePath), { recursive: true });
    const payload = `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })}\n`;
    try {
      await writeFile(leasePath, payload, { flag: "wx" });
      return true;
    } catch {
      // Held by another worker; reclaim only a provably stale lease.
      let age: number;
      try {
        age = Date.now() - (await stat(leasePath)).mtimeMs;
      } catch {
        return false;
      }
      if (age <= this.staleLeaseMs) return false;
      await rm(leasePath, { force: true });
      try {
        await writeFile(leasePath, payload, { flag: "wx" });
        return true;
      } catch {
        return false;
      }
    }
  }

  async release(runId: string): Promise<void> {
    await rm(this.leasePathFor(runId), { force: true });
  }

  async read(run: RunSpecification): Promise<readonly CanonicalEvent[] | null> {
    const path = join(this.root, this.pathFor(run));
    try {
      await stat(path);
    } catch {
      return null;
    }
    const { events } = await readCanonicalJsonl(path);
    return events;
  }

  async openSink(run: RunSpecification): Promise<StudyArtifactHandle> {
    const finalPath = join(this.root, this.pathFor(run));
    await mkdir(dirname(finalPath), { recursive: true });
    const temporary = `${finalPath}.tmp-${String(process.pid)}`;
    const buffered: CanonicalEvent[] = [];
    const secrets = this.secrets;
    const write = async (): Promise<void> => {
      const handle = await open(temporary, "w");
      try {
        await handle.writeFile(
          buffered.map((event) => serializeCanonicalEvent(event, { secrets: [...secrets] }))
            .join("\n") + "\n",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    const sink: DebateEventSink = {
      append: (event) => {
        buffered.push(structuredClone(event));
        return Promise.resolve();
      },
      flush: () => write(),
    };
    return {
      sink,
      publish: async () => {
        await write();
        await rename(temporary, finalPath);
      },
      discard: async () => {
        await rm(temporary, { force: true });
      },
    };
  }
}
