import { describe, expect, test } from "vitest";
import { registerPiZvecGrep } from "../src/extension.js";
import type { SearchEngine } from "../src/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("registerPiZvecGrep", () => {
  test("adds routing guidance for semantic versus exact workspace search", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const pi = {
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerTool: () => {},
      registerCommand: () => {},
    };
    registerPiZvecGrep(pi as never);
    const result = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, {});
    expect(result).toMatchObject({ systemPrompt: expect.stringContaining("zvec_search") });
    expect((result as any).systemPrompt).toContain("exact identifiers");
    expect((result as any).systemPrompt).toContain("grep");
  });

  test("registers search immediately and manages runtime through session lifecycle", async () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
    const tools: any[] = [];
    const commands = new Map<string, any>();
    const statuses: Array<[string, string | undefined]> = [];
    let closed = false;
    const engine: SearchEngine = {
      index: async () => {},
      search: async (query) => ({ text: `result:${query}`, raw: {} }),
      close: async () => { closed = true; },
    };
    const pi = {
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: (name: string, command: any) => commands.set(name, command),
    };

    registerPiZvecGrep(pi as never, {
      createEngine: async () => engine,
      resolveRoot: async () => "/repo",
      runtimeOptions: { watch: false },
    });

    expect(tools.map((tool) => tool.name)).toEqual(["zvec_search"]);
    expect([...commands.keys()]).toEqual(["zvec-status", "zvec-reindex"]);

    const ctx = { cwd: "/repo/src", hasUI: true, ui: { setStatus: (key: string, value?: string) => statuses.push([key, value]), notify: () => {} } };
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await tools[0].execute("call-1", { query: "auth flow", limit: 5 }, undefined, undefined, ctx);
    expect(result.content).toEqual([{ type: "text", text: "result:auth flow" }]);
    expect(statuses.some(([, value]) => value?.includes("/repo"))).toBe(true);

    await handlers.get("session_shutdown")?.({}, ctx);
    expect(closed).toBe(true);
  });

  test("search before session startup returns an actionable error", async () => {
    const tools: any[] = [];
    const pi = { on: () => {}, registerTool: (tool: any) => tools.push(tool), registerCommand: () => {} };
    registerPiZvecGrep(pi as never, { createEngine: async () => { throw new Error("unused"); } });
    const result = await tools[0].execute("call-1", { query: "auth" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("workspace runtime is not ready");
  });

  test("returns structured retryable status instead of waiting for initial indexing", async () => {
    const initial = deferred<void>();
    const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
    const tools: any[] = [];
    const engine: SearchEngine = {
      index: () => initial.promise,
      search: async () => ({ text: "must not search", raw: {} }),
      close: async () => {},
    };
    const pi = {
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: () => {},
    };
    registerPiZvecGrep(pi as never, {
      createEngine: async () => engine,
      resolveRoot: async () => "/repo",
      runtimeOptions: { watch: false },
    });
    const ctx = { cwd: "/repo", hasUI: false, ui: { setStatus: () => {}, notify: () => {} } };
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);

    const pending = await Promise.race([
      tools[0].execute("call-1", { query: "auth" }),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 20)),
    ]);

    expect(pending).not.toBe("timed-out");
    expect(pending).toMatchObject({
      details: { status: "indexing", retryable: true, root: "/repo" },
    });
    expect((pending as any).isError).toBeUndefined();
    expect(JSON.parse((pending as any).content[0].text)).toMatchObject({
      status: "indexing",
      retryable: true,
    });
    initial.resolve();
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  test("keeps the TUI status synchronized during a manual reconciliation", async () => {
    const secondIndex = deferred<void>();
    let indexes = 0;
    const statuses: string[] = [];
    const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
    const commands = new Map<string, any>();
    const engine: SearchEngine = {
      index: async () => { if (++indexes === 2) await secondIndex.promise; },
      search: async () => ({ text: "unused", raw: {} }),
      close: async () => {},
    };
    const pi = {
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerTool: () => {},
      registerCommand: (name: string, command: any) => commands.set(name, command),
    };
    registerPiZvecGrep(pi as never, {
      createEngine: async () => engine,
      resolveRoot: async () => "/repo",
      runtimeOptions: { watch: false },
    });
    const ctx = {
      cwd: "/repo",
      hasUI: true,
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setStatus: (_key: string, value?: string) => { if (value) statuses.push(value); },
        notify: () => {},
      },
    };
    await handlers.get("session_start")?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reconcile = commands.get("zvec-reindex").handler("", ctx);
    await Promise.resolve();
    expect(statuses.at(-1)).toContain("updating");
    secondIndex.resolve();
    await reconcile;
    expect(statuses.at(-1)).toContain("ready");
    await handlers.get("session_shutdown")?.({}, ctx);
  });
});
