import { createZvecGrep, type ZvecGrep, type ZvecGrepContextResult } from "@zvec/zvec-grep";
import type { SearchEngine, SearchResult } from "./types.js";

export async function createZvecSearchEngine(root: string): Promise<SearchEngine> {
  const client = await createZvecGrep({ root, embedding: "local/potion-code-16m-v2" });
  return new ZvecSearchEngine(client);
}

class ZvecSearchEngine implements SearchEngine {
  constructor(private readonly client: ZvecGrep) {}

  async index(changedPaths?: readonly string[], options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.client.index({ ...(changedPaths ? { changedPaths } : {}), signal: options.signal });
  }

  async search(query: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<SearchResult> {
    if (options.signal?.aborted) throw options.signal.reason;
    const raw = await this.client.context({
      query,
      limit: options.limit ?? 10,
      autoUpdate: false,
      routes: [{ mode: "vector", query }, { mode: "fts", query }],
    });
    return { text: formatSearchResult(raw), raw };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export function formatSearchResult(result: ZvecGrepContextResult): string {
  return JSON.stringify({
    status: "ready",
    query: result.query,
    root: result.root,
    source: result.source,
    coverage: result.coverage,
    results: result.items.map((item) => ({
      path: item.file.relativePath,
      ...("startLine" in item.range ? { startLine: item.range.startLine, endLine: item.range.endLine } : {}),
      content: item.content,
      status: item.status,
      matchedBy: item.matchedBy,
      ...(item.score === undefined ? {} : { score: item.score }),
    })),
  }, null, 2);
}
