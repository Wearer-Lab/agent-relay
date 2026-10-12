# Agent Relay 0.3.0 — initial review (historical snapshot)

This document records the initial review of f5c37ca. Its findings and line numbers describe that revision, not the current implementation. See the [updated review](2026-10-11-code-review.md) for resolution status and new findings.

Reviewed October 11, 2026, America/New_York.

**Result: 26 findings: 3 P1, 22 P2, and 1 P3.** Twenty-two findings were reproduced with focused probes; four are established by source inspection. The existing 137-test suite passes, but it does not cover several important combinations and lifecycle boundaries. Address the restore and process-signaling findings before relying on the new maintenance commands in a working installation.

This is a review and evidence delivery, not an implementation of fixes. Runtime source and existing tests were not edited. All probes used disposable projects, private temporary storage, recording runner clients, or fixture processes owned by the review. No real agent was messaged, no working ledger was restored, and no existing runner or broker was stopped.

## Scope and revision

The comparison is the 0.2.0 release, `6fe371d`, through current HEAD, **`f5c37cac0b1ff8b672aaf2cd7e0282dbddc8c817`**:

- `f41e531`: “Address package feedback across 23 findings and release 0.3.0.”
- `f5c37ca`: “Document shipped bulletin and process-record operations.” This follow-up was included in the final review; the earlier wording calling those operations planned is no longer a finding.

The change touches 33 files, including the broker, CLI, client, Codex bridge, MCP adapter, OpenCode plugin, dashboard, machine gate, setup diagnostics, worktree discovery, documentation, and tests. Review covered the complete runtime modules and relevant baseline behavior, not only added lines. Prior requirements were taken from the existing [October 9 feedback](../internal/AGENT_RELAY_PACKAGE_FEEDBACK_2026-10-09.md). Its Windows incident reports were treated as historical evidence, not as new reproductions here.

Existing untracked feedback and deployment documents were left untouched. Findings below concern changes or remaining gaps in 0.3.0. Source line numbers refer to the reviewed HEAD.

## Validation performed

| Check | Result and limits |
| --- | --- |
| `npm run release:check` | All **137 tests pass**, no skips. Extracted archive has 29 files; packaged CLI help/version and dashboard syntax checks pass. |
| Focused review probes | **22 evidence records**, covering 22 reproduced findings (one record demonstrates both Unicode budgeting and false inclusion receipts; one illustrates source-verified usage scopes). Real loopback brokers and SDK transports were used where practical; runner reconnection and OpenCode context insertion used recording clients. |
| Fresh packed installation | Packed 0.3.0, installed its dependencies independently in a temporary directory, and exercised packaged setup, registration, send, inbox, ack, receipt, claim/release, export, and small dry-run restore. Passed. Dependencies were not symlinked to the checkout for this extra smoke check. |
| Packaged Markdown links | Every relative Markdown link inspected in the packed artifact resolves. |
| `npm ls --depth=0` | Installed direct dependencies match the five pinned package versions. |
| `npm audit --omit=dev --json` | Registry audit reported **0 known vulnerabilities** at review time. This is an advisory lookup, not proof that the dependency code is defect-free. |
| `git diff --check` | Passed for tracked changes. |
| Environment | macOS, Node **v26.5.0**, npm **11.17.0**. This run does not establish Node 20/22, Linux, or Windows behavior. |

The first sandboxed suite failed because loopback binding was prohibited (`listen EPERM`). The unrestricted repeat passed. Those initial failures are an environment limitation, not package defects.

Reproduce the focused observations from a source checkout with dependencies installed:

```sh
node docs/reviews/2026-10-11-probes.mjs
```

The [probe harness](2026-10-11-probes.mjs) asserts the observed faulty behavior, so a successful exit means the observations reproduced; it is not a passing regression suite for a fixed implementation. The [captured evidence](2026-10-11-evidence.jsonl) contains synthetic data only. The restore/waiter case temporarily captures an uncaught timer exception inside the disposable review process to allow cleanup; an ordinary daemon does not have that exception handler.

## Finding index

