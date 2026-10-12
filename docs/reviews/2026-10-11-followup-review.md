# Agent Relay 0.3.0 — second review (historical snapshot)

This document records the review of 9646712. Its findings and line numbers describe that revision, not the latest working tree. See the [current review](2026-10-11-code-review.md) for the October 12 update.

Updated October 11, 2026, America/New_York. Reviewed commit **`9646712f292bf0326b6e1a96e1885574717bd67d`**, “Address 0.3.0 code review across 26 findings,” against the previous reviewed revision, `f5c37ca`.

**Current result: 14 distinct findings — 1 P1, 12 P2, and 1 P3.** Of the original 26 findings, **17 are resolved, 8 are partially resolved, and 1 remains open**. This follow-up identifies six additional findings, N01–N06. The original R24 tool-coverage gap overlaps the new N03 task-schema defect and is not counted twice.

The most urgent issue is **N01: offline restore bypasses the live writer lease**. It can replace the disk ledger while the running broker still owns it; the broker's next mutation overwrites the import. The old online-restore waiter crash and unsafe discovery-PID shutdown reproduction are addressed, but the new maintenance path needs its own ownership and durability guarantees.

All **192 automated tests pass**, and the fresh installed packed-artifact smoke passes. Twelve current findings have direct behavioral or packed-artifact evidence; N06 and the remaining R25 documentation inconsistencies are source verified. Passing tests do not establish that the six new paths and remaining edge cases below are correct.

## Scope, preservation, and artifacts

The follow-up change modifies **20 tracked files**, adding 3,179 lines and deleting 254. Review covered the broker, CLI, client, Codex bridge, MCP adapter, OpenCode plugin, dashboard receipt rendering, setup parser, changed documentation, and relevant regression tests. Package version remains **0.3.0**. The changes were initially uncommitted and became commit `9646712` during review; final code/evidence was checked against that commit.

The current working tree also contains three untracked Markdown operational reports moved under `docs/`. They are relevant because `npm pack` includes them. Runtimes and existing tests were not changed by this review. Only review documents, evidence, and the new reproduction harness were written. Every broker, fixture process, ledger import, attachment operation, and SDK connection used for review was disposable. No working runner or broker was signaled, and no real project messages were sent.

- [Original review and original 26 findings](2026-10-11-initial-review.md): historical snapshot, retained for comparison.
- [Original synthetic evidence](2026-10-11-evidence.jsonl) and [original probe harness](2026-10-11-probes.mjs): describe the old revision; that harness deliberately asserts old faults and is not expected to pass unchanged on fixed code.
- [Follow-up evidence](2026-10-11-followup-evidence.jsonl) and [follow-up probe harness](2026-10-11-followup-probes.mjs): current behavioral evidence.

Run the current focused checks from a source checkout with dependencies installed:

```sh
node docs/reviews/2026-10-11-followup-probes.mjs
```

The harness asserts both resolved behavior and remaining faulty behavior. A successful exit means its observations reproduced, not that every assertion is a product acceptance test. Captured evidence contains synthetic data only. Source line numbers below refer to `9646712`.

## Validation results

| Check | Result |
| --- | --- |
| `npm run release:check` | **192 passed**, 0 failed, 0 skipped; approximately 81.4 seconds in this environment. Packaged CLI help/version and dashboard syntax checks pass. |
| Follow-up probes | **18 records**: 7 resolved-behavior checks and 11 current fault reproductions. One probe exercises multiple related behaviors. |
| Independent packed install | Installed the `.tgz` and its own dependencies in a temporary directory. Packaged setup, join, send, inbox, ack, receipt, claims, export, and small dry-run restore pass. |
| Archive inspection | **32 files**, approximately 131 KiB compressed in the release check. Three additional operational Markdown reports enter the archive; N05. |
| Packaged Markdown links | The fresh artifact smoke's relative Markdown-link check passes. Absolute local paths inside operational reports are not portable package links. |
| npm production audit | Registry audit reports **0 known vulnerabilities** at review time. This is an advisory lookup, not a dependency-source audit. |
| Working tree/syntax | `git diff --check` and follow-up probe syntax check pass. |
| Environment | macOS, Node **v26.5.0**, npm **11.17.0**. No new Windows/Linux, Node 20/22, or live vendor-model acceptance run was performed. |

