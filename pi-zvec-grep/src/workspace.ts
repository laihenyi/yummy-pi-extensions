import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function resolveWorkspaceRoot(cwd: string): Promise<string> {
  const canonicalCwd = await realpath(cwd);
  try {
    const { stdout } = await exec("git", ["-C", canonicalCwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    });
    return await realpath(stdout.trim());
  } catch {
    return canonicalCwd;
  }
}