P1: blocks recovery, can crash the broker, or can signal an unrelated process. P2: materially incorrect coordination, delivery, capacity, diagnostics, or confidentiality behavior; also includes explicitly identified incomplete feature coverage. P3: documentation/operating-contract inconsistency.

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| R01 | P1 | Restore can commit, report failure, and crash when a waiter's room is removed | Reproduced |
| R02 | P1 | Stop/restart trust an unrelated or invalid PID | Reproduced |
| R03 | P1 | Restore cannot accept ordinary exports larger than 128 KiB | Reproduced |
| R04 | P2 | Byte-limited pages have broken or contradictory continuation metadata | Reproduced |
| R05 | P2 | Both agent adapters invert the unread filter | Reproduced in MCP; same OpenCode code |
| R06 | P2 | OpenCode records context inclusion for omitted messages | Reproduced |
| R07 | P2 | OpenCode's byte budget counts UTF-16 characters | Reproduced |
| R08 | P2 | A single large receipt bypasses tool-response limits | Reproduced |
| R09 | P2 | Fanout allows three markers per recipient; OpenCode needs four | Reproduced |
| R10 | P2 | The first message after a Codex disconnect is fenced before reconnection | Reproduced with recording connection |
| R11 | P2 | Closed adapters retain connected readiness | Reproduced in MCP; related source gaps |
| R12 | P2 | Task listing loses machine-claim blockers | Reproduced |
| R13 | P2 | Task blockers ignore parent directory claims | Reproduced |
| R14 | P2 | A stale handoff can reverse its original transfer direction | Reproduced |
| R15 | P2 | Bulletin acknowledgements can certify an unread version | Reproduced |
| R16 | P2 | Bulletin acknowledgements exhaust the active-agent bound during churn | Reproduced |
| R17 | P2 | Restore validates attachment filenames, not attachment contents | Reproduced |
| R18 | P2 | Exported private history uses ordinary file permissions | Reproduced |
| R19 | P2 | Retirement strands claims without a preflight | Reproduced |
| R20 | P2 | Retained-capacity recovery guidance cannot reclaim capacity | Source verified |
| R21 | P2 | Usage subtracts global totals from per-room limits | Source verified |
| R22 | P2 | Setup diagnostics inspect another MCP server's TOML entry | Reproduced |
| R23 | P2 | Capability negotiation checks only one feature in combined requests | Reproduced |
| R24 | P2 | Important coordination operations remain absent from agent tools | Source verified; incomplete feature coverage |
| R25 | P3 | Shipped operating documentation still disagrees with implementation | Source verified |
| R26 | P2 | Explicitly missing delivery advances the positive receipt ladder | Reproduced |

## Detailed findings

### R01 — Restore can commit a replacement ledger and then crash the broker

**P1 · Reproduced · Newly introduced by full-store restore.**

Source: [lib/broker.mjs](../../lib/broker.mjs), lines 580–594, 604–615, 1058–1096, and 1480–1485.

`restore` replaces the entire state while existing long-poll waiters remain registered. `change()` persists and assigns the new state before calling `wake()`. Each waiter lookup assumes its project room still exists. If restore removes a waiting room, that lookup throws **after durable replacement**. The request reports an error although the new ledger has already been committed. The waiter's later timer and broker `close()` also assume the room exists.

Probe `restore-removes-waiter-room` installed a waiter and restored a valid empty ledger. The restore returned **404 `UNKNOWN_ROOM`**, the saved ledger contained **zero rooms**, and the timer raised an uncaught `UNKNOWN_ROOM` exception. In the normal daemon that uncaught exception can terminate the process. Until then, the retained waiter also makes subsequent mutation wakeups fail.

Suggested fix: coordinate replacement with waiter cancellation/rebinding; ensure wake, timeout, disconnect, and close tolerate removed rooms. Restore must have one unambiguous durable result. Test room removal and agent removal with active waits, and verify successful shutdown and later mutations.

### R02 — Stop and restart do not establish which process owns the broker

**P1 · Reproduced · New lifecycle-command hazard.**

Source: [bin/agent-relay.mjs](../../bin/agent-relay.mjs), lines 34–60 and the restart branch.

`verifiedBroker()` accepts a numeric discovery PID if it appears alive and the discovery URL answers any successful `/health` response. It does not authenticate the broker, compare the PID with a writer lease, or prove that the healthy endpoint belongs to that PID. `stopBroker()` then sends `SIGTERM` to that number.

Probe `stop-trusts-unrelated-pid` pointed a disposable discovery file at a healthy fixture broker but put a separate harmless child process's PID in it, with an incorrect token. `stop` reported success, killed the unrelated **review-owned child**, and left the actual fixture broker healthy. This reproduces the identity mismatch without stopping any working process.

The source also accepts zero, negative, fractional, or non-finite parsed numbers rather than requiring a positive safe integer. On POSIX, zero/negative process IDs can have process-group/broader signal semantics. Those signal cases were **not executed**.

Suggested fix: validate positive integer PIDs and loopback discovery URLs; establish ownership through authenticated broker-controlled shutdown or a verified instance/lease identity. Refuse ambiguous discovery. Test stale/recycled PIDs, mismatched endpoints, wrong tokens, and malformed PIDs without signaling them.

### R03 — Export and restore have incompatible size contracts

**P1 · Reproduced · Recovery fails at modest ledger size.**

Source: [lib/broker.mjs](../../lib/broker.mjs), `MAX_REQUEST` at line 9, request parsing around line 417, export at 1034–1036, restore at 1058; [bin/agent-relay.mjs](../../bin/agent-relay.mjs), lines 142–145.

Export can return the whole **64 MiB** ledger. CLI restore reads that export and submits it as one JSON HTTP request, but all requests are limited to **128 KiB**. There is no separate streaming or offline import path.

Probe `large-export-cannot-restore` exported only 24 messages with 8,000-byte bodies. The dry-run restore request was **197,716 bytes** and was rejected with **413 `REQUEST_TOO_LARGE`**, before restore validation ran. Real ledgers requiring maintenance will routinely exceed this threshold. The existing round-trip test uses a single message, so it misses the mismatch.

Suggested fix: give bounded full-store import an appropriate authenticated transport, such as streamed upload or a deliberate offline maintenance command. Do not globally relax every normal RPC limit. Require dry-run and real round trips for exports exceeding 128 KiB and approaching the supported store bound.

### R04 — Byte-limited pages cannot be resumed consistently