The fuller test suite is a material improvement. It adds regression coverage for waiter removal, attachment corruption, cursor continuation, version-bound bulletin acknowledgements, retired obligations, per-room utilization, capability combinations, adapter parity, Unicode, and explicit adapter close. The remaining failures are combinations or entry points outside that coverage.

## Status of each original finding

“Resolved” means the original triggering behavior is addressed by the current code and the stated verification. It does not certify every replacement path; for example, R03's large import now has an offline route, whose new defects are N01/N02/N06.

| Original ID | Status | Current evidence and remaining scope |
| --- | --- | --- |
| R01 — restore/waiter crash | **Resolved** | Restore cancels waits before replacing state; wake, timeout and close tolerate missing rooms. Real wait + empty restore + later registration passed. Suite covers agent removal too. |
| R02 — unsafe PID shutdown | **Resolved** | Positive integer/loopback checks, authenticated capabilities and lease-PID agreement are required. New CLI test refuses forged discovery, invalid PIDs, mismatched leases and wrong tokens without signaling victims. This verification is not used safely by offline restore, N01. |
| R03 — export larger than request limit | **Resolved through offline route** | A **196,577-byte**, 24-message import succeeded through `--offline` and reopened successfully. Normal RPC retains its 128 KiB cap. Ownership, maximum store size and durability gaps are new N01/N02/N06. |
| R04 — byte-page continuation | **Resolved** | Receipt rows include durable cursors; both adapter limiters update cursor/nextCursor/done after trimming. Follow-up history/outbox continuation matches last shown row. Oversized single rows remain R08. |
| R05 — inverted unread option | **Resolved** | Both adapters directly forward `unread` to `unacked`; a real MCP unread query excludes the acknowledged first message. |
| R06 — false context receipts | **Resolved for context transform** | Only `shaped.includedIds` receive context notices. Probe inserted two messages and recorded exactly two context notices. Wake admission still fences omitted rows, N04. |
| R07 — Unicode byte accounting | **Resolved for normal admitted message envelopes** | UTF-8 accounting includes wrapper/footer, with compact retrieval envelopes. The previous Unicode backlog now produces **32,279 bytes**, below 32 KiB. |
| R08 — single-row response cap | **Open** | Receipt recipient pagination leaves the full pending list; outbox still returns full broadcast receipts and admits one oversized row. **147,687-byte** receipt and **173,722-byte** outbox reproduced. |
| R09 — three-stage fanout budget | **Resolved for the reported path** | Allowance is six per recipient, giving **3,072** at 512 recipients. Suite records the four OpenCode stages plus reconciliation without the prior refusal. Arbitrary marker sets remain bounded. |
| R10 — first Codex message after close | **Resolved** | Preparation/reconnection occurs before admission. Recording connection reproduced one reconnect and accepted the same first message without another runner. |
| R11 — stale connected readiness | **Partial** | Explicit adapter close and OpenCode disposal now report disconnect; transient report failures no longer disable reporting. Natural MCP peer close still leaves connected metadata. Codex still omits readiness transport/push reports; no crash freshness rule. |
| R12 — machine task blockers | **Resolved** | The shadowing variable is renamed and the real ledger is passed to task views. Real list with `blocked:true` returns the machine-blocked task. |
| R13 — parent/path task blockers | **Partial** | Parent/child comparison is fixed; canonical symlink identity is still absent. A task using an in-project alias says unblocked while the actual claim fails. |
| R14 — stale handoff direction | **Partial** | Fresh offers save holder/generation and reject changed ownership. Retained legacy offers take the old branch and can still reverse direction. |
| R15 — unread bulletin version ack | **Resolved** | Version is required, optional hash is checked, and acknowledgement is recorded against that exact retained version with a stale/current result. Probe acknowledged v1 while current was v2, correctly retaining v1 evidence. |
| R16 — bulletin churn bound | **Resolved** | Ack admission/validation use the retained 8,192-identity bound and a specific capacity error. New suite covers churn past the former active bound. |
| R17 — attachment restore verification | **Resolved** | Shared verifier checks bounded bytes, hash and size; dry-run reports missing/corrupt separately, actual restore refuses unless incomplete restoration is explicit. New real broker tests cover corruption, missing files, shared hashes and unreadable files. |
| R18 — private export permissions | **Partial** | New files are 0600 and final-component symlinks are refused. Overwriting a 0644 destination deliberately preserves 0644. |
| R19 — retirement strands ownership | **Resolved for default retirement** | Default retirement refuses claims, machine claims, pending handoffs and process records. Explicit `relinquish` returns stranded obligations/recovery instead of silently losing them. |
| R20 — impossible retained recovery advice | **Resolved as guidance** | The error now explains export, a fresh directory and explicit pending-work handover. Retirement is correctly documented as retaining its slot. Safe archival remains a product limitation, not a shipped operation. |
| R21 — wrong-scope capacity | **Partial** | Per-room minimum headroom and machine separation are correct. Notice headroom selects the largest marker count rather than the smallest remaining allowance; a full smaller message is missed. |
| R22 — wrong TOML server | **Partial** | Ordinary/quoted neighboring tables and escapes are handled. Inline-table values after the first key remain invisible to the line-anchored extractor. |
| R23 — combined capability checks | **Resolved for the reported combinations** | Arrays of requirements replace one-feature selection; added tests refuse missing summary or provenance before mutation. Newly introduced argument contracts still have no separate feature identity; compatibility limit below. |
| R24 — agent operation parity | **Partial; overlaps N03** | Both adapters now expose bulletin, handoff, narrowing, tasks, process list and group list, plus time/reverse-history filters and richer OpenCode status/provenance. Task lists cannot be cleared through their schemas, N03. OpenCode narrowing/handoff metadata and completion-ack exposure remain narrower than the broker. |
| R25 — stale operating docs | **Partial** | CI artifact distinction, gate measurements, process-list persistence and retained identity semantics are corrected. Test count and notice allowance are still stale. |
| R26 — missing delivery becomes notified | **Resolved for negative reconciliation** | Broker and dashboard now have missing/attempted states and negative reasons. New tests preserve missing delivery meaning, then distinguish accepted and acked states. |

