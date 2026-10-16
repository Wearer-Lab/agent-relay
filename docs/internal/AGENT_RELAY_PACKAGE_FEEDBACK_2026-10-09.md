# Agent Relay package feedback from a shared Windows development environment

Prepared on October 9, 2026, America/New_York. Live inspection timestamp: `2026-10-10T00:47:43.783Z`.

Package reviewed: `@wearer-haitch/agent-relay` version `0.2.0`. Audience: the Agent Relay package maintainers.

## What needs attention first

Agent Relay provides useful durable coordination, but several gaps make it hard to rely on in a busy project. The most concrete failure was a full historical-session registry. New agents could not join even though very few agents were recently active. A local capacity repair restored registration without deleting sessions, messages, or claims.

The next priorities are reliable Windows attachment diagnostics, coordination across Git worktrees, accurate delivery and presence reporting, and a claim-handoff workflow. Other agents reported repeated claim blockages, interleaved changes, an unidentified development watcher, and a broad process kill that interrupted paid benchmark runs. Those incidents expose coordination needs. They do not establish that the relay executed those commands or caused the application failures.

This report contains 23 findings, supporting incident references, suggested changes, and acceptance checks. It covers the installed package and the locally available history. It does not claim to audit every upstream revision or every agent conversation.

## Scope and evidence

The environment is Windows with PowerShell, Node.js, Codex, Claude Code, and some OpenCode registrations. Agents work in a shared primary checkout and additional project checkouts on several drives.

The review used:

- The installed package's source, README, and Markdown documentation.
- The original broker source saved before our local repair.
- The capacity repair's four regression tests and preservation receipts.
- Retained history containing 83 relay messages across eight rooms, with direct inspection of the relevant reports. Repeated requests and duplicate sends are grouped as incidents.
- Read-only probes of the default Codex control connection and Windows machine gate.
- The earlier drive-wide Git audit and consolidation receipts.

The live snapshot contained 284 retained agent records across eight rooms. The canonical project room contained 258 records, including 27 marked as left. Only one non-left identity had been seen within the previous 30 minutes. These counts are a snapshot and include changes made after the repair receipt.

The earlier repair receipt recorded 282 pre-existing agent records, 82 messages, 31 claims, and eight rooms, all preserved exactly. Immediately after the repaired registration, the canonical room had 257 retained records. Its policy broadcast had 229 recipients. At this report's snapshot, that broadcast still had zero acknowledgements and zero transport-notification records.

Evidence labels used below:

| Label | Meaning |
| --- | --- |
| Reproduced | A local probe or regression test observed the behavior. |
| Source verified | The installed implementation or its explicit contract establishes the behavior. |
| Agent reported | A retained peer message describes the incident. This is testimony, not an independent replay. |
| Proposed improvement | A requested capability or acceptance criterion, not a claim that a defect was reproduced. |

Priorities are suggested maintenance priorities. P1 blocks joining, delivery, or reliable coordination. P2 materially improves operating the relay or resolving common conflicts. P3 is a useful extension. No observed loss of the existing ledger is claimed.

## Existing capabilities to preserve

The package already has durable messages, explicit acknowledgements, reply links, stable message IDs in the broker and CLI, attachment hashes and fetch, inbox filters, bulk acknowledgement, status reporting, and a read-only dashboard. It has project claims, machine-scope logical claims, stale-claim warnings, and an explicitly selected, audited human force-release operation.

It also has a serial durable writer, atomic snapshot replacement, a separate writer lease, conservative recovery, bounded storage, and visible refusal rather than silent history eviction. Its adapters aim to use an existing runner session and keep peer messages separate from user authorization. The CLI watch command reconnects after broker disruption.

These foundations should remain. Several findings concern uneven exposure or incomplete workflows around features that already exist.

## Findings

### F01. Retained historical sessions exhaust registration capacity

Priority: P1. Evidence: reproduced and source verified.

The original broker limited a project to 256 retained agent records. Both registration and saved-state validation enforced that limit. Records marked as left remain stored for history validation and still count against capacity. Leaving a session therefore does not restore a registration slot.

Our project reached all 256 slots. The ordinary listing hid 27 left records and showed 229 other registrations, which made the actual reason for refusal less obvious. A new identity could not join to send the requested coordination message.

The local repair introduced a shared `MAX_AGENTS_PER_PROJECT = 4096` constant for registration and validation. Four tests covered the original refusal, successful registration beyond 256, restart preservation, bounded refusal at 4097, existing-identity re-registration at capacity, and byte-identical loading of a copied ledger. The targeted live restart retained all existing data.

This repair is installed locally. It has not been published upstream. A reinstall can overwrite it. Reverting to a validator that refuses more than 256 records would make the expanded ledger unloadable by that validator.

Requested changes:

- Separate active-session capacity from retained identity history, while preserving references from old messages and claims.
- Provide a supported archive or retirement lifecycle that preserves identity resolution and audit history.
- Display stored, left, recently seen, and capacity counts together. Warn before registration reaches the limit.
- Use one reviewed capacity contract for admission and loading. Include migration and downgrade behavior.
- Retain a hard bound. Increasing a constant alone only postpones the same failure.

Acceptance: repeatedly create and retire more than 256 sessions, preserve their messages and acknowledgements across restart, and still admit a new legitimate session. Refusal at a documented hard bound must leave the ledger intact and explain the available recovery options.

Source: `lib/broker.mjs`, registration and `validateStore`; `lib/observability.mjs`, `presence`. Repair evidence: E01 and E02 below.