**P2 · Reproduced · Affects MCP and the same OpenCode paging implementation.**

Source: [lib/mcp.mjs](../../lib/mcp.mjs), lines 114–125; [lib/opencode-plugin.mjs](../../lib/opencode-plugin.mjs), lines 83–95; [lib/broker.mjs](../../lib/broker.mjs), lines 201–210 and outbox at 745–757.

`boundPage()` removes messages from the response without updating the broker's `cursor`, `nextCursor`, or `done`. Inbox/history supply an additional `omitted.resumeCursor`, but their primary paging fields still describe rows the caller never received. An agent using `nextCursor` or obeying `done:true` can skip omitted data.

Outbox has a stronger failure: `messageReceipt()` omits each message's durable cursor. Its byte-limited continuation therefore becomes **zero**, which returns the same first page; using the unadjusted `nextCursor` skips the missing rows instead.

Probe `byte-page-cursors` observed:

- Inbox: last shown cursor **8**, reported cursor **12**.
- History: last shown cursor **7**, `nextCursor:12`, `done:true`, despite **five omitted messages**.
- Outbox: seven of twelve rows shown; `omitted.resumeCursor:0`, no row cursors, `nextCursor:24`.

Suggested fix: retain cursors in receipt rows and derive all continuation/completion fields from the returned page. Use one paging contract across adapters. Verify that repeatedly following the advertised cursor reaches every row exactly once under both count and byte limits.

### R05 — `unread:true` includes acknowledged messages

**P2 · Reproduced in MCP; identical mapping in OpenCode.**

Source: [lib/mcp.mjs](../../lib/mcp.mjs), line 219; [lib/opencode-plugin.mjs](../../lib/opencode-plugin.mjs), inbox mapping around lines 260–264.

Both adapters translate `unread` to `unacked: !unread`. The broker's `unacked:true` means exclude acknowledged rows. Thus explicit `unread:true` selects all rows, while `unread:false` selects only unacknowledged rows. Omitting the option happens to preserve the broker's default unread behavior.

Probe `unread-filter-inverted` acknowledged the oldest message and requested `relay_inbox({unread:true,limit:1})`. It returned that acknowledged message. Existing MCP tests explicitly assert the inverted mapping, which is why the suite passes.

Suggested fix: forward `unread` directly to `unacked`; test actual broker results after an acknowledgement for omitted, true, and false options in both adapters. Update the test expectation rather than preserving the incorrect field mapping.

### R06 — Omitted OpenCode messages get false context-inclusion receipts

**P2 · Reproduced with recording runner/transport.**

Source: [lib/opencode-plugin.mjs](../../lib/opencode-plugin.mjs), lines 67–81 and 356–367.

The formatter selects a bounded subset for the synthetic model input. The context hook then loops over **all pending rows**, adds all their IDs to `state.included`, and records `opencode-context` notices for them. Messages omitted by count or size are therefore marked as included even though their contents never reached that model boundary.

Probe `opencode-context-bounds-and-receipts` supplied 30 valid messages. The synthetic context contained six bodies, but the plugin recorded **30 context markers**, including **24 for omitted messages**. Because those omitted IDs are already in `state.included`, later genuine insertion will not generate a fresh context marker.

Suggested fix: return selected message IDs along with formatted text and mark only those IDs after actual insertion. Regression coverage must compare message IDs in the synthetic part with IDs receiving context notices. Preserving omitted messages in durable inboxes is good and should remain.

### R07 — OpenCode's advertised byte cap counts characters

**P2 · Reproduced with valid Unicode messages.**

Source: [lib/opencode-plugin.mjs](../../lib/opencode-plugin.mjs), lines 58–81.

`MAX_CONTEXT_BYTES` is 32 KiB, but the formatter measures `line.length`, which counts UTF-16 code units. It also excludes the header/omission footer from that accounting and admits the first row unconditionally.

The same OpenCode probe used 5,300 `漢` characters per body—**15,900 UTF-8 bytes**, within the broker's 16 KiB body limit. The resulting context measured **96,137 bytes**, almost three times the stated cap, while the character-based logic admitted six rows.

Suggested fix: measure the complete UTF-8 envelope with `Buffer.byteLength`, including wrapper text. Define a compact oversized-row envelope with an explicit retrieval instruction rather than silently truncating peer instructions. Test non-ASCII text and metadata-heavy attachments as well as ASCII bodies.

### R08 — One receipt can exceed the 64 KiB tool budget

**P2 · Reproduced.**

Source: [lib/mcp.mjs](../../lib/mcp.mjs), lines 114–125; [lib/opencode-plugin.mjs](../../lib/opencode-plugin.mjs), lines 83–95; receipt tool implementations in both files.

The page limiter stops when one message remains, even if that message still exceeds `maxBytes`. Broadcast receipts carry per-recipient marker arrays, so one receipt can be substantially larger than a normal body. The standalone receipt tool has no aggregate bounding at all; large agent listings are also outside the page limiter.

Probe `single-message-page-exceeds-budget` queried a valid 512-recipient broadcast outbox. Its **single row was 155,242 bytes**, `maxBytes` was **65,536**, and `omitted` was null. The result is advertised as bounded but is not.

