import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

const IGNORED_DIRECTORIES = new Set([
  ".git", ".zvec-grep", "node_modules", "dist", "build", "coverage", ".next", ".turbo", "target",
]);

export class WorkspaceWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private closed = false;
  private readonly recoveryAttempts = new Map<string, number>();

  constructor(
    private readonly root: string,
    private readonly onPath: (path: string) => void,
    private readonly onOverflow: () => void,
    private readonly onState: (state: "active" | "recovering" | "stopped") => void = () => {},
  ) {}

  async start(): Promise<void> {
    if (process.platform === "linux") {
      await this.watchTree(this.root);
      this.onState("active");
      return;
    }
    try {
      this.addWatcher(this.root, true);
      this.onState("active");
    } catch {
      await this.watchTree(this.root);
      this.onState("active");
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.onState("stopped");
  }

  private addWatcher(directory: string, recursive: boolean): void {
    if (this.closed || this.watchers.has(directory)) return;
    const watcher = watch(directory, { recursive }, (event, filename) => {
      if (!filename) {
        this.onOverflow();
        return;
      }
      const path = recursive ? join(this.root, filename.toString()) : join(directory, filename.toString());
      if (this.isIgnored(path)) return;
      this.onPath(path);
      if (!recursive && event === "rename") void this.watchTree(path).catch(() => this.onOverflow());
    });
    watcher.on("error", () => {
      watcher.close();
      this.watchers.delete(directory);
      this.onOverflow();
      this.onState("recovering");
      this.scheduleRecovery(directory);
    });
    this.watchers.set(directory, watcher);
    this.recoveryAttempts.delete(directory);
  }

  private async watchTree(directory: string): Promise<void> {
    if (this.closed || this.isIgnored(directory)) return;
    const info = await stat(directory).catch(() => undefined);
    if (!info?.isDirectory()) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    this.addWatcher(directory, false);
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => this.watchTree(join(directory, entry.name))));
  }

  private isIgnored(path: string): boolean {
    const rel = relative(this.root, path);
    return rel.split(sep).some((part) => IGNORED_DIRECTORIES.has(part)) || basename(path) === ".DS_Store";
  }

  private scheduleRecovery(directory: string): void {
    if (this.closed) return;
    const attempt = this.recoveryAttempts.get(directory) ?? 0;
    this.recoveryAttempts.set(directory, attempt + 1);
    const retry = setTimeout(() => {
      void this.watchTree(directory).then(() => {
        if (!this.watchers.has(directory)) this.scheduleRecovery(directory);
        else this.onState("active");
      }).catch(() => {
        this.onOverflow();
        this.scheduleRecovery(directory);
      });
    }, Math.min(250 * 2 ** attempt, 5_000));
    retry.unref?.();
  }
}
