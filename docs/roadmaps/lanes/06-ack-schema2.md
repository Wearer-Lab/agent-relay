# Lane 06 — ack-backlog Phase 5: store a broadcast once (schema 2)

Priority: p2. Labels: schema, performance.

Read `docs/roadmaps/ack-backlog.md` Phase 5 and `docs/roadmaps/lanes/README.md`
first.

This is the riskiest lane in the wave: it changes the on-disk shape of the
ledger. **Schema 1 must keep working exactly as it does today.** Schema 2 is
opt-in, behind an explicit offline migration.

## Files you own

- a new module `lib/schema2.mjs`
- `lib/ledger.mjs`
- `lib/broker.mjs`, only these parts: `SCHEMA_VERSION`, `validateStore`, and
  the `inbox`, `ack`, `receipt`, `history` and `outbox` ops.
- a new test file `test/ack-schema2.test.mjs`
- a new script `scripts/bench-schema2.mjs`

Do not touch `lib/registry.mjs`, `lib/compaction.mjs`, `lib/client.mjs`,
`lib/mcp.mjs`, `lib/opencode-plugin.mjs`, `bin/agent-relay.mjs`,
`lib/dashboard*`, `lib/gateway.mjs`, or any existing test file.

## What to build

### 1. The cursor model

- Schema 2 stores a broadcast once, with its audience rule and the audience
  snapshot it was sent to, instead of one row per recipient. Each agent has a
  `readThrough` cursor for broadcasts, plus explicit acks for direct messages.
- Receipts for a broadcast are computed from the cursors (who has read through
  it) instead of stored rows.
- The message shape gains what schema 2 needs. Keep the schema 1 shape valid:
  `validateStore` accepts a schema 1 state and a schema 2 state, and rejects a
  mixed one (a schema 2 version with schema 1 messages) with a clear error that
  names the fix (`agent-relay migrate --to 2`).
- The broker refuses to run on a mixed state. Say so plainly and do not
  half-read it.

### 2. The offline migration

```
lib/schema2.mjs exports:
  planMigration(state, {to = 2, now})  -> {from, to, dryRun: true, counts, changes, warnings}
  migrateState(state, {to = 2, now})  -> {state, report}
  isSchema2(state)                    -> boolean
```

- The migration is offline: the broker is stopped, the state file is read,
  migrated, backed up and written back. The CLI command (`agent-relay migrate
  --to 2`, with `--dry-run`) is lane 10's; you provide the functions, the
  backup discipline and the validation report.
- The report says what changed: message count, broadcast count, recipient rows
  removed, bytes before and after, and anything the migration could not decide.
- The migration is idempotent: migrating an already-migrated state changes
  nothing.

### 3. Clients keep working

- Clients feature-detect schema 2 and keep the old inbox and ack shapes, so the
  adapters work unchanged. The broker already reports its schema in
  `capabilities.runtime.schema`; make sure it reports 2 for a migrated state.
- The MCP adapter and the OpenCode plugin are lane 05's files; do not edit
  them. Make sure the broker's responses keep the same shape for a schema 1
  client, and report what a schema 2 client needs to know.

### 4. Proof

- `scripts/bench-schema2.mjs` builds a large fixture, migrates it, and prints
  the row and size reduction. It must run in a few seconds.
- `test/ack-schema2.test.mjs` proves inbox, ack, receipt, history and outbox
  are equivalent before and after the migration on a large fixture.

## Guardrails

- Schema 1 stays the default. Nothing you write may make a schema 1 state
  unreadable, and the existing tests must keep passing.
- The migration never deletes a message. It changes how a broadcast's
  deliveries are stored, and the old rows are recoverable from the backup.
- Keep `lib/ledger.mjs` byte-exact: the cached serializer must still produce
  exactly `JSON.stringify(state)` and the exact byte length. The existing
  `test/write-path.test.mjs` checks that; do not break it.

## Tests

Create `test/ack-schema2.test.mjs`:

- `planMigration` reports the counts and changes nothing;
- `migrateState` is idempotent and keeps every message;
- inbox, ack, receipt, history and outbox give the same answers before and
  after the migration;
- the broker refuses a mixed state with a clear error;
- a schema 1 state still validates and still works.

## Report

Commit your work. Your final message lists: the files you changed, the exact
schema 2 state shape, the exported function names and signatures lane 10 needs
for `agent-relay migrate --to 2`, the before/after numbers from your benchmark,
the roadmap items you finished, and anything you could not do.