### F02. Fallback identities and smoke tests consume real project history

Priority: P2. Evidence: source verified and agent reported.

The CLI reuses a supplied session ID or inherited Codex/Claude session variable when available. Without those inputs, the MCP adapter defaults to a random UUID. Reconnecting without a stable runner identity can therefore create another historical registration.

A setup agent explicitly identified smoke-test messages and short-lived test registrations in the normal project room. This proves that testing polluted the working room. It does not prove that every historical record came from testing.

Requested changes:

- Make stable runner-session binding visible and diagnose fallback identity creation.
- Offer an explicitly temporary test room or disposable data directory in smoke-test commands.
- Mark test registrations and messages so normal presence views and policy delivery can exclude them.
- Provide a safe identity-alias or retirement workflow. Never merge distinct sessions merely because their names look similar.

Acceptance: reconnecting the same identifiable runner session reuses its identity. A smoke test leaves the real room's agent and message counts unchanged. A deliberate fallback identity produces a clear warning.

Source: `bin/agent-relay.mjs`, `mcp`; `lib/mcp.mjs`, `createMcpAdapter`. Agent evidence: A01.

### F03. Windows Codex push attachment needs better discovery and diagnostics

Priority: P1. Evidence: reproduced; historical failure also recorded.

Basic CLI coordination works here, but the default Codex control connection does not. The current read-only `connectCodex()` probe returned:

```text
connect EACCES <CODEX_HOME>/app-server-control/app-server-control.sock
```

An earlier investigation recorded `ENOENT` for that default control endpoint. The earlier absence and the current access failure are different observations. The current probe alone does not establish why access was denied.

The README documents an explicit loopback WebSocket URL for an existing supported server on Windows. That option exists. The remaining problem is discovering and diagnosing a usable endpoint for the running owner session. Writing MCP configuration or having a running desktop app does not prove push attachment works.

Requested changes:

- Add a read-only attachment diagnostic that reports endpoint selection, permission failure, protocol compatibility, project binding, and supported next steps.
- Support the owning runner's documented Windows control transport, or clearly identify the required explicit endpoint.
- Expose attachment failure through structured relay status in addition to stderr.
- Keep polling coordination available and clearly show when push is unavailable.

Acceptance: on supported Windows hosts, use two existing owner sessions to send, receive, explicitly acknowledge, and reply. On an unavailable endpoint, report the precise failure without launching another app-server, changing permissions, or targeting a different thread.

Source: `lib/codex.mjs`, `connectCodex`; CLI attachment paths; README runner compatibility table. Evidence: E03.

### F04. Different Git worktrees become separate coordination rooms

Priority: P1. Evidence: source verified; checkout fragmentation observed separately.

Room identity is the exact canonical project directory. Symlink aliases converge, but different worktree directories remain different rooms. Commands default to the current directory. Explicit `--project` binding can keep agents together, and setup writes such a binding into adapters, but it requires consistent configuration.

The Codex bridge adds a second constraint. It requires the thread's canonical working directory to equal the room's canonical project path. A thread in a linked worktree cannot simply attach to the primary checkout's room through this code path, even if both belong to the same Git common directory. This is a source-derived limitation, not a live cross-worktree attachment test performed for this report.

Our Git audit found linked worktrees, independent clones, and an unregistered copied checkout. They were subsequently consolidated. A peer also described landing work from an independent clean clone. The relay did not create those directories. It currently lacks a repository-membership view that would make fragmentation obvious.

Requested changes:

- Support an explicit coordination-group identity with registered checkout members.
- Distinguish the shared coordination group from each runner's actual working directory and physical file claims.
- Recognize linked worktrees through verified Git common-directory membership.
- Require explicit association for independent clones. A matching remote URL alone is insufficient authority to merge rooms.
- Show registration mismatches and isolated rooms before an agent starts work.

Acceptance: agents in two linked worktrees discover and message each other in one approved coordination group, attach to their own existing threads, and claim their own checkout files accurately. Unrelated repositories remain isolated.

Source: `canonicalProject` in `lib/broker.mjs`; directory checks in `lib/codex.mjs`; `lib/setup.mjs`; OpenCode `roomFor`. Agent evidence: A09. Git audit: E04.

### F05. Registration and recent activity do not establish live delivery readiness

Priority: P1. Evidence: source verified and snapshot observed.

Presence uses `updatedAt`, refreshed by agent operations. Status is persistent metadata supplied by agents and adapters. It is not a live connection measurement. A record can retain `busy`, `working`, or `channel-ready` long after a transport has stopped.

The snapshot included 185 records with `awaiting-attachment` and 25 with `channel-ready`, across both left and non-left records in the canonical room. Only one non-left identity was recently seen. These labels alone cannot establish which runner is currently reachable.

Requested changes:

- Separate registration, agent-declared task status, last broker activity, adapter connection, push readiness, and model acknowledgement.
- Show disconnected or unknown transport state independently of a retained task label.
- Report the source and timestamp of each readiness observation.
- Allow recipient selection by explicit readiness criteria while retaining an option to target durable offline inboxes.

Acceptance: closing an adapter does not leave its old status looking like verified live connectivity. Polling-only and push-attached agents are visibly distinct. Presence checks remain read-only.

Source: `lib/observability.mjs`; `seen` and `status` in `lib/broker.mjs`; adapter status updates. Evidence: E05.

### F06. Senders need a first-class delivery receipt and outbox query

Priority: P1. Evidence: source verified; real broadcast still pending.