## Current finding index

P1 indicates a live ownership/recovery failure. P2 indicates material coordination, confidentiality, delivery, diagnostics or maintenance reliability failure. P3 indicates a remaining documentation mismatch.

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| N01 | **P1** | Offline restore bypasses the live writer lease | Reproduced |
| N02 | P2 | Offline restore accepts a ledger the broker refuses to load | Reproduced |
| R08 | P2 | Recipient pagination does not enforce aggregate response limits | Reproduced |
| R11 | P2 | Natural MCP disconnect retains connected readiness | Reproduced; Codex/freshness gaps source verified |
| R13 | P2 | Task blockers still ignore canonical symlink identity | Reproduced |
| R14 | P2 | Retained legacy handoffs bypass the direction/generation fix | Reproduced |
| R18 | P2 | Export overwrites preserve permissive permissions | Reproduced |
| R21 | P2 | Notice utilization hides a full smaller message | Reproduced |
| R22 | P2 | Inline TOML diagnostics fail open on an unchecked command/CLI | Reproduced |
| N03 | P2 | Task tools cannot clear dependencies or resource lists | Reproduced in MCP; OpenCode schema verified |
| N04 | P2 | OpenCode fences messages omitted from a bounded wake | Reproduced with recording runtime |
| N05 | P2 | Package now includes untracked operational Markdown reports | Packed-artifact inspection |
| N06 | P2 | Offline restore announces success without durable flushing | Source verified; no power-loss test |
| R25 | P3 | Current docs still list 144 tests and three notices per recipient | Source verified |

## Detailed current findings

### N01 — Offline restore does not acquire the durable writer lease

**P1 · New path · Reproduced.**

Source: [bin/agent-relay.mjs](../../bin/agent-relay.mjs), lines 186–236; compare `writerLease()` in [lib/broker.mjs](../../lib/broker.mjs).

