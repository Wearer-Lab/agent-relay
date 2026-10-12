# Agent Relay 0.3.0 — current in-depth code review

Updated **October 12, 2026**, America/New_York. Third review of the package.

**Result: 8 current findings — 1 P1 and 7 P2.** Eleven of the previous review's 14 active findings are resolved; R08, R11 and R22 are partially resolved. Five additional findings, N07–N11, are reproduced below. All eight current findings have focused behavioral evidence.

The highest-priority regression is **N07: `restore --offline --dry-run` performs a real restore**. A disposable ledger with one room was replaced by an empty ledger despite the explicit dry-run flag. The new writer-lease and durability protections correctly address the previous offline-maintenance problems, but the CLI refactor dropped the dry-run and export-schema checks.

All **232 tests pass**, with no failures or skips. The independent packed-install smoke also passes, and the archive is back to **29 files**, excluding internal operational reports. Passing tests do not cover the new CLI option regressions, collection continuation, initialization/close race, or remaining large-row and TOML cases.

## Reviewed state and preservation

The review covers the **uncommitted working-tree changes** on top of `9646712f292bf0326b6e1a96e1885574717bd67d`, the revision reviewed previously. Seventeen tracked files changed: 1,972 insertions and 202 deletions at initial inspection. Package version remains 0.3.0. Findings refer to this working-tree snapshot rather than claiming that the changes are already committed or released.

The [source manifest](2026-10-12-source-manifest.json) records SHA-256 hashes for the 17 changed tracked files. Review covered the broker/CLI maintenance refactor, both adapter response limiters and schemas, readiness reporting, OpenCode wake selection, task path canonicalization, TOML parsing, package checks, documentation, and the corresponding regression tests.

Only review artifacts were written. Runtime source and existing tests were left as supplied. Every behavioral check used private disposable storage, fixture brokers, real loopback HTTP/SDK connections, or a recording OpenCode client. No existing runner was woken, no working ledger was restored, and no working broker/process was stopped.

Historical reviews remain available:

- [Initial review of f5c37ca](2026-10-11-initial-review.md), with the original 26 findings.
- [Second review of 9646712](2026-10-11-followup-review.md), with the previous 14 current findings and their evidence.
- [Current probe harness](2026-10-12-probes.mjs) and [captured current evidence](2026-10-12-evidence.jsonl).

```sh
node docs/reviews/2026-10-12-probes.mjs
```

The current harness deliberately asserts both resolved behavior and remaining failures. Its successful exit means the observations reproduced, not that every asserted behavior is correct. The older harnesses assert historical behavior and should not be treated as current regression suites.

## Validation

| Check | Result and scope |
| --- | --- |
| `npm run release:check` | **232 passed**, 0 failed, 0 skipped; approximately **48.8 seconds**. Packaged help/version and dashboard syntax checks pass. |
| Current focused probes | **13 records**: five records verify resolved behavior and eight reproduce current findings. Real broker/CLI/SDK paths are used where applicable. |
| Fresh installed artifact | Installed the packed 0.3.0 archive with independent dependencies. Setup, registration, send/inbox/ack/receipt, claims, export and ordinary online dry-run restore pass. This smoke does not establish offline dry-run safety. |
| Pack inventory | **29 files**, approximately 113.4 KiB compressed in the release check. Operational reports under `docs/internal/` are excluded; the release checker now requires the eight intended public Markdown guides. |
| Markdown links | Relative links in the packed artifact resolve. Review/archive links were checked separately. |
| Production dependency audit | npm registry audit reports **0 known vulnerabilities** at review time. No exhaustive dependency-source audit is claimed. |
| Syntax and whitespace | Current probe syntax and `git diff --check` pass. |
| Environment | macOS, Node **v26.5.0**, npm **11.17.0**. No new Windows/Linux, Node 20/22, or live vendor-model acceptance evidence. |

The new suite adds useful boundary and failure-injection checks: shared writer ownership, 64 MiB admission, backup/state/directory flushing, attachment errors, legacy handoff refusal, private replacement exports, canonical claim aliases, narrow notice headroom, bounded wake admission, and ordinary peer disconnect. The next tests should target complete CLI workflows and resumable read contracts as well as helper behavior.

## Status of the previous 14 active findings

