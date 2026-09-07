import { describe, expect, test } from "vitest";
import { formatSearchResult } from "../src/engine.js";

describe("formatSearchResult", () => {
  test("returns bounded search fields without internal diagnostics", () => {
    const formatted = JSON.parse(formatSearchResult({
      query: "authentication flow",
      root: "/repo",
      source: "index",
      coverage: "ranked_sample",
      items: [{
        kind: "indexed_entity",
        rank: 1,
        file: { absolutePath: "/repo/src/auth.ts", relativePath: "src/auth.ts" },
        range: { kind: "text", startLine: 10, endLine: 14, startOffset: 0, endOffset: 42 },
        content: "export function authenticate() {}",
        status: "fresh",
        matchedBy: "vector",
        score: 0.91,
        trace: { large: "internal diagnostics" } as never,
      }],
      diagnostics: { timings: [{ name: "search", durationMs: 12 }] },
    }));

    expect(formatted).toEqual({
      status: "ready",
      query: "authentication flow",
      root: "/repo",
      source: "index",
      coverage: "ranked_sample",
      results: [{
        path: "src/auth.ts",
        startLine: 10,
        endLine: 14,
        content: "export function authenticate() {}",
        status: "fresh",
        matchedBy: "vector",
        score: 0.91,
      }],
    });
    expect(JSON.stringify(formatted)).not.toContain("diagnostics");
    expect(JSON.stringify(formatted)).not.toContain("trace");
  });
});