`restore --offline` refuses only when `verifiedBroker()` succeeds. That function depends on healthy discovery, a reachable endpoint, authentication, and a matching lease. A broker can still own `writer.lock` when discovery is missing/corrupt, authentication is unavailable, or the endpoint cannot answer. The offline branch neither rejects that lease nor takes a new exclusive lease before rewriting `state.json`. It also has a check/write race with a concurrent broker startup.

Probe `offline-restore-bypasses-live-lease` used the public `createBroker()` API, which intentionally leaves discovery to the caller. The live fixture held a valid writer lease and retained one agent. Offline restore reported success and replaced disk state with zero rooms. The live broker still listed its old agent; its next registration rewrote the ledger with a room again, **overwriting the supposedly completed import**.

Fix: acquire the same exclusive writer ownership used by the broker for the entire offline operation. Refuse live or ambiguous leases regardless of discovery/HTTP state. Test missing discovery, bad token, unresponsive/faulted endpoints, ambiguous recovery sentinels, and concurrent startup. Keep the correct online writer lease invariant.

### N02 — Offline import ignores the 64 MiB storage bound

**P2 · New path · Reproduced.**

Source: [bin/agent-relay.mjs](../../bin/agent-relay.mjs), lines 201–217 and 232–236; startup byte check in [lib/broker.mjs](../../lib/broker.mjs), lines 1744–1754.

`validateStore()` validates record structure; the byte bound is enforced separately by broker startup and online persistence. Offline restore calls the structural validator but never checks the serialized store size. Dry-run can say valid, and a real import can report restored, for a ledger that cannot reopen.

Probe `offline-restore-exceeds-store-bound` imported a structurally valid object with a large optional/unknown field. It wrote **67,108,914 bytes** and reported success. The subsequent broker startup failed with **“Relay state exceeds its storage bound.”** This is a deterministic admission-contract mismatch; no actual full production ledger was used.

Fix: share shape and serialized-byte validation between offline import, online persistence and startup. Reject before backup/replacement and report actual bytes/limit. Test below, exactly at, and above the limit, including supported retained metadata as well as unknown fields. Preserve the valid medium-sized offline route verified for R03.

### R08 — Count pagination still permits very large model/tool responses

**P2 · Original finding remains open · Reproduced.**

Sources: [lib/broker.mjs](../../lib/broker.mjs), lines 901–927 and agents response at 947–959; `boundPage()` in [lib/mcp.mjs](../../lib/mcp.mjs) and [lib/opencode-plugin.mjs](../../lib/opencode-plugin.mjs).

The new receipt recipient slice is useful, but `pendingReceipts()` still returns every pending recipient. Outbox still constructs full receipts, and both page limiters still stop when one message remains. Agent pages are count-limited only and return all claims; 100 agent task objects can be much larger than 64 KiB. Newly added bulletin/task/handoff/group tools also have no aggregate byte contract.

Probe `remaining-tool-byte-overruns` seeded a valid 800-recipient broadcast. A receipt with **`recipientsLimit:1`** returned one recipient plus **800 pending rows**, totaling **147,687 bytes**. A one-message outbox was **173,722 bytes** against its **65,536-byte** budget.

Fix: bound the complete response, including pending/claims and wrapper metadata. Offer resumable recipient/pending pages and compact outbox summaries; preserve a separate explicit full retrieval where needed. Test one oversized row and default pages with maximum-size task metadata. Avoid silently truncating instructions.

### R11 — The new shutdown report covers explicit close, not transport close

**P2 · Partially fixed · Reproduced.**

Source: [lib/mcp.mjs](../../lib/mcp.mjs), lines 376–401; Codex registration/finally in [lib/codex.mjs](../../lib/codex.mjs); [lib/observability.mjs](../../lib/observability.mjs).

`adapter.close()` now reports disconnected before aborting. However, `server.onclose` still just aborts the lifetime. When the MCP peer closes its transport, that callback runs first; it never sends the report, and a later explicit close uses an already-aborted signal. This is the normal parent/transport closure entry point, not just a hard process crash.