Suggested fix: paginate recipient details or return a compact message receipt plus a bounded detail operation. Ensure the total serialized tool response, not just its `messages` array, fits the contract. Add single-row broadcast and attachment-metadata cases.

### R09 — The new fanout allowance is too small for normal OpenCode delivery

**P2 · Reproduced with a valid seeded ledger.**

Source: [lib/broker.mjs](../../lib/broker.mjs), lines 15–21 and notified admission around 1250; [lib/opencode-plugin.mjs](../../lib/opencode-plugin.mjs), toast, wake, and context marker calls.

`noticeAllowance()` allows `max(1024, recipients × 3)` markers. A normal OpenCode recipient can record **four** distinct stages: `opencode-toast-attempted`, `opencode-toast`, `opencode-wake-attempted`, and `opencode-context`.

Probe `opencode-notice-budget` seeded a valid 512-recipient broadcast with the first three stages per recipient: **1,536 markers**, equal to the allowance. The first context stage then failed with **409 `NOTICE_LIMIT`**. Context marker failures are swallowed by the plugin, so delivery accounting can become silently incomplete. This is a bound mismatch, not a measured throughput claim.

Suggested fix: model the actual allowed transitions per recipient, including reconciliation, rather than multiplying by an insufficient constant. Test complete delivery paths at the advertised recipient limit for mixed adapters. Keep bounded storage and explicit refusals.

### R10 — Codex reconnect loses the first post-disconnect delivery opportunity

**P2 · Reproduced with a recording connection; no real Codex session used.**

Source: [lib/codex.mjs](../../lib/codex.mjs), lines 130–175.

The bridge considers any non-null `conn` usable. A quiet WebSocket close does not proactively clear it. On the next message, the bridge first persists `codex-attempted`; `ensureConn()` sees the stale object and skips reconnecting. The subsequent `thread/read` fails and only then clears `conn`. The message is now permanently fenced as attempted, even though no turn operation was submitted.

Probe `codex-first-post-disconnect-message` passed initial attachment, then failed the next `thread/read` with “Codex connection closed.” It observed **zero reconnection calls**, a durable attempted marker, no accepted marker, and a failure record with **`submission:null`**. Later messages can reconnect; this first message remains polling-only/manual-review work.

Suggested fix: track connection closure and reconnect safe read-only preparation before admitting a turn submission. Preserve the no-auto-retry rule after any uncertain turn operation. Test an idle connection closing before message arrival and distinguish pre-submission recovery from post-submission uncertainty.

### R11 — Adapter shutdown leaves stale connected readiness

**P2 · Reproduced in MCP; broader source gaps.**

Source: [lib/mcp.mjs](../../lib/mcp.mjs), lines 245–250 and 318–341; [lib/opencode-plugin.mjs](../../lib/opencode-plugin.mjs), initial watch and lines 304–307; [lib/codex.mjs](../../lib/codex.mjs), lines 145–146 and 175; [lib/observability.mjs](../../lib/observability.mjs), lines 1–14.

MCP records connected channel transport but its close paths only abort the watcher. They never clear that transport report. `presence()` continues returning the retained `connected` state, and `agents({transport:'connected'})` includes it with no freshness requirement.

Probe `mcp-close-keeps-connected` initialized a real SDK channel, closed its adapter and client, then queried the broker. The closed identity still matched **transport connected**.

Related gaps: OpenCode sends no initial connected report and only updates transport on a recovery; disposal reports declared `offline` without clearing an earlier connected transport. Codex attachment never writes the new transport/push fields. MCP permanently disables readiness reporting after any `reportTransport` error, including a transient outage.

Suggested fix: distinguish durable last reports from current observed connection state, report orderly disconnects before aborting, and add freshness/unknown semantics for crashes. Integrate the fields consistently across adapters without claiming that transport readiness proves a model read the message.

### R12 — Machine-claim blockers disappear from task lists

**P2 · Reproduced.**

Source: [lib/broker.mjs](../../lib/broker.mjs), lines 143–150 and 814–822.

The task list branch declares a local `state` containing the requested task-state filter. It shadows the broker ledger and is passed to `taskView()`. That view therefore receives `undefined`, `open`, or `complete` instead of the state containing `machineClaims`.

Probe `machine-task-blocking` created a task blocked by another agent's machine `build` claim. Upsert returned the correct machine holder and `blocked:true`. Listing the same task reported an **unknown reference** and `blocked:false`; `tasks({blocked:true})` returned **zero rows**.

Suggested fix: use a distinct filter variable and pass the actual ledger. Verify consistent upsert/list/complete views for machine blockers with and without task-state filters, including the CLI `tasks --blocked` path.

### R13 — Task blockers disagree with real parent/child claim conflicts

**P2 · Reproduced.**

Source: [lib/broker.mjs](../../lib/broker.mjs), lines 143–153; compare `canonicalResource()` and `resourceConflict()` near lines 76–101.

Task blocking uses exact resource equality or a simple `path.resolve`. Claim admission uses canonical paths and parent/child conflicts. A task blocked by `src/file.mjs` does not see another agent's claim on `src`, although that claim prevents the task from acquiring its file. Symlink/case normalization can similarly diverge from the claim contract.

