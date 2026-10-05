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
| `agents` | none | `{agents,claims,cursor}` |
| `send` | `from`, `to` (ID or `"*"`), `body`, optional `replyTo`, `messageId` | `{messageId,recipients,duplicate,cursor}` |
| `inbox` | `agentId`, optional `unacked` (default true) | `{messages,cursor}` |
| `ack` | `agentId`, `messageId` | `{messageId,acked,duplicate}` |
| `notified` | `agentId`, `messageId`, `adapter` | `{messageId,acked,duplicate}` |
| `status` | `agentId`, optional `status`, `frozen`, `resources`, `task` | `{agent}` |
| `claim` | `agentId`, `resources` | `{claims,owned}` |
| `release` | `agentId`, optional `resources` | `{released,claims}` |
| `wait` | `agentId`, optional `after` (0), `timeoutMs` (25000) | `{messages,cursor}` |

Agent records contain `agentId, runner, registeredAt, updatedAt, status, frozen, resources,
task` and optional `sessionId`. Initial status is `idle`, frozen is false, resources is an
empty array and task is null. Status accepts any nonempty string up to 80 UTF-8 bytes,
including `busy`, `offline`, `awaiting-attachment` and `channel-ready`. Re-registration and
partial status updates retain omitted fields. Task is null, a string, or a JSON object
up to 8 KiB. Status has no action semantics: offline never releases resources.
Reported `status.resources` is metadata; actual authority is the claims list.

Inbox/wait messages contain `messageId, from, to, body, createdAt, cursor, recipients,
acked, notified` and optional `replyTo`. Notices are this recipient's
`{agentId,adapter,at}` entries. Reading an inbox, waking a waiter, or successfully handing
data to an adapter is **not an acknowledgement**. Only recipient `ack` changes the ack
state. `notified` records an adapter's transport notice and remains pending until ack.

The caller should supply a stable message ID when retrying an uncertain send. Same room,
same ID and exact same sender/target/body/reply target returns the original receipt with
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
they are project scoped in v1. To coordinate work across projects, use an explicitly shared
room. `agents` is the read-only claim query. `release` removes only the requesting agent's
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

Bounds: 128 KiB HTTP JSON, 16 KiB message body, 128-byte IDs, 256 rooms, 256 agents per room,
64 resources per input, 4096 claims per room, 1024 transport notices per message, 10000 total
messages and 64 MiB history. There is no history eviction: reaching a bound fails visibly
instead of discarding unacked work. The broker has no shell execution or tool dispatcher.

Persistence means retries do not create a second relay message and restart does not invent
an ack or free ownership. It does **not** make an agent's external effects exactly once:
an agent crashing after sending email and before ack must reconcile that effect using its
own execution receipts rather than blindly rerunning an unacked message.

Focused checks use `node --test test/broker.test.mjs`: real HTTP parallel delivery,
room isolation, stable broadcasts, exact ack identity, restart retention, concurrent
transactional claims, long polling, corrupt-state retention, cross-process writer refusal,
dead-PID recovery and unknown-owner refusal. These checks do not validate Codex/OpenCode
adapter wake-up behavior or actual external tool execution.