Probe `mcp-peer-close-keeps-connected` initialized a real SDK channel, closed the SDK **client** rather than the adapter helper, and queried the broker. The closed adapter still matched **connected**.

Codex continues reporting declared `attached` without populating transport/push observations. Durable connected reports have no expiration/freshness interpretation after abrupt termination. These are residual portions of R11, not reasons to discard the successful OpenCode disposal and transient-error fixes.

Fix: centralize disconnect cleanup for both close paths and use a short-lived independent report context when the transport/lifetime has already ended. Add peer-close, subprocess EOF and signal teardown tests; interpret old reports as last observations rather than verified current readiness.

### R13 — Claim blocking and task blocking still canonicalize differently

**P2 · Partially fixed · Reproduced.**

Source: [lib/broker.mjs](../../lib/broker.mjs), lines 151–162; compare `canonicalResource()`.

The new parent/child comparison fixes broad directory claims. It still resolves task references with `path.resolve`, while real claims use filesystem `realpath` and canonical existing ancestors. An in-project symlink points a task at the same physical file under another spelling, but the task view does not find its blocker.

Probe `symlink-task-blocker` created `alias -> target` inside a temporary project, claimed `alias/file` for A, and made B's task depend on `alias/file`. The task said **`blocked:false`**; B's actual claim failed with **`CLAIM_CONFLICT`**.

Fix: share canonical resource resolution with task references, while preserving original human-readable refs. Test aliases, nonexistent children under canonical ancestors, directory claims and supported Windows path identity.

### R14 — Legacy handoff records still take the unsafe branch

**P2 · Partially fixed · Reproduced across restore/legacy record shape.**

Source: [lib/broker.mjs](../../lib/broker.mjs), lines 1652–1735.

New handoffs retain original holder and claimed-at generation. If `offeredBy` is absent—as it is for all pending offers retained from the earlier 0.3.0 broker—the broker takes the legacy branch, which still chooses direction from the current holder. The upgrade therefore fixes new traffic but not existing obligations.

Probe `legacy-handoff-reversal` first verified that a fresh stale offer failed with **`HANDOFF_STALE`**. It then loaded the equivalent valid legacy record without offered/generation fields. B accepted the old A-to-B offer while B held the file, and ownership transferred **back to A**.

Fix: fail closed on legacy pending offers unless their direction can be established safely. Ask parties to recreate/confirm offers, preserving the old audit record. Cover upgrade/startup from an old saved ledger and both offer/request forms, rather than only fresh requests.

### R18 — Existing export permissions are deliberately preserved

**P2 · Partially fixed · Reproduced.**

Source: [bin/agent-relay.mjs](../../bin/agent-relay.mjs), lines 164–182.

The new default 0600 and atomic rename improve fresh exports. For overwrites, `const mode = existing ?? 0o600` preserves the destination's old mode, and the temporary file is chmod'd to it. A previously permissive file remains permissive when filled with the complete private ledger.

Probe `existing-export-permissions` created a 0644 destination and ran the real CLI export. The result reported **mode 644**, and the replaced file remained **0644**. The added package test currently expects this preserved mode.

Fix: use private permissions for private exports on both creation and replacement, or require an explicit choice before preserving wider access. Correct the regression expectation and test an existing 0644 file. No other-user access was attempted in this review.

### R21 — Notice headroom is calculated for the wrong message

**P2 · Partially fixed · Reproduced.**

Source: [lib/broker.mjs](../../lib/broker.mjs), lines 1167–1174 and 1195–1213.

Per-room resource headroom now uses the correct minimum. Notice headroom still uses the message with the **largest absolute marker count**. Different messages have different allowances, so that message need not be the one closest to refusal.

Probe `notice-headroom-chooses-wrong-message` used a 300-recipient message with 1,500 markers/1,800 allowance and a one-recipient message with 1,024 markers/1,024 allowance. Usage reported **300 free notices** and no notice warning. Another marker for the smaller message immediately failed with **`NOTICE_LIMIT`**.

Fix: report minimum remaining per-message capacity (and which message), separately from the largest absolute marker count. Compute near-limit warnings against each relevant allowance. Add the mixed-fanout fixture to the utilization tests.

