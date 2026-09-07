import { describe, expect, test, vi } from "vitest";
import { ChangeBatcher } from "../src/change-batcher.js";

describe("ChangeBatcher", () => {
  test("deduplicates paths and flushes after the debounce period", async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const batcher = new ChangeBatcher((paths) => { batches.push(paths); }, { debounceMs: 50, maxWaitMs: 200 });
    batcher.add("/repo/a.ts");
    batcher.add("/repo/a.ts");
    batcher.add("/repo/b.ts");
    await vi.advanceTimersByTimeAsync(50);
    expect(batches).toEqual([["/repo/a.ts", "/repo/b.ts"]]);
    await batcher.close();
    vi.useRealTimers();
  });

  test("close flushes pending changes exactly once", async () => {
    const batches: string[][] = [];
    const batcher = new ChangeBatcher((paths) => { batches.push(paths); }, { debounceMs: 10_000 });
    batcher.add("/repo/a.ts");
    await batcher.close();
    await batcher.close();
    expect(batches).toEqual([["/repo/a.ts"]]);
  });

  test("a failed flush does not prevent a later batch", async () => {
    let attempts = 0;
    const batches: string[][] = [];
    const batcher = new ChangeBatcher(async (paths) => {
      attempts += 1;
      if (attempts === 1) throw new Error("busy");
      batches.push(paths);
    });
    batcher.add("/repo/first.ts");
    await expect(batcher.flush()).rejects.toThrow("busy");
    batcher.add("/repo/second.ts");
    await batcher.flush();
    expect(batches).toEqual([["/repo/second.ts"]]);
    await batcher.close();
  });

  test("maximum wait flushes during continuous changes", async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const batcher = new ChangeBatcher((paths) => { batches.push(paths); }, { debounceMs: 100, maxWaitMs: 250 });
    for (let elapsed = 0; elapsed < 250; elapsed += 50) {
      batcher.add(`/repo/${elapsed}.ts`);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(5);
    await batcher.close();
    vi.useRealTimers();
  });
});