“Resolved” refers to the previously documented trigger, not a certification of every revised path. The offline helper fixes N01/N02/N06 while its CLI integration introduces N07/N08/N10.

| Previous finding | Status | Current assessment |
| --- | --- | --- |
| N01 — offline import bypasses writer lease | **Resolved** | Offline import uses the shared exclusive writer lease. A live broker without discovery is refused and its ledger remains unchanged. Suite covers missing/corrupt discovery, ambiguous locks/recovery, and concurrent startup. |
| N02 — offline import exceeds store bound | **Resolved** | Serialized bytes are checked against exported `MAX_STORE` before replacement. Suite verifies below/exactly/above 64 MiB and reopening a medium import. |
| R08 — aggregate tool response limits | **Partial** | Recipient/pending slices and broad byte accounting fix the prior 800-recipient fixture. One recipient's large marker history still exceeds the cap; collection trimming introduces N09. |
| R11 — closed readiness remains connected | **Partial** | Natural MCP closure now uses an independent disconnect context, and Codex reports connection/disconnection. Closure while the first connected report is in flight still skips cleanup. Timestamp age is exposed but has no freshness-based connected-state policy. |
| R13 — canonical task claim aliases | **Resolved** | Task views canonicalize existing ancestors like claims. The same in-project symlink fixture now reports blocked correctly. |
| R14 — legacy handoff reversal | **Resolved** | Acceptance of unverifiable legacy offers fails closed with `HANDOFF_STALE`; the record remains for audit and parties can recreate it. Decline remains available. |
| R18 — permissive replacement export | **Resolved** | Both new and replacement exports use 0600. A pre-existing 0644 destination becomes 0600 in the real CLI probe. |
| R21 — notice headroom chooses largest | **Resolved for the reported trigger** | Usage tracks the smallest remaining allowance separately from largest marker count. Added mixed-fanout test recognizes the exhausted smaller message. |
| R22 — inline TOML key order | **Partial** | The previous first-key-only failure is fixed and missing fields fail closed. Valid root inline-table and triple-quoted command forms are still rejected. |
| N03 — task arrays cannot be cleared | **Resolved** | Both schemas now permit empty task replacement arrays. Real MCP update clears both dependency and resource lists. |
| N04 — wake fences omitted messages | **Resolved** | Formatting selects IDs before admission. A 30-message backlog admits exactly the two prompt messages, leaving 28 omitted messages unfenced. |
| N05 — operational reports enter archive | **Resolved in current candidate** | Reports moved to `docs/internal/`; the archive excludes them, and the release checker rejects unexpected top-level Markdown guides. |
| N06 — offline import omits durable flushes | **Resolved** | The helper syncs backup and state files plus directory entries where supported. New fault-injected tests cover pre/post-rename failures and prohibit stale-state rollback. No physical power-loss test was performed. |
| R25 — stale counts/docs | **Resolved for the reported mismatches** | Guides now state 232 tests and six notices per recipient; those agree with this run. |

The originally resolved delivery, acknowledgement, capacity, version-bound bulletin and machine-claim behaviors remain covered by the expanded suite. Remaining minor API parity differences, such as OpenCode narrowing/handoff provenance and completion-ack exposure, are listed as coverage limits rather than counted again as the same task-schema defect.

## Current finding index

P1 indicates an explicitly non-mutating maintenance command changing durable data. P2 indicates an incorrect coordination/read/diagnostic contract, a recovery regression, or a demonstrated performance-contract regression.

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| N07 | **P1** | Offline dry-run replaces the ledger and creates a backup | Real CLI/disk reproduction |
| N08 | P2 | Offline restore ignores the export wrapper's schema version | Real CLI reproduction |
| N09 | P2 | Byte-trimmed task/handoff/process lists have no read continuation | Real SDK/task reproduction; related branches inspected |
| R08 | P2 | A single recipient's transport history still bypasses the byte cap | Real broker/SDK reproduction |
| R11 | P2 | Close during the initial connected report leaves connected metadata | Real broker/SDK with controlled RPC completion |
| R22 | P2 | Valid TOML forms are diagnosed as missing a command | Filesystem diagnostic reproduction; stdlib parser validates syntax |
| N10 | P2 | Offline import no longer prepares a new data directory | Real CLI reproduction |
| N11 | P2 | Volatile transport age invalidates unchanged dashboard snapshots | Real authenticated dashboard HTTP reproduction |

