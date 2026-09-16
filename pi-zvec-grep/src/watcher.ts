import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

const IGNORED_DIRECTORIES = new Set([
  ".git", ".zvec-grep", "node_modules", "dist", "build", "coverage", ".next", ".turbo", "target",
]);

const DEFAULT_OVERFLOW_RATE_LIMIT_MS = 30_000;

export type WorkspaceWatcherOptions = {
  /** Injectable for tests; defaults to `node:fs`'s `watch`. */
  watchFn?: typeof watch;
  /** Minimum interval between onOverflow notifications. */
  overflowRateLimitMs?: number;
};

export class WorkspaceWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private closed = false;
  private readonly recoveryAttempts = new Map<string, number>();
  private readonly watchFn: typeof watch;
  private readonly overflowRateLimitMs: number;
  private lastOverflowAt = -Infinity;

  constructor(
    private readonly root: string,
    private readonly onPath: (path: string) => void,
    private readonly onOverflow: () => void,
    private readonly onState: (state: "active" | "recovering" | "stopped") => void = () => {},
    options: WorkspaceWatcherOptions = {},
  ) {
    this.watchFn = options.watchFn ?? watch;
    this.overflowRateLimitMs = options.overflowRateLimitMs ?? DEFAULT_OVERFLOW_RATE_LIMIT_MS;
  }

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
    const watcher = this.watchFn(directory, { recursive }, (event, filename) => {
      if (!filename) {
        // Recursive fs.watch on Windows reports our own atomic tmp-file
        // rename (e.g. manifest.json.<pid>.<uuid>.tmp -> manifest.json) as a
        // trailing filename-less "change" event. That's not a buffer
        // overflow, so only a filename-less "rename" is treated as one.
        if (event === "change") return;
        this.notifyOverflow();
        return;
      }
      const path = recursive ? join(this.root, filename.toString()) : join(directory, filename.toString());
      if (this.isIgnored(path)) return;
      this.onPath(path);
      if (!recursive && event === "rename") void this.watchTree(path).catch(() => this.notifyOverflow());
    });
    watcher.on("error", () => {
      watcher.close();
      this.watchers.delete(directory);
      this.notifyOverflow();
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

  private notifyOverflow(): void {
    const now = Date.now();
    if (now - this.lastOverflowAt < this.overflowRateLimitMs) return;
    this.lastOverflowAt = now;
    this.onOverflow();
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
        this.notifyOverflow();
        this.scheduleRecovery(directory);
      });
    }, Math.min(250 * 2 ** attempt, 5_000));
    retry.unref?.();
  }
}
