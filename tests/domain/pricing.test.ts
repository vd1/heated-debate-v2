import { describe, expect, test } from "bun:test";

import {
  calculateUsageCost,
  definePricingSnapshot,
  pricingSnapshotHash,
  type PricingSnapshot,
} from "../../src/domain/pricing";

function snapshot(overrides: Partial<PricingSnapshot> = {}): PricingSnapshot {
  return {
    snapshotId: "pricing-2026-07",
    snapshotVersion: "1",
    currency: "USD",
    effectiveDate: "2026-07-01",
    provenance: "provider public price pages, retrieved 2026-07-01",
    entries: [
      {
        model: { providerId: "openai-codex", modelId: "gpt-5.6-sol" },
        inputRatePerMillionTokens: 1.25,
        outputRatePerMillionTokens: 10,
        cacheReadRatePerMillionTokens: 0.125,
        cacheWriteRatePerMillionTokens: 1.5,
        reasoningBilling: { mode: "included-in-output" },
      },
      {
        model: { providerId: "local", modelId: "gemma-3-27b" },
        inputRatePerMillionTokens: 0,
        outputRatePerMillionTokens: 0,
        cacheReadRatePerMillionTokens: 0,
        cacheWriteRatePerMillionTokens: 0,
        reasoningBilling: { mode: "unbilled" },
      },
    ],
    ...overrides,
  };
}

describe("pricing snapshot", () => {
  test("defines an immutable validated snapshot with a zero-cost local entry", () => {
    const input = snapshot();
    const defined = definePricingSnapshot(input);

    expect(defined).toEqual(snapshot());
    expect(Object.isFrozen(defined)).toBe(true);
    expect(Object.isFrozen(defined.entries)).toBe(true);
    expect(Object.isFrozen(defined.entries[0])).toBe(true);
    const local = defined.entries.find((entry) => entry.model.providerId === "local");
    expect(local?.outputRatePerMillionTokens).toBe(0);
  });

  test("rejects duplicate models, negative rates, and missing identity fields", () => {
    expect(() => definePricingSnapshot(snapshot({
      entries: [...snapshot().entries, ...snapshot().entries.slice(0, 1)],
    }))).toThrow("duplicate pricing entry for openai-codex/gpt-5.6-sol");

    const negative = snapshot();
    const [first] = negative.entries;
    if (!first) throw new Error("bad fixture");
    expect(() => definePricingSnapshot({
      ...negative,
      entries: [{
        ...first,
        outputRatePerMillionTokens: -1,
      }],
    })).toThrow("outputRatePerMillionTokens must be a finite non-negative number");

    expect(() => definePricingSnapshot(snapshot({ snapshotId: " " })).snapshotId).toThrow(
      "snapshotId must be non-empty",
    );
    expect(() => definePricingSnapshot(snapshot({ effectiveDate: "July 1" }))).toThrow(
      "effectiveDate must be an ISO date (YYYY-MM-DD)",
    );
    expect(() => definePricingSnapshot(snapshot({ currency: "usd" }))).toThrow(
      "currency must be an uppercase ISO 4217 code",
    );
  });

  test("rejects a separate reasoning rate that is not finite and non-negative", () => {
    const base = snapshot();
    const [first] = base.entries;
    if (!first) throw new Error("bad fixture");
    expect(() => definePricingSnapshot({
      ...base,
      entries: [{
        ...first,
        reasoningBilling: { mode: "separate-rate", ratePerMillionTokens: -2 },
      }],
    })).toThrow("reasoning ratePerMillionTokens must be a finite non-negative number");
  });

  test("hashes canonically regardless of key insertion order", () => {
    const base = snapshot();
    const reordered: PricingSnapshot = {
      entries: base.entries.map((entry) => ({
        reasoningBilling: entry.reasoningBilling,
        cacheWriteRatePerMillionTokens: entry.cacheWriteRatePerMillionTokens,
        cacheReadRatePerMillionTokens: entry.cacheReadRatePerMillionTokens,
        outputRatePerMillionTokens: entry.outputRatePerMillionTokens,
        inputRatePerMillionTokens: entry.inputRatePerMillionTokens,
        model: { modelId: entry.model.modelId, providerId: entry.model.providerId },
      })),
      provenance: base.provenance,
      effectiveDate: base.effectiveDate,
      currency: base.currency,
      snapshotVersion: base.snapshotVersion,
      snapshotId: base.snapshotId,
    };

    const hash = pricingSnapshotHash(definePricingSnapshot(base));

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(pricingSnapshotHash(definePricingSnapshot(reordered))).toBe(hash);
    expect(pricingSnapshotHash(definePricingSnapshot(snapshot({
      snapshotVersion: "2",
    })))).not.toBe(hash);
  });
});