## Detailed findings

### N07 — `restore --offline --dry-run` performs a real replacement

**P1 · New CLI regression · Reproduced.**

Source: [bin/agent-relay.mjs](../../bin/agent-relay.mjs), lines 186–197; [lib/broker.mjs](../../lib/broker.mjs), `offlineRestore()` at 643–738.

The parser still accepts `--dry-run` and help still advertises it. The refactored offline branch calls `offlineRestore()` with only `allowIncomplete`. That helper has no dry-run branch and always writes a backup/new state for valid input. The ordinary online restore branch still passes `dryRun`, so the same requested safety option has different semantics depending on `--offline`.

Probe `offline-dry-run-mutates` created a temporary ledger with one registered room, closed its broker, and invoked the real CLI with an empty export and **`--offline --dry-run`**. The response said **`restored:true`**, returned no `dryRun` flag, created a backup, and the disk ledger changed from **one room to zero**.

This is durable data mutation, not just a transient lock or inspection timestamp. The backup helps recovery but does not make dry-run correct. No real project data was used.

**Fix:** preserve the dry-run option through the shared helper. Validate shape, bytes, schema and attachments without replacing state or creating backups. Test byte-identical preservation of state/token/attachments and absence of backup/temp files for both online and offline dry runs, including missing/corrupt artifacts and invalid input.

### N08 — Export-schema validation disappeared from offline CLI restore

**P2 · New CLI regression · Reproduced.**

Source: [bin/agent-relay.mjs](../../bin/agent-relay.mjs), lines 191–197; [lib/broker.mjs](../../lib/broker.mjs), lines 668–675 and online restore schema guard.

The CLI unwraps `payload.state` and discards `payload.schemaVersion` when calling the helper. Previously the offline branch rejected an incompatible wrapper schema before mutation. Structural validation of `state.version` cannot substitute for checking the declared export schema; both have separate fields/contracts. Online restore still forwards and checks the wrapper version.

Probe `offline-wrapper-schema-ignored` submitted **`schemaVersion:999`** with a structurally valid version-1 state. Offline restore reported **`restored:true`** instead of refusing the incompatible export.

**Fix:** pass the export schema explicitly into shared validation or validate the complete export envelope before unwrapping. Preserve the supported raw-state-file contract separately. Test incompatible envelope schemas against both entry points and verify that all durable files remain unchanged after refusal.

### N09 — Collection trimming removes rows without providing a continuation

**P2 · New read-contract regression · Reproduced in MCP; matching OpenCode branches.**

Source: [lib/mcp.mjs](../../lib/mcp.mjs), `boundPage()` lines 204–249 and task tool schema around 62–67; corresponding [lib/opencode-plugin.mjs](../../lib/opencode-plugin.mjs) limiters; broker task-list branch.

The new limiter bounds task, handoff and process lists by deleting trailing rows. It reports `total`, omitted counts and `hasMore:true`, but there is no corresponding offset/cursor in those tools or broker reads. Repeating the read gives the same prefix. Task `id` exists in the general tool schema for mutation, but the broker ignores it for `action:'list'`; it is not a read-by-ID fallback.

Probe `collection-trimming-no-continuation` loaded **64 valid tasks**, each with permitted 4 KiB verification text. `relay_tasks({action:'list'})` returned **15 tasks**, `total:64`, `hasMore:true`, and **no continuation**. Listing with `id:'task-63'` returned exactly the same prefix. All tasks shared the same owner/state, so existing filters did not provide a partitioning workaround. Forty-nine rows were unreachable through that read interface.

The same trimming pattern affects handoffs and process records. Agent claims can be removed with `claimsOmitted` but lack claim-page continuation; group-agent trimming likewise only reports an omission count. Those related paths were inspected, not independently replayed here.

**Fix:** add broker-level count/byte paging with stable continuation and explicit read-by-ID where appropriate, then expose it in both schemas. Require repeated advertised reads to reach every retained row once. Avoid requiring a mutation or shell access to read omitted coordination state.

### R08 — An oversized single transport history still exceeds 64 KiB

**P2 · Partially resolved original finding · Reproduced.**

