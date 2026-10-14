# Validation

Run the repeatable release checks:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run release:check
```

The current automated suite has **237 passing tests for 0.3.1** on macOS. 0.3.2 adds two Windows page-file gate tests and has not been rerun on macOS. The optional
[`docs/ci-workflow.md`](./ci-workflow.md) template runs the suite on macOS,
Linux, and Windows with Node.js 20 and 22. Automatic GitHub Actions is not
enabled in this repository; activating it requires permission to push workflow
files.

The suite covers project isolation, durable message delivery, acknowledgements,
replies, cooperative claims, restart retention, writer ownership, authentication,
corrupt-store handling, and runner configuration preservation. Adapter tests
exercise MCP transports, existing-thread delivery, OpenCode hooks, and safe
handling of uncertain notifications without launching a vendor model.

Dashboard tests cover project discovery, bounded snapshots, read-only observation,
authentication, origin checks, legacy-broker compatibility, HTTP assets, and
light/dark/system preferences. Test brokers and projects use disposable temporary
directories. Public-release checks have also verified a fresh npm installation,
two project rooms, history isolation, and the packaged dashboard assets.

The release checker inspects archive contents and checks help/version from the
extracted package. Runtime behavior in an actual vendor session depends on that
runner's supported interfaces and account policies. Transport success is separate
from model acknowledgement. Cloud-model behavior and cross-platform live runner
integrations are not established by these tests.

Local session evidence, machine-specific logs, and message histories are not part
of this public repository.

## Validation matrix

This matrix describes the baseline evidence behind the support claims for version 0.3.0
of the npm package. It is versioned: every release that claims platform or
runner support must update it to match its own evidence. "Automated" means the
repeatable test suite or release checker; "live-verified" means observed in a
real runner session; "not-verified" means no evidence exists in this
environment, so support is not established.

| Check type | Platform | Runner | Evidence status |
| --- | --- | --- | --- |
| basic messaging | macOS | Codex | automated + live-verified (two existing sessions, two-way) |
| adapter activation | macOS | Codex | live-verified |
| context insertion | macOS | Codex | live-verified (delivery steers the attached thread's turn) |
| explicit acknowledgement | macOS | Codex | live-verified |
| nonempty reply | macOS | Codex | live-verified |
| basic messaging | macOS | Claude Code | automated |
| adapter activation | macOS | Claude Code | live-verified (channel initialized, notification written) |
| context insertion | macOS | Claude Code | not-verified |
| explicit acknowledgement | macOS | Claude Code | not-verified (upstream rate-limit rejection before any tool call) |
| nonempty reply | macOS | Claude Code | not-verified |
| basic messaging | macOS | OpenCode | automated + live-verified (isolated runtime) |
| adapter activation | macOS | OpenCode | live-verified (plugin loaded in an actual OpenCode 1.18.34 runtime) |
| context insertion | macOS | OpenCode | live-verified (scripted local provider; cloud-model behavior unverified) |
| explicit acknowledgement | macOS | OpenCode | live-verified (scripted local provider) |
| nonempty reply | macOS | OpenCode | live-verified (scripted local provider joins reply; model understanding unverified) |
| basic messaging | macOS | other MCP/CLI agents | automated (tool/transport tests) |
| basic messaging | Linux | any | not-verified (CI template exists but GitHub Actions is not enabled) |
| adapter activation | Linux | any | not-verified |
| context insertion | Linux | any | not-verified |
| explicit acknowledgement | Linux | any | not-verified |
| nonempty reply | Linux | any | not-verified |
| basic messaging | Windows | any | not-verified (CI template exists but GitHub Actions is not enabled) |
| adapter activation | Windows | Codex | not-verified — default control attachment is known-broken (probe fails `EACCES`); the explicit `--url ws://127.0.0.1:PORT` path is documented but unverified |
| adapter activation | Windows | Claude Code / OpenCode | not-verified |
| context insertion | Windows | any | not-verified |
| explicit acknowledgement | Windows | any | not-verified |
| nonempty reply | Windows | any | not-verified |

Notes kept deliberately separate from the matrix:

- Machine measurement (the `gate` preflight) reads swap, load, and free disk with
  read-only OS probes: macOS uses `sysctl vm.swapusage`/`vm.loadavg` with an
  `os.loadavg` fallback plus `df -Pk`; Linux uses `/proc/meminfo` plus `df -Pk`;
  Windows uses PowerShell `Win32_PageFileUsage.CurrentUsage` (MB, summed across page
  files) for swap in use,
  `Win32_PerfFormattedData_PerfOS_System.ProcessorQueueLength` for load, and
  `Win32_LogicalDisk` free space for the selected drive. The default permissive
  gate passes with unknown measurements unless a measured value breaches its
  limit; the strict gate (`--gate-strict`) refuses when any required measurement
  is unavailable. The result reports `mode`, per-key `coverage` (`measured` or
  `unknown` for `swap`/`load`/`disk`), `assessed` (`pass`,
  `insufficient-evidence`, or `refusal`), the unknown sources in `unknown`, and
  per-measurement value/source/timestamp/error records. A pass with
  `assessed:insufficient-evidence` is not a measured capacity assessment.
- Claude's channel is a research-preview capability subject to account and
  organization policy. An OpenCode row verified with a scripted local provider
  does not establish cloud-model behavior.

## Release gate

Platform and runner acceptance **should be a release gate wherever support is
claimed**: before a release advertises live support for a platform/runner pair,
perform nonempty send, explicit acknowledgement, and reply checks between real
existing sessions on that platform, and record the outcome in the matrix above.
Include disconnect/restart, unavailable endpoint, worktree binding, and capacity
cases in that acceptance run. Claims without such evidence must remain marked
not-verified.

Release validation must also run the same packed artifact users install:
`npm pack`, install the resulting `.tgz` in a disposable project outside the
source checkout, and execute setup, launch, and the smoke checks from that
installation — not from the checkout's dependencies. The
[publishing guide](./publishing.md) includes this as an explicit step; treat it
as part of validation, not an optional extra.

## 0.3.1 review regression checks

The full release suite passes 237 tests on macOS with Node.js 26.5.0. It includes
the eight latest review reproductions: real offline CLI dry-run/schema/new-directory
workflows, complete collection and marker retrieval, MCP initialization/closure,
valid TOML bindings, and unchanged authenticated HTTP snapshot caching.

Both adapters share a 64 KiB response limiter with lossless response snapshots.
Tests cover full snapshot reconstruction, Unicode/control characters, byte counts
including metadata, token/session isolation, retries, expiry, eviction, and source
mutation after capture. These checks do not wake a vendor model.

For a separate fresh dependency installation of the packed artifact, run:

```sh
node docs/reviews/2026-10-12-packed-smoke.mjs
```

That smoke checks all runner bindings, CLI message/claim workflows, the installed
MCP SDK, offline maintenance, and relative links in the shipped Markdown. It uses
disposable storage and stops only its own broker. It requires npm registry access.
