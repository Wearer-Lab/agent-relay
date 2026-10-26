# Runbook: a stuck backlog

One page. Use it when `agent-relay pending` shows a backlog that nobody is going to read, or
when the ledger stopped growing and you do not know why.

Every step below is a dry run first. Nothing changes until you add `--apply`.

## 0. Look before you touch anything

```sh
agent-relay pending --by state
agent-relay usage
```

`pending --by state` splits the backlog into four groups:

| Group | Meaning | What clears it |
| --- | --- | --- |
| `awaiting-live` | a live agent can still read the delivery | the agent reads and acks it |
| `awaiting-dormant` | the recipient left or was never seen; the delivery waits in a durable inbox | the identity is retired, or the TTL passes |
| `awaiting-retired` | the recipient is retired and can never come back | `compact` archives it |
| `expired` | the delivery outlived its TTL and waits for the archive | `compact` archives it |

A delivery is finished when its recipient acked it, is retired, or is dormant or unseen longer
than the TTL: 7 days for a broadcast, 30 days for a direct message.

`usage` reports the ledger size against the limits (10,000 messages, 64 MB) and names the
identities that pin the most messages. A room near the message limit has about two days of
runway; act now, not on Friday.

**Safe to do next:** nothing. Read the numbers.

## 1. Diagnose: who is holding the backlog

```sh
agent-relay pending --by recipient --limit 50
agent-relay pending --by age
agent-relay pending --by kind
agent-relay compact --older-than-days 3
```

| Command | What it prints | What it tells you |
| --- | --- | --- |
| `pending --by recipient` | one row per identity, biggest first, with the identity's own split | who owes the acknowledgements |
| `pending --by age` | `under-1h`, `1h-to-1d`, `1d-to-7d`, `7d-to-30d`, `over-30d` | whether the backlog is fresh traffic or years of history |
| `pending --by kind` | `broadcast`, `direct`, `task`, `handoff`, `bulletin` | whether the room is drowning in broadcasts |
| `compact` (dry run) | `archivedMessages`, `retainedMessages`, `bytesBefore`, `bytesAfter` and a `blockers` list | how much would be archived, and who pins the rest |

The `blockers` list is the answer to "why did nothing move". Each entry names one identity, how
many messages it pins and how long ago it was seen.

**Safe to do next:** still nothing. Compare the blockers with the identities you know are gone.

## 2. Clean: leave the identities that are gone

First a dry run:

```sh
agent-relay leave --stale --idle-hours 24
```

It prints:

```json
{"dryRun": true, "mode": "leave",
 "candidates": [{"agentId": "claude-tmp-1", "runner": "claude", "lastSeenAgeMs": 172800000}],
 "kept": [{"agentId": "builder",
           "obligations": {"claims": ["build"], "machineClaims": [], "branchClaims": [],
                           "handoffs": [], "processes": [], "tasks": ["t-1"]}}],
 "skippedLive": ["reviewer"], "changed": 0,
 "total": {"candidates": 1, "kept": 1, "skippedLive": 1},
 "scope": {"stale": true, "idleHours": 24}}
```

| Field | Meaning |
| --- | --- |
| `candidates` | identities that are not live, idle past the threshold and hold nothing. These would be left. |
| `kept` | identities that hold an obligation. They stay active and the obligations are named. |
| `skippedLive` | identities that are still live. They are never touched. |
| `changed` | `0` on a dry run; the number of identities changed on an applied run |
| `scope` | the scope you asked for, echoed back |

Narrow the population before you apply:

```sh
agent-relay leave --stale --idle-hours 24 --prefix claude-tmp-
agent-relay leave --stale --idle-hours 24 --runner codex
```

Then apply:

```sh
agent-relay leave --stale --idle-hours 24 --apply
```

An applied run reports the same candidate list as the dry run, so you can compare them row by
row. Every applied run is written to `bulk-audit.log` in the data directory, naming the actor,
the scope and the identities that changed. A dry run is not logged.

**"Safe to do" means:**

- every candidate is idle past the threshold you chose, and
- no candidate is on the `kept` list, and
- you have checked the `kept` list by hand: those identities hold real work.

**Safe to do next:** apply the leave.

### Retiring instead of leaving

`leave` marks an identity dormant: it still receives direct messages in a durable inbox, and
re-registering brings it back. `retire` marks it finished: it can never come back, and its
deliveries become `awaiting-retired` and get archived.

```sh
agent-relay retire --stale --idle-hours 24 --apply
```

Retire a role that is gone for good (a finished worktree, a decommissioned service). Leave a
role that might come back.

## 3. Archive: move the finished messages out

```sh
agent-relay compact --older-than-days 3
agent-relay compact --older-than-days 3 --apply
```

The dry run prints `archivedMessages`, `retainedMessages`, `expiredDeliveries`, `bytesBefore`,
`bytesAfter` and the archive file it would write (`null` when there is nothing to archive).
The applied run writes the same numbers and names the archive file.

`compact` never deletes. The messages move into `<dataDir>/archive/` as fsynced JSONL files, and
the ledger keeps the range.

Two optional flags:

```sh
agent-relay compact --older-than-days 3 --drop-identities --apply
```

`--drop-identities` also removes dormant identities that nothing references. Retired
identities are always kept, and an identity that any retained message, claim, task, handoff or
process record points at is kept.

```sh
agent-relay compact --older-than-days 3 --broadcast-ttl-days 7 --direct-ttl-days 30 --apply
```

The TTLs decide when a delivery is finished. Lowering them frees old broadcasts sooner;
raising them keeps a dormant lane's inbox longer. The defaults are 7 days for a broadcast and 30
days for a direct message.

Measure again:

```sh
agent-relay pending --by state
agent-relay usage
```

## When to stop

Stop and hand back to a human when any of these is true:

- **`kept` is not empty and the obligations are not yours to resolve.** A claim, a machine
  claim, a branch claim, a pending handoff, a process record or an open task on somebody
  else's identity is theirs to release or hand over. Use
  `agent-relay handoff-request --as ID --to ID --reason TEXT RESOURCE` and
  `agent-relay branch force-release NAME --as HUMAN --reason TEXT`.
- **The room's project directory is gone.** The broker canonicalises the project path and
  refuses project-scoped commands for a path that no longer exists ("project must be an
  absolute existing directory"). Re-create the directory, or reach the room through the broker's
  background sweep.
- **`pending` is dominated by `awaiting-dormant` direct messages.** Those are durable on
  purpose: a lane that comes back finds its work. They are not garbage. Only a human decides
  to retire those identities.
- **The ledger is still on schema 1.** Run `agent-relay migrate --to 2 --dry-run` first, then
  `agent-relay migrate --to 2`. It refuses to run while a broker owns the data directory, it
  backs the ledger up first, and running it twice changes nothing.
- **The numbers moved but the ledger did not shrink.** `compact` archives messages; it does not
  delete rows. A room whose pending count barely moves usually has one identity holding most of
  the backlog. That identity is in the `blockers` list.

## What this does not fix

- A message that carries an attachment is never archived. The attachment stays with it.
- A message that a retained message replies to stays too, so reply links never dangle.
- An open task, a pending handoff or a live claim keeps its message in the ledger. That is by
  design: nothing is dropped while somebody owns it.