### R22 — Inline TOML extraction ignores keys after the first

**P2 · Partially fixed · Reproduced with valid TOML forms.**

Source: [lib/setup.mjs](../../lib/setup.mjs), lines 127–150, 160–171 and 197–202.

The new selector isolates the correct server table. Inline content is still passed to extractors whose `command` and `args` patterns require the beginning of a line. Values after a comma on the same line are not inspected. Missing captures are treated as healthy rather than as an incomplete binding.

Probe `inline-toml-diagnostics-fail-open` tested two forms:

```toml
[mcp_servers]
agent-relay = { command = "/existing/node", args = ["/missing/relay-cli"] }
# Or with the key order reversed:
agent-relay = { args = ["/existing/file"], command = "/missing/relay-node" }
```

Each was tested separately using a real existing executable path. Both diagnostics returned **`ok:true`**: the first ignored missing CLI args; the second ignored the missing command. The new inline test catches a missing command only when it is first.

Fix: parse the actual inline key/value structure and require the needed fields. Cover both key orders, nested inline tables, comments, quoting and multiline arrays, plus missing values. Avoid another regex-only happy-path assertion.

### N03 — The newly added task tools cannot remove a dependency list

**P2 · New tool-schema defect · Reproduced in MCP; same OpenCode constraint.**

Source: [lib/mcp.mjs](../../lib/mcp.mjs), lines 62–67 and validation at 99–104; [lib/opencode-plugin.mjs](../../lib/opencode-plugin.mjs), task schema around lines 409–424.

The broker accepts `blockedBy:[]` and `resources:[]` to clear existing lists. Both adapters require at least one entry for these optional task arrays. Omitting the field preserves the old value, so a tools-only agent cannot clear the final blocker/resource after a handoff.

Probe `task-tool-cannot-clear-arrays` created a task, then tried to update it with **`blockedBy:[]`**. MCP returned **“Invalid blockedBy array.”** The equivalent direct broker update succeeded.

Fix: permit zero-length replacement lists specifically for task updates and enforce the broker's maximum bound. Keep nonempty arrays for claim acquisition/handoff requests. Verify clear operations end to end in both adapters. Remaining parity limits include OpenCode handoff/narrowing meta and completion acknowledgement fields; do not infer complete parity from matching tool names.

### N04 — OpenCode marks omitted wake content as attempted

**P2 · Newly exposed in the bounded wake path · Reproduced with recording runner.**

Source: [lib/opencode-plugin.mjs](../../lib/opencode-plugin.mjs), lines 216–229.

Context-transform notices now correctly use included IDs. `wake()` still admits **every pending row**, adds all to `state.attempted`, and only then formats a bounded subset for `promptAsync`. The omitted message bodies never enter the prompt, but their persistent wake-attempt markers suppress later idle wake attempts, including after restart.

Probe `omitted-wake-messages-fenced` used 30 valid Unicode messages. The prompt contained **two** message envelopes, while the plugin persisted **30 wake-attempt markers**, including **28 omitted messages**. The omission footer makes them discoverable via tools, but does not make those messages submitted to the model or justify fencing their own wake opportunities.

Fix: select the bounded payload before admission, then admit/submit exactly those IDs, preserving duplicate-admission handling. Keep uncertain submitted content fenced. Test multiple idle cycles where earlier included rows are handled and previously omitted rows become eligible.

### N05 — Operational reports now enter the public package candidate

**P2 · Packaging change in the current working tree · Verified on the packed artifact.**

Source: [package.json](../../package.json), `files: ["docs/*.md", ...]`; allowlist in [scripts/release-check.mjs](../../scripts/release-check.mjs).

Moving local reports from the repository root into `docs/` makes them match the publication wildcard. Current `npm pack` includes:

- `docs/AGENT_RELAY_PACKAGE_FEEDBACK_2026-10-09.md`
- `docs/DEPLOY-RESULT.md`
- `docs/DEPLOY-RESULT-1.md`

They are **untracked**, but npm packaging still includes them. The archive increased from **29 to 32 files**. The feedback contains retained incident/message references; deployment reports contain machine paths, PIDs, broker/release history and owner follow-up instructions. No bearer token or credential exposure was established. The packed archive was inspected locally and was not published by this review.

