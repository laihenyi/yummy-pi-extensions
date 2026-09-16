import { EventEmitter } from "node:events";
import type { FSWatcher, watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WorkspaceWatcher } from "../src/watcher.js";

type FakeListener = (event: string, filename: string | null) => void;

type FakeWatcher = FSWatcher & EventEmitter;

type FakeWatchCall = {
  directory: string;
  recursive: boolean;
  listener: FakeListener;
  watcher: FakeWatcher;
};

function createFakeWatch() {
  const calls: FakeWatchCall[] = [];
  const watchFn = ((directory: string, options: { recursive?: boolean }, listener: FakeListener) => {
    const watcher = new EventEmitter() as FakeWatcher;
    watcher.close = () => {};
    calls.push({ directory, recursive: Boolean(options.recursive), listener, watcher });
    return watcher;
  }) as typeof watch;
  return { watchFn, calls };
}

function firstCall(calls: FakeWatchCall[]): FakeWatchCall {
  const call = calls[0];
  if (!call) throw new Error("expected watchFn to have been called");
  return call;
}

describe("WorkspaceWatcher", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-zvec-watcher-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("reports active and stopped lifecycle states", async () => {
    const states: string[] = [];
    const watcher = new WorkspaceWatcher(root, () => {}, () => {}, (state) => states.push(state));
    await watcher.start();
    await watcher.close();
    expect(states).toEqual(["active", "stopped"]);
  });

  test("ignores a filename-less 'change' event (Windows rename artifact)", async () => {
    const { watchFn, calls } = createFakeWatch();
    const onOverflow = vi.fn();
    const onPath = vi.fn();
    const watcher = new WorkspaceWatcher(root, onPath, onOverflow, undefined, { watchFn });
    await watcher.start();

    firstCall(calls).listener("change", null);

    expect(onOverflow).not.toHaveBeenCalled();
    expect(onPath).not.toHaveBeenCalled();
    await watcher.close();
  });

  test("still treats a filename-less 'rename' event as a genuine overflow", async () => {
    const { watchFn, calls } = createFakeWatch();
    const onOverflow = vi.fn();
    const watcher = new WorkspaceWatcher(root, () => {}, onOverflow, undefined, { watchFn });
    await watcher.start();

    firstCall(calls).listener("rename", null);

    expect(onOverflow).toHaveBeenCalledTimes(1);
    await watcher.close();
  });

  test("leaves filename-bearing events unaffected", async () => {
    const { watchFn, calls } = createFakeWatch();
    const onOverflow = vi.fn();
    const onPath = vi.fn();
    const watcher = new WorkspaceWatcher(root, onPath, onOverflow, undefined, { watchFn });
    await watcher.start();

    const call = firstCall(calls);
    call.listener("change", "file.txt");

    expect(onOverflow).not.toHaveBeenCalled();
    expect(onPath).toHaveBeenCalledWith(join(call.directory, "file.txt"));
    await watcher.close();
  });

  test("rate-limits repeated overflow notifications, including watcher errors", async () => {
    vi.useFakeTimers();
    try {
      const { watchFn, calls } = createFakeWatch();
      const onOverflow = vi.fn();
      const watcher = new WorkspaceWatcher(root, () => {}, onOverflow, undefined, {
        watchFn,
        overflowRateLimitMs: 30_000,
      });
      await watcher.start();
      const call = firstCall(calls);

      call.listener("rename", null);
      expect(onOverflow).toHaveBeenCalledTimes(1);

      // A watcher error immediately after should be suppressed by the rate limit.
      call.watcher.emit("error", new Error("boom"));
      expect(onOverflow).toHaveBeenCalledTimes(1);

      // Another filename-less rename before the window elapses is also suppressed.
      call.listener("rename", null);
      expect(onOverflow).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(30_001);

      call.listener("rename", null);
      expect(onOverflow).toHaveBeenCalledTimes(2);

      await watcher.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
