# Delivery backlog: liveness, expiry and fan-out
Status: todo
Labels: reliability, registry, roadmap

Goal: a busy room never accumulates deliveries nobody can read. Dead identities stop counting as live, unread rows expire on their own, broadcasts stop multiplying rows, and the numbers people see describe what actually needs attention.

Source: the 2026-10-25 read-only investigation of a large room on relay 0.7.3. It found 166,526 pending deliveries: 95.2% for left identities, 98.3% from `*` broadcasts, and 97.8% older than 7 days. Only 40 were for live agents. The room held 1,971 identities (29 live) and 6,824 messages, of the 10,000-message cap.

The causal chain:
1. Before 0.4.0, `*` reached every non-left identity, so each broadcast wrote about 1,000 recipient rows (about 160,000 in total).
2. Leaving keeps a dormant identity's rows on purpose: durable inboxes.
3. Compaction archives a message only when every recipient is done, so one straggler pins it.
4. 28 non-left identities are idle for days, and 22 of them still say `transport.state = connected` from a report 8 to 11 days old. `isLive()` trusts that with no age check, so prune keeps them and compaction archives nothing.

Simulated with the relay's own functions: marking those 28 as left, then compacting at 7 days, clears 158,503 rows.

Success measures:
- The sweep clears that room with no manual steps.
- The headline shows the backlog for live agents (about 40), not 166,526.
- No message is pinned by a single identity.
- A burst of short-lived processes adds no permanent identities.

Decisions:
- **Acks and `leave` stay cooperative.** Agent IDs are not authentication; the broker token is the trust boundary on a single-user machine. So `leave --as` and `ack --as` for any known id are kept, and documented as such (Phase 7). Binding receipts to sessions is the optional "Later" phase, not a fix.
- **Stale claims are never released silently by default.** Auto-release can let two agents edit the same files, so it is opt-in (Phase 3), limited to dormant or retired owners, and always audited. By default stale claims are surfaced prominently instead.

Release plan:
- Phase 0: now, before 0.7.4, an operator cleanup of the reported room.
- 0.7.4: Phase 1 (correctness).
- 0.8.0: Phases 2–4 (visibility, cleanup tools, registration).
- 0.9.0: Phase 5 (broadcast cursors, schema 2).
- Phase 6 (data-dir hygiene) ships alongside, and Phase 7 runs alongside all of them.

## Phase 0: Clean the reported room now
Priority: p0
Labels: operations, urgent

At the peak send rate the room has about two days of runway before the 10,000-message cap. This cleanup uses only commands that already exist in 0.7.3. It is reversible: archives stay on disk, and the ledger is backed up first.

### Verify, clean and archive
- [ ] Back up `state.json` (copy next to it, mode 600) before any change
- [ ] Verify the broker's own `prune` and `compact` dry runs against the investigation's simulation (0 prune candidates today; about 5,400 archivable at 3 days once the 28 are left)
- [ ] List the 28 non-left identities idle for more than 24 hours (`agents`, sorted by `lastSeenAgeMs`) and check the 22 that report `connected` against running Claude/Codex/MCP processes on the machine
- [ ] `leave --as <id> --if-idle` for each identity confirmed gone; decide the six with obligations (resolve or hand off their claim, task or branch claim first)
- [ ] `compact --older-than-days 3` dry run, review the counts, then `--apply`; record the before/after pending figure (expected 166,526 to about 7,400)
- [ ] Optional: `compact --drop-identities --apply` to remove about 100 unreferenced dormant identities
- [ ] Ask each live role to `ack --all` its own backlog after reading it, never on another identity's behalf

## Phase 1: Unstick the backlog (0.7.4)
Priority: p0
Labels: correctness

The four fixes that make the reported room clean itself. Each is small, tested on its own, and safe to ship as a patch.

### Stale transports stop counting as live
- [ ] `isLive()` treats `connected` as live only when `updatedAt` or `transport.ts` is within a stale window (default 5 minutes; watchers refresh about every 25 s through `wait`)
- [ ] Apply the same rule everywhere liveness is used: prune plan, sweep, broadcast audience, ownership view, dashboard, `agents` counts
  - [ ] One shared helper in `lib/registry.mjs`, no second definition
  - [ ] Show transport age (`transportAgeMs`) and a `stale` flag in `agents` and `snapshot`
- [ ] When a connected transport goes stale, the sweep rewrites it to `unknown` with `source: 'expired'`, so later readers see the truth
- [ ] The broker notices a dropped watcher: when an agent's `wait` connection closes and no new `wait` arrives within a grace period (default 60 s), it marks the transport `disconnected` with `source: 'broker'`, without waiting for the adapter to report it
- [ ] Tests: a connected agent unseen for longer than the window is prunable; a watcher that keeps polling stays live; broadcast `*` excludes stale-connected agents

