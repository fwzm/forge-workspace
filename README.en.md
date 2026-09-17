**English** | [简体中文](README.md)

# FORGE — Autonomous Software Engineering Workspace

A local, zero-dependency multi-agent software engineering workbench simulator.
Node.js backend + vanilla HTML/CSS/JS frontend (no frameworks, no npm packages).
Runs as a **Windows desktop app** (Edge/Chrome app-mode window) or a plain
local web server — and can **orchestrate real agent CLIs** (Codex, Claude Code)
in fully automated pipelines with a human merge gate.

## Real-agent orchestration (patch mode)

The orchestrator drives your installed agent CLIs through the same task DAG
the simulated agents use:

```
issue ─▶ external implementer (codex/claude) ─▶ internal QA + security engines
      ─▶ external reviewer ─▶ CI (lint/unit/integration/security/build)
      ─▶ PR (approved + green) ─▶ ⏸ human merge gate (default) or auto-merge
```

Safety model:

- **Patch mode** — the agent never touches your real files or the virtual
  repository directly. Its whole workspace is exported to an isolated temp
  directory (`%TEMP%\forge-<agent>-…`); FORGE diffs the result back and
  applies only that changeset, then runs the CI engines as the arbiter.
- **Human merge gate** — pipelines park at "PR approved + CI green" until you
  click Merge (enable `autoMergeExternal` in Settings to skip; not
  recommended).
- **Circuit breaker** — three consecutive external failures disable the
  auto-scheduler and write an audit entry instead of looping forever.
- Empty agent output fails the task (no silent no-ops), and every step lands
  in the audit log.

Adapters ship for **Codex CLI** (`codex exec`, stdin prompt) and
**Claude Code** (`claude -p --permission-mode acceptEdits`, stdin prompt);
both are probed via Settings → *External agents*. Adding another CLI is one
object in `server/orchestration/adapters.js`.

## Run — Windows desktop app

Double-click **`desktop\Start-FORGE.vbs`** (or the desktop shortcut created by
`desktop\Install-Shortcut.ps1`). It starts the workspace server under
`%LOCALAPPDATA%\FORGE`, opens a chromeless app window, and shuts everything
down when you close that window. Requires Node.js on PATH and Microsoft Edge
(preinstalled on Windows 10/11) or Google Chrome.

```
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\Install-Shortcut.ps1   # desktop shortcut with icon
node desktop\make-icon.js                                                          # regenerate desktop\forge.ico
```

## Run — local web server

```bash
node server/index.js          # http://127.0.0.1:7788  (env: FORGE_PORT, FORGE_DATA_DIR)
```

Open the UI, click **Reset & seed demo**, then **Run all steps** to watch the full
scenario: issue → planner DAG → buggy implementation → failing QA → failing security
scan → fix → reviewer request-changes → fix → CI green → approve → merge.

## Test

```bash
npm test                      # or: node test/run-all.js
```

273 automated tests (see `test-report.json` after a run): state machine, task DAG,
scheduler, repository, diff, 3-way merge, PR gate, CI pipeline, permissions,
audit, persistence, terminal, demo scenario, HTTP API, i18n dictionary
integrity (en/zh-CN key parity, placeholder parity, orphan/reference scan),
and the Windows desktop launcher (port picking, launch-info handshake, icon
format, launcher-script wiring, headless boot). The orchestration suite runs
the full pipeline against injectable fake adapters — implement → gates →
review → CI → human/auto merge, request-changes gating, the circuit breaker,
empty-output rejection and sandbox path-confinement — so the orchestration
logic is verified without spending tokens; real-CLI runs are smoke-tested
separately.

## Architecture

```
browser (vanilla ES modules)          server (Node http, zero deps)
┌─────────────────────────┐           ┌────────────────────────────────────┐
│ main.js  router+keys    │  fetch    │ index.js ─ main.js                 │
│ store.js polling state  │ ────────► │ routes-core/repo/collab + jsonio   │
│ views/*  11 views       │ ◄──────── │ static.js (UI assets)              │
│ actions.js guards       │  JSON     │ terminal.js (shell)                │
│ i18n.js  en/zh-CN       │           │ domain/  workspace facade+perms    │
└─────────────────────────┘           │  tasks(DAG+FSM) repo(Commits)      │
                                      │  merge(diff3) pr ci agents         │
                                      │ agents/runners.js internal runners │
                                      │ engines/ harness(vm) lint security │
                                      │          build review              │
                                      │ orchestration/ real-CLI orchestr.  │
                                      │  export(isolate) adapters(codex/   │
                                      │  claude) orchestrator(pipeline)    │
                                      │ demo/ seed + 15-step scenario      │
                                      └────────────────────────────────────┘
```