Probe `parent-claim-not-in-task-blockers` claimed `src` for A and created B's task blocked by `src/file.mjs`. The task reported **`blocked:false`**, while B's actual claim failed with **`CLAIM_CONFLICT`**.

Suggested fix: normalize path references with the same resource rules and match the same conflict relation. Test directory claims, nonexistent child paths, symlink aliases, and supported Windows case behavior. Named logical resources should remain separate from path resources.

### R14 — Stale handoff acceptance can reverse the offered direction

**P2 · Reproduced.**

Source: [lib/broker.mjs](../../lib/broker.mjs), lines 1362–1421.

Handoff records retain parties/resources but not the original holder/direction or claim generation. At acceptance, the broker chooses the transfer direction from whoever holds the claim **now**: `holder === record.from ? responder : record.from`.

Probe `handoff-direction-reverses`: A claimed `x` and offered it to B. A later released it, and B independently claimed it. B then accepted the old A-to-B offer. The broker transferred **B's current claim back to A**, the opposite of the offer.

Suggested fix: record source owner, destination owner, and claim identity/generation when requesting a handoff; reject or invalidate stale requests when ownership changes. Verify both offer and acquisition-request forms, release/reclaim, intervening transfers, retirement, and partial acceptance.

### R15 — Bulletin acknowledgement does not bind to what the agent read

**P2 · Reproduced.**

Source: [lib/broker.mjs](../../lib/broker.mjs), lines 1201–1209; [bin/agent-relay.mjs](../../bin/agent-relay.mjs), bulletin ack branch.

`ackBulletin` always acknowledges the latest version at the time of the write. It neither requires nor validates a version/hash supplied by the reader. An agent can read version 1, an operator can publish version 2, and the agent's delayed ack will certify version 2 despite never reading it.

Probe `bulletin-ack-race` read v1, published v2, and submitted an ack carrying `version:1`. The broker ignored that field and returned **`version:2`**.

Suggested fix: require the exact version and preferably hash being acknowledged. Reject a stale-current acknowledgement or record it against that exact retained version. Expose the binding in CLI and agent tools. Add a read/update/ack race test.

### R16 — Bulletin acknowledgements use the wrong identity bound

**P2 · Reproduced at the declared boundary.**

Source: [lib/broker.mjs](../../lib/broker.mjs), lines 374–386 and 1201–1209.

The validator caps one bulletin's acknowledgement list at **4,096**, the active-session limit. Those acknowledgements are retained across session departures, while the room can retain **8,192** identities. Legitimate churn therefore makes the current bulletin unacknowledgeable well before the retained registry fills.

Probe `bulletin-ack-churn-bound` seeded 4,096 departed identities that had acknowledged the current bulletin and one fresh active identity. The valid fixture loaded, but the fresh acknowledgement returned **503 `STORE_IO`** when validation rejected the 4,097th ack. Only **one** agent was active.

Suggested fix: derive the acknowledgement bound from the retained identity contract or introduce documented archival semantics. Validate capacity before mutation and return a specific actionable error. Test departed and retired readers, restart, and repeated acknowledgements at the boundary.

### R17 — Restore does not verify attachment integrity

**P2 · Reproduced.**

Source: [lib/broker.mjs](../../lib/broker.mjs), lines 960–971 and 1069–1088.

Restore calls `attachmentInventory()` and compares hash-shaped filenames with referenced hashes. It never reads the contents or checks their hash/size. A corrupt file with the right name is treated as present. Dry-run can therefore report a valid restore with no missing attachments when the restored messages cannot fetch their artifacts.

Probe `restore-does-not-verify-attachments` sent a valid artifact, exported state, overwrote the stored content with corrupt bytes, and ran dry-run restore. It returned **`valid:true`, `missingAttachments:[]`**. Fetch immediately failed with **`ATTACHMENT_ERROR` / hash or size mismatch**. Non-dry restore also proceeds when attachments are missing, returning the missing list rather than requiring an explicit incomplete-restore choice.

Suggested fix: validate referenced files by bounded size and SHA-256, report missing versus corrupt artifacts separately, and make incomplete restore an explicit policy. Test corruption, wrong size, missing content, duplicate hashes, and cross-directory recovery. Export currently contains an inventory, not the attachment bytes; document the required private backup of those bytes.

### R18 — CLI export weakens private-ledger permissions

**P2 · Reproduced on POSIX with umask 022.**

Source: [bin/agent-relay.mjs](../../bin/agent-relay.mjs), lines 136–139.

The broker writes its ledger with mode **0600**. `export --out` uses `fs.writeFile()` with ordinary defaults, so a new export can be **0644**. It contains all rooms and message bodies. In a searchable/shared parent directory, local users can read it. The report does not claim another user actually accessed any data.

Probe `export-file-permissions` ran the actual CLI under umask 022 and observed **mode 644** on the synthetic export.

Suggested fix: create private exports with mode 0600; define safe overwrite/symlink behavior and use atomic replacement if overwrites are supported. Test a new file and an existing permissive destination. An existing file's permissions are not tightened merely by adding a creation mode.

### R19 — Retirement can strand cooperative ownership permanently

**P2 · Reproduced; lifecycle hazard rather than a request for automatic release.**

Source: [lib/broker.mjs](../../lib/broker.mjs), lines 684–685, 1153–1163, and `agentFor()` near 556.