### Per-recipient delivery expiry
- [ ] A delivery counts as finished when its recipient acked, is retired, or is dormant or unseen longer than the TTL
- [ ] Broadcast TTL defaults to 7 days. Direct messages default to 30 days, so dormant identities keep a durable inbox for a month
- [ ] A message is archivable when all its deliveries are finished, so no single straggler pins it
- [ ] Expose `--broadcast-ttl-days` and `--direct-ttl-days` on `compact`, the matching daemon flags and environment variables, and the sweep
- [ ] Expired deliveries are written to the archive as `expired` (with the recipient and the reason), so the history stays explainable
- [ ] Tests: one idle non-left recipient no longer blocks a broadcast; a direct message to a dormant identity survives 7 days and archives after 30; the counts match the investigation's simulation on a fixture

### Broker spawn from inside OpenCode
- [ ] `ensureBroker` never spawns `process.execPath` blindly. Resolve a real Node runtime: the path setup recorded, else `node` on PATH, else fail clearly with the fix
- [ ] Detect non-Node runtimes (OpenCode/Bun binaries) and test that the spawn command is Node
- [ ] Retry Windows `EPERM`/`EACCES`/`EBUSY` when renaming `broker.json.*.tmp` to `broker.json`, as the state file replace already does
- [ ] Tests: the plugin path spawns Node, a missing Node gives one clear error, the discovery rename retries on Windows

### Temporary identities are ephemeral
- [ ] Treat `claude-tmp-*`, `codex-tmp-*` and other fallback IDs as ephemeral in prune and the sweep, even without the stored flag (covers the 653 IDs registered before the flag existed)
- [ ] Ephemeral identities that hold nothing are retired, not just left, after the ephemeral idle window, so they count as finished recipients immediately
- [ ] Tests: legacy tmp IDs get swept; tmp IDs holding claims or tasks are kept and reported

## Phase 2: Numbers that mean something (0.8.0)
Priority: p1
Labels: visibility, dashboard

People and agents should see the 40 deliveries that matter, and why the rest exist, without reading `state.json`.

### Honest headline counts
- [ ] Split "awaiting acknowledgement" into awaiting live agents, held for dormant, held for retired, and expired (pending archive) in `snapshot`, `usage` and the dashboard Tower view
- [ ] Per-agent pending counts in Strips use the same split
- [ ] Rename the headline to "Awaiting live agents"; show the other groups as secondary figures with a tooltip that explains durability
- [ ] Tests: the split sums to the old total; the headline equals the live-recipient count

### Pending breakdown command
- [ ] `agent-relay pending [--by recipient|state|age|sender|kind] [--limit N] [--json]`, read-only, through the broker (never by reading the file)
- [ ] MCP and OpenCode tool `relay_pending` with the same options, paged like other large results
- [ ] Tests: the breakdowns on a fixture match a hand-computed table

### Explain what blocks compaction
- [ ] `compact` dry runs list the top blocking identities with how many messages and rows each pins, and their last-seen and transport age
- [ ] `prune` dry runs report "kept: transport connected but not seen for N hours" separately from truly live agents
- [ ] `usage.nearLimit` warns at 80% of the message cap and names the compaction blockers; `doctor` surfaces the same warning
- [ ] Tests: a fixture with one straggler names it as the blocker

## Phase 3: Cleanup tools for operators and lanes (0.8.0)
Priority: p1
Labels: cli, hygiene

Safe, bulk, dry-run-first commands, so an owner never has to script against the ledger.

### Bulk stale cleanup
- [ ] `agent-relay leave --stale --idle-hours N` and `retire --stale --idle-hours N`, dry run by default, with `--apply`. Each reports candidates, kept-with-obligations (and what they hold) and skipped-live
- [ ] Scope by id prefix (`--prefix claude-tmp-`) and runner
- [ ] Every bulk action is recorded in an audit log, with who ran it and which ids changed
- [ ] Tests: obligations are never stranded; dry run changes nothing; `--apply` matches the dry run

### Own-backlog acknowledgement, documented
- [ ] Document the "mark my backlog read" flow: `ack --as ME --all` and `--through CURSOR`, and the MCP `relay_ack` all/through options, in README and docs/registry.md
- [ ] `relay_inbox` mentions the bulk ack when an agent's backlog is larger than one page
- [ ] State plainly that acking for an identity you do not run creates a false receipt