The broker stores recipient sets, acknowledgements, and adapter notification markers. The dashboard can display this information. However, the CLI and agent tools do not expose a focused sender query such as "show the current receipt for this message" or an outbox with per-recipient outcomes. The inbox is recipient-oriented. Attachment fetch authorizes the sender but returns files, not a delivery receipt.

Our policy broadcast was persisted for 229 recipients. At the inspected snapshot it had no transport markers and no acknowledgements. That establishes durable storage, not delivery into those agents' model contexts. Historical registrations also inflate the apparent audience.

Requested changes:

- Add sender-accessible message receipts and outbox filtering.
- Report durable storage, attempted notification, accepted transport submission, context insertion where known, and explicit acknowledgement separately.
- Show pending, unavailable, and uncertain recipients with reasons and timestamps.
- Offer an explicit request for follow-up or escalation. Do not infer permission to execute the message.

Acceptance: a sender can inspect one stable message ID through CLI, MCP, OpenCode, and dashboard without reading private state files. Counts agree after restart. Acknowledgement remains an explicit action by the recipient.

Source: `send`, `inbox`, `fetch`, `notified`, and `ack` in `lib/broker.mjs`; `roomSnapshot`; CLI and tool definitions. Evidence: E02 and E05.

### F07. Adapter recovery is uneven and uncertain delivery has no complete operator workflow

Priority: P1. Evidence: source verified and documented limitation.

The CLI watcher retries after broker disruption. The OpenCode watcher stops after a wait error and warns; a later session or tool event may reconnect it. An idle session with no later event can remain unwatched. The OpenCode documentation explicitly describes this behavior.

The Codex bridge retries broker waits, but its existing runner connection is created once. A closed runner connection is not re-established by that wait retry. Delivery failures are recorded as `delivery-needs-review`.

Codex and OpenCode persist attempt markers before external runner submission to avoid duplicate wake-ups after uncertain outcomes. That is useful. It also means a recorded attempt can prevent automatic redelivery even when the operator needs to resolve whether a message actually arrived.

Requested changes:

- Give adapters bounded reconnect with backoff for their own transports, preserving the existing session and identity.
- Expose a receipt-reconciliation workflow for uncertain submissions, with an explicitly authorized retry when appropriate.
- Record structured delivery failure details instead of relying only on an agent-wide task string or a generic toast.
- Keep external effects separate from message delivery. Never replay a tool action just because a message remains unacknowledged.

Acceptance: restart the broker while an owner session is idle, then send a new message. Watching recovers without another user turn. Disconnect the runner during submission and show an uncertain receipt that can be reconciled without duplicate sessions or automatic duplicate work.

Source: `lib/watch.mjs`; `watch` in `lib/opencode-plugin.mjs`; `runCodexBridge`; `docs/opencode.md`.

### F08. Agent-facing tools expose only part of the broker's capabilities

Priority: P2. Evidence: source verified.

| Capability | CLI | MCP adapter | OpenCode plugin |
| --- | --- | --- | --- |
| Stable ID supplied on send | Yes | No | Yes |
| Summary and attachment paths on send | Yes | No | No |
| Fetch and verify attachments | Yes | No | No |
| Inbox pagination and sender filtering | Yes | No | No |
| Paginated acknowledged-history query | No inbox flag; watch can replay history | No | No |
| Bulk acknowledgement | Yes | No | No |
| Recently active agent filter | Yes | No | No |
| Machine-scope claim and release | Yes | No | No |
| Explicit leave | Yes | No | No |

An agent can fall back to the CLI if shell access is available and authorized, but that adds friction and makes capability availability depend on the runner's tools. The MCP resource schema also allows up to 128 items, while the documented broker input bound is 64. Accepted tool input can therefore fail at the next layer.

Requested changes: generate tool schemas from one capability contract, expose supported ordinary operations consistently, and publish a compatibility matrix. Keep human force release restricted to a deliberate operator workflow. Parity should not give agents unilateral authority over another agent's claims.

Acceptance: test each advertised operation through every applicable adapter. Stable-ID retries remain idempotent, resource bounds agree, and unsupported features fail before mutation with a useful explanation.

Source: definitions in `lib/mcp.mjs`; tools in `lib/opencode-plugin.mjs`; CLI switch; broker contract.

### F09. History retrieval and search are incomplete

Priority: P2. Evidence: source verified and documented limitation.

The broker supports `inbox` with `unacked: false`, but the CLI's `inbox` command does not expose a corresponding flag. Its optional `--unread` still leaves the default at unacknowledged-only. CLI `watch` can replay acknowledged history by default, so retrieval is not wholly absent; it is a long-running stream rather than a paginated history query. MCP and OpenCode inbox tools have no filter arguments.

The dashboard's search and filters apply to the latest 100 messages, although its totals cover the whole retained history. The snapshot API itself is limited to at most 200 messages. An operator can easily see a total larger than the searchable window without being able to retrieve the relevant older discussion through that view.

Preparing this report required selective reading of the ledger to recover earlier reports. Normal retrospective work should have a supported query path.

Requested changes: full-history pagination, acknowledged-message retrieval, sender and recipient filters, reply-thread lookup, time ranges, and explicit display of the current search window. Offer a redacted export for support reports.

Acceptance: after more than 200 messages and several acknowledged exchanges, retrieve an old incident through supported tools without raw state access. Search results explain their scope and use durable cursors.

Source: CLI `inbox`; broker `inbox` and `snapshot`; `docs/dashboard.md`; adapter schemas.

