import { createHash } from "node:crypto";

import type { ModelIdentity, NormalizedUsage, UsageKind } from "./agent";

export type ReasoningBillingRule =
  | { mode: "included-in-output" }
  | { mode: "unbilled" }
  | { mode: "separate-rate"; ratePerMillionTokens: number };

export interface ModelPricingEntry {
  model: ModelIdentity;
  inputRatePerMillionTokens: number;
  outputRatePerMillionTokens: number;
  cacheReadRatePerMillionTokens: number;
  cacheWriteRatePerMillionTokens: number;
  reasoningBilling: ReasoningBillingRule;
}

export interface PricingSnapshot {
  snapshotId: string;
  snapshotVersion: string;
  currency: string;
  effectiveDate: string;
  provenance: string;
  entries: readonly ModelPricingEntry[];
}

const RATE_FIELDS = [
  "inputRatePerMillionTokens",
  "outputRatePerMillionTokens",
  "cacheReadRatePerMillionTokens",
  "cacheWriteRatePerMillionTokens",
] as const;

export function definePricingSnapshot(snapshot: PricingSnapshot): PricingSnapshot {
  assertExactFields(snapshot, [
    "snapshotId", "snapshotVersion", "currency", "effectiveDate", "provenance", "entries",
  ], "snapshot");
  const entriesValue: unknown = snapshot.entries;
  if (!Array.isArray(entriesValue)) throw new Error("snapshot.entries must be an array");
  assertNonEmpty(snapshot.snapshotId, "snapshotId");
  assertNonEmpty(snapshot.snapshotVersion, "snapshotVersion");
  if (!/^[A-Z]{3}$/.test(snapshot.currency)) {
    throw new Error("currency must be an uppercase ISO 4217 code");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.effectiveDate)) {
    throw new Error("effectiveDate must be an ISO date (YYYY-MM-DD)");
  }
  assertCalendarDate(snapshot.effectiveDate);
  assertNonEmpty(snapshot.provenance, "provenance");

  const seen = new Set<string>();
  for (const entry of snapshot.entries) {
    assertExactFields(entry, [
      "model", "inputRatePerMillionTokens", "outputRatePerMillionTokens",
      "cacheReadRatePerMillionTokens", "cacheWriteRatePerMillionTokens", "reasoningBilling",
    ], "snapshot entry");
    assertExactFields(entry.model, ["providerId", "modelId"], "snapshot entry model");
    assertNonEmpty(entry.model.providerId, "model.providerId");
    assertNonEmpty(entry.model.modelId, "model.modelId");
    const key = `${entry.model.providerId}/${entry.model.modelId}`;
    if (seen.has(key)) throw new Error(`duplicate pricing entry for ${key}`);
    seen.add(key);
    for (const field of RATE_FIELDS) {
      assertRate(entry[field], field);
    }
    if (entry.reasoningBilling.mode === "separate-rate") {
      assertRateScale(entry.reasoningBilling.ratePerMillionTokens, "reasoning ratePerMillionTokens");
    }
    for (const field of RATE_FIELDS) {
      assertRateScale(entry[field], field);
    }
    const billingMode: string = entry.reasoningBilling.mode;
    if (billingMode !== "included-in-output" && billingMode !== "unbilled"
      && billingMode !== "separate-rate") {
      throw new Error("reasoningBilling.mode is invalid");
    }
    if (entry.reasoningBilling.mode === "separate-rate") {
      assertRate(
        entry.reasoningBilling.ratePerMillionTokens,
        "reasoning ratePerMillionTokens",
      );
    }
  }

  return deepFreeze(structuredClone(snapshot));
}

