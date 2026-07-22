import { Type } from "@earendil-works/pi-ai";

import type {
  WebSearchOptions,
  WebSearchPort,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResultItem,
} from "../domain/web-search";
import type { PiToolRegistration } from "./pi-agent";

export interface WebSearchFetchResponse {
  status: number;
  json(): Promise<unknown>;
}

export type WebSearchFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<WebSearchFetchResponse>;

export interface HttpWebSearchPortOptions {
  provider: string;
  endpoint: string;
  /** Sent as an Authorization header only; never placed in responses or errors. */
  apiKey?: string;
  fetchFn: WebSearchFetch;
  now?: () => number;
}

export function createHttpWebSearchPort(options: HttpWebSearchPortOptions): WebSearchPort {
  const now = options.now ?? Date.now;

  async function search(
    request: WebSearchRequest,
    searchOptions: WebSearchOptions = {},
  ): Promise<WebSearchResponse> {
    const url = new URL(options.endpoint);
    url.searchParams.set("q", request.query);
    url.searchParams.set("format", "json");
    const response = await options.fetchFn(url.toString(), {
      headers: options.apiKey === undefined
        ? {}
        : { authorization: `Bearer ${options.apiKey}` },
      ...(searchOptions.signal === undefined ? {} : { signal: searchOptions.signal }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`search backend responded with status ${String(response.status)}`);
    }
    const available = parseResults(await response.json());
    const results = request.maxResults === undefined
      ? available
      : available.slice(0, request.maxResults);

    return {
      query: request.query,
      retrievedAt: now(),
      provenance: {
        provider: options.provider,
        endpoint: options.endpoint,
      },
      results,
      truncation: results.length < available.length
        ? { available: available.length, returned: results.length }
        : null,
    };
  }

  return { search };
}

function parseResults(payload: unknown): WebSearchResultItem[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("search backend returned a non-object payload");
  }
  const results = (payload as Record<string, unknown>).results;
  if (!Array.isArray(results)) {
    throw new Error("search backend payload is missing a results array");
  }
  return results.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`search result ${String(index)} is not an object`);
    }
    const record = item as Record<string, unknown>;
    const title = record.title;
    const url = record.url;
    const snippet = record.content;
    if (typeof title !== "string" || typeof url !== "string" || typeof snippet !== "string") {
      throw new Error(`search result ${String(index)} is missing title, url, or content`);
    }
    return { title, url, snippet };
  });
}

export function createWebSearchToolRegistration(port: WebSearchPort): PiToolRegistration {
  return {
    toolId: "web-search",
    schemaVersion: "1",
    tool: {
      name: "web-search",
      label: "Web search",
      description: "Search the web and return titled results with URLs and snippets.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1 }),
        maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }),
      execute: async (_toolCallId, params, signal) => {
        const request = params as { query: string; maxResults?: number };
        const response = await port.search({
          query: request.query,
          ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }),
        }, signal === undefined ? {} : { signal });
        return {
          content: [{ type: "text", text: JSON.stringify(response) }],
          details: {},
        };
      },
    },
  };
}