### F10. Broadcasts do not provide persistent policy for future sessions

Priority: P2. Evidence: source verified.

A broadcast captures its recipients at send time. Agents that join later are excluded. Retired registrations are excluded only when marked left; stale non-left registrations remain eligible. This is a sensible stable-message contract, but it does not distribute lasting project rules to future agents.

We sent a worktree-policy notice and attached the current bootstrap documents. A later session still needs to discover those documents separately. Peer messages also referred to changes in `AGENT_BEST_PRACTICES.md`, but that file was not available at the inspected primary path or current main tree. Its reported edits are therefore treated as agent testimony, not independently verified document content.

Requested changes: add an optional pinned policy or onboarding bulletin with version, source document, hash, and per-session acknowledgement. Keep one-off broadcast semantics unchanged. New sessions should be able to discover the current bulletin without replaying every historical chat message.

Acceptance: a future registration sees the current approved bulletin and its source. Updating the bulletin preserves earlier versions and acknowledgement evidence. The bulletin does not override user instructions or grant tool permission.

Source: recipient selection in broker `send`; `lib/setup.mjs`. Evidence: E02 and A11.

### F11. Claims lack a practical narrowing, queue, and handoff workflow

Priority: P1. Evidence: agent reported and source verified.

Agents repeatedly asked a directory owner to release or narrow broad roadmap claims. Another agent reported holding completed code-file claims while waiting for an unrelated roadmap update, which blocked a repair agent with failing route tests. A separate stale claim on a shared HTTP file required repeated requests and eventually a reported owner-authorized narrow exception.

The relay already detects path conflicts and stale holders. It preserves ownership rather than assuming that an idle agent has finished. An audited human force release exists. The missing piece is a practical process connecting a blocked agent, the holder, and an authorized operator.

Requested changes:

- Add a claim-change operation that atomically replaces a broad owned claim with narrower claims.
- Record handoff requests, requested resources, blocking holder, and response state.
- Support an explicit transfer accepted by the current holder and recipient.
- Show dependency chains and warn when unrelated blocked work retains completed resources.
- Make the existing human recovery operation discoverable with exact selected resources and its audit consequence.

Acceptance: two agents can narrow and transfer ownership without an unprotected release/reclaim gap. A blocked agent can track its request. Staleness alone never grants permission to steal or expire a claim.

Source: broker `claim`, `release`, conflict validation, and `releaseLog`; stale detection in `lib/observability.mjs`. Agent evidence: A03, A04, A05.

### F12. File claims do not describe dirty-work ownership or Git handoff provenance

Priority: P2. Evidence: agent reported; Git audit observed.

Agents reported different uncommitted hunks in the same files and coordinated filtered staging by message. One reported landing from a clean independent clone to avoid capturing another agent's work. Another warned that changes already committed on a review branch remained duplicated in the shared primary tree and should not be sweep-committed again.

A file claim states cooperative current ownership. It does not inventory pre-existing changes, identify the author of each hunk, or prove that a shared checkout is safe to stage. Likewise, a message saying work is complete does not provide a structured record of the branch, exact HEAD, validation, or preserved local artifacts.

Requested changes:

- Provide optional read-only checkout inventory with Git common directory, branch or detached HEAD, dirty-state summary, and agent association.
- Let a claim or handoff reference an exact base commit, patch hash, resulting commit, and verification receipt.
- Prefer isolated linked worktrees for concurrent edits. If shared-file work is deliberate, allow an explicit collaboration agreement and provenance attachments.
- Diagnose independent clones and unregistered checkouts when an operator requests a repository inventory.

Acceptance: a receiving agent can distinguish committed work, duplicate local residue, and still-uncommitted peer work before staging. The relay must not silently stage, commit, rewrite Git metadata, or convert clones.

Source: file-resource claim model and attachment support. Agent evidence: A06, A07, A09, A12. Git evidence: E04.

### F13. Process and development-watcher ownership are not visible

Priority: P1 as an operational coordination improvement. Evidence: agent reported.

One agent reported that every `node.exe` was killed at once, interrupting two paid Canvas benchmark runs and two Codex jobs. The responsible agent then confirmed that a subagent had run `taskkill /F /IM node.exe` while debugging a hung test.

Other messages asked who owned a development watcher that published uncommitted schema changes on save. A later warning said the watcher could overwrite a reviewed deployment with an older local copy. The messages illustrate the cost of invisible shared process ownership.

The broker has no shell dispatcher. These were runner actions and development-tool behaviors, not commands issued by Agent Relay. Resource claims can name logical activities, but there is no structured process record tying a PID, start time, working directory, port, deployment target, and owner together.

Requested changes: add optional owner-reported process and watcher records, with liveness verification and PID-reuse protection. Show who to contact before a shared restart. Include source checkout and exact deployment provenance for watchers that publish on save. Bootstrap guidance should require stopping owned process trees by verified identity and prohibit broad name-based kills.

Acceptance: agents can identify the owner of a shared server or watcher without broadcasting "whose process is this?" A process record is coordination information and never authorizes another agent to kill it. Deleting a record does not stop the process.

Agent evidence: A02, A07, A08, A10. This finding requests integration and guidance, not a broker execution feature.

### F14. The Windows machine gate can pass with every measurement unknown

Priority: P1 when used as an admission check. Evidence: reproduced and documented.

The current Windows probe returned:

```json
{
  "ok": true,
  "swapGb": null,
  "load": null,
  "freeGb": null,
  "reasons": [],
  "unknown": ["swap", "load", "free disk"]
}
```

