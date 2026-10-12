# Agent Relay 0.3.1 — review fixes and verification

Updated **October 12, 2026**, America/New_York.

**All eight findings from the latest review are fixed.** The full release check
passes **237 tests**, with zero failures, cancellations or skips. A separate fresh
installation of the packed 0.3.1 artifact passes. The original failure report is
preserved in [the third review](2026-10-12-third-review.md).

## Findings and fixes

| Finding | Status | Implemented fix and evidence |
| --- | --- | --- |
| N07 — offline dry-run replaces the ledger | Fixed | The CLI forwards dry-run to the shared helper. Existing storage is validated under the writer lease without backups or state/token writes. The real CLI regression verifies identical ledger bytes, token bytes and directory contents. |
| N08 — offline restore ignores export schema | Fixed | The CLI forwards the wrapper schema; the helper rejects unsupported versions before directory creation or replacement. A schema-999 export is refused and the original ledger remains intact. Raw state input remains supported. |
| N10 — offline restore cannot initialize storage | Fixed | Actual restore creates missing nested storage with mode 0700 and state with mode 0600, then uses the shared writer lease and existing flush/rename protections. Dry-run against an absent destination validates without creating it. |
| N09 — trimmed collections have no continuation | Fixed | Both adapters now use one response limiter. Oversized results retain an immutable full response and advertise `relay_read_page`. All task, handoff, process, claim, agent/group and bulletin acknowledgement data remain available through the continuation. The original 64-task fixture recovers all 64 tasks, including the last row. |
| R08 — one large marker history exceeds 64 KiB | Fixed | The complete serialized envelope, including metadata, is measured. A row that cannot fit returns an explicit details-omitted envelope and a lossless continuation. The original 1,024-marker inbox and receipt fixtures fit within 64 KiB and recover the full body and all markers. Escaped control characters and Unicode are covered. |
| R11 — close during readiness leaves connected state | Fixed | Readiness is tracked before sending the connected report. Close sends terminal status using an independent context, and a report that settles after closure repeats terminal cleanup. A real broker/SDK test delays the connected response until after peer close and verifies no connected agent remains. |
| R22 — valid TOML bindings fail diagnosis | Fixed | A complete TOML parser replaces the custom extractor. Root inline tables, triple-quoted command strings, dotted/quoted tables, multiline args and existing key-order/escape cases pass. Setup still preserves conflicting runner configuration. |
| N11 — transport age changes snapshot ETags | Fixed | Conditional snapshots omit nested derived transport age while live presence retains it. An unchanged authenticated snapshot containing connected transport metadata returns 304 with the same ETag. |

## Continuation contract

Large results include a `continuation` with tool name, token, initial offset,
encoding, total character count, SHA-256 and expiry. Call `relay_read_page`, append
its `text` chunks in offset order, and resume at `nextOffset` until `done` is true.
Parse the concatenated text to recover the complete original broker response.

This retrieves a snapshot of the original response, including its original
collection order and marker data. Existing broker recipient/agent/message cursors
remain usable for later broker pages. Reading a continuation never acknowledges
a message; omitted details must be read before acknowledgement.

Snapshots are scoped to the MCP adapter or OpenCode session, expire after five
minutes, and use at most 16 entries and 64 MiB of serialized snapshot data per
adapter. Closing clears snapshots; the oldest entries are evicted at capacity.
Expired/evicted/foreign tokens fail explicitly and ask the caller to repeat its
original read. A single response exceeding the snapshot storage budget fails
explicitly and requires a narrower query. No oversized response is silently
returned as a supposedly bounded page.

## Package updates

Agent Relay is bumped from **0.3.0 to 0.3.1**. Direct dependencies remain pinned:

| Dependency | Before | After |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.31.0 | 1.32.1 |
| `@opencode-ai/plugin` | 1.18.34 | 1.19.0 |
| `smol-toml` | Absent | 1.9.1 |
| `cross-spawn` | 7.0.6 | 7.0.6 |
| `jsonc-parser` | 3.3.1 | 3.3.1 |
| `ws` | 8.22.0 | 8.22.0 |

The [TOML parser's primary documentation](https://github.com/squirrelchat/smol-toml)
describes its standard syntax support. The development lockfile and published
shrinkwrap are synchronized; the release checker verifies that they agree with
the package version and pinned dependencies. Publication examples now use 0.3.1.
No npm publication, tag or remote push is part of this commit request.

## Verification

| Check | Result |
| --- | --- |
| `npm run release:check` | **237 passed**, 0 failed, 0 skipped; approximately 48.3 seconds. Packed CLI help/version and dashboard syntax pass. |
| [Fix probe harness](2026-10-12-fix-probes.mjs) | **13 resolved observations**: all eight latest findings plus five previously fixed behaviors. This harness also runs in the normal test suite. |
| [Fresh artifact smoke](2026-10-12-packed-smoke.mjs) | Independently installs the 0.3.1 archive and its dependencies; all runner bindings, send/inbox/ack/receipt, claims, export/online dry-run, installed MCP SDK, offline dry-run/schema refusal and fresh-directory restore pass. |
| Pack inventory | **30 files**; includes the shared limiter. Review evidence and internal operational reports remain outside the npm artifact. All shipped relative Markdown links resolve. |
| `npm audit --omit=dev` | **0 known vulnerabilities** at verification time. |
| `npm outdated --json` | No outdated direct dependencies at verification time. |
| Locks and whitespace | Synchronized lockfiles and `git diff --check` pass. |
| Environment | macOS, Node **26.5.0**, npm **11.17.0**. |

[Captured fix evidence](2026-10-12-fix-evidence.jsonl),
[packed smoke evidence](2026-10-12-packed-smoke.json), and
[fixed source manifest](2026-10-12-fixed-source-manifest.json) identify the checks
and runtime source that were verified.

All runtime probes use isolated temporary storage and fixture SDK connections.
No existing working broker, ledger or model session was changed. Physical power
loss, Windows/Linux, Node 20/22 and live vendor-model acceptance remain unverified.
The dependency audit reports known registry advisories and is not a dependency
source audit.

## Historical evidence

- [Initial 26-finding review](2026-10-11-initial-review.md).
- [Second 14-finding review](2026-10-11-followup-review.md).
- [Third eight-finding review before these fixes](2026-10-12-third-review.md).
- [Historical third-review probes](2026-10-12-probes.mjs) and
  [their original evidence](2026-10-12-evidence.jsonl).

Historical probes intentionally assert old failures and are not current regression
tests. Use the fix harness and the normal test suite to verify the corrected code.
