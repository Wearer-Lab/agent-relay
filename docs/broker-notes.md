# Local relay broker contract

`createBroker({dataDir, port: 0})` requires an existing absolute data directory and returns
`{url, token, close}`. It binds **127.0.0.1 only**. `close()` is idempotent and releases the
writer lease after pending writer work and HTTP shutdown. The caller owns daemon startup,
discovery (`broker.json`), and its startup mutex; the broker never writes those files.

`GET /health` is unauthenticated and returns only `{ok:true, version:1}`. Every room operation
is `POST /rpc` with `Authorization: Bearer <token>` and a JSON body `{op, project, ...fields}`.
The project is an existing absolute directory, canonicalized with `realpath`. Symlink aliases
share a room; different canonical directories have separate agents, history and claims.
The bearer token protects access to the broker, while agent IDs are cooperative identities.
An agent ID is not cryptographic authentication and this is not an untrusted multi-user service.

Success is `{ok:true, ...result}`. Failure uses an appropriate HTTP error status and
`{ok:false, error:{code,message,...details}}`. Errors never silently acknowledge messages,
release claims, or execute work.

| Operation | Fields after `op, project` | Result after `ok:true` |
| --- | --- | --- |
| `register` | `agentId`, `runner`, optional `sessionId` | `{agent}` |
| `agents` | optional `active`, `within` (minutes), `staleMinutes` | `{agents,claims,cursor}` |
| `send` | `from`, `to` (ID or `"*"`), `body`, optional `replyTo`, `messageId`, `summary`, `attachments` (absolute local paths) | `{messageId,recipients,duplicate,cursor}` |
| `inbox` | `agentId`, optional `unacked` (default true), `since` (exclusive cursor), `from`, `limit` | `{messages,cursor,roomCursor}` |
| `ack` | `agentId`, `messageId` or `all:true` or `through` | single receipt or `{acked:count}` |
| `notified` | `agentId`, `messageId`, `adapter` | `{messageId,acked,duplicate}` |
| `status` | `agentId`, optional `status`, `frozen`, `resources`, `task` | `{agent}` |
| `claim` | `agentId`, `resources`, optional `scope` | `{claims,owned}` |
| `release` | `agentId`, optional `resources`, `scope`, `force` | `{released,claims}` |
| `leave` | `agentId` | `{left:agentId}` |
| `fetch` | `agentId`, `messageId`, absolute `out` directory | `{files}` with name, hash, size and output path |
| `wait` | `agentId`, optional `after` (0), `timeoutMs` (25000) | `{messages,cursor}` |
| `compact` | optional `olderThanDays` (broker default, 14), `dryRun` (default true), `dropIdentities` (default false) | `{archivedMessages,removedIdentities,retainedMessages,bytesBefore,bytesAfter,archive}` |