This is documented best-effort behavior. Windows load is deliberately treated as unknown. Swap measurement is implemented for macOS, and disk measurement calls `df`. On this host those paths produced no usable measurements.

The output honestly lists unknown values, but `ok: true` and a successful exit can be mistaken for a measured capacity pass by an automated caller.

Requested changes: use supported read-only Windows measurements, resolve the selected drive correctly, and distinguish measured pass, measured refusal, and insufficient evidence. Add an explicit policy for required measurements. Default compatibility can remain permissive if the result clearly states that no capacity assessment was established.

Acceptance: Windows drive-specific disk checks return a measured value. A strict gate with an unavailable required metric refuses admission with a structured reason. A permissive result exposes its coverage and cannot be presented as a fully measured pass.

Source: `lib/gate.mjs`, `machineGate`; CLI `checkGate` and `claim --gate`. Evidence: E03.

### F15. Machine claims are available but ordinary adapters cannot use them

Priority: P2. Evidence: source verified.

The broker and CLI support exact logical claims at machine scope. Ordinary MCP and OpenCode claim tools send only project resources. Agents in separate rooms can each own a project-local `build` claim while competing for the same machine capacity.

The gate is also a preflight measurement, not a reservation or atomic guarantee about load after admission. It does not represent weighted CPU, memory, container, or paid-test capacity.

Requested changes: expose machine scope consistently and document standard logical resources. If richer admission is added, support explicit bounded permit counts and resource costs. Keep ownership until the real process tree has ended. Do not make a preflight result look like a reserved slot.

Acceptance: agents in separate project rooms contend for the same declared machine build resource. A claim plus gate has clear semantics under concurrent requests. Unknown measurements and exhausted permits produce distinct results.

Source: broker machine-claim paths; CLI `claim`; MCP/OpenCode tool definitions; `docs/broker-notes.md`.

### F16. Storage has hard limits but no supported long-term maintenance workflow

Priority: P2. Evidence: source verified and documented.

The broker caps total retained messages at 10,000 and the ledger at 64 MiB. Attachments are limited to 25 MiB per file and 100 MiB for the content store. Messages across all rooms share the message/store bounds. Attachments are deduplicated by content hash, but admitted files from failed or uncertain sends may remain and consume capacity. The package explicitly documents this possibility.

No history eviction occurs. That protects pending work, but a long-running installation eventually needs an operator workflow for backup, archive, capacity review, and safe reclamation. The CLI has no supported export, archive, compaction, or attachment-reference audit command.

Requested changes:

- Display utilization and headroom for messages, ledger bytes, rooms, agents, claims, notices, release logs, and attachments.
- Add validated export and restore, including attachment hashes and schema version.
- Add an explicit archive policy that preserves pending messages, identity references, claims, and audit evidence.
- Offer a dry-run audit of unreferenced attachments before any authorized cleanup.
- Reserve enough capacity for acknowledgement, status, and recovery operations near a limit, or document and test their failure behavior.

Acceptance: fill a disposable store near each bound, inspect it through supported tools, export and restore it, and verify all retained references and hashes. Maintenance never silently deletes unread work or active ownership.

Source: broker constants and persistence; `lib/attachments.mjs`; CLI operations; documented bounds.

### F17. Operators need supported broker lifecycle and recovery commands

Priority: P2. Evidence: source verified; local repair required manual operating steps.

The CLI provides `start` and a daemon entry point. The broker's internal close operation drains writer work and releases its lease. There is no ordinary supported CLI command for verified stop, drain, restart, diagnostics, or a restart receipt.

For our repair, we verified the broker process against discovery and writer ownership, backed up the state, restarted only that process, and compared the ledger hash. This procedure should not require ad hoc scripts or reading secret-bearing discovery files manually.

Requested changes: add `doctor`, runtime information, targeted stop/restart, preflight validation, backup, and recovery guidance. Verify the actual daemon identity and data directory before stopping it. Retain conservative refusal for unknown writer ownership. Return a receipt showing the old/new runtime, state schema, and preservation checks.

Acceptance: restart a broker while preserving histories, claims, and identities. A live writer or ambiguous lock remains protected. Diagnostic output never prints its bearer token. Commands do not stop unrelated Node processes.

Source: `lib/client.mjs`, `ensureBroker`; daemon signal handlers; `createBroker.close`; writer lease. Evidence: E02.

### F18. Runtime version and capability compatibility are too weakly exposed

Priority: P2. Evidence: source verified.

The installed package reports version `0.2.0`, while `/health` reports `version: 1`, which is the broker protocol value. MCP server metadata and the Codex initialization client metadata use `0.1.0`. There is no unified diagnostic showing package version, protocol/schema version, installed source, and the running broker's build identity.

For extended operations, the client checks that `capabilities.features` is an array, but does not verify that the requested feature is in that array. This protects against a broker with no capability operation, but is incomplete feature negotiation for partially compatible implementations.

The local capacity patch is another example. The npm package version remains `0.2.0`, yet the broker's admission contract differs. An operator needs to see that distinction before reinstalling or restarting.

Requested changes: report package, protocol, schema, and build identity separately. Check the specific required feature before submission. Add a read-only upgrade preflight that validates the retained ledger against the replacement runtime without rewriting it. Document rollback limits.

Acceptance: a broker advertising an empty feature array rejects a client request requiring machine claims before mutation. Diagnostics distinguish an original package from a patched runtime. An incompatible replacement refuses safely with actionable migration guidance.

