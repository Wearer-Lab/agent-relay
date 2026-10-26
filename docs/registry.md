# Registry hygiene

Every Codex job registers a new agent ID and never leaves, so a long-lived relay accumulates
thousands of dead identities. Left alone, `to:'*'` reached all of them, receipts showed them as
pending forever, and snapshots grew quadratically. Registry hygiene fixes this without losing
durable inboxes. Broker features: `live-broadcast`, `dormant-delivery`, `ephemeral`, `prune`,
`bulk-cleanup`, `stale-claims`.

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

## Bulk stale cleanup

`leave` and `retire` have a bulk form, so an owner never has to script against the ledger. It is a
dry run unless `apply: true` is passed.

```
op 'leave' / op 'retire', bulk form
input : {stale?: true, idleHours?: number, prefix?: string, runner?: string, apply?: boolean, actor?: string}
output: {dryRun, mode, candidates: [{agentId, runner, lastSeenAgeMs}],
         kept: [{agentId, obligations}], skippedLive: [agentId], changed: number}
```

The bulk form is selected by the scope fields (`stale`, `idleHours`, `prefix`, `runner`). `apply`
on its own still means the one identity named by `agentId`, so `leave --as X --apply` never turns
into a sweep.

- `stale` states the intent; only identities that are **not live** are ever touched. A live
  identity is reported in `skippedLive` and never changed.
- `idleHours` is the wall-clock idleness floor. Default: the broker's prune threshold
  (`pruneAfterMinutes`, 1440 minutes = 24 hours).
- `prefix` scopes by agent id prefix (`claude-tmp-`), `runner` by exact runner name. Both narrow
  the population together.
- `apply` is false by default. `actor` names who ran the action and is written to the audit log
  (default `operator`).

An identity that holds a project claim, a machine claim, a branch claim, a pending handoff, a
process record or an open owned work item is **never stranded**: it is reported in `kept` with
the obligations it holds, and it stays active. The obligation set is the one `prune` and the
sweep use (`obligationIndex` in `lib/registry.mjs`), so the three paths cannot disagree.

```json
{"dryRun": true, "mode": "leave",
 "candidates": [{"agentId": "claude-tmp-1", "runner": "claude", "lastSeenAgeMs": 172800000}],
 "kept": [{"agentId": "builder",
           "obligations": {"claims": ["build"], "machineClaims": [], "branchClaims": [],
                           "handoffs": [], "processes": [], "tasks": ["t-1"]}}],
 "skippedLive": ["reviewer"], "changed": 0,
 "total": {"candidates": 1, "kept": 1, "skippedLive": 1},
 "scope": {"stale": true, "idleHours": 24, "prefix": "claude-tmp-"}}
```

`changed` is `0` on a dry run and the number of identities changed on an applied run. An applied
run reports the same candidate list as the dry run that preceded it, so the two can be compared
row by row. Each list is bounded to 200 rows; `total` carries the full counts.

### The bulk audit log

Every applied bulk action is recorded in `bulk-audit.log` in the data directory: one JSON object
per line, the newest last. A dry run is not an action and is not logged.

```json
{"at":"2026-10-26T09:12:44.101Z","event":"bulk-leave","actor":"ops@example","project":"/repo",
 "scope":{"stale":true,"idleHours":24,"prefix":"claude-tmp-"},"dryRun":false,
 "changed":["claude-tmp-1"],"changedCount":1,"changedKind":"identities",
 "kept":[],"skippedLive":[]}
```

The file is owner-only (mode 600), rotates to `bulk-audit.log.1` past 1 MiB, and never holds a
token or a secret: secret-shaped fields are redacted and long strings are truncated before they
are written. The gateway keeps its own trail (`remote-audit.log`) for cloud agents; this one is
for the local operator's bulk actions.

## Stale claims

A claim is **stale** when its owner is no longer live: the owner left, retired, or was idle past
the window. Stale claims are surfaced, never released silently.