Source: [lib/mcp.mjs](../../lib/mcp.mjs), lines 136–182; matching [lib/opencode-plugin.mjs](../../lib/opencode-plugin.mjs) code; broker `noticeAllowance()`.

The broader limiter correctly handles many recipients/pending rows, but it preserves at least one row and one recipient. It does not page that recipient's notified/accepted/missing marker arrays. A one-recipient message can legally retain up to 1,024 notices. Trimming recipient counts cannot reduce that transport history.

Probe `single-row-response-still-unbounded` used a valid saved message with one recipient, a permitted 16 KiB body and **1,024 bounded marker entries**. Real MCP calls returned an inbox of **155,862 bytes** and a recipient-limited receipt of **136,641 bytes**, both exceeding the advertised **65,536-byte** cap.

The extra `byteSize/maxBytes/continuation` fields are also added after size calculation, so even a payload just under the limit is not guaranteed to fit as the complete returned JSON. The reproduced large-row failure does not depend on that small overhead discrepancy.

**Fix:** bound or paginate transport history within each recipient, with explicit full-detail retrieval and truthful totals. Measure the final complete serialized response. Include one-row/one-recipient maximum metadata fixtures and mutation responses, rather than only many-row list tests.

### R11 — Shutdown can skip cleanup while the first connected report is pending

**P2 · Partially resolved original finding · Reproduced with controlled completion.**

Source: [lib/mcp.mjs](../../lib/mcp.mjs), lines 422–448 and 502–530.

The new independent disconnect context fixes ordinary peer closure. It is guarded by `connectedReported`, which becomes true only after the connected-status RPC returns. If the broker has already persisted connected state but its response is still pending when the peer closes, `reportDisconnect()` returns early. The lifetime is then aborted and no automatic cleanup occurs when the earlier operation settles.

Probe `close-during-readiness-report` used a real SDK channel and real temporary broker, delaying only the completion of the status RPC after the broker committed it. The SDK peer closed during that window. After the operation was released, `agents({transport:'connected'})` still returned **one connected identity**. A real HTTP abort after durable admission can produce the same uncertainty; the probe does not claim to reproduce a physical network outage.

Codex now reports attach/disconnect and transport age is visible, both useful fixes. Old connected reports still have no freshness-based unknown state; consumers should not equate the retained report alone with verified reachability.

**Fix:** coordinate cleanup with an attempted/in-flight readiness write, not only a successfully returned write. Ensure a terminal disconnect is reported after any possible connected commit using a bounded independent context. Test close before, during and after initial reporting, plus temporary report failure and EOF.

### R22 — The custom parser still rejects valid TOML configurations

**P2 · Partially resolved original finding · Reproduced.**

Source: [lib/setup.mjs](../../lib/setup.mjs), string parsing in `tomlExtract()` and root selection in `tomlCommand()` around lines 310–334; diagnosis at 355–362.

Inline key order, comments and missing values are handled more carefully now. The parser still does not recognize a root inline `mcp_servers` table containing the relay entry, or TOML triple-quoted basic strings for the command. `hasExistingCodexRelay()` recognizes enough of the root assignment to attempt diagnosis, then missing captures are reported as missing executable fields.

Probe `valid-toml-forms-rejected` used two separate files with real existing Node/CLI paths:

```toml
mcp_servers = { "agent-relay" = { command = "/existing/node", args = ["/existing/cli"] } }
```

```toml
[mcp_servers.agent-relay]
command = """/existing/node"""
args = ["/existing/cli"]
```

Python's standard-library **`tomllib` accepted both fixtures**. Relay diagnostics returned **`ok:false`**, “missing command in Codex relay binding,” for both. No missing file or Windows path behavior was involved.

**Fix:** use a complete TOML parser or explicitly support/document the configuration forms and return an unsupported-format result instead of claiming a missing path. Test standard-parser-valid fixtures and compare the extracted exact server fields, not only healthy managed examples.

### N10 — Offline CLI restore cannot initialize a fresh data directory

**P2 · New CLI regression · Reproduced.**

Source: [bin/agent-relay.mjs](../../bin/agent-relay.mjs), lines 188–193; [lib/broker.mjs](../../lib/broker.mjs), lines 648–659.

