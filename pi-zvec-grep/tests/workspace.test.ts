import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { resolveWorkspaceRoot } from "../src/workspace.js";

const exec = promisify(execFile);

describe("resolveWorkspaceRoot", () => {
  test("uses the Git worktree root when Pi starts in a nested directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-zvec-root-"));
    await exec("git", ["init", "-q", root]);
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    expect(await resolveWorkspaceRoot(nested)).toBe(await realpath(root));
  });

  test("falls back to the canonical cwd outside Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-zvec-plain-"));
    expect(await resolveWorkspaceRoot(root)).toBe(await realpath(root));
  });
});