Fix: explicitly decide which reports are public, and exclude local operational material from the runtime package candidate unless publication is intended. Use a deliberate documentation allowlist or a private subdirectory. Make release validation reject unexpected report files and test the same clean package candidate that will be published. The existing check accepts any `docs/*.md`, so it passes this change.

### N06 — Offline restore skips the durable flushing used by the broker

**P2 · New path · Source verified; no power-loss experiment performed.**

Source: [bin/agent-relay.mjs](../../bin/agent-relay.mjs), lines 225–236; compare `persist()` in [lib/broker.mjs](../../lib/broker.mjs).

The online writer syncs the new file before rename, then syncs the directory where supported. Offline restore writes/chmods the backup and temporary state, renames, and immediately reports success. Neither file contents nor directory entries are flushed. Atomic rename prevents observing a partial file during normal execution, but does not establish the same durable completion or durable backup guarantee after a crash/power loss.

Fix: reuse the reviewed persistence primitive and platform-specific flush handling for offline import, under the lease required by N01. Flush the backup before relying on it, and define errors after replacement as ambiguous rather than overwriting from a stale snapshot. Use fault-injected filesystem tests for write/sync/rename boundaries; successful readback alone cannot establish crash durability.

### R25 — Documentation still gives old test and notice counts

**P3 · Partially fixed · Source verified.**

Sources: [docs/validation.md](../validation.md), line 10; [docs/broker-notes.md](../broker-notes.md), lines 88–92; [lib/broker.mjs](../../lib/broker.mjs), notice allowance constant.

Validation now says **144 passing tests**, while the suite has **192**. Broker notes say `max(1024, 3 per recipient)`, while the implementation now uses **six** per recipient. The corrected CI artifact explanation, gate measurement description and process-list write semantics should remain.

Fix: align those numbers with the final implementation and consider checking shared published constants/test summaries at release time. The Codex client-info version remains 0.1.0 and is now described as protocol metadata; this review did not independently establish the documentation's assertion that this literal must stay stable for protocol matching.

## Compatibility and verification limits

The same package version/protocol/schema and mostly the same capability names span both the old and corrected 0.3.0 code. New `ackBulletin` version binding and agent/receipt pagination therefore cannot be distinguished from the previous broker solely by existing feature names. Updated clients can still encounter a running older broker that advertises the feature but ignores new fields. The original combined-field issue R23 is fixed; these new-contract compatibility cases remain a validation gap, not an independently reproduced extra finding in the 14-count above.

Groups still discover agents across separate rooms rather than implementing a shared cross-worktree message room. Retirement/archival does not reclaim retained identity slots. Process liveness remains best-effort for PID reuse. Those limitations are not newly introduced by this patch. No advertised-limit p50/p95/p99 throughput or memory/write-volume study was run.

No real Codex/Claude/OpenCode model was woken. Runner observations used recording clients, while broker/CLI/SDK behavior used real temporary storage and loopback HTTP. Windows/Linux, Node 20/22 and fresh live model send/ack/reply evidence remain unverified in this review. Registry audit results are time-specific.

## Recommended next changes

1. **Offline recovery:** N01 first, then N02/N06. Share ownership, bounds and persistence mechanics with the online broker before relying on offline maintenance for a working store.
2. **Existing coordination obligations:** R14 and R13. Test upgrades with pending legacy offers and canonical alias references, not only new records.
3. **Delivery/model evidence:** R08, R11 and N04. Test natural peer closure, complete serialized payload budgets, and the exact message IDs admitted versus actually submitted.
4. **Operator/tool correctness:** R18, R21, R22 and N03. Correct the regression expectations that preserve permissive exports or validate only one inline key order.
5. **Release candidate:** N05 and R25. Inspect the clean packed file inventory, synchronize documentation, then repeat targeted regressions, the full 192-test suite, and independent packed installation.

The patch meaningfully improves the original review's failure cases. The remaining work is concentrated in entry-point parity, old persisted records, and shared contracts that currently have different implementations across online/offline or broker/adapter paths.