The former offline CLI branch created the selected data directory before restoration. The helper now requires `realpath(dataDir)` to succeed, and the CLI no longer prepares that directory. Restoring a backup into a new `--data-dir` fails even though no writer or conflicting state exists. This is distinct from the correct library precondition for `createBroker()`; it is a regression in the CLI workflow that previously handled initialization.

Probe `offline-fresh-directory-regression` invoked the real offline CLI with a valid export and a nonexistent private destination directory. It failed with **“dataDir must be a directory.”**

**Fix:** let the CLI create a private directory before calling the leased helper, or implement safe initialization within the shared helper while retaining exclusive ownership. Test nested fresh destinations, default storage not yet initialized, existing directories, invalid paths and concurrent initialization. Manual `mkdir` is a current workaround, not a complete restore workflow.

### N11 — Transport age breaks conditional dashboard snapshots

**P2 · New observability regression · Reproduced through authenticated HTTP.**

Source: [lib/observability.mjs](../../lib/observability.mjs), `presence()` lines 1–12 and `roomSnapshot()` near 34–42; ETag generation in [lib/dashboard.mjs](../../lib/dashboard.mjs).

`presence()` now adds `readiness.transport.ageMs`, calculated from the current time. `roomSnapshot()` removes volatile top-level age fields but retains this nested one. The dashboard hashes the complete snapshot for its ETag. An agent with a transport report therefore changes the snapshot on every read even when the durable ledger has not changed.

Probe `transport-age-invalidates-snapshot-etag` used the actual dashboard handler and snapshot helper over local HTTP. After a successful read, it sent `If-None-Match` with that ETag against unchanged saved data. The server returned **200 with a new ETag**, not 304. The transport report itself was byte-identical; nested age advanced from **716 to 738 ms**.

The loss of conditional responses is reproduced. Additional repeated serialization/transfer costs for large rooms are consequences of that behavior, not a benchmark measured here. The existing snapshot comment explicitly intends ages to be calculated in the dashboard so conditional snapshots remain stable.

**Fix:** omit derived age from conditional snapshots, calculate it in the browser from `ts`, or normalize volatile fields before hashing. Keep age available in explicitly live presence queries if useful. Test repeated unchanged HTTP snapshots with actual connected/disconnected transport metadata.

## Remaining limits and useful guarantees

The writer-lease, maximum-size and file/directory flush tests meaningfully improve offline maintenance. Existing tests continue verifying durable-before-response ordering, conservative ambiguous-ownership handling, fixed recipients, explicit acknowledgement, claim isolation and refusal of uncertain duplicate wakes. Private replacement exports, canonical task aliases and fail-closed legacy handoffs were independently retested successfully here.

Package schema/protocol/features still do not identify the corrected implementation uniquely: both revisions are called 0.3.0. New recipient/pending paging fields can meet a running earlier broker advertising the same feature name. That compatibility remains a validation gap; it is not counted as an extra reproduced finding above.

Routine agent operations now have substantially better parity. OpenCode narrowing/handoff metadata and task completion-ack fields remain narrower than broker support. Coordination groups still discover separate rooms rather than creating one shared worktree message room, and retained identity archival is not implemented. These are existing coverage/product limits, not newly demonstrated faults in this patch.

No live Codex/Claude/OpenCode model was woken. OpenCode wake evidence used a recording client; broker, CLI, SDK and dashboard checks used real isolated filesystem/HTTP behavior. Physical power loss, Windows/Linux, Node 20/22, advertised-limit latency/memory/write-volume, and fresh cloud-model send/ack/reply runs remain unverified. npm's zero-advisory result is time-specific.

## Recommended next changes

1. **Restore entry-point parity:** N07 first, followed by N08/N10. Test actual CLI flags and export envelopes in addition to the shared helper. A dry-run must preserve the ledger byte for byte.
2. **Resumable bounded reads:** N09 and R08. Bound the complete payload while ensuring every omitted row/marker remains reachable through an advertised read continuation.
3. **Readiness lifecycle and snapshots:** R11 and N11. Test asynchronous startup/closure boundaries and unchanged snapshots containing transport reports.
4. **Configuration diagnostics:** R22. Verify the exact extracted binding against standard-parser-valid TOML fixtures.

After those targeted regressions pass, rerun the full suite and independently installed package. Keep the source manifest or final commit identity with the results so the evidence identifies the implementation that was actually tested.
