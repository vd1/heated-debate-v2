export interface WebSearchRequest {
  query: string;
  maxResults?: number;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchTruncation {
  available: number;
  returned: number;
}

export interface WebSearchProvenance {
  provider: string;
  endpoint: string;
}

export interface WebSearchResponse {
  query: string;
  retrievedAt: number;
  provenance: WebSearchProvenance;
  results: readonly WebSearchResultItem[];
  truncation: WebSearchTruncation | null;
}

export interface WebSearchOptions {
  signal?: AbortSignal;
}

export interface WebSearchPort {
  search(request: WebSearchRequest, options?: WebSearchOptions): Promise<WebSearchResponse>;
}
