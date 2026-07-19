import { describe, expect, test } from "bun:test";

import { ENGINE_NAME } from "../src/index";

describe("project harness", () => {
  test("loads the typed public entry point", () => {
    expect(ENGINE_NAME).toBe("heated-debate-v2");
  });
});
