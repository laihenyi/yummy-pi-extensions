import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { WorkspaceWatcher } from "../src/watcher.js";

describe("WorkspaceWatcher", () => {
  test("reports active and stopped lifecycle states", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-zvec-watcher-"));
    const states: string[] = [];
    const watcher = new WorkspaceWatcher(root, () => {}, () => {}, (state) => states.push(state));
    try {
      await watcher.start();
      await watcher.close();
      expect(states).toEqual(["active", "stopped"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