`retire` irreversibly marks the identity left/retired without checking claims or pending obligations. Claims remain held, but the retired holder cannot use normal release, handoff-response, or ack operations because `agentFor()` rejects left identities. Re-registration is forbidden because the identity is retired.

Probe `retirement-strands-claims` retired an identity with a path claim. The claim remained; normal release failed with **`UNKNOWN_AGENT`** and rejoin with **`RETIRED`**. A human forced release remains possible, but an ordinary lifecycle action has unnecessarily escalated cleanup into that workflow.

Suggested fix: refuse retirement while owned resources or required handoffs need resolution, or require an explicit retained-obligations choice with a clear receipt and recovery instructions. Preserve the rule that going offline must never silently release another agent's ownership.

### R20 — Retiring identities cannot repair a full retained registry

**P2 · Source verified.**

Source: [lib/broker.mjs](../../lib/broker.mjs), lines 674–677 and 1153–1159; advertised maintenance operations around 1034–1096.

Retained capacity counts `room.agents.length`, including retired identities. At the 8,192-record limit, registration recommends **“archive or retire identities.”** Retirement changes flags but never reduces that length. There is no supported archive operation that preserves references while reclaiming retained slots.

The active/retained split fixes the old 256-record bottleneck, but this particular recovery message offers an action that cannot solve its own failure. Starting an empty data directory is a different coordination ledger; it does not preserve pending inboxes and ownership there.

Suggested fix: provide accurate bound-specific guidance now, and define safe identity/history archival with reference preservation before advertising it as recovery. Test more than the retained hard bound through a supported archive workflow, or explicitly document that the retained bound requires a new ledger with a deliberate handover.

### R21 — Usage reports capacity with the wrong scope

**P2 · Source verified; multi-room counters observed in the probe.**

Source: [lib/broker.mjs](../../lib/broker.mjs), lines 975–1031.

Usage sums agents, project claims, handoffs, and processes across every room, then subtracts those totals from limits enforced separately **per room**. Machine claims have their own global limit. Thus two individually healthy rooms can appear to have exhausted a single room's capacity; headroom can become negative even though registration/claims remain allowed in each room.

Notice headroom always subtracts from the old **1,024 base**, despite the allowance now growing with recipient count. The largest valid 512-recipient fixture has 1,536 permitted markers and would display negative base headroom while exactly meeting its actual allowance.

Suggested fix: report per-room utilization plus meaningful global totals, and derive notice headroom from the relevant message's allowance. Include task, bulletin, follow-up, and forced-release-log bounds if claiming coverage of every bound. Test two populated rooms, machine/project claims separately, and variable fanout allowances.

### R22 — Setup diagnostics parse the wrong TOML server

**P2 · Reproduced.**

Source: [lib/setup.mjs](../../lib/setup.mjs), lines 70–74 and 97–102.

`diagnoseSetup()` checks whether a Codex relay entry exists, then `tomlCommand()` extracts the **first command and first args anywhere in the file**. A normal configuration with another MCP server before agent-relay can produce either a false failure or a false healthy result. Regex captures also leave TOML escapes undecoded, which makes Windows paths particularly suspect; that Windows case was not executed here.

Probe `setup-diagnoses-wrong-table` generated a valid managed relay binding and prepended an unrelated server whose executable was missing. Diagnostics blamed that unrelated path and returned **`ok:false` for Codex**, despite the relay binding being valid.

Suggested fix: parse/select the exact TOML relay table and decode its values. Test earlier/later servers, quoted tables, inline configuration, multiline args, and escaped Windows paths. Keep the existing preservation behavior when setup encounters unmanaged configuration.

### R23 — Combined options can bypass feature negotiation

**P2 · Reproduced against a partial-capability fixture.**

Source: [lib/client.mjs](../../lib/client.mjs), lines 56–95.

`requiredFeature()` returns one feature. In a send containing attachments and summary it checks only attachments; in a machine claim containing provenance it checks only machine claims. A partially compatible broker can accept and silently ignore unsupported fields even though the client promises to refuse before submitting them.

Probe `partial-capability-combination` advertised only **attachments**. A send with `attachments:[]` and an unadvertised summary was nevertheless submitted. The field reached the fixture's mutation endpoint.

Suggested fix: derive the full set of features required by an operation and every supplied extension, and require all of them. Keep this check read-only and prior to mutation. Add a table-driven combination matrix for attachments/summary, scope/meta, and any other independent extensions.

### R24 — Agent-tool parity remains incomplete for the new coordination workflows

**P2 · Source verified · Feature-coverage gap, not a claim that every operator command should be an agent tool.**

Source: [lib/mcp.mjs](../../lib/mcp.mjs), tool definitions at lines 22–57; [lib/opencode-plugin.mjs](../../lib/opencode-plugin.mjs), tool definitions at lines 246–303; compare CLI help and broker capabilities.

Both adapters now expose 12 standard tools, including attachments, receipts, history, machine claims, and bulk ack. They still do not expose bulletin read/ack, claim narrowing, handoff request/respond/list, structured tasks, process ownership discovery, or group discovery. Those are central agent-to-agent operations requested in the earlier feedback, so a tools-only owner must fall back to shell access or cannot use them.