describe("usage-to-cost calculation", () => {
  const SNAPSHOT = definePricingSnapshot(snapshot());
  const CODEX = { providerId: "openai-codex", modelId: "gpt-5.6-sol" };
  const LOCAL = { providerId: "local", modelId: "gemma-3-27b" };

  function withReasoning(rule: PricingSnapshot["entries"][number]["reasoningBilling"]): PricingSnapshot {
    const base = snapshot();
    const [first, second] = base.entries;
    if (!first || !second) throw new Error("bad fixture");
    return definePricingSnapshot({
      ...base,
      entries: [{ ...first, reasoningBilling: rule }, second],
    });
  }

  test("prices full usage with reasoning included in output without double charging", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 200_000,
      cacheWriteTokens: 40_000,
      reasoningTokens: 50_000,
    };

    expect(calculateUsageCost(SNAPSHOT, CODEX, usage)).toEqual({
      status: "known",
      amount: 2.335,
      amountScaled: 2_335_000_000_000n,
      currency: "USD",
    });
  });

  test("subtracts unbilled reasoning tokens from billable output", () => {
    const priced = withReasoning({ mode: "unbilled" });

    expect(calculateUsageCost(priced, CODEX, {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 40_000,
    })).toEqual({ status: "known", amount: 1.85, amountScaled: 1_850_000_000_000n, currency: "USD" });
  });

  test("bills separate-rate reasoning as disjoint from output", () => {
    const priced = withReasoning({ mode: "separate-rate", ratePerMillionTokens: 2 });

    expect(calculateUsageCost(priced, CODEX, {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 40_000,
    })).toEqual({ status: "known", amount: 2.33, amountScaled: 2_330_000_000_000n, currency: "USD" });
  });

  test("returns unknown when reasoning affects price but is absent", () => {
    for (const rule of [
      { mode: "unbilled" as const },
      { mode: "separate-rate" as const, ratePerMillionTokens: 2 },
    ]) {
      expect(calculateUsageCost(withReasoning(rule), CODEX, {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })).toEqual({ status: "unknown", missing: ["reasoningTokens"] });
    }
  });

  test("returns unknown listing every absent priced token kind", () => {
    expect(calculateUsageCost(SNAPSHOT, CODEX, { outputTokens: 10 })).toEqual({
      status: "unknown",
      missing: ["inputTokens", "cacheReadTokens", "cacheWriteTokens"],
    });
  });

  test("prices absent kinds as zero only when their rate is zero", () => {
    expect(calculateUsageCost(SNAPSHOT, LOCAL, {})).toEqual({
      status: "known",
      amount: 0,
      amountScaled: 0n,
      currency: "USD",
    });
  });

  test("rejects reasoning tokens exceeding output tokens outside separate-rate", () => {
    expect(() => calculateUsageCost(withReasoning({ mode: "unbilled" }), CODEX, {
      inputTokens: 0,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 20,
    })).toThrow("reasoningTokens cannot exceed outputTokens");
  });

  test("rejects a model without a pricing entry", () => {
    expect(() => calculateUsageCost(SNAPSHOT, { providerId: "x", modelId: "y" }, {})).toThrow(
      "no pricing entry for x/y",
    );
  });
});

describe("exact monetary arithmetic and stricter validation", () => {
  test("rejects rates and dates that cannot be represented exactly", () => {
    const base = snapshot();
    const [first, second] = base.entries;
    if (!first || !second) throw new Error("bad fixture");
    expect(() => definePricingSnapshot({
      ...base,
      entries: [{ ...first, inputRatePerMillionTokens: 0.1234567 }, second],
    })).toThrow("inputRatePerMillionTokens must have at most 6 decimal places");
    for (const date of ["2026-02-31", "2026-99-99", "2025-02-29"]) {
      expect(() => definePricingSnapshot(snapshot({ effectiveDate: date }))).toThrow(
        "effectiveDate must be a real calendar date",
      );
    }
    expect(definePricingSnapshot(snapshot({ effectiveDate: "2024-02-29" })).effectiveDate)
      .toBe("2024-02-29");
  });

  test("returns an exact scaled amount alongside the display amount", () => {
    const cost = calculateUsageCost(definePricingSnapshot(snapshot()), {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
    }, {
      inputTokens: 100_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    if (cost.status !== "known") throw new Error("expected known cost");
    // 100k tokens at 1.25 per million: 0.125 currency units, exact in 1e-12 scale.
    expect(cost.amountScaled).toBe(125_000_000_000n);
    expect(cost.amount).toBe(0.125);
  });

  test("rejects reasoning exceeding output under included-in-output billing", () => {
    expect(() => calculateUsageCost(definePricingSnapshot(snapshot()), {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
    }, {
      inputTokens: 0,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 20,
    })).toThrow("reasoningTokens cannot exceed outputTokens");
  });
});