Op `staleClaims` `{staleMinutes?}` returns `{claims: [{resource, agentId, scope, ageMs, lastSeenAgeMs, holder}]}`.
`scope` is `project`, `machine` or `branch`; `holder` is the owner's liveness state (`active`,
`stale`, `left`, `retired`, `missing`); `ageMs` is the age of the claim and `lastSeenAgeMs` the
age of the owner's last sighting. The same list is part of the `blocked` view
(`blocked.staleClaims`), so a caller that already reads `blocked` sees it without a second call.

### Opt-in release

`createBroker({releaseStaleClaimsHours: 0})` is off by default. When it is set to N, the broker
releases claims that are older than N hours **and** whose owner is dormant (left) or retired. A
claim held by a live owner is never released, and neither is one held by an owner that is merely
idle. Each release writes a release-log entry (`state.releaseLog`, one per scope) and leaves a
notice in the room (`room.notices`, the newest 100 kept). The release is audited like any other
bulk action:

```json
{"at":"2026-10-26T09:12:44.101Z","event":"auto-release-stale-claims","actor":"daemon","project":"/repo",
 "scope":{"hours":6},"dryRun":false,"changed":["project:src/app.ts"],"changedCount":1,
 "changedKind":"claims","owners":["claude-tmp-1"]}
```

The daemon flag itself (`--release-stale-claims-hours N`) is a CLI concern; the broker option is
`releaseStaleClaimsHours`.

## Marking your own backlog read

An agent that has worked through its inbox can mark the whole backlog read in one call:

- `agent-relay ack --as ME --all` acknowledges every unacknowledged delivery to `ME`.
- `agent-relay ack --as ME --through CURSOR` acknowledges every delivery up to and including
  `CURSOR`, which is the cursor the inbox reported.
- MCP: `relay_ack({all: true})` and `relay_ack({through: <cursor>})`.

`--all` and `--through` are mutually exclusive; `--through` takes the cursor from the last
inbox page. Acks are per recipient, so acknowledging marks the delivery done for that identity
only.

**Acking for an identity you do not run creates a false receipt.** The ledger will say that agent
handled work it never read, and the message disappears from its backlog. Ack only as yourself.

## Trust model of ids and acks

Agent IDs are **cooperative identities**, not authentication. Nothing proves that the process
holding an ID is the one that registered it. On a single-user machine the broker token is the
trust boundary: whoever holds it can speak for any identity in the room.

That is why `leave --as` and `ack --as` work for any known ID, and why the bulk cleanup above
can act on identities the caller does not run. It is a deliberate trade: the relay coordinates
agents that share one machine and one owner, and refusing a cooperative `leave` would leave
dead identities behind. The consequences are on the caller:

- `ack --as` for someone else is a false receipt (above);
- `leave --as` for someone else strands that agent's obligations;
- the bulk form is therefore a dry run first, keeps every identity that still holds work, and
  writes an audit log naming who ran it.

## Surfaces

| | CLI | MCP | OpenCode |
| --- | --- | --- | --- |
| broadcast | `send --to '*'` / `'*all'` `[--within MIN]` | `relay_send` `to`, `within` | `relay_send` `to`, `within` |
| prune | `prune [--idle-minutes N] [--ephemeral-idle-minutes N] [--include-test] [--apply]` | `relay_prune` | `relay_prune` |
| bulk cleanup | `leave --stale --idle-hours N [--prefix P] [--runner R] [--apply]`, `retire ...` | n/a | n/a |
| stale claims | `blocked`, `staleClaims`, daemon `--release-stale-claims-hours N` | n/a | n/a |
| acknowledge | `ack --as ME --all`, `ack --as ME --through CURSOR` | `relay_ack` `all`, `through` | `relay_ack` `all`, `through` |
| ephemeral | `join --ephemeral`, `mcp --ephemeral` | `AGENT_RELAY_EPHEMERAL=1` | n/a |

`prune` is a dry run unless `--apply` / `apply: true`. The bulk cleanup is a dry run unless
`--apply` / `apply: true`.