OpenCode additionally lacks claim provenance metadata and the richer transport/frozen/resource status fields available through MCP. Both history tools advertise time filters in their descriptions but provide no `afterTs`/`beforeTs` arguments. Neither accepts reverse-page `before`.

Suggested fix: agree on an explicit agent-operation parity table and implement the routine coordination/read operations with pinned project/identity validation. Keep dangerous maintenance, forced release, restore, and process signaling operator-scoped unless deliberately designed otherwise. Test schemas and real broker behavior in each adapter rather than only tool-name counts.

### R25 — Several published operating contracts are stale or misleading

**P3 · Source verified in the final HEAD.**

Sources: [docs/broker-notes.md](../broker-notes.md), [docs/validation.md](../validation.md), [docs/ci-workflow.md](../ci-workflow.md), [docs/process-ownership.md](../process-ownership.md), and [lib/codex.mjs](../../lib/codex.mjs), line 66.

Concrete inconsistencies:

- Broker notes still state **256 agents per room** and a fixed **1,024 notice** limit; implementation now has 4,096 active, 8,192 retained, and a derived notice allowance.
- Validation says **68 tests**, while the actual suite has **137**.
- Validation says Windows load is deliberately unknown; the new gate tries to measure `ProcessorQueueLength`. Its strict/permissive coverage contract deserves current documentation.
- The new process-ownership guide says listing verifies liveness **read-only**. The `processes/list` branch persists `lastVerifiedAt` through `change()` when more than a second has elapsed. The command does not signal the process, but it does write the relay ledger.
- Codex still initializes its client metadata with package version **0.1.0**. `version --detail` reports the local package/CLI and protocol 1 but cannot identify the package/build of the already running broker. The source-path/Node tuple is not a broker build identity.
- The CI guide calls `npm publish --dry-run --ignore-scripts` a dry-run of the same packed artifact. In the shown workflow no archive path is passed and the release checker deletes its temporary archive; this step repacks the checkout.

The f5c37ca follow-up correctly documents shipped bulletin/process commands; those resolved wording issues are not included here. Relative links in the final packed Markdown are valid.

Suggested fix: reconcile documentation and diagnostics with one explicit runtime contract; distinguish observation from persistence, protocol/schema from package/build identity, and source repacking from validating one exact artifact.

### R26 — Explicitly missing delivery advances the positive receipt ladder

**P2 · Reproduced.**

Source: [lib/codex.mjs](../../lib/codex.mjs), lines 47–51; [lib/broker.mjs](../../lib/broker.mjs), lines 184–218; [lib/dashboard/dashboard.js](../../lib/dashboard/dashboard.js), `receiptSummary()` near lines 32–51.

`reconcile --missing` writes `codex-reconciled-missing`. `markerStage()` treats every adapter name other than `*-attempted`/`*-accepted` as a positive notification. The probe `missing-reconciliation-counts-delivered` therefore observed **`arrived:false` but receipt state `notified` and an empty pending list**. This is positive delivery evidence for an operator-confirmed missing notice.

The dashboard additionally collapses attempted notices into notified rows, obscuring the distinction the new receipt API otherwise exposes. Broker summary counts also combine attempted and notified states; pending reasons only cover the completely unmarked `stored` state.

Suggested fix: model failed/reconciled-missing outcomes explicitly, including timestamps and evidence source. An attempt or negative reconciliation must not certify transport success. Regression coverage should reconcile a stored/attempted notice as missing and verify consistent broker, CLI and dashboard meaning without resending or acknowledging it.

## Disposition of the earlier 23 feedback items

“Added” below means a capability exists in source and/or passed its targeted automated check, not that every acceptance criterion or live platform integration has been completed.

