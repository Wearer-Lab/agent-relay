# Lane 02 — ack-backlog Phase 1 (broker spawn) and Phase 6 (data-dir hygiene)

Priority: p0 / p1. Labels: correctness, ops.

Read `docs/roadmaps/ack-backlog.md` Phase 1 ("Broker spawn from inside
OpenCode") and Phase 6, and `docs/roadmaps/lanes/README.md` first.

## Files you own

- `lib/client.mjs`
- `lib/broker.mjs`, only the `createBroker` options, the startup path and the
  `close` path. The op dispatch is lane 01's and lane 03's; do not touch the
  ops.
- a new test file `test/ack-runtime.test.mjs`

Do not touch any existing test file, `lib/registry.mjs`, `lib/compaction.mjs`,
`lib/mcp.mjs`, `lib/opencode-plugin.mjs`, `bin/agent-relay.mjs`, `lib/dashboard*`,
`lib/gateway.mjs`.

## What to build

### 1. Broker spawn from inside OpenCode

`ensureBroker` in `lib/client.mjs` spawns the daemon with `process.execPath`.
Inside the OpenCode plugin (and any Bun-based host) `process.execPath` is the
host binary, not Node, so the daemon never starts.

- `ensureBroker` must resolve a real Node runtime: the path recorded by the
  setup step, else `node` on `PATH`, else fail clearly with the one command
  that fixes it. Never spawn `process.execPath` blindly.
- The setup step is `lib/setup.mjs` (`setupProject`), which already writes
  `command: process.execPath` into `.mcp.json` and the Codex config. Extend it
  so the recorded command is the resolved Node runtime, and read it back here.
  `lib/setup.mjs` is not in your list: if you need it, make the change in
  `lib/client.mjs` (a small exported helper the setup can use later) and
  report it.
- Detect a non-Node runtime (an OpenCode or Bun binary) and say so in the
  error, with the fix.
- Retry the Windows `EPERM` / `EACCES` / `EBUSY` failures when renaming
  `broker.json.*.tmp` to `broker.json`, the way the state file replace already
  does in `lib/broker.mjs` (`replaceFile`). Factor the retry into one helper and
  use it for both.

### 2. Data directory hygiene (Phase 6)

- At startup, remove stale `broker.json.*.tmp`, `.state-*.tmp` and old
  `state.backup-*` files (keep the newest few), and log what was removed. The
  cleanup must never touch a file the running broker is using.
- Write only broker output to `broker.log`, with timestamps, and rotate it by
  size. Today `ensureBroker` opens `broker.log` and hands its descriptor to the
  child. Timestamped, rotated output means the daemon itself must write the
  lines (or the child must be wrapped), so decide the cleanest way and keep it
  working on macOS, Linux and Windows.
- Record "another live broker owns this data directory" refusals with the
  owning PID once, not on every client start. Today `discovery` returns null
  for a dead broker and the caller starts a new one; the refusal case is the
  one where a live broker holds the writer lease.

## Tests

Create `test/ack-runtime.test.mjs`:

- the spawn command is Node, not the host binary: resolve the runtime through
  the helper you wrote and assert on the resolved command;
- a missing Node gives one clear error that names the fix;
- the discovery-file rename retries on Windows (simulate by making `rename`
  fail with `EPERM` twice through an injectable seam, then succeed);
- startup cleanup leaves the current files untouched and removes the stale
  ones;
- log rotation keeps the bound;
- the "another live broker owns this data directory" message is written once
  per owning PID.

The existing tests use `execFile` against the real CLI and temporary data
directories; follow `test/registry.test.mjs` and `test/write-path.test.mjs` for
the house style.

## Report

Commit your work. Your final message lists: the files you changed, the exact
name and signature of the runtime-resolution helper (lane 10 wires it into the
CLI and lane 04 may need it for the plugin), the new environment variables, the
roadmap items you finished, and anything you could not do.