export function pricingSnapshotHash(snapshot: PricingSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

export function findPricingEntry(
  snapshot: PricingSnapshot,
  model: ModelIdentity,
): ModelPricingEntry | undefined {
  return snapshot.entries.find(
    (entry) => entry.model.providerId === model.providerId
      && entry.model.modelId === model.modelId,
  );
}

export type MonetaryCost =
  | {
      status: "known";
      /** Display value; derived from amountScaled and subject to binary rounding. */
      amount: number;
      /** Exact amount in 1e-12 currency units; use this for comparisons. */
      amountScaled: bigint;
      currency: string;
    }
  | { status: "unknown"; missing: readonly UsageKind[] };

/** Exact scaled value of a currency amount with at most 6 decimal places, in 1e-12 units. */
export function scaledCurrencyAmount(amount: number, field: string): bigint {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  const micros = Math.round(amount * 1_000_000);
  if (Math.abs(micros - amount * 1_000_000) > 1e-6) {
    throw new Error(`${field} must have at most 6 decimal places`);
  }
  return BigInt(micros) * 1_000_000n;
}

/**
 * Prices normalized usage against one snapshot entry. A token kind whose rate
 * is positive but whose usage is absent makes the cost unknown, never zero.
 * Reasoning is a subset of output unless the entry selects separate-rate, in
 * which case reasoning is billed as disjoint tokens at its own rate.
 */
export function calculateUsageCost(
  snapshot: PricingSnapshot,
  model: ModelIdentity,
  usage: NormalizedUsage,
): MonetaryCost {
  const entry = findPricingEntry(snapshot, model);
  if (!entry) throw new Error(`no pricing entry for ${model.providerId}/${model.modelId}`);

  const missing: UsageKind[] = [];
  let numerator = 0n;

  const priceKind = (kind: UsageKind, rate: number, tokens: number | undefined): bigint => {
    if (tokens === undefined) {
      if (rate > 0) missing.push(kind);
      return 0n;
    }
    return BigInt(tokens) * rateMicros(rate);
  };

  numerator += priceKind("inputTokens", entry.inputRatePerMillionTokens, usage.inputTokens);

  const billing = entry.reasoningBilling;
  const outputRate = entry.outputRatePerMillionTokens;
  if (billing.mode === "included-in-output") {
    if (usage.reasoningTokens !== undefined && usage.outputTokens !== undefined
      && usage.reasoningTokens > usage.outputTokens) {
      throw new Error("reasoningTokens cannot exceed outputTokens");
    }
    numerator += priceKind("outputTokens", outputRate, usage.outputTokens);
  } else {
    const reasoningRate = billing.mode === "separate-rate" ? billing.ratePerMillionTokens : 0;
    const reasoningAffectsPrice = billing.mode === "unbilled"
      ? outputRate > 0 && usage.outputTokens !== undefined
      : outputRate > 0 || reasoningRate > 0;
    if (usage.reasoningTokens === undefined) {
      if (reasoningAffectsPrice) missing.push("reasoningTokens");
      numerator += priceKind("outputTokens", outputRate, usage.outputTokens);
    } else if (billing.mode === "unbilled") {
      if (usage.outputTokens !== undefined && usage.reasoningTokens > usage.outputTokens) {
        throw new Error("reasoningTokens cannot exceed outputTokens");
      }
      numerator += priceKind(
        "outputTokens",
        outputRate,
        usage.outputTokens === undefined ? undefined : usage.outputTokens - usage.reasoningTokens,
      );
    } else {
      numerator += priceKind("outputTokens", outputRate, usage.outputTokens);
      numerator += BigInt(usage.reasoningTokens) * rateMicros(reasoningRate);
    }
  }

  numerator += priceKind(
    "cacheReadTokens",
    entry.cacheReadRatePerMillionTokens,
    usage.cacheReadTokens,
  );
  numerator += priceKind(
    "cacheWriteTokens",
    entry.cacheWriteRatePerMillionTokens,
    usage.cacheWriteTokens,
  );

  if (missing.length > 0) return { status: "unknown", missing };
  // numerator is token-count times micro-rate: exactly 1e-12 currency units.
  return {
    status: "known",
    amount: Number(numerator) / 1e12,
    amountScaled: numerator,
    currency: snapshot.currency,
  };
}

function rateMicros(rate: number): bigint {
  return BigInt(Math.round(rate * 1_000_000));
}

function assertRateScale(value: number, field: string): void {
  if (Math.abs(Math.round(value * 1_000_000) - value * 1_000_000) > 1e-6) {
    throw new Error(`${field} must have at most 6 decimal places`);
  }
}

function assertCalendarDate(value: string): void {
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("effectiveDate must be a real calendar date");
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) {
    throw new Error("effectiveDate must be a real calendar date");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const fields = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`,
  );
  return `{${fields.join(",")}}`;
}

function assertExactFields(value: unknown, known: readonly string[], path: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object`);
  }
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) throw new Error(`unknown field at ${path}: ${key}`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
}

function assertRate(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
}