| Earlier item | Assessment in 0.3.0 |
| --- | --- |
| F01 — historical session capacity | Active/retained split and retirement added; old 256-session blockage is addressed. Retained archival/recovery remains incomplete; R19–R21. |
| F02 — fallback identities/test pollution | Stable inherited-session selection, fallback warning, and disposable MCP room/data controls added. Broker ignores the `test` registration field, so test marking is not durably retained or filterable; isolation still works through the separate room. |
| F03 — Windows attachment diagnostics | Endpoint selection/error categories and read-only diagnostics added. No new Windows live push evidence was produced in this review. |
| F04 — worktree coordination | Git common-directory detection and explicit group discovery added. Groups list agents across separate rooms; `send`/`wait` remain room-scoped and Codex still requires exact room/thread cwd equality. The requested shared approved coordination-room behavior is not implemented by discovery alone. |
| F05 — honest delivery readiness | Declared status, timestamps, transport and push fields added; adapter integration/shutdown remain incomplete, R11. Dashboard agent rows still primarily render declared status and last update. |
| F06 — receipts/outbox | Added across broker/CLI/MCP/OpenCode. R04, R06, R08 and R26 affect accuracy and usability. |
| F07 — reconnect/reconciliation | Backoff and structured failure/reconcile records added. R10 loses a pre-submission opportunity; R26 misclassifies negative reconciliation. Reconciliation is a marker operation rather than a complete authorized retry workflow. |
| F08 — tool parity | Attachments, summaries, IDs, machine scope, filters, bulk ack, history and receipts improved. Remaining ordinary coordination gaps are listed in R24. |
| F09 — retained history retrieval | Full-ledger cursor/time/thread search and dashboard older-page loading added. Adapter paging metadata and advertised filter parity need correction, R04/R24. |
| F10 — persistent policy | Versioned bulletin/hash/acks added and documented in final HEAD. Ack evidence is not version-bound, churn hits the wrong bound, and tools lack read/ack, R15/R16/R24. |
| F11 — claim narrowing/handoff | Atomic narrowing and consent-based transfer paths added and covered by tests. Stale requests can reverse direction, R14. |
| F12 — Git/provenance metadata | Optional claim provenance retained through restart. It is owner-reported information, not verified hunk ownership; OpenCode lacks meta, R24. |
| F13 — watcher/process ownership | Registration, liveness listing and record removal added; removal does not kill processes. PID reuse is explicitly best-effort. R02 is a separate unsafe broker lifecycle implementation. |
| F14 — gate measurement honesty | Strict/permissive modes, coverage, sources, timestamps and explicit insufficient evidence added. Windows/Linux measurement tests are fixture-based here, not physical-platform runs. |
| F15 — machine claims in adapters | Exposed in both MCP and OpenCode and tested. Combined scope/provenance negotiation remains incomplete, R23. |
| F16 — long-term storage maintenance | Usage, export, restore and dry-run orphan inventory added. R01/R03/R17/R20/R21 prevent calling this a complete recovery/archival workflow; audit does not reclaim bytes. |
| F17 — broker lifecycle/recovery | Doctor/stop/restart/detail added. Stop/restart ownership verification needs R02. No actual replacement-runtime compatibility preflight was added. |
| F18 — version/capability compatibility | MCP package metadata and exact single-feature checks improved. Multiple feature combinations, running broker build identity and downgrade preflight remain incomplete; R23/R25. |
| F19 — model-input bounds | Count/byte controls added, but Unicode, oversized rows, paging and false inclusion receipts need R04/R06–R08. Codex/Claude push notices still use bodies without a common artifact envelope. |
| F20 — compatible fanout/scaling | Derived notice allowance added; OpenCode's real transitions exceed it, R09. No advertised-limit p50/p95/p99, write-volume, memory or restart benchmark is present. |
| F21 — installation-path refresh | Diagnose/refresh added; TOML diagnostics select the wrong entry, R22. Owner-loaded status correctly remains unknown. |
| F22 — packaged docs/platform matrix | Markdown CI template and links fixed; matrix distinguishes real versus scripted runner evidence. Fresh macOS packed-artifact smoke passed here. Linux/Windows and Node 20/22 were not run; GitHub Actions remains unconfigured. |
| F23 — structured tasks/dependencies | Task records, blockers, handoff references and completion fields added. Machine/path blockers are incorrect, R12/R13; adapter task tools remain absent, R24. |

## Strengths and preserved guarantees

The release substantially improves the package. The serial writer, durable-before-response ordering, private storage, atomic snapshots, separate writer lease, and conservative ambiguous-ownership handling remain valuable. Existing tests verify parallel delivery, restart preservation, fixed broadcast recipients, cooperative claim isolation, old-ledger compatibility, and explicit acknowledgements. The packed runtime smoke also exercises these basic paths successfully.

Agent adapters continue to pin project/session identity and distinguish peer coordination from user authorization. Recording-client tests cover existing-session delivery and refusal to invent another runner. None of the reproduced findings showed automatic acknowledgement, automatic claim expiry, or implicit execution of arbitrary broker commands. Attachment fetch still detects corrupted content even though restore's preflight does not.

The appropriate changes are targeted corrections to lifecycle, paging, delivery evidence and feature contracts while preserving those guarantees.

## Recommended implementation and verification order

1. **Recovery and process ownership:** R01–R03. Add active-wait restore coverage, realistic export sizes, and authenticated/verified shutdown before using maintenance on working installations.
2. **Reliable pages and receipts:** R04–R11 and R26. Test actual end-to-end adapter payloads, complete fanout paths, Unicode, continuation fields, and connection closure.
3. **Correct coordination state:** R12–R16 and R19/R20. Test machine/path blockers, stale handoffs, version-bound acknowledgements, and identity churn through lifecycle limits.
4. **Backup, diagnostics and exposure:** R17/R18/R21–R25. Verify attachment integrity, private export files, per-room usage, exact setup bindings, combined capabilities, and the agreed tool parity surface.

For each fix, use a regression that exercises the failing behavior rather than only asserting forwarded fields. The unread test already demonstrates why field-shape assertions can preserve a bug. After targeted checks pass, run the full suite and the fresh installed packed artifact. Add actual Node 20/22 and Windows/Linux validation where support is claimed; separately record live runner send/ack/reply results.

## Remaining verification limits

No live Codex/Claude/OpenCode model session was woken during this review. The existing validation matrix's historical live evidence was not independently replayed. Windows gate/Codex endpoint behavior and Linux filesystem/process behavior were not tested on those systems. No full advertised-limit performance benchmark, crash-at-every-filesystem-step campaign, or exhaustive dependency-source audit was performed. The zero-advisory npm result is time-specific.

These limits do not weaken the directly reproduced source/HTTP/SDK findings above. They mean the report should not be read as a certification of every platform or of cloud-model understanding.