Source: broker `/health` and `capabilities`; client `rpc`; MCP server metadata; `connectCodex` initialization; CLI `version`.

### F19. Backlogs can expand model input without a clear byte budget

Priority: P2. Evidence: source-derived risk; no model-context exhaustion reproduced.

Default inbox reads can return the full unacknowledged backlog up to the broker's global message bound. The basic agent tools expose no pagination controls. OpenCode's context transform formats all pending rows into a synthetic text part. Individual bodies are bounded, but a bounded message is not the same as a bounded aggregate model input.

The notification formatting uses message bodies. It does not provide a common compact envelope containing summary, attachment metadata, and a fetch instruction across adapters. Attachment support in the broker therefore does not automatically give the receiving model a complete artifact-discovery workflow.

Requested changes: bound batches by both count and bytes, expose resumable pagination, carry summaries and artifact descriptors, and preserve the complete durable message for explicit retrieval. Do not drop older unread messages or silently truncate instructions. Let agents prioritize urgent coordination without requiring the entire backlog in one context insertion.

Acceptance: seed a large backlog and demonstrate bounded notification and tool-response sizes. All omitted messages remain discoverable. Explicit acknowledgement applies only to messages actually handled.

Source: broker default inbox limit; `lib/mcp.mjs`; OpenCode `formatted` and context-transform hook; Codex delivery text.

### F20. Capacity changes need consistent fanout limits and measured scaling

Priority: P2. Evidence: source verified; performance consequences are inferences.

The local repair permits 4,096 retained identities per room, but `MAX_NOTICES` remains 1,024 per message. A successfully delivered Codex message ordinarily records both an attempted and an accepted marker for each recipient. A broadcast to more than 512 such recipients can exceed that notice budget. Mixed adapters use different numbers of markers. A larger registry therefore does not establish equivalent end-to-end broadcast capacity.

The broker clones and persists the complete state for mutations. Presence refreshes, acknowledgements, claim changes, and notification markers all use the serial writer. Attachment preparation also occurs within the serialized RPC path. This design gives a clear durability order, but its latency and disk-write cost should be measured at the advertised limits. No throughput benchmark or measured latency regression is claimed here.

Requested changes: derive compatible recipient/notice bounds, or store bounded per-recipient delivery state. Benchmark full stores, many waiting agents, broadcasts, attachment sends, and restart. Investigate journaled persistence or separate observability updates only if measurements justify the added complexity. Preserve durable-before-response ordering and one-writer safety.

Acceptance: an advertised maximum-sized broadcast can record every permitted delivery transition without hitting an unrelated bound. Publish p50/p95/p99 latency, write volume, memory use, and restart time with exact fixture sizes. Concurrent attachment work does not produce unexplained coordination stalls.

Source: `MAX_NOTICES`; broker `change`, `persist`, `seen`, `send`, and `notified`; Codex attempt/accepted markers. The hotfix's four tests did not test large live fanout.

### F21. Setup binds configurations to the package's current installation path

Priority: P2. Evidence: source verified; relocation failure not reproduced here.

Setup writes the current absolute Node executable and package CLI path into MCP configuration. The OpenCode loader imports the current absolute package module URL. `.agent-relay.json` records the package root. The managed OpenCode loader itself says to rerun setup after moving the package.

This is predictable within a stable installation, but temporary `npx` locations, package moves, Node changes, or installation replacement can leave stale references. Setup changes also require the owning runner to load the configuration; they do not inject tools into an already running process.

Requested changes: validate configured paths in diagnostics, detect changed installation roots, and provide an idempotent refresh command that preserves unrelated configuration. Show whether each running owner actually loaded the configured adapter. Document stable installation options and the limits of live attachment.

Acceptance: move a disposable installation or change its Node path, diagnose the stale binding, refresh it safely, and verify the owner-loaded adapter. Existing sessions, permissions, and other MCP servers remain preserved.

Source: `lib/setup.mjs`; README setup contract; managed OpenCode loader.

### F22. Cross-platform validation and packaged documentation need completion

Priority: P2. Evidence: package documentation and installed file inspection.

The validation document reports 52 automated tests passing on macOS and describes an optional CI template for Windows and Linux. It explicitly states that those tests do not establish cross-platform live runner integrations. The README reports live two-way Codex delivery on macOS. Claude's live evidence distinguishes transport activation from a nonempty model reply. OpenCode documentation distinguishes recording-client tests from real model understanding.

Those distinctions are useful and should remain. Windows default attachment and machine measurement are still material gaps in this environment.

The README and validation guide also link to `docs/ci-workflow.yml`, but that file is absent from the installed package. The published file pattern includes `docs/*.md`, which excludes the YAML template. Tests and scripts are intentionally excluded from the npm package, which is ordinary packaging; the problem is that installed documentation refers users to an unavailable template without a usable alternative.

Requested changes: make platform/runner acceptance an actual release gate where support is claimed, publish a versioned validation matrix, and fix packaged documentation links. Run the same packed artifact that users install. Distinguish basic messaging, adapter activation, context insertion, explicit acknowledgement, and reply evidence.

Acceptance: perform nonempty send/ack/reply checks between existing sessions on each supported platform. Include disconnect/restart, unavailable endpoint, worktree binding, and capacity cases. Every relative link in the packed README and guides resolves or points to a versioned source location.

Source: `docs/validation.md`, `docs/claude-channel.md`, `docs/opencode.md`, README, and `package.json` file list.

### F23. Task dependencies and handoff completion are free-form messages

Priority: P3. Evidence: agent reported; proposed integration.

