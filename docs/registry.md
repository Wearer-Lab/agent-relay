# Registry hygiene

Every Codex job registers a new agent ID and never leaves, so a long-lived relay accumulates
thousands of dead identities. Left alone, `to:'*'` reached all of them, receipts showed them as
pending forever, and snapshots grew quadratically. Registry hygiene fixes this without losing
durable inboxes. Broker features: `live-broadcast`, `dormant-delivery`, `ephemeral`, `prune`.

## Liveness

An agent is **live** when it has not left and either its transport is `connected` or it was last
seen (`updatedAt`) within the window. Long polls (`wait`) and every authenticated operation refresh
`updatedAt`. The window is 120 minutes unless a request says otherwise. This is the only liveness
definition: `isLive` / `liveness` in `lib/registry.mjs`. The ownership view reuses it with the
`staleMinutes` threshold as the window (inclusive: an agent seen exactly `staleMinutes` ago is live).

Identity states:

| State | Meaning |
| --- | --- |
| live | not left, connected or seen within the window |
| idle | not left, not live (still addressable, still receives `*all`) |
| dormant | left (by `leave`, ephemeral close or prune) but not retired; re-register reactivates it |
| retired | permanently out; resolvable for history, cannot register or receive |

## Broadcast audiences

`send` with `to`:

- `'*'` reaches live agents seen within `within` minutes (default 120). Connected agents always count,
  however old their last heartbeat.
- `'*all'` keeps the former semantics: every non-left agent except the sender.
- An agent ID is a direct send.

`message.to` is stored exactly as given. The response includes
`audience: {mode: 'live'|'all'|'direct', within, excluded}` where `excluded` is the number of non-left
agents that were skipped. If nobody qualifies, `NO_RECIPIENTS` fails with `excluded`, `within` and
`audience` in the error details, and the message suggests retrying with `*all` or a larger `within`.
(`agent-relay`'s client exposes the error body as `error.details`.)

`'*'` and `'*all'` are reserved and cannot be registered as agent IDs.

## Dormant delivery

Direct sends to a dormant recipient succeed and are stored in its durable inbox
(`recipientDormant: true` in the response). They stay pending until the agent registers again.
Sends to retired identities still fail with `UNKNOWN_AGENT`. Broadcasts never reach dormant agents.

## Ephemeral registrations

`register` accepts `ephemeral: true` (stored on the agent, validated by `validateStore`). The MCP adapter
registers as ephemeral when `AGENT_RELAY_EPHEMERAL=1`, when `--ephemeral` is given to
`agent-relay mcp` / `agent-relay join`, or when it falls back to a temporary `tmp-` session ID.
Pass `ephemeral: false` to `createMcpAdapter` to opt out. An older broker without the `ephemeral`
feature still gets a plain registration.

When the adapter closes (or the CLI's stdin ends) an ephemeral agent calls `leave` with `ifIdle: true`.
The broker leaves only if the agent holds no project or machine claims, branch claims, pending handoffs
(from or to), process records, or open owned work items (any non-terminal status). Otherwise it answers
`{left:false, kept:true, obligations}` and the adapter just reports its transport disconnected.
`obligations` is `{claims, machineClaims, branchClaims, handoffs, processes, tasks}`. The same set guards
`prune`, the automatic sweep and `retire` (`RETIRE_BLOCKED` and `stranded` carry all six lists, tasks
included), so no path can strand work another path would have protected.

## Stable worker names

`AGENT_RELAY_AGENT_ID` (and `--as` on `agent-relay mcp`) sets the agent ID, so pooled jobs reuse
`codex-worker-3` instead of minting an identity per thread. The session ID is still recorded.
Precedence: explicit `agentId`/`--as`, then `AGENT_RELAY_AGENT_ID`, then `<runner>-<session>` (the
`agent-relay mcp` command derives `<runner>:<session>` itself, the form Codex and Claude launches use).

## Pruning

Op `prune` `{idleMinutes = the broker's pruneAfterMinutes (1440 when the sweep is off), ephemeralIdleMinutes = 15, dryRun = true, includeTest = false}`
marks agents dormant (`left: true`, keeping `updatedAt` as the last-seen time) when they are
not left or retired, idle at least the threshold, transport not connected, and hold no obligations
(project claims, machine claims, branch claims, pending handoffs, process records, open owned work items). Ephemeral agents
use the shorter of the two thresholds (`ephemeralIdleMinutes: 0` disables the shorter threshold).
Test-marked agents are skipped unless `includeTest` is true.

```json
{"dryRun": true,
 "candidates": [{"agentId": "codex-019f", "runner": "codex", "lastSeenAt": "...", "ephemeral": true}],
 "total": 1006, "pruned": 0,
 "kept": {"withObligations": 4, "live": 25}, "skippedTest": 0}
```

`candidates` is bounded to the first 200; `total` is the full count. `pruned` is `0` on a dry run.

### Automatic sweep

`createBroker({pruneAfterMinutes = 1440, ephemeralPruneMinutes = 15})` runs the same sweep (non-dry,
every room) at startup and every 10 minutes on an unref'd timer, through the serial writer and never
while closing. `pruneAfterMinutes: 0` disables it. `close()` clears the timer. A sweep with nothing to
prune does not rewrite the ledger. The daemon accepts `--prune-after-minutes N` and
`--ephemeral-prune-minutes N` (env `AGENT_RELAY_PRUNE_AFTER_MINUTES`, `AGENT_RELAY_EPHEMERAL_PRUNE_MINUTES`).

A pruned agent that is still running (for example an idle non-channel session that was never connected)
gets `UNKNOWN_AGENT` on its next call. The MCP adapter and the OpenCode plugin handle that themselves:
the first `UNKNOWN_AGENT` for a call that is not `register` triggers one re-registration (which reactivates
the dormant identity) and one retry; the channel watcher does the same and reports readiness again. A
session that called `relay_leave` is never revived, and a genuinely unknown recipient still fails (after at
most one extra registration). Raw CLI users re-run `join`.

The same sweep also archives finished message history (compaction, `compactAfterDays`, default 14 days); see [the broker notes](./broker-notes.md#compaction). Pruning marks identities dormant without shrinking `state.json`; compaction is what shrinks it, optionally dropping dormant identities that nothing references (`agent-relay compact --drop-identities --apply`).

## Counts and snapshots

The `agents` op `counts` gains `live`, `dormant`, `retired`, `ephemeral` and `prunable` (`live` honors
`within`, default 120; `ephemeral` counts stored ephemeral identities in any state; `prunable` uses the
broker's prune thresholds). `snapshot` gains `registry: {stored, live, dormant, retired, ephemeral, prunable}`
and each agent row gains `live: boolean`. `pendingByAgent` is now computed in one pass over messages.

## Surfaces

| | CLI | MCP | OpenCode |
| --- | --- | --- | --- |
| broadcast | `send --to '*'` / `'*all'` `[--within MIN]` | `relay_send` `to`, `within` | `relay_send` `to`, `within` |
| prune | `prune [--idle-minutes N] [--ephemeral-idle-minutes N] [--include-test] [--apply]` | `relay_prune` | `relay_prune` |
| ephemeral | `join --ephemeral`, `mcp --ephemeral` | `AGENT_RELAY_EPHEMERAL=1` | n/a |

`prune` is a dry run unless `--apply` / `apply: true`.
