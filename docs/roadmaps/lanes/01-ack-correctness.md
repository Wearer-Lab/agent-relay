# Lane 01 — ack-backlog Phase 1 (correctness) and Phase 2 (blockers)

Priority: p0. Labels: correctness.

You implement the four fixes that make a busy room clean itself, minus the
broker-spawn fix (lane 02 owns that), plus the "explain what blocks compaction"
part of Phase 2.

Read `docs/roadmaps/ack-backlog.md` Phase 1 and Phase 2, and
`docs/roadmaps/lanes/README.md` (the shared foundation and the rules) first.

## Files you own

- `lib/compaction.mjs`
- `lib/broker.mjs`, only these parts: the `compact` op, the `prune` op, the
  `agents` op, the `wait` op, the `sweep` function and the `createBroker`
  options it takes.
- a new test file `test/ack-correctness.test.mjs`

Do not touch `lib/registry.mjs`, `lib/ownership.mjs`, `lib/observability.mjs`,
`lib/client.mjs`, `lib/mcp.mjs`, `lib/opencode-plugin.mjs`, `bin/agent-relay.mjs`,
`lib/dashboard*`, `lib/gateway.mjs`, `lib/ledger.mjs`, or any existing test
file. If you need a change in one of those, put the new logic in a new module
under `lib/` and report what to wire.

## What to build

### 1. Stale transports stop counting as live (the broker side)

The liveness rule itself is already in `lib/registry.mjs`; do not re-implement it.

- The `agents` op must show the transport age and the stale flag for every
  agent row: `transportAgeMs` (ms since the last transport report, `null` when
  there is none) and `transportStale` (boolean). The rows already carry
  `readiness.transport`; add the two fields next to it. `registryCounts` already
  reports `staleTransports`.
- The `snapshot` op must show the same two fields. `lib/observability.mjs`
  already adds them to the rows, so check that the broker's snapshot view
  passes them through.
- The sweep must rewrite a stale transport to the truth: when an agent still
  claims `transport.state = 'connected'` but the report is older than the
  stale window, the sweep sets `transport.state = 'unknown'` with
  `source: 'expired'`, so later readers see the truth instead of a stale
  claim. This is a state change, so it goes through the broker's writer.
- The broker must notice a dropped watcher: when an agent's `wait` connection
  closes and no new `wait` arrives within a grace period (default 60 s), mark
  its transport `disconnected` with `source: 'broker'`, without waiting for the
  adapter to report it. The `wait` op is where the connection lives; find how a
  long poll is aborted (`longPoll`, the response close) and hook the grace
  period there. Make the grace period configurable through `createBroker`
  options.

### 2. Per-recipient delivery expiry

A delivery counts as finished when its recipient acked, is retired, or is
dormant or unseen longer than the TTL.

- Broadcast TTL defaults to 7 days. Direct messages default to 30 days, so a
  dormant identity keeps a durable inbox for a month.
- A message is archivable when all its deliveries are finished, so no single
  straggler pins it. This changes `deliveryFinished` in `lib/compaction.mjs`.
- Expose `--broadcast-ttl-days` and `--direct-ttl-days` on the `compact` op
  (the CLI flags come later, in lane 10; you only add the broker fields), the
  matching daemon options and environment variables
  (`AGENT_RELAY_BROADCAST_TTL_DAYS`, `AGENT_RELAY_DIRECT_TTL_DAYS`), and the
  sweep.
- Expired deliveries are written to the archive as `expired`, with the
  recipient and the reason, so the history stays explainable. The archive
  format is one JSON object per line: `{project, message}`. Extend it with the
  expired rows, and keep `validArchived` in step.

### 3. Temporary identities are ephemeral

- `claude-tmp-*`, `codex-tmp-*` and the other fallback identities are ephemeral
  in the prune plan and in the sweep, even without the stored flag (this covers
  the identities that registered before the flag existed).
  `lib/registry.mjs` already exports `looksEphemeral(agent)`; use it, do not
  write a second pattern.
- An ephemeral identity that holds nothing (no claims, tasks, handoffs, process
  records) is retired, not just left, after the ephemeral idle window, so it
  counts as a finished recipient immediately. A retired identity stays
  resolvable for history.
- An ephemeral identity that still holds something is kept and reported, never
  retired.

### 4. Explain what blocks compaction (Phase 2)

- `compact` dry runs list the top blocking identities: how many messages and
  how many delivery rows each one pins, plus their last-seen age and transport
  age. Use `liveness` from `lib/registry.mjs` for the ages.
- `prune` dry runs report "kept: transport connected but not seen for N hours"
  separately from truly live agents. The `kept` counters in the prune report
  are the place; add the split without breaking the existing keys.
- `usage.nearLimit` warns at 80 % of the message cap and names the compaction
  blockers. The `usage` op belongs to lane 03, so do not edit it: export the
  blocker computation from `lib/compaction.mjs` (or a new module) and report
  the exact function name and signature so lane 03 can call it.

## Tests

Create `test/ack-correctness.test.mjs`. Follow the style of
`test/registry.test.mjs`: a `fixture(t)` helper that creates a broker over a
temporary data directory with a `serverFactory` that never binds a port, a
`register` helper, and a `restart(mutate)` helper that closes the broker,
edits `state.json` and reopens it.

Cover at least:

- an agent whose transport report went stale is prunable, and a watcher that
  keeps polling stays live;
- the sweep rewrites a stale `connected` transport to `unknown` with
  `source: 'expired'`;
- a dropped `wait` connection marks the transport `disconnected` with
  `source: 'broker'` after the grace period, and not before;
- one idle non-left recipient no longer blocks a broadcast;
- a direct message to a dormant identity survives 7 days and archives after 30;
- expired deliveries land in the archive with the recipient and the reason;
- legacy `claude-tmp-*` identities get swept, and a tmp identity that holds a
  claim is kept and reported;
- a `compact` dry run names the blocking identity.

## Report

Commit your work. Your final message lists: the files you changed, the new
broker fields and their exact names, the exported functions lane 03 should call
(and the feature names the orchestrator must add to the capability list), the
roadmap items you finished, and anything you could not do.
