# Lane 10 — the surfaces: CLI, MCP tools and OpenCode tools

Priority: p1. Labels: cli, ux.

This lane runs **after** the code lanes, so the broker operations it wires
already exist. Read `docs/roadmaps/lanes/README.md` (the operation contract)
and the lane reports of lanes 01, 03, 04, 05, 06, 07 and 08 first.

## What already exists (do not rebuild it)

- `lib/pending.mjs` — the split and the breakdown; broker op `pending`.
- `lib/bulk.mjs` — the bulk plan; the broker's `leave` and `retire` take
  `stale`, `idleHours`, `prefix`, `runner` and `apply`.
- `lib/schema2.mjs` — `planMigration`, `migrateState`, `isSchema2`,
  `backupStateFile`, `writeStateFile`.
- `lib/registration.mjs` — `sessionIdentity(runner, sessionId)` and the two
  broadcast guards.
- `lib/remote-host.mjs` — `planRemoteHost`, `writeRemoteHostArtifacts`,
  `remoteHostArtifacts`, `remoteHostInstructions`, `pointLocalAtHost`.
- `lib/runtime.mjs` — `resolveNodeRuntime`, `renameWithRetry`.
- The broker's capability list and `lib/client.mjs`'s feature map already know
  the new operations (`pending`, `stale-claims`, `bulk-cleanup`,
  `delivery-ttl`). You do not have to touch either.

## Files you own

- `bin/agent-relay.mjs`
- `lib/mcp.mjs`
- `lib/opencode-plugin.mjs`
- a new test file `test/ack-surfaces.test.mjs`

Do not touch `lib/broker.mjs`, `lib/registry.mjs`, `lib/compaction.mjs`,
`lib/client.mjs`, `lib/pending.mjs`, `lib/bulk.mjs`, `lib/schema2.mjs`,
`lib/registration.mjs`, `lib/remote-host.mjs`, `lib/runtime.mjs`,
`lib/dashboard*`, `lib/gateway.mjs`, or any existing test file.

## What to wire

### 1. The CLI (`bin/agent-relay.mjs`)

- `agent-relay pending [--by recipient|state|age|sender|kind] [--limit N]
  [--json]` — read-only, through the broker, never by reading the file.
- `agent-relay leave --stale --idle-hours N [--prefix PREFIX] [--runner R]
  [--apply]` and the same for `agent-relay retire --stale`. A dry run by
  default; `--apply` changes something. The output must say what was kept and
  why.
- `agent-relay migrate --to 2 [--dry-run]` — the offline migration. It refuses
  to run while a live broker owns the data directory, backs the ledger up
  first, prints the validation report, and is idempotent.
- `agent-relay remote host` — prints (and copies to the clipboard) the
  deployment artifacts for an always-on host, and the steps to point local
  agents at it.
- `agent-relay compact --broadcast-ttl-days N --direct-ttl-days N`.
- `agent-relay prune` keeps reporting "kept: transport connected but not seen
  for N hours" separately from the live agents.
- `agent-relay doctor` surfaces the near-limit warning with the compaction
  blockers, the same ones `usage` names.
- Update `agent-relay help` with every new command and flag, and keep the help
  text honest: run `agent-relay help` and read it back.
- The flag parser in `bin/agent-relay.mjs` keeps a list of boolean flags and
  takes every other flag as `key value`. Add the new boolean flags
  (`--stale`, `--json`) to that list, or they will swallow the next argument.

### 2. The MCP tools (`lib/mcp.mjs`)

- `relay_pending` with the same options as the CLI, paged like the other large
  results (the adapter has a page helper for that).
- `relay_leave` and `relay_retire` gain the bulk options.
- `relay_inbox` mentions the bulk ack when the agent's backlog is larger than
  one page (lane 04 wrote the text; read it from the report or the code).
- `relay_compact` gains the TTL options.

### 3. The OpenCode tools (`lib/opencode-plugin.mjs`)

- The same tool set as MCP: `relay_pending`, the bulk `relay_leave` and
  `relay_retire`, the TTL options on `relay_compact`.

### 4. Wiring the other lanes asked for

Four things the code lanes built and deliberately left to you:

- **The discovery-file rename** in the `daemon` case of the CLI: use
  `renameWithRetry` from `lib/runtime.mjs` instead of a bare `fs.rename`, so
  Windows can replace the file while a dashboard reads it. Pass `project` to
  `ensureBroker` too, so it can find the recorded Node runtime.
- **The identity rule**: the `mcp` case derives `${runner}:${sessionId}` today.
  Call `sessionIdentity(runner, sessionId)` from `lib/registration.mjs` instead,
  so a CLI-launched MCP server and a directly launched adapter are one identity
  for one session.
- **The inbox hint**: when an agent's backlog is larger than one page, the
  `relay_inbox` result mentions the bulk ack (MCP and the OpenCode tool). The
  text is in `docs/registry.md`; use it verbatim.
- **The `*all` limit**: the broker answers `BROADCAST_ALL_RATE_LIMIT` with a
  message that suggests a bulletin. The CLI and the tools show that message
  as it is; do not rewrite it.

### 5. The feature map

`lib/client.mjs` already has a `requiredFeatures` map for the new operations.
Do not edit `lib/client.mjs`. If an operation is not advertised by the running
broker, the client must fail with the existing `UNSUPPORTED_FEATURE` message,
not a crash.

## Tests

Create `test/ack-surfaces.test.mjs`:

- the CLI parses the new flags (a boolean flag must not swallow the next
  argument);
- `agent-relay pending --json` prints the breakdown and changes nothing;
- `agent-relay leave --stale` is a dry run and `--apply` matches it;
- `agent-relay migrate --to 2 --dry-run` refuses nothing and changes nothing,
  and the real migration refuses to run while a broker owns the directory;
- the MCP tool `relay_pending` forwards the exact broker fields;
- the OpenCode tool `relay_pending` mirrors the MCP surface.

The CLI tests run the real binary against a temporary data directory; follow
`test/registry.test.mjs` and `test/cli.test.mjs`.

## Report

Commit your work. Your final message lists: the files you changed, the exact
new commands and flags, the feature names the orchestrator must add to the
capability list and to `lib/client.mjs`, the roadmap items you finished, and
anything you could not do.
