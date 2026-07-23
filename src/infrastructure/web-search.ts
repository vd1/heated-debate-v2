import { Type } from "@earendil-works/pi-ai";

import type {
  WebSearchOptions,
  WebSearchPort,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResultItem,
} from "../domain/web-search";
import type { PiToolRegistration } from "./pi-agent";

/** Queries must contain at least one non-whitespace character. */
export const QUERY_PATTERN = "\\S";

export const MIN_RESULTS = 1;
export const MAX_RESULTS = 20;

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
  const endpoint = new URL(options.endpoint);
  // Provenance must stay credential-free: origin and path only.
  const provenanceEndpoint = `${endpoint.origin}${endpoint.pathname}`;
  // Redact the header key plus every credential the configured endpoint carries.
  const rawQueryValues = endpoint.search
    .replace(/^\?/, "")
    .split("&")
    .map((pair) => pair.split("=")[1])
    .filter((item): item is string => item !== undefined);
  const redactionValues = [
    options.apiKey,
    // Both the percent-encoded and decoded forms of every endpoint credential.
    endpoint.username === "" ? undefined : endpoint.username,
    endpoint.username === "" ? undefined : decodeURIComponent(endpoint.username),
    endpoint.password === "" ? undefined : endpoint.password,
    endpoint.password === "" ? undefined : decodeURIComponent(endpoint.password),
    ...rawQueryValues,
    ...[...endpoint.searchParams.values()],
  ].filter((value): value is string => value !== undefined && value.length > 0);
  const redact = (message: string): string => redactionValues.reduce(
    (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
    message,
  );

  async function search(
    request: WebSearchRequest,
    searchOptions: WebSearchOptions = {},
  ): Promise<WebSearchResponse> {
    if (typeof request.query !== "string" || request.query.trim().length === 0) {
      throw new Error("query must be non-empty");
    }
    if (request.maxResults !== undefined
      && (!Number.isInteger(request.maxResults)
        || request.maxResults < MIN_RESULTS
        || request.maxResults > MAX_RESULTS)) {
      throw new Error(`maxResults must be an integer from ${String(MIN_RESULTS)} to ${String(MAX_RESULTS)}`);
    }
    const url = new URL(options.endpoint);
    url.searchParams.set("q", request.query);
    url.searchParams.set("format", "json");
    let response: WebSearchFetchResponse;
    let payload: unknown;
    try {
      response = await options.fetchFn(url.toString(), {
        headers: options.apiKey === undefined
          ? {}
          : { authorization: `Bearer ${options.apiKey}` },
        ...(searchOptions.signal === undefined ? {} : { signal: searchOptions.signal }),
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`search backend responded with status ${String(response.status)}`);
      }
      payload = await response.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(redact(message));
    }
    const available = parseResults(payload);
    const results = request.maxResults === undefined
      ? available
      : available.slice(0, request.maxResults);

    return {
      query: request.query,
      retrievedAt: now(),
      provenance: {
        provider: options.provider,
        endpoint: provenanceEndpoint,
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
        query: Type.String({ minLength: 1, pattern: QUERY_PATTERN }),
        maxResults: Type.Optional(Type.Integer({ minimum: MIN_RESULTS, maximum: MAX_RESULTS })),
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
