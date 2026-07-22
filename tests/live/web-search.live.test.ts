import { describe, expect, test } from "bun:test";

import {
  createHttpWebSearchPort,
  createWebSearchToolRegistration,
  type WebSearchFetch,
} from "../../src/infrastructure/web-search";
import { LIVE_ENABLED } from "./support";

const SEARCH_URL = process.env.HEATED_DEBATE_SEARCH_URL;
const SEARCH_API_KEY = process.env.HEATED_DEBATE_SEARCH_API_KEY;

describe("web search live smoke", () => {
  if (!LIVE_ENABLED || SEARCH_URL === undefined) {
    test.skip("requires HEATED_DEBATE_LIVE=1 and HEATED_DEBATE_SEARCH_URL", () => {});
    return;
  }
  const endpoint = SEARCH_URL;

  test("searches the configured backend and returns secret-free evidence", async () => {
    const fetchFn: WebSearchFetch = async (url, init) => {
      const response = await fetch(url, {
        headers: init.headers,
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      });
      return { status: response.status, json: () => response.json() };
    };
    const port = createHttpWebSearchPort({
      provider: "live-search",
      endpoint,
      ...(SEARCH_API_KEY === undefined ? {} : { apiKey: SEARCH_API_KEY }),
      fetchFn,
    });
    const registration = createWebSearchToolRegistration(port);

    const result = await registration.tool.execute(
      "live-call-1",
      { query: "bounded queue backpressure", maxResults: 3 },
      AbortSignal.timeout(30_000),
    );

    const text = result.content[0];
    if (text?.type !== "text") throw new Error("expected text content");
    const parsed = JSON.parse(text.text) as {
      query: string;
      results: unknown[];
      provenance: { provider: string };
    };
    expect(parsed.query).toBe("bounded queue backpressure");
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.provenance.provider).toBe("live-search");
    if (SEARCH_API_KEY !== undefined) {
      expect(text.text).not.toContain(SEARCH_API_KEY);
    }
  }, 45_000);
});