Agents used free-form messages to coordinate who commits first, which branch contains the reviewed work, which test failures belong to another lane, and who is waiting for a claim. Status accepts a task string or object in the broker, but there is no common task/handoff contract for consumers to query.

Requested changes: add optional structured task and handoff records with owner, blocked-by references, resources, exact source revision, verification evidence, expected recipient, and completion acknowledgement. Build this on message IDs and attachments. Avoid turning a coordination package into an autonomous scheduler unless that becomes an explicitly designed product scope.

Acceptance: an operator can query which tasks are blocked, which claim caused the block, and whether a recipient accepted a handoff. A completed task can retain unresolved acceptance gates without indefinitely retaining every editing claim. A task request never counts as new user authorization.

Agent evidence: A03 through A12. Existing `task`, `replyTo`, attachments, and acknowledgement fields provide a foundation.

## Reports from other agents

The references below identify the retained evidence so maintainers can ask for a redacted excerpt or reproduction. Times are UTC. IDs are evidence references, not claims that the package generated an independent incident record. Sender names are shortened where the full generated ID adds no explanatory value.

| Ref | Date/time UTC | Sender | What was reported | Related findings |
| --- | --- | --- | --- | --- |
| A01 | October 5, 23:52:21 | Claude setup session | Smoke-test messages and short-lived test agents were in the real room; the sender said to ignore and acknowledge them. | F02 |
| A02 | October 6, 06:46:37 to 07:10:49 | `canvas-release`, `cad-closure` | Broad Node process kill interrupted two paid benchmark runs and two Codex jobs. The responsible agent confirmed its subagent ran the command. | F13 |
| A03 | October 7, 20:46:35 to 21:24:43 | Product-journey agent, `codex-bom-m1` | Broad directory claims prevented narrowly scoped roadmap edits; agents repeatedly asked the owner to narrow or release. | F11, F23 |
| A04 | October 7, 21:49:03 to 21:55:41 | `codex-bomfix-20261007` | Completed-file claims remained held while their owner waited on an unrelated roadmap; repair work with failing route tests could not proceed. | F11, F23 |
| A05 | October 8, 01:02:03 to 02:48:13 | BOM repair agents | A stale claim on `convex/http.ts` blocked a small handler fix. A later agent reported owner authorization for a narrow edit while preserving other hunks. | F11 |
| A06 | October 7, 21:42:29 and 23:04:35 | `canvas-release` | Existing uncommitted work overlapped newly claimed files; different changes were interleaved in shared files and required filtered staging. | F12 |
| A07 | October 8, 00:41:56 | `canvas-release` | Detailed hunk-by-hunk commit coordination, plus a report that a watcher had published still-unreviewed schema changes. | F12, F13 |
| A08 | October 8, 00:52:35 | `canvas-release` | Asked who owned the development watcher and requested that only its owner stop it. | F13 |
| A09 | October 8, 01:47:45 | Claude design-master session | Planned landing from a clean independent clone with selected hunks; said the watcher was not theirs. | F04, F12, F13 |
| A10 | October 8, 13:09:14 | `canvas-release` | Warned that a still-running watcher had an older uncommitted tree and could overwrite a reviewed deployment on the next save. | F13 |
| A11 | October 8, 09:47:27 | Claude design-master session | Reported best-practices additions about delegated Codex jobs and uncommitted schema publishing. Document content was not independently recovered for this report. | F10, F13 |
| A12 | October 8, 21:52:11 | Claude KiCad review session | Reviewed work was already on a branch, but duplicated modifications remained in the shared primary checkout; warned against sweep-committing them again. | F12, F23 |

Exact message references:

```text
A01 68a9ab0f-9d33-4224-add7-4fa957a98ec3
A02 8014b086-ff17-4785-9966-d1f52184995d
    413549c1-30fb-4591-9b8e-428769d89061
    056d012a-5b3a-4f9d-9461-d81eacbea4ef
A03 caacd489-2f57-4a01-88c1-e7ca3d9b9f23
    37360940-00a7-4a05-b6a5-7136cf936791
    835c3810-7d1f-4628-ab62-ea7ae9fd05df
    3fc84207-3c13-4112-934d-0969a449e31d
    abec5963-9a26-4b74-abc3-7cafb0f1eb5e
A04 67b6a57a-2141-44b2-8e97-7d523aed061c
    96964cb0-3e20-4664-a29b-80fba371f104
    58e3ac70-4bdf-4ffe-b727-f05087d6cc81
    1eef5c1a-dc61-45a3-b47d-8515b38e8e63
A05 46277443-a8c9-4a4a-bfbf-f9fd94a6c5dc
    856e7070-2f36-48c0-b0c1-408a170129b9
    a2c3f2af-25c2-4435-9833-39e6d4b4b4e2
    ddbbf3c5-e977-4699-8b90-61a19108930c
A06 e3d64dda-1eb6-4a2e-a1dc-b90179f00d39
    fc00b81f-8715-423e-b971-1d84060791a7
A07 396be789-4447-4d81-943e-c9ffdc9768de
A08 e5df89ff-8c6e-4892-9fb2-8f6d4aef8c92
A09 fcff3ef3-e0c0-49ad-8f21-fee1753cc026
A10 14adc7b4-51d6-4393-9377-2cd13e673e98
A11 f49f50f8-eda8-478f-987a-910c20c7c678
A12 8cee2259-f5ea-4ef9-b848-6c60c5b80abd
```

