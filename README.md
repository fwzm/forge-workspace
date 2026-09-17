# FORGE — Autonomous Software Engineering Workspace

A local, zero-dependency multi-agent software engineering workbench simulator.
Node.js backend + vanilla HTML/CSS/JS frontend (no frameworks, no npm packages).
Runs as a **Windows desktop app** (Edge/Chrome app-mode window) or a plain
local web server.

## Run — Windows desktop app

Double-click **`desktop\Start-FORGE.vbs`** (or a shortcut created by
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

259 automated tests (see `test-report.json` after a run): state machine, task DAG,
scheduler, repository, diff, 3-way merge, PR gate, CI pipeline, permissions,
audit, persistence, terminal, demo scenario, HTTP API, i18n dictionary
integrity (en/zh-CN key parity, placeholder parity, orphan/reference scan),
and the Windows desktop launcher (port picking, launch-info handshake, icon
format, launcher-script wiring, headless boot).

## Architecture

```
browser (vanilla ES modules)          server (Node http, zero deps)
┌─────────────────────────┐           ┌────────────────────────────────────┐
│ main.js  router+keys    │  fetch    │ index.js ─ main.js                 │
│ store.js polling state  │ ────────► │ routes-core/repo/collab + jsonio   │
│ views/* 11 views        │ ◄──────── │ static.js (UI assets)              │
│ actions.js guards       │  JSON     │ terminal.js (shell)                │
└─────────────────────────┘           │ domain/                            │
                                      │  workspace.js  facade+permissions  │
                                      │  tasks.js      DAG + FSM + sched   │
                                      │  repo.js       blobs/trees/commits │
                                      │  merge.js      diff3 3-way merge   │
                                      │  pr.js ci.js   gate: checks+approve│
                                      │  agents.js     registry+protocol   │
                                      │  audit.js persistence.js           │
                                      │ agents/runners.js  real agent work │
                                      │ engines/ harness(vm) lint security │
                                      │          build review              │
                                      │ demo/  seed + 15-step scenario     │
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

- Server makes **no outbound requests**; the only URL parsing is the request
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