### Stale claims, surfaced and optionally released
- [ ] List stale claims (owner left, retired, or idle past a window) in `agents`, `blocked` and the dashboard, with age and owner state
- [ ] Opt-in auto-release: `--release-stale-claims-hours N` on the daemon (off by default), only for owners that are dormant or retired, with a release-log entry and a notice to the room
- [ ] Tests: claims held by live owners are never released; released claims are recorded in the audit log

## Phase 4: Fewer identities (0.8.0)
Priority: p1
Labels: registry, adapters

Stop short-lived processes from becoming permanent identities and broadcast recipients.

### Lazy registration
- [ ] The MCP adapter and the OpenCode plugin register on the first relay tool call or the first watch start, not when the process launches
- [ ] Processes that never touch the relay create no identity (removes the 658 sub-minute registrations)
- [ ] Tests: an adapter that starts and exits without a tool call leaves no record

### Reuse a session's identity
- [ ] One identity per runner session id. A second process with the same session id attaches to the existing identity instead of creating a tmp one
- [ ] Fallback tmp identities persist their id in the data dir per parent process tree for the session lifetime, so restarts reuse it
- [ ] Tests: two MCP processes of one session share an identity; a restart within the session reuses it

### Broadcast audience guard
- [ ] Never fan a `*` broadcast to identities registered less than a minute ago with no transport report
- [ ] Rate-limit `*all` per sender (for example 5 an hour) with a clear error that suggests a bulletin
- [ ] Tests: a fresh probe identity is excluded; the `*all` limit triggers and recovers

## Phase 5: Store a broadcast once (0.9.0)
Priority: p2
Labels: schema, performance

Replace per-recipient rows for broadcasts with a read cursor, so broadcasts cost O(1) and bulk ack is natural.

### Cursor model and migration
- [ ] Schema 2: broadcasts stored once with their audience rule and snapshot; each agent has a `readThrough` cursor for broadcasts plus explicit acks for direct messages
- [ ] Receipts for broadcasts are computed from cursors (who has read through it) rather than stored rows
- [ ] Offline migration `agent-relay migrate --to 2` with dry run, backup and a validation report; the broker refuses mixed schemas
- [ ] Clients feature-detect schema 2 and keep the old inbox and ack shapes so adapters work unchanged
- [ ] Tests: inbox, ack, receipt, history and outbox are equivalent before and after migration on large fixtures; a benchmark shows row and size reduction

## Phase 6: Data directory hygiene (0.7.4 and 0.8.0)
Priority: p1
Labels: ops

### Clean files and an honest log
- [ ] Remove stale `broker.json.*.tmp`, `.state-*.tmp` and old `state.backup-*` files (keep the newest few) at startup, and log what was removed
- [ ] Write only broker output to `broker.log`, with timestamps, and rotate it by size
- [ ] Record "another live broker owns this data directory" refusals with the owning PID once, not on every client start
- [ ] Tests: startup cleanup leaves current files untouched; log rotation keeps the bound

## Phase 7: Docs and guidance for agent teams
Priority: p1
Labels: docs

### Operating guidance
- [ ] Best-practices page for large rooms:
  - [ ] Stable `AGENT_RELAY_AGENT_ID` per role
  - [ ] `--ephemeral` for probes
  - [ ] Direct sends or tasks instead of broadcasts for named lanes
  - [ ] Bulletins for standing rules
  - [ ] `*all` only rarely
  - [ ] `relay_leave` at the end of every lane
  - [ ] An end-of-lane checklist: final report sent, inbox acked, open tasks completed or handed off, claims and branch claims released or handed off, then `relay_leave`
  - [ ] Orchestrators run `leave --if-idle` for every lane id they created, in the same step as worktree and branch cleanup
  - [ ] A weekly hygiene check (`pending`, `prune` and `compact` dry runs)
- [ ] One-page runbook for a stuck backlog: diagnose with `pending` and `compact` dry runs, clean with `leave --stale`, archive with `compact`
- [ ] Explain the trust model of acks and agent IDs: cooperative identities, the broker token as the boundary, why `leave --as` and `ack --as` work for any id, and why acking for others is a false receipt
- [ ] Document the stale-claim policy: surfaced by default, opt-in auto-release for dormant or retired owners only, always audited
- [ ] CHANGELOG entries per release with the before and after numbers from the reported room

## Later: stronger receipts
Priority: p3
Labels: future

### Delivered versus handled
- [ ] Separate "delivered" (an adapter or poll fetched the body) from "handled" (the agent acked after acting), and show both in `receipt`
- [ ] Optionally bind an ack to the session that fetched the body (a per-session nonce), so a receipt proves which session read it
