import { describe, expect, test } from "vitest";
import { WorkspaceRuntime } from "../src/runtime.js";
import type { SearchEngine, SearchResult } from "../src/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeResult(text: string): SearchResult {
  return { text, raw: { groups: [] } };
}

describe("WorkspaceRuntime", () => {
  test("starts initial indexing without waiting for it", async () => {
    const initial = deferred<void>();
    const engine: SearchEngine = {
      index: () => initial.promise,
      search: async () => fakeResult("found"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    expect(runtime.status().phase).toBe("indexing");
    initial.resolve();
    await runtime.ready();
    expect(runtime.status().phase).toBe("ready");
  });

  test("publishes indexing and ready status changes", async () => {
    const initial = deferred<void>();
    const phases: string[] = [];
    const engine: SearchEngine = {
      index: () => initial.promise,
      search: async () => fakeResult("found"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    const unsubscribe = runtime.subscribe((status) => phases.push(status.phase));
    runtime.start();
    initial.resolve();
    await runtime.ready();
    unsubscribe();
    expect(phases).toEqual(["idle", "indexing", "ready"]);
  });

  test("aborts an in-flight initial index during close", async () => {
    let receivedSignal: AbortSignal | undefined;
    const engine: SearchEngine = {
      index: (_paths, options) => new Promise<void>((_resolve, reject) => {
        receivedSignal = options?.signal;
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      }),
      search: async () => fakeResult("unused"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    await Promise.resolve();
    await runtime.close();
    expect(receivedSignal?.aborted).toBe(true);
    expect(runtime.status().phase).toBe("closed");
  });

  test("first search returns immediately while initial indexing is incomplete", async () => {
    const initial = deferred<void>();
    let searched = false;
    const engine: SearchEngine = {
      index: () => initial.promise,
      search: async () => { searched = true; return fakeResult("answer"); },
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    await expect(runtime.search("where is auth?")).rejects.toThrow("Workspace index is not ready (indexing)");
    expect(searched).toBe(false);
    initial.resolve();
    await runtime.ready();
    await expect(runtime.search("where is auth?")).resolves.toEqual(fakeResult("answer"));
  });

  test("serializes incremental path batches behind the initial index", async () => {
    const first = deferred<void>();
    const calls: Array<readonly string[] | undefined> = [];
    let invocation = 0;
    const engine: SearchEngine = {
      index: async (paths) => {
        calls.push(paths);
        invocation += 1;
        if (invocation === 1) await first.promise;
      },
      search: async () => fakeResult("answer"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false, debounceMs: 0 });
    runtime.start();
    runtime.recordChangedPath("/repo/a.ts");
    runtime.recordChangedPath("/repo/b.ts");
    first.resolve();
    await runtime.flushChanges();
    expect(calls).toEqual([undefined, ["/repo/a.ts", "/repo/b.ts"]]);
  });

  test("reports the number of paths waiting for an incremental update", async () => {
    const engine: SearchEngine = {
      index: async () => {},
      search: async () => fakeResult("answer"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false, debounceMs: 10_000 });
    runtime.start();
    await runtime.ready();
    runtime.recordChangedPath("/repo/a.ts");
    runtime.recordChangedPath("/repo/b.ts");
    expect(runtime.status()).toMatchObject({ phase: "updating", pendingFiles: 2 });
    await runtime.close();
  });

  test("reports initial indexing failure and surfaces it to search", async () => {
    const engine: SearchEngine = {
      index: async () => { throw new Error("native binding unavailable"); },
      search: async () => fakeResult("unused"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    await expect(runtime.ready()).rejects.toThrow("native binding unavailable");
    expect(runtime.status()).toMatchObject({ phase: "error", error: "native binding unavailable" });
    await expect(runtime.search("query")).rejects.toThrow("native binding unavailable");
  });

  test("close discards pending changes and closes the engine", async () => {
    const calls: Array<readonly string[] | undefined> = [];
    let closed = false;
    const engine: SearchEngine = {
      index: async (paths) => { calls.push(paths); },
      search: async () => fakeResult("answer"),
      close: async () => { closed = true; },
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    await runtime.ready();
    runtime.recordChangedPath("/repo/a.ts");
    await runtime.close();
    expect(calls).toEqual([undefined]);
    expect(closed).toBe(true);
  });

  test("a successful reindex recovers searches after initial failure", async () => {
    let attempts = 0;
    const engine: SearchEngine = {
      index: async () => { if (++attempts === 1) throw new Error("busy"); },
      search: async () => fakeResult("recovered"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    await expect(runtime.ready()).rejects.toThrow("busy");
    await runtime.reindex();
    await expect(runtime.search("query")).resolves.toEqual(fakeResult("recovered"));
  });

  test("does not begin an index while a search is using the engine", async () => {
    const searching = deferred<SearchResult>();
    let indexDuringSearch = false;
    let searchActive = false;
    const engine: SearchEngine = {
      index: async () => { if (searchActive) indexDuringSearch = true; },
      search: async () => { searchActive = true; const result = await searching.promise; searchActive = false; return result; },
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false, debounceMs: 0 });
    runtime.start();
    await runtime.ready();
    const result = runtime.search("query");
    await Promise.resolve();
    runtime.recordChangedPath("/repo/a.ts");
    const flush = runtime.flushChanges();
    await Promise.resolve();
    expect(indexDuringSearch).toBe(false);
    searching.resolve(fakeResult("done"));
    await result;
    await flush;
    expect(indexDuringSearch).toBe(false);
  });

  test("stops lock-busy retries when the tool call is aborted", async () => {
    let attempts = 0;
    const controller = new AbortController();
    const engine: SearchEngine = {
      index: async () => {},
      search: async () => {
        attempts += 1;
        throw new Error("LOCK.BUSY");
      },
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    await runtime.ready();
    const search = runtime.search("query", { signal: controller.signal });
    await Promise.resolve();
    controller.abort(new Error("tool cancelled"));
    await expect(search).rejects.toThrow("tool cancelled");
    expect(attempts).toBe(1);
    await runtime.close();
  });

  test("closes native resources without starting a final change batch", async () => {
    let calls = 0;
    let closed = false;
    const engine: SearchEngine = {
      index: async () => { if (++calls > 1) throw new Error("write failed"); },
      search: async () => fakeResult("unused"),
      close: async () => { closed = true; },
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    await runtime.ready();
    runtime.recordChangedPath("/repo/a.ts");
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(closed).toBe(true);
    expect(runtime.status().phase).toBe("closed");
  });
});
