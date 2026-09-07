export type ChangeBatcherOptions = {
  debounceMs?: number;
  maxWaitMs?: number;
};

export class ChangeBatcher {
  private readonly paths = new Set<string>();
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private maxWaitTimer?: ReturnType<typeof setTimeout>;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly onFlush: (paths: string[]) => void | Promise<void>,
    private readonly options: ChangeBatcherOptions = {},
  ) {}

  get pending(): boolean {
    return this.paths.size > 0;
  }

  get pendingCount(): number {
    return this.paths.size;
  }

  add(path: string): void {
    if (this.closed) return;
    this.paths.add(path);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flush().catch(() => {}), this.options.debounceMs ?? 750);
    this.debounceTimer.unref?.();
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => void this.flush().catch(() => {}), this.options.maxWaitMs ?? 5_000);
      this.maxWaitTimer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.paths.size === 0) return this.tail;
    this.clearTimers();
    const paths = [...this.paths].sort();
    this.paths.clear();
    const operation = this.tail.then(() => this.onFlush(paths));
    this.tail = operation.catch(() => {});
    return operation;
  }

  async close(): Promise<void> {
    if (this.closed) return this.tail;
    this.closed = true;
    await this.flush();
  }

  private clearTimers(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = undefined;
    this.maxWaitTimer = undefined;
  }
}
