export const CONTROL_DIMENSIONS_VERSION = "1";

export type ControlDimensionEnforcement =
  | "provider-taxonomy"
  | "prompt-instruction"
  | "project-dispatcher";

export interface ControlDimension {
  id: string;
  enforcement: ControlDimensionEnforcement;
}

/**
 * Dimensions whose end-to-end propagation the D-CONTROLS audit proves:
 * validated config through scheduling/request, adapter or policy enforcement,
 * control report, and canonical events. Only audited dimensions may vary in an
 * experiment matrix. Provider taxonomy applies to thinking, output limit, and
 * temperature; creativity is an exact prompt instruction and tool allowlists
 * are enforced by the project dispatcher, so neither ever carries provider
 * verification. The creativity schedule is audited but not matrix-eligible:
 * only linear-cooling@1 is implemented, so the dimension cannot take two
 * distinct values until a second schedule exists.
 */
export const MATRIX_ELIGIBLE_CONTROL_DIMENSIONS: readonly ControlDimension[] = Object.freeze([
  Object.freeze({ id: "thinkingLevel", enforcement: "provider-taxonomy" as const }),
  Object.freeze({ id: "maxOutputTokens", enforcement: "provider-taxonomy" as const }),
  Object.freeze({ id: "temperature", enforcement: "provider-taxonomy" as const }),
  Object.freeze({ id: "toolCapabilityPolicy", enforcement: "project-dispatcher" as const }),
]);