Several messages also discuss application-specific generation failures, Convex workflow leases, test gates, and release blockers. Those are excluded as relay defects. Application job claims are separate from Agent Relay resource claims. Smoke-test traffic is treated as evidence about test isolation, not as real task failures. Our own policy broadcast is operator evidence and is not presented as a peer complaint.

## Suggested implementation order

| Stage | Scope | Required proof |
| --- | --- | --- |
| 1 | F01, F03, F05, F06, F14, F18 | New sessions can join; Windows attachment failures are actionable; receipts distinguish storage from delivery; gates expose measurement coverage; upgrades preserve the store. |
| 2 | F04, F07, F08, F09, F11 | Worktree agents share approved coordination; interrupted adapters recover; tools expose consistent operations; historical reports are retrievable; ownership transfers are explicit and atomic. |
| 3 | F02, F10, F12, F13, F15, F16, F17, F21 | Tests stay isolated; new agents discover policy; source/process ownership is visible; operators can maintain and restart safely. |
| 4 | F19, F20, F22, F23 | Backlogs and fanout remain bounded; measured scale and cross-platform evidence match advertised support; structured handoffs are queryable. |

Cross-platform and packed-artifact checks should run for each stage. Stage 4 is where broader coverage is completed, not permission to defer basic regression checks until then.

## Reproduction and regression cases

Use disposable projects and a private temporary data directory. None of these cases requires deleting the working installation's history.

1. Register 256 distinct identities against the original implementation. Mark some as left, then try a new identity. Confirm refusal and preserved state. Test the replacement with a retained ledger above 256 and with its actual hard limit.
2. Connect MCP twice without an inherited runner session ID. Check whether two identities appear. Repeat with a stable real session ID and confirm reuse.
3. On Windows, probe the default existing Codex control transport, then a supported explicit owner endpoint. Record the exact error category. Test nonempty send, acknowledgement, and reply only through authorized existing sessions.
4. Use two linked Git worktrees. Compare default room identity, explicit canonical binding, and attachment validation. Confirm unrelated repository isolation.
5. Close an adapter, restart the broker, and send while the receiving session remains idle. Observe readiness, recovery, and receipts rather than relying on a stale status string.
6. Hold a broad directory claim, request one child file, narrow the claim, and transfer ownership. Verify no partial acquisition or implicit stale takeover.
7. Send and acknowledge more than 200 messages. Retrieve an early acknowledged discussion through supported tools and export a redacted report.
8. Exercise the Windows gate on each selected drive and with deliberately unavailable measurements. Verify permissive and strict policies separately.
9. Fill message, attachment, notice, and ledger bounds in isolated fixtures. Verify refusals, recovery operations, and complete preservation. Include a broadcast whose recipients would require more than 1,024 notification markers.
10. Restore an exported ledger and its attachments, validate hashes, and verify pending inboxes and claims. Test incompatible replacement preflight without modifying the source store.
11. Simulate configured package-path relocation. Validate safe setup refresh and packed documentation links.
12. Seed a large unacknowledged backlog. Measure aggregate tool and context input size, writer latency, disk writes, and restart time without substituting tiny fixtures for advertised capacity.

## Evidence inventory and sharing guidance

| Ref | Material reviewed | What it establishes |
| --- | --- | --- |
| E01 | Installed `0.2.0` source and the saved pre-repair broker | Original admission/loading limits, current adapter/tool contracts, and code-derived limitations. |
| E02 | Capacity repair tests, `capacity.patch`, restart receipt, delivery receipt, and final verification | Four tests passed; all original records survived; policy notice persisted; local repair scope. |
| E03 | Read-only `connectCodex()` and `machineGate()` probes during report preparation | Current Windows `EACCES` failure and a gate pass with every measurement unknown. |
| E04 | Earlier drive-wide Git inventory and consolidation report | Linked worktrees, independent clones, and unregistered checkout fragmentation were found and reconciled. |
| E05 | Selective live ledger inspection at the timestamp above | Session/status counts, 83 retained messages, and the policy broadcast's zero receipts at that snapshot. |

Maintainers can locate the relevant symbols in their package checkout using the package-relative paths named under each finding. Source locations are based on the installed `0.2.0` implementation. The capacity constant differs because of the disclosed local repair. No claim is made that a newer upstream release has the same behavior.

For comparing the exact reviewed broker modules:

```text
Original broker SHA-256:
a6908848458767cdf5d9d96b3967b9b7969698e37c77e16ddaf601235995a131

Locally patched broker SHA-256:
dd5d7b01bd045daee4edbd7e2535519521d91add874c25261e27406a2da3fb00
```

This document is intended to be forwarded by itself. It includes no bearer token, full ledger, private discovery file, state backup, or raw conversation dump. The local supporting directory contains private history backups and should not be uploaded wholesale. Share a selected patch, regression test, or redacted receipt separately if requested.

## Limits of this report

The capacity repair and two Windows probes were verified directly. The process shutdown, watcher behavior, and overlapping edit incidents are supported by peer messages, including a confirmation from the agent responsible for the shutdown. They were not replayed during this documentation task.

No live cross-worktree push test, large fanout test, full upstream test suite, or throughput benchmark was run for this report. Those gaps are stated in the relevant findings. Existing preserved history was used for the retrospective; we did not solicit new complaints, change another agent's claims, or submit the report to the maintainers.

The most useful near-term outcome is an installation where a new agent can join, see the approved coordination group, determine who is reachable, inspect message receipts, and resolve a blocked claim through supported tools. The evidence above gives maintainers concrete failures and acceptance checks for that work.
