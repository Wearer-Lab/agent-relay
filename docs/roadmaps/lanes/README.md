# Wave lanes

One file per lane. Each lane is one agent session that owns a disjoint set of files
and implements one slice of `docs/roadmaps/ack-backlog.md` and
`docs/roadmaps/remote-agents.md`.

The lanes run at the same time, each in its own git worktree and branch, so two
agents never touch the same file at the same time. The orchestrator merges the
branches afterwards and resolves the few places where two lanes needed the same
line.

## Rules for every lane

1. Work only inside your worktree. Never edit the main checkout.
2. Edit only the files your lane owns. Every other file is another lane's.
3. Put new tests in a NEW file (`test/<lane>.test.mjs`). Never edit an existing
   test file, and never edit a test file another lane owns.
4. Do not edit the roadmap markdown, `CHANGELOG.md` or `README.md`. Report what
   you finished instead; the orchestrator ticks the boxes.
5. Do not edit the broker's capability list (`lib/broker.mjs`, the `capabilities`
   op) or the feature map in `lib/client.mjs`. Report the feature names you need
   and the orchestrator wires them.
6. Commit your work on your branch. A commit per coherent step is fine; the last
   commit must leave the tree clean and the lane's own tests green.
7. Run `node --test --test-timeout=120000 test/<your test file>` and the full
   `npm test` before you finish. Report the exact commands and their result.

## Shared foundation (already on every branch)

`lib/registry.mjs` is the one liveness definition. Do not add a second one.

```js
DEFAULT_LIVE_WINDOW_MINUTES = 120      // how long a seen identity stays live
DEFAULT_TRANSPORT_STALE_MINUTES = 5     // a connected transport stops counting after this
transportAgeMs(agent, {now})            // ms since the last transport report, or null
isTransportFresh(agent, {now, transportStaleMinutes})
isTransportStale(agent, {now, transportStaleMinutes})
isLive(agent, {now, withinMinutes, transportStaleMinutes})
liveness(agent, {now, withinMinutes, transportStaleMinutes})
//   -> {holder:'active'|'stale'|'left'|'retired'|'missing', live, lastSeenAgeMs,
//        transportAgeMs, transportStale, stale}
broadcastAudience(room, from, to, {within, now, transportStaleMinutes})
planPrune(state, room, {idleMinutes, ephemeralIdleMinutes, includeTest, now, transportStaleMinutes})
registryCounts(state, room, {...})
//   -> {stored, live, dormant, retired, ephemeral, staleTransports, prunable}
pendingByAgent(room)
looksEphemeral(agent)                   // true for `claude-tmp-*` style fallback identities
```

A connected transport counts as live only while `updatedAt` **or** `transport.ts`
is inside the stale window. An old "connected" report is a claim, not a fact.

## Broker operation contract (fixed, so lanes agree)

New operations the lanes add, with the exact shape they must use.

```js
// op 'pending'   (Phase 2: honest counts and the pending breakdown)
input : {by?: 'recipient'|'state'|'age'|'sender'|'kind', limit?: number, offset?: number}
output: {total, counts: {live, dormant, retired, expired},
         groups: [{key, count}],
         rows: [{messageId, from, to, kind, createdAt, ageMs, state, recipients: []}],
         offset, limit}
// `state` is one of 'awaiting-live' | 'awaiting-dormant' | 'awaiting-retired' | 'expired'.

// op 'leave' and op 'retire', bulk form (Phase 3)
input : {stale?: true, idleHours?: number, prefix?: string, runner?: string, apply?: boolean}
output: {dryRun, candidates: [{agentId, runner, lastSeenAgeMs}],
         kept: [{agentId, obligations}], skippedLive: [agentId], changed: number}

// op 'staleClaims' (Phase 3: stale claims surfaced)
output: {claims: [{resource, agentId, scope, ageMs, lastSeenAgeMs, holder}]}
```

## Lanes

| Lane | Roadmap | Owns |
| --- | --- | --- |
| `00-phase0-operator` | ack Phase 0 | the live data dir; writes one report |
| `01-ack-correctness` | ack Phase 1 (liveness, TTL), Phase 2 (blockers) | `lib/compaction.mjs`, the compact/prune/agents/wait/sweep parts of `lib/broker.mjs` |
| `02-ack-runtime` | ack Phase 1 (spawn), Phase 6 (hygiene) | `lib/client.mjs`, the startup part of `lib/broker.mjs` |
| `03-ack-pending` | ack Phase 2 (counts, breakdown) | new `lib/pending.mjs`, the snapshot/usage/pending parts of `lib/broker.mjs` |
| `04-ack-bulk` | ack Phase 3 | new `lib/bulk.mjs`, the leave/retire/blocked parts of `lib/broker.mjs`, `docs/registry.md` |
| `05-ack-registration` | ack Phase 4 | new `lib/registration.mjs`, `lib/mcp.mjs`, `lib/opencode-plugin.mjs`, the register/send parts of `lib/broker.mjs` |
| `06-ack-schema2` | ack Phase 5 | new `lib/schema2.mjs`, `lib/ledger.mjs`, the schema and message parts of `lib/broker.mjs` |
| `07-remote-dashboard` | remote Phase 5 | `lib/dashboard*`, `lib/gateway.mjs` |
| `08-remote-hardening` | remote Phase 2, Phase 6 | new `test/support/fake-tunnel.mjs`, new `test/remote-e2e.test.mjs`, new `docs/threat-model.md`, new `lib/remote-host.mjs` |
| `09-ack-docs` | ack Phase 7 | `README.md`, `CHANGELOG.md`, new `docs/large-rooms.md`, `docs/runbook-backlog.md`, `docs/trust-model.md` |
| `10-surfaces` | wiring for all of the above | `bin/agent-relay.mjs`, `lib/mcp.mjs`, `lib/opencode-plugin.mjs` |

Lanes 00 to 08 run at the same time. Lanes 09 and 10 run after them, because
they describe and wire what the first nine actually shipped.