- **Unified message protocol**: every agent action posts `{id, agent, timestamp, task,
  status, input, output, artifacts, dependencies}`.
- **Task FSM**: `blocked → ready → running → completed|failed|paused → …`;
  `failed --retry--> ready`; cancel from every non-terminal state. Illegal
  transitions throw `FORGE_INVALID_TRANSITION` with the explicit pair.
- **Scheduler**: dependency satisfaction promotes `blocked → ready`; container
  tasks (split parents) auto-complete when all children complete; optional
  auto-scheduler assigns and executes ready tasks.
- **Repository**: content-addressed blobs (SHA-256), flat trees, hash-chained
  commits (tree+parents+message+author+timestamp), branches as refs, working
  tree with dirty tracking, diff3 merge with conflict markers and
  ours/theirs/manual resolution.
- **PR gate**: merge requires the configured required checks green on the head
  SHA (latest run) **and** ≥1 approval scoped to that head; conflicts surface
  as `FORGE_CONFLICT` and are resolved on the target branch.
- **CI**: lint / unit / integration / security / build execute real engines over
  a real snapshot; repo tests run in a locked-down `vm` sandbox with a mini
  describe/it/assert harness and repo-relative require (no fs/process access).
- **Permissions**: role × action matrix (admin/planner/implementer/reviewer/
  qa/security/viewer/system) enforced at the workspace facade; toggleable,
  always audited.
- **Persistence**: every mutation serializes the whole workspace atomically
  (tmp+rename) to `data/workspace.json`; import/export uses the same envelope
  (`format: "forge.workspace", version: 1`).
- **Audit**: append-only log of every significant state change with actor,
  from/to details (capped at 5000 entries).
- **Multi-language UI (i18n)**: English / 简体中文, switchable from the
  sidebar quick-switch or Settings; preference persists in `localStorage`
  (browser language is auto-detected on first visit). All chrome, statuses,
  severities and toasts are localized through a single dictionary
  (`public/js/i18n/messages.json`) with `{param}` interpolation.

## Security notes

- The server makes **no outbound requests**; the only URL parsing is the request
  target of the local HTTP server itself.
- All JSON responses are serialized through one encoded channel
  (`jsonio.encodeJson`: `< > & U+2028 U+2029` neutralized, OWASP JSON
  hardening) with `X-Content-Type-Options: nosniff`; static serving is isolated
  in its own module with path confinement.
- Repo test execution runs in a `vm` sandbox without host globals; repo paths
  are validated (`../`, absolute paths, weird chars rejected); request bodies
  are size-capped and JSON-validated; every API error is a typed
  `ForgeError` with a stable code.

## Known limitations

- Single-user local workspace (API actor is always the local admin); no auth.
- Sandbox test harness supports sync + promise-returning tests, flat
  describe blocks; no beforeEach/afterEach hooks.
- Multi-line empty-catch and more advanced lint/security rules are out of
  scope; the security scanner is pattern-based (deterministic, no taint
  analysis).
- Merge resolution is per-file ours/theirs/manual content (no per-hunk
  picking); rename/rename and directory-level conflicts are not modelled.
- Audit log and messages are capped (5000 / 4000 entries) to bound memory;
  older entries are dropped, not archived.
- `autoScheduler` drains ready tasks sequentially; there is no per-agent
  concurrency model.
- The demo scenario is orchestrated through real APIs step by step, but the
  step sequence itself is fixed (it is a demo, not an autonomous planner).
- Server-side strings (API error messages, terminal command output, demo step
  names) are English-only; the i18n layer covers the web UI. Language is a
  client-side preference, not part of the persisted workspace state.
- The desktop app is an app-mode browser window over the local server (no
  Electron-style bundling), so it needs Node.js on PATH; it is Windows-only
  (VBS launcher). A packaged single-exe build is out of scope.
- External orchestrator failures need a manual Retry (no auto-retry, to avoid
  burning tokens); no dsh/zcode adapters ship.
