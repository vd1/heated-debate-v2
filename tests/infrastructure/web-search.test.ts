import { describe, expect, test } from "bun:test";

import {
  createHttpWebSearchPort,
  createWebSearchToolRegistration,
  type WebSearchFetch,
} from "../../src/infrastructure/web-search";

function fakeBackend(payload: unknown, options: {
  status?: number;
  onRequest?: (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => void;
} = {}): WebSearchFetch {
  return (url, init) => {
    options.onRequest?.(url, init);
    return Promise.resolve({
      status: options.status ?? 200,
      json: () => Promise.resolve(structuredClone(payload)),
    });
  };
}

const THREE_RESULTS = {
  results: [
    { title: "Bounded queues", url: "https://example.test/a", content: "Queues with caps." },
    { title: "Backpressure", url: "https://example.test/b", content: "Flow control." },
    { title: "Ring buffers", url: "https://example.test/c", content: "Fixed storage." },
  ],
};

describe("http web search port", () => {
  test("normalizes query, results, provenance, timestamp, and truncation", async () => {
    const requests: string[] = [];
    const port = createHttpWebSearchPort({
      provider: "test-search",
      endpoint: "https://search.example.test/search",
      fetchFn: fakeBackend(THREE_RESULTS, {
        onRequest: (url) => {
          requests.push(url);
        },
      }),
      now: () => 1_753_000_000_000,
    });

    const response = await port.search({ query: "bounded queues", maxResults: 2 });

    expect(requests).toEqual([
      "https://search.example.test/search?q=bounded+queues&format=json",
    ]);
    expect(response).toEqual({
      query: "bounded queues",
      retrievedAt: 1_753_000_000_000,
      provenance: {
        provider: "test-search",
        endpoint: "https://search.example.test/search",
      },
      results: [
        { title: "Bounded queues", url: "https://example.test/a", snippet: "Queues with caps." },
        { title: "Backpressure", url: "https://example.test/b", snippet: "Flow control." },
      ],
      truncation: { available: 3, returned: 2 },
    });
  });

  test("reports no truncation when every result is returned", async () => {
    const port = createHttpWebSearchPort({
      provider: "test-search",
      endpoint: "https://search.example.test/search",
      fetchFn: fakeBackend(THREE_RESULTS),
      now: () => 1_753_000_000_000,
    });

    const response = await port.search({ query: "bounded queues" });

    expect(response.results).toHaveLength(3);
    expect(response.truncation).toBeNull();
  });

  test("fails on non-success status without leaking the endpoint credentials", async () => {
    const port = createHttpWebSearchPort({
      provider: "test-search",
      endpoint: "https://search.example.test/search",
      apiKey: "search-secret-123",
      fetchFn: fakeBackend({}, { status: 503 }),
      now: () => 0,
    });

    let caught: unknown;
    try {
      await port.search({ query: "queues" });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof Error)) throw new Error("expected a search failure");
    expect(caught.message).toBe("search backend responded with status 503");
    expect(caught.message).not.toContain("search-secret-123");
  });

  test("sends the API key as a header and never places it in the response", async () => {
    let observedHeaders: Record<string, string> | undefined;
    const port = createHttpWebSearchPort({
      provider: "test-search",
      endpoint: "https://search.example.test/search",
      apiKey: "search-secret-123",
      fetchFn: fakeBackend(THREE_RESULTS, {
        onRequest: (_url, init) => {
          observedHeaders = init.headers;
        },
      }),
      now: () => 0,
    });

    const response = await port.search({ query: "queues" });

    expect(observedHeaders).toEqual({ authorization: "Bearer search-secret-123" });
    expect(JSON.stringify(response)).not.toContain("search-secret-123");
  });

  test("rejects malformed backend payloads with a typed message", async () => {
    const port = createHttpWebSearchPort({
      provider: "test-search",
      endpoint: "https://search.example.test/search",
      fetchFn: fakeBackend({ results: [{ title: "x", url: "https://a", content: 5 }] }),
      now: () => 0,
    });

    let caught: unknown;
    try {
      await port.search({ query: "queues" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("search result 0 is missing title, url, or content");
  });
});

describe("web search tool registration", () => {
  test("wraps the port as a versioned Pi tool emitting the full JSON evidence", async () => {
    const port = createHttpWebSearchPort({
      provider: "test-search",
      endpoint: "https://search.example.test/search",
      fetchFn: fakeBackend(THREE_RESULTS),
      now: () => 1_753_000_000_000,
    });
    const registration = createWebSearchToolRegistration(port);

    expect(registration.toolId).toBe("web-search");
    expect(registration.schemaVersion).toBe("1");
    expect(registration.tool.name).toBe("web-search");

    const result = await registration.tool.execute(
      "call-1",
      { query: "bounded queues", maxResults: 1 },
    );

    expect(result.content).toHaveLength(1);
    const text = result.content[0];
    if (text?.type !== "text") throw new Error("expected text content");
    expect(JSON.parse(text.text)).toEqual({
      query: "bounded queues",
      retrievedAt: 1_753_000_000_000,
      provenance: {
        provider: "test-search",
        endpoint: "https://search.example.test/search",
      },
      results: [
        { title: "Bounded queues", url: "https://example.test/a", snippet: "Queues with caps." },
      ],
      truncation: { available: 3, returned: 1 },
    });
  });
});

describe("web search secret containment and request validation", () => {
  test("redacts the API key from transport errors and normalizes the failure", async () => {
    const port = createHttpWebSearchPort({
      provider: "test-search",
      endpoint: "https://search.example.test/search",
      apiKey: "search-secret-123",
      fetchFn: () => Promise.reject(new Error("transport logged Bearer search-secret-123")),
      now: () => 0,
    });

    let caught: unknown;
    try {
      await port.search({ query: "queues" });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof Error)) throw new Error("expected a transport failure");
    expect(caught.message).not.toContain("search-secret-123");
    expect(caught.message).toContain("[REDACTED]");
  });

  test("sanitizes credential-bearing endpoints out of provenance", async () => {
    const port = createHttpWebSearchPort({
      provider: "test-search",
      endpoint: "https://user:password@search.example.test/search?api_key=query-secret",
      fetchFn: fakeBackend(THREE_RESULTS),
      now: () => 0,
    });

    const response = await port.search({ query: "queues" });

    expect(response.provenance.endpoint).toBe("https://search.example.test/search");
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("query-secret");
  });

  test("validates the request at the port boundary", async () => {
    const port = createHttpWebSearchPort({
      provider: "test-search",
      endpoint: "https://search.example.test/search",
      fetchFn: fakeBackend(THREE_RESULTS),
      now: () => 0,
    });

    for (const query of ["", "   "]) {
      let caught: unknown;
      try {
        await port.search({ query });
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).message).toBe("query must be non-empty");
    }
    for (const maxResults of [0, -1, 1.5, Number.NaN, 21]) {
      let caught: unknown;
      try {
        await port.search({ query: "queues", maxResults });
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).message).toBe("maxResults must be an integer from 1 to 20");
    }
  });
});

describe("residual secret and schema boundaries", () => {
  test("redacts endpoint-derived credentials echoed by a throwing transport", async () => {
    const endpoint = "https://user:password@search.example.test/search?api_key=query-secret";
    const port = createHttpWebSearchPort({
      provider: "test-search",
      endpoint,
      fetchFn: (url) => Promise.reject(new Error(`transport failed for ${url}`)),
      now: () => 0,
    });

    let caught: unknown;
    try {
      await port.search({ query: "x" });
    } catch (error) {
      caught = error;
    }
    const message = (caught as Error).message;
    expect(message).not.toContain("password");
    expect(message).not.toContain("query-secret");
  });

  test("rejects whitespace-only queries at the tool schema before execution", async () => {
    const { validateToolArguments } = await import("@earendil-works/pi-ai/compat");
    const registration = createWebSearchToolRegistration(createHttpWebSearchPort({
      provider: "test-search",
      endpoint: "https://search.example.test/search",
      fetchFn: fakeBackend(THREE_RESULTS),
      now: () => 0,
    }));

    expect(() => {
      validateToolArguments(registration.tool, {
        type: "toolCall",
        id: "c1",
        name: "web-search",
        arguments: { query: "   " },
      });
    }).toThrow();
  });
});
