# Lane 03 — ack-backlog Phase 2: numbers that mean something

Priority: p1. Labels: visibility, dashboard.

Read `docs/roadmaps/ack-backlog.md` Phase 2 and `docs/roadmaps/lanes/README.md`
(the shared foundation, the operation contract and the rules) first.

## Files you own

- a new module `lib/pending.mjs`
- `lib/broker.mjs`, only these parts: the `snapshot` op, the `usage` op and the
  new `pending` op.
- a new test file `test/ack-pending.test.mjs`

Do not touch `lib/registry.mjs`, `lib/compaction.mjs`, `lib/client.mjs`,
`lib/mcp.mjs`, `lib/opencode-plugin.mjs`, `bin/agent-relay.mjs`,
`lib/dashboard*`, `lib/gateway.mjs`, `lib/ledger.mjs`, or any existing test
file.

Lane 01 owns the `compact` and `prune` ops and is adding a blocker computation
for them. Lane 03 owns `usage`, so lane 01 will report the name and signature
of the blocker function it exports; if it is not available when you start,
implement the `usage.nearLimit` warning with a local call into
`lib/compaction.mjs` if that function exists, otherwise report what you need
and leave a clear TODO in your report (not a stub that silently does nothing).

## What to build

### 1. Honest headline counts

The room holds pending deliveries for identities nobody can reach. Split
"awaiting acknowledgement" into four groups:

- awaiting live agents,
- held for dormant identities,
- held for retired identities,
- expired (pending archive).

Use `isLive`, `isDormant` and `isRetired` from `lib/registry.mjs`. A retired
recipient can never come back, so its delivery is finished.

- `snapshot` must report the split, and the headline must be the count of
  deliveries awaiting **live** agents. Keep the old total as well, so the sum
  can be checked.
- `usage` must report the same split, and `usage.nearLimit` must warn at 80 %
  of the message cap and name the compaction blockers.
- Per-agent pending counts (the `pendingByAgent` map in the snapshot) must use
  the same split, so a person can see which group each identity's backlog is
  in. Lane 07 renders these in the dashboard; keep the field names stable and
  report them.

### 2. The pending breakdown

A read-only `pending` operation, through the broker, never by reading the file:

```
op 'pending'
input : {by?: 'recipient'|'state'|'age'|'sender'|'kind', limit?: number, offset?: number}
output: {total, counts: {live, dormant, retired, expired},
         groups: [{key, count}],
         rows: [{messageId, from, to, kind, createdAt, ageMs, state, recipients: []}],
         offset, limit}
```

- `by` picks the grouping: by recipient, by state (the four groups above), by
  age bucket, by sender, or by kind (broadcast, direct, task, handoff,
  bulletin). Define the buckets yourself and document them.
- `rows` is the page of pending deliveries; it is bounded and paged like every
  other large result in this codebase.
- `limit` is 1..500 and defaults to 50. `offset` is 0 or more.
- The operation is read-only: it must not register an observer, acknowledge
  anything, or take the writer lease.

### 3. The doctor warning

`agent-relay doctor` already prints `usage.nearLimit`. Make sure the same
warning names the compaction blockers (lane 10 wires the CLI; the broker's
`usage` op is yours).

## Tests

Create `test/ack-pending.test.mjs` with the house `fixture(t)` helper (see
`test/registry.test.mjs`):

- the split sums to the old total, and the headline equals the live-recipient
  count;
- the breakdown on a fixture matches a hand-computed table;
- `pending` is read-only: it does not create an agent, does not change the
  ledger, and reports the same numbers twice;
- the four groups are right for a live, a dormant and a retired recipient;
- `usage.nearLimit` warns at 80 % and names the blockers.

## Report

Commit your work. Your final message lists: the files you changed, the exact
field names the dashboard (lane 07) should render, the feature name the
orchestrator must add to the broker capability list, the roadmap items you
finished, and anything you could not do.