Agent records contain `agentId, runner, registeredAt, updatedAt, status, frozen, resources,
task` and optional `sessionId` and `left`. Left records remain internal for history validation; presence queries exclude them. Query records add `lastSeenAgeMs`. Agent operations refresh last seen at most once a second, in memory (see [Write path](#write-path-and-durability)); `agents`, `rooms` and `snapshot` do not. Initial status is `idle`, frozen is false, resources is an
empty array and task is null. Status accepts any nonempty string up to 80 UTF-8 bytes,
including `busy`, `offline`, `awaiting-attachment` and `channel-ready`. Re-registration and
partial status updates retain omitted fields. Task is null, a string, or a JSON object
up to 8 KiB. Status has no action semantics: offline never releases resources.
Reported `status.resources` is metadata; actual authority is the claims list.

Inbox/wait messages contain `messageId, from, to, body, createdAt, cursor, recipients,
acked, notified` and optional `replyTo`, `summary`, `attachments`. Each attachment is `{name,sha256,size}`. Notices are this recipient's
`{agentId,adapter,at}` entries. Reading an inbox, waking a waiter, or successfully handing
data to an adapter is **not an acknowledgement**. Only recipient `ack` changes the ack
state. `notified` records an adapter's transport notice and remains pending until ack.

The caller should supply a stable message ID when retrying an uncertain send. Same room,
same ID and exact same sender/target/body/reply target/summary/attachment metadata returns the original receipt with
`duplicate:true`; changed content returns `MESSAGE_ID_CONFLICT`. Broadcast recipients
are registered peers at the first durable send, excluding its sender. Later registrations
and duplicate sends never backfill that recipient set. Replies must identify an existing
message in the same room. IDs are scoped to the room.

Each new message has a globally increasing numeric cursor, and each room reports its
latest actual message cursor (gaps from another room are harmless). Metadata changes,
acks and duplicate sends do not advance it. `wait` returns pending recipient messages
strictly newer than `after`, or an empty array on its 0–30000 ms timeout. It installs its
listener in the same serial turn as the inbox read, then releases the writer while waiting.
Wakes are event driven, without a polling interval. Disconnection and broker close clean
up the waiter. Advancing a cursor does not ack older messages: use `inbox` at attachment
or restart to recover all unacked messages before relying on live wait.

Claims are `{agentId,resource,claimedAt}` records. A claim batch is all-or-nothing.
Relative/absolute file paths resolve inside the canonical project, including canonical
existing ancestors for files not created yet. Paths outside it, including escaping
symlinks, are rejected. A parent directory conflicts with any descendant claimed by
another agent. Bare `build`, `install` and `native` are separate exclusive logical names;
they remain project scoped by default. Opt-in `scope:"machine"` claims exact logical resource names across every room using the same store. These optional top-level `machineClaims` records contain `agentId,project,resource,claimedAt`. The project is part of holder identity, even for identical agent IDs. Query rows add `scope,ageMs,lastSeenAgeMs,stale`. The default stale threshold is 30 minutes, configurable with `createBroker({staleMinutes})`, daemon `--stale-minutes`, or `AGENT_RELAY_STALE_MINUTES` for CLI startup. No marker releases ownership. `agents` is the read-only claim query. `release` removes only the requesting agent's
exact resources; omitted resources releases all that agent's claims. There are no expiry,
offline-stealing or automatic-release rules. `CLAIM_CONFLICT` includes retained conflicting
rows and acquires nothing.

One serial writer atomically persists the full versioned `state.json` snapshot before
publishing a response or waking receivers. It flushes a private temporary file, renames
it into place, and flushes the directory where supported. An ambiguous failure after
replacement stops further mutation until restart. Corrupt or unsupported history is
retained and rejected rather than reset. The private token is persisted and reused.

`writer.lock` independently prevents a second broker process owning the same data directory.
An existing live PID, inaccessible PID probe, invalid lock or ambiguous ownership fails
closed. A proven dead PID can be reclaimed under exclusive `writer-recovery.lock` ownership;
every new lease rechecks that sentinel before activation. A crashed or unknown recovery
sentinel requires manual inspection instead of automatic removal. Close/startup failure
removes only its own nonce-bearing lease. PID reuse conservatively rejects takeover.
Startup discovery locking alone does not supply this writer guarantee.

Bounds: 128 KiB HTTP JSON, 16 KiB message body, 128-byte IDs, 256 rooms, 4096 active
agents per room with 8192 retained identities per room, 64 resources per input, 4096
claims per room, a derived transport-notice allowance of max(1024, 6 per recipient)
per message, 10000 total messages and 64 MiB history. There is no history eviction:
reaching a bound fails visibly instead of discarding unacked work. The broker has no
shell execution or tool dispatcher.

`leave` marks an identity departed but retained; a departed (non-retired) identity
may re-register while active capacity allows. `retire` additionally marks the
identity retired: it stays resolvable for history but can never register again.
Both keep their slot in the retained count, so retirement does not free retained
capacity; a full retained registry requires a fresh ledger with a deliberate
handover.

Persistence means retries do not create a second relay message and restart does not invent
an ack or free ownership. It does **not** make an agent's external effects exactly once:
an agent crashing after sending email and before ack must reconcile that effect using its
own execution receipts rather than blindly rerunning an unacked message.

Focused checks use `node --test test/broker.test.mjs`: real HTTP parallel delivery,
room isolation, stable broadcasts, exact ack identity, restart retention, concurrent
transactional claims, long polling, corrupt-state retention, cross-process writer refusal,
dead-PID recovery and unknown-owner refusal. These checks do not validate Codex/OpenCode
adapter wake-up behavior or actual external tool execution. The `test/` and `scripts/`
directories are not included in the npm package; they are available in the source
repository at the installed version (https://github.com/Wearer-Lab/agent-relay).

## Write path and durability

The broker keeps the whole ledger in memory and is its only writer. Mutations are applied
in memory under the serial lock and written in **batches**: one atomic replacement of
`state.json` (temporary file, fsync, rename, directory fsync) carries every mutation applied
before it started, while later mutations queue for the next batch. A response is released only
after everything its operation observed is on disk, reads included, so no client ever sees
state that a failed write could take back. Responses leave in the order their operations ran.

- **Atomic mutations.** Each mutation runs on a copy-on-write draft. A mutation that fails
  partway leaves the ledger untouched, and unchanged rooms, agents and messages are shared
  between versions rather than deep-copied.
- **Incremental checks.** Every new ledger is still validated in full structurally, but
  per-message checks are skipped for message objects that already passed them. Messages in a
  room must be in ascending cursor order, which every broker-written ledger satisfies. The size
  bound is computed from cached per-message JSON, and serialization reuses it.
- **Failed writes.** A write that fails before the rename is rolled back: the operations it
  carried fail with `STORE_IO` and the in-memory ledger returns to the last durable one, so a
  rolled-back cursor is reused, never skipped. A failure after the rename has an unknown durable
  result and faults the broker until restart, as before.
- **Presence is volatile.** Refreshing an agent's last-seen time never writes on its own. It
  rides along with the next write, a periodic presence flush (`presenceFlushMs`, default 30
  seconds) or shutdown. After a crash, last-seen times may lag by up to that interval.
- **Long-poll wakes** look only at messages past each waiter's cursor, and only at durable ones.

### Compaction

`compact` moves finished history out of `state.json` into append-only archive files under
`<dataDir>/archive/` (`<room hash>-<timestamp>-<id>.jsonl`, one `{project, message}` per line,
fsynced before the smaller ledger is written; a crash in between can at most duplicate lines in
an archive). A message is archived when it is older than `olderThanDays`, has no attachments,
and its delivery is finished:

- every recipient acknowledged it, or
- each recipient that did not acknowledge it is retired, or
- for a broadcast, each recipient that did not acknowledge it is dormant or retired.

Direct messages to a dormant identity stay, because dormant identities keep durable inboxes.
Messages that a retained message replies to also stay. The room records
`archived: {messages, through, files, at}`. `history` reports it in `scope.archived`, and the
room cursor keeps counting past archived messages. Archived messages no longer appear in
`inbox`, `history`, `outbox`, `receipt` or `export`; read them from the archive files.
`dropIdentities: true` also deletes dormant identities that nothing retained references
(messages, claims, branch and machine claims, tasks, handoffs, bulletin acknowledgements,
process records). Retired identities are always kept, so they still cannot register again.

The maintenance sweep runs compaction for every room at the prune interval (default every 10
minutes), with `compactAfterDays` (default 14, `0` disables, `--compact-after-days` or
`AGENT_RELAY_COMPACT_AFTER_DAYS` on the daemon). The sweep never drops identities. From the
CLI: `agent-relay compact [--older-than-days N] [--drop-identities] [--apply]` (dry run unless
`--apply`).

### Measured effect

`node scripts/bench-broker.mjs` builds a 16.3 MiB ledger: 1,400 identities (25 live), 9,000
messages, broadcasts to about 1,000 recipients. It then runs 15 seconds of mixed load with 25
long-polling agents and five workers sending, acknowledging, reporting status, reading and
claiming. On a MacBook (Apple silicon, local SSD):

| | Before (0.4.0) | After | After prune + compaction (4.3 MiB) |
| --- | --- | --- | --- |
| Throughput | 9.2 ops/s | 117.9 ops/s | 146.2 ops/s |
| `send` p50 / p99 | 3,914 / 5,035 ms | 55 / 166 ms | 42 / 89 ms |
| `status` p50 / p99 | 3,945 / 4,295 ms | 57 / 167 ms | 42 / 83 ms |
| CPU per mutation | ~60 ms (clone 31 + validate 11 + stringify 18) | ~1.7 ms (draft 0.1 + validate 0.6 + size 1.0) | |

Throughput after the change is limited by the benchmark's own pacing (each worker pauses 20 ms
between operations). The remaining per-operation latency is one write and fsync of the whole
file, shared by every operation in the batch, which is why compaction still matters.

## Optional ledger additions and local files

Version remains 1. Old messages and stores require no migration or rewrite on startup. New fields are optional: message summary/attachments, agent left marker, top-level machineClaims/releaseLog. A forced release requires `force:true`, an explicit resources list and `agentId` naming the human; that identity need not be registered. It applies only to the selected scope and records human, time, requesting project, scope and removed claims in `releaseLog`. The log is bounded at 10000 entries and never evicted.

Inbox filters combine, sort in durable cursor order and apply limit after filtering. Its returned cursor is the last returned message or supplied since when empty; roomCursor is independent. Bulk ack only changes the caller's recipient rows. The existing default unacked inbox and wait contract stay compatible with adapters.

Send copies local attachment paths into a private attachments directory using hash filenames. Files are flushed before a message references them; hash/size are validated on fetch, with sender-or-recipient access checked first. A file is at most 25 MiB, the stored directory at most 100 MiB. Identical content shares a copy. There is no deletion or eviction. Files admitted before a failed/uncertain send may remain and count toward capacity; operators must not blindly retry with changed IDs. Attachments are local data and are excluded from releases and transfers together with history and tokens. Use a private data directory: cooperative IDs and broker tokens are not per-user security boundaries.

The gate is a CLI preflight using read-only measurements, not a broker lock or atomic guarantee about later machine load. Unknown values are printed and do not fail it. Claims remain all-or-nothing after a successful preflight. No dependencies were added.

New feature tests use an injected HTTP server to exercise real handler validation, serial transactions, disk persistence and restart without TCP. Existing loopback tests remain unchanged. `node scripts/smoke-improvements.mjs` (source repository only; see above) runs the actual CLI with temporary projects, private storage and ephemeral ports; it also tests watch recovery and SIGTERM. It never uses the globally installed command or default storage.

The updated client checks a read-only `capabilities` RPC before submitting extended fields. An older running broker fails that check with a restart-required error; it must not silently drop summaries/attachments or interpret machine claims as project claims. Existing command fields still work without that check. Upgrade the broker before using new options. Older code is not safe for coordinating machine claims after a downgrade.

Version identity: the relay package version is separate from the broker protocol
version (`GET /health` reports `version:1`) and the store schema version.
`agent-relay version --detail` reports the local package version, schema,
Node/CLI paths, and the live broker's protocol version when one answers; it
cannot identify the build of an already running broker. The Codex bridge's
`initialize` clientInfo (`agent-relay/0.1.0`) is Codex-protocol metadata that
must stay stable for protocol matching; it is not the relay package version.

Offline restore accepts both raw state and export envelopes, validates an envelope's
`schemaVersion`, and takes the same writer lease as a broker before replacement.
`restore --offline --dry-run` validates without backups or ledger/token writes;
with a missing destination it does not create a directory. An actual import creates
a missing destination with mode 0700 and writes state with mode 0600. Dry-run
reports missing/corrupt attachments as `valid: false`; actual incomplete imports
require `--allow-incomplete`. Stop the broker before offline maintenance.
