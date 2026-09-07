# pi-zvec-grep

`pi-zvec-grep` is an install-once [Pi](https://pi.dev/) extension that gives the agent semantic and ranked full-text search over the project in which Pi is running. It embeds [Alibaba zvec](https://github.com/alibaba/zvec) through the public [zvec-grep](https://github.com/zvec-ai/zvec-grep) engine API.

The extension owns the complete index lifecycle. After package installation, users do **not** run `zg install`, `zg index`, `zg serve`, or any other setup command for each project.

## Requirements

- Node.js 22 or newer
- Pi

No separate zvec or zvec-grep CLI installation is required.

## Installation

### Option 1: install once for all projects

Run this command once:

```bash
pi install npm:@sugarforever/pi-zvec-grep
```

Then start Pi normally from any project directory:

```bash
cd /path/to/project
pi
```

That is the complete setup. The extension discovers the workspace and creates or refreshes its index automatically. Do not run `zg install`, `zg index`, or `zg serve`.

### Option 2: enable it for one shared project

Add the package to the repository's `.pi/settings.json`:

```json
{
  "packages": ["npm:@sugarforever/pi-zvec-grep"]
}
```

When a user opens the trusted project with Pi, Pi installs the missing package automatically. This is useful when every contributor should have the same project-search capability.

### Verify the installation

Start Pi in a project and run:

```text
/zvec-status
```

The footer and command output will initially report `indexing`, then `ready`. The first run may download the local embedding model automatically. Large repositories can take longer to index, but Pi remains usable during this process.

## User-visible features

- `zvec_search`: agent tool for semantic and ranked full-text workspace retrieval.
- `/zvec-status`: reports the resolved workspace root and current index state.
- `/zvec-reindex`: manually requests a full reconciliation for diagnosis or recovery. Normal use does not require it.
- TUI status: continuously shows indexing, updating, ready, degraded, or error state without blocking Pi startup.

## Design goals

1. **One installation, zero project commands.** Starting Pi is sufficient to create or refresh the index.
2. **Fast startup.** Initial indexing runs in the background; the TUI is not held until embedding completes.
3. **Responsive searches.** A search attempted during indexing returns structured retryable status immediately, allowing the agent or user to choose a fallback instead of blocking a turn indefinitely.
4. **Offline-change recovery.** Every Pi startup performs an incremental full-workspace reconciliation, catching changes made while Pi was stopped.
5. **Local by default.** The default embedding is `local/potion-code-16m-v2`; project content is not sent to a remote embedding service.
6. **No CLI or MCP dependency.** The extension calls the zvec-grep engine API directly in the Pi process.

## How it works

The extension runs inside the Pi process and owns the complete index lifecycle:

1. **Resolve the workspace.** When a Pi session starts, the extension uses the enclosing Git worktree as the workspace root. Outside Git, it uses the directory where Pi was started.
2. **Open the embedded engine.** It creates a zvec-grep engine directly in-process. It does not execute the `zg` CLI and does not start an MCP server or daemon.
3. **Reconcile automatically.** It starts a background reconciliation that scans the workspace, compares content hashes with the existing index, and adds, changes, or removes records as needed.
4. **Watch live changes.** While Pi is running, filesystem events are collected, deduplicated, and sent to incremental indexing after a short debounce period.
5. **Recover missed events.** Every Pi startup performs reconciliation, and a periodic reconciliation repairs filesystem events that may have been dropped.
6. **Expose search to the agent.** Pi receives a `zvec_search` tool for semantic and ranked full-text retrieval. Exact identifiers, literal strings, filenames, and regular expressions remain better suited to grep.

There are no per-project setup commands. The normal lifecycle is simply:

```text
install extension once → cd into a project → start Pi → index stays current automatically
```

### Runtime flow

```text
Pi process starts in any directory
        │
        ▼
session_start(ctx.cwd)
        │
        ├── resolve canonical workspace root
        │     ├── Git worktree root when available
        │     └── realpath(ctx.cwd) otherwise
        │
        ├── create @zvec/zvec-grep engine
        ├── start incremental reconciliation in background
        ├── start workspace file watcher
        └── expose zvec_search immediately
                  │
                  ├── return structured status while an index job is active
                  ├── search the last completed index when ready
                  └── return bounded hybrid vector + FTS results

session_shutdown
        ├── stop watcher and timers
        ├── cancel active or queued index work
        └── close zvec-grep engine
```

### Why the zvec-grep engine rather than raw zvec

`@zvec/zvec` is the embedded vector database. A useful project-search product additionally needs file discovery, ignore handling, binary and size filtering, structure-aware code and Markdown extraction, chunking, content hashes, add/modify/delete detection, metadata, full-text search, vector search, ranking, and read/write locking.

Those capabilities already exist behind the public `@zvec/zvec-grep` library API. This package uses `createZvecGrep()`, `index()` and `context()` directly. It does not spawn `zg` or require the zvec-grep daemon. This preserves the mature indexing pipeline without making users manage another executable.

### Workspace root resolution

The extension canonicalizes `ctx.cwd` with `realpath`. If it is inside a Git worktree, `git rev-parse --show-toplevel` becomes the root. Otherwise, the exact directory from which Pi started becomes the root.

Consequences:

- Starting Pi inside `repo/packages/app` still indexes the complete Git worktree.
- Separate Git worktrees receive separate indexes because their file contents may differ.
- A non-Git directory is still supported without configuration.

### Initial indexing and readiness

`session_start` creates a `WorkspaceRuntime` and calls `start()`. `start()` schedules `engine.index()` but does not await it, so a large repository does not freeze TUI startup.

The runtime retains the initial-index Promise for lifecycle and recovery management. If `zvec_search` is called while the runtime is `indexing` or `updating`, it does not wait. It immediately returns a normal tool result with machine-readable readiness details:

```json
{
  "status": "indexing",
  "retryable": true,
  "root": "/path/to/workspace",
  "message": "The workspace index is not ready. Choose whether to use grep/read now or retry zvec_search later."
}
```

This keeps the agent turn responsive and lets the LLM or human choose whether to use `grep`/`read`, continue other work, or retry later. Index failures transition the runtime to `error` and are returned as actionable tool errors rather than becoming unhandled background rejections.

The not-ready response is a normal structured tool result, not a failed tool call. This prevents automatic error-retry loops while still exposing `status`, `retryable`, and `root` to the agent.

The first local embedding use may download a model into the zvec-grep model cache. This is automatic resource acquisition, not a separate configuration step.

### File watching and incremental updates

During a Pi session, `WorkspaceWatcher` watches the root and sends changed paths to `ChangeBatcher`.

- macOS and Windows use recursive `fs.watch` where supported.
- Linux uses one watcher per admitted directory. This avoids Node's recursive Linux behavior consuming watches for every file, and lets ignored trees be skipped.
- `.git`, `.zvec-grep`, `node_modules`, common build/cache directories, and `.DS_Store` are excluded before events enter the queue.
- Duplicate paths are collapsed.
- The quiet-period debounce is 750 ms.
- Continuous writes are forced to flush after 5 seconds.
- Every batch calls `index({ changedPaths })`; zvec-grep performs content-hash diffing and updates or deletes only affected records.
- A watcher overflow or event without a filename requests a full reconciliation.
- A watcher error requests reconciliation and retries the failed directory watcher.
- A one-hour periodic reconciliation is a safety net for dropped filesystem events.

The footer distinguishes watcher degradation from index failure. `zvec: degraded` means the existing index remains searchable, but live filesystem updates are recovering; `zvec: error` means no healthy index operation is available.

The implementation intentionally treats filesystem events as hints, not the source of truth. Startup and periodic reconciliation are what guarantee eventual correctness.

### Consistency and concurrency

All indexing operations in one runtime pass through a Promise queue. The initial index and watcher batches therefore never write concurrently.

If an index job is visibly active when the tool is called, the tool returns the retryable status above instead of waiting. This avoids indexing on every keystroke while preventing an abnormal index job from holding a tool call indefinitely.

The extension also adds short per-turn routing guidance: semantic, architectural, and cross-file questions use `zvec_search`; known identifiers, literal strings, filenames, and regular expressions use Pi's exact grep/search facilities. Search output is projected to stable, bounded fields rather than exposing the engine's full diagnostics object to the model context.

Multiple Pi processes may open the same repository. The zvec-grep engine applies workspace read/write locks around index and context operations, while content hashes make repeated watcher updates idempotent. This package deliberately retains that engine boundary instead of opening raw zvec collections itself.

Index and search operations share the same in-process queue, so a live update cannot race a query. Cross-process `LOCK.BUSY` responses are retried with bounded exponential backoff for roughly two minutes before being surfaced, allowing another Pi process to finish a normal embedding job.

### Storage

The index is stored by zvec-grep under:

```text
<workspace>/.zvec-grep/
```

The directory is excluded from its own scanner and watcher. The extension does not modify the project's `.gitignore`; teams may add `.zvec-grep/` themselves if they do not want it shown as an untracked directory.

Local embedding models and zvec-grep global state use zvec-grep's normal user cache under `~/.zvec-grep/`.

### Lifecycle behavior

Pi can replace extension runtimes during `/new`, `/resume`, `/fork`, and `/reload`. Pi emits `session_shutdown` for the old runtime and then `session_start` for the replacement. Cleanup is idempotent, aborts active indexing, and has a bounded wait before native resources are closed, so a stuck embedding operation cannot indefinitely block session replacement.

Shutdown deliberately discards paths still waiting in the debounce buffer instead of starting new index work while Pi is exiting. The next startup reconciliation repairs those changes automatically.

Print, JSON, and RPC modes have no interactive UI, but indexing and search still work because status operations are guarded by `ctx.hasUI`.

## Privacy and security

- The default embedding model is local.
- No remote embedding provider is configured by this package.
- Index contents remain in the workspace-local `.zvec-grep` directory.
- Pi extensions execute with the user's filesystem permissions. Review package source before installation, especially when enabling it globally for all projects.
- Project-local Pi packages are subject to Pi's project-trust mechanism.

## Current limitations

- Real-time watching exists only while at least one Pi process is running. Startup reconciliation repairs the index after downtime.
- Very large Linux repositories may approach the system `inotify` directory-watch limit, although ignored dependency and build trees are not watched.
- The initial local model download can take time and requires network access if the model is not cached.
- zvec-grep currently stores its index inside the workspace; an external per-user index location would require an upstream storage-layout option.
- Embedding model, device, debounce, and reconciliation intervals are currently fixed defaults rather than user-facing configuration.
- Binary office documents and archives follow zvec-grep's supported-format policy and are not indexed as source text.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

Load the local package in Pi while developing:

```bash
pi -e ./pi-zvec-grep
```

## Source layout

- `src/index.ts`: Pi package entry point.
- `src/extension.ts`: Pi tools, commands, and lifecycle wiring.
- `src/engine.ts`: public zvec-grep engine adapter.
- `src/runtime.ts`: readiness, job serialization, status, and shutdown.
- `src/watcher.ts`: cross-platform filesystem watcher.
- `src/change-batcher.ts`: debounce, maximum-wait, deduplication, and serialized flush.
- `src/workspace.ts`: canonical Git-aware root discovery.

## License

MIT
