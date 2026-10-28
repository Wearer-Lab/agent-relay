# Changelog

All notable changes to `@wearer-haitch/agent-relay` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may add or change behavior).

## [Unreleased]

## [0.9.0] - 2026-10-28

A receipt now says whether a message was delivered or handled, and a stale claim names the state of its owner.

### Added

- A receipt now separates **delivered** (an adapter or poll fetched the body) from **handled** (the agent acked). An optional session nonce, presented by the session that fetched the body, records which session read it. An ack without that nonce still counts as handled, and the receipt says the session is unbound.

### Changed

- Stale claims listed by `agents`, `blocked` and the dashboard include the claim's age and the owner's state (left, retired, idle, or missing), using the same liveness classification as the stale-claim list.
- A gateway token may hold four long polls; another is `429` with `Retry-After`. Always-on tokens expire, and each use renews the window (24 hours, or `--ttl-hours`); a paired session keeps a fixed 24 hour expiry. An uncollected token is handed to the gateway in memory and is not written to disk. Approval names the checkout, and a named branch with no checkout is not approved into main. A token that names another room or another agent is refused. Ledger writes from the gateway carry the cloud marker.
- The host plan runs the gateway in the broker's network namespace, so a container reaches the broker on `127.0.0.1`, and the tunnel command is separate arguments.

## [0.8.0] - 2026-10-26

A busy room now cleans itself, and the numbers people read describe what actually needs attention.

### Added

- `agent-relay pending [--by recipient|state|age|sender|kind]` breaks the pending deliveries down into the ones a live agent can still read, the ones held for a dormant identity, the ones held for a retired one and the ones that expired. The `relay_pending` MCP and OpenCode tools do the same.
- `agent-relay leave --stale --idle-hours N` and `agent-relay retire --stale` sweep many idle identities at once. They are a dry run until `--apply`, they report what they kept and why, and every applied run is written to an audit log.
- A delivery expires on its own: a broadcast after seven days, a direct message after thirty. An expired delivery is written to the archive with its recipient and its reason, so the history stays explainable. `compact --broadcast-ttl-days` and `--direct-ttl-days` tune it.
- `agent-relay migrate --to 2` converts a ledger to schema 2 offline: a broadcast is stored once with its audience rule, and each agent keeps a `readThrough` cursor instead of a row per reader. On the room from the 2026-10-25 investigation that is 671,074 delivery rows down to 243,746 and 42.54 MiB down to 15.34 MiB; a bulk ack of a whole backlog costs 61 bytes instead of 5,360.
- `agent-relay remote host` prints the deployment artifacts and the steps for an always-on host, so cloud agents keep working while this computer sleeps. The plan it writes is for a Linux host: systemd units, a compose file and the amd64 `cloudflared` binary.
- The dashboard marks cloud agents with a runner badge, and the Overview view lists the pairing requests that wait for a human, read-only.
- `docs/large-rooms.md`, `docs/runbook-backlog.md`, `docs/trust-model.md` and `docs/threat-model.md`.

### Changed

- **A connected transport is a claim, not a fact.** An identity counts as live only while its transport report is fresh (five minutes by default) or it was seen in the same window. An old `connected` report no longer keeps an identity alive, the sweep rewrites it to the truth, and `*` broadcasts stop reaching it.
- The headline is "awaiting live agents". The other groups are shown beside it, with a tooltip that explains why a durable inbox is not a bug.
- `agent-relay compact` and `agent-relay prune` name the identities that block compaction, with their age and their transport age.
- The broker spawns on a real Node runtime, not on whatever binary happens to host it, and the data directory is cleaned at startup: stale temporary files go, the log is timestamped and rotated, and a refusal to start is written down once.

### Fixed

- The pairing code was a bearer secret: `GET /pair/<code>` handed a token to whoever guessed it. The public endpoint now takes the request id only.
- The value of an approved token was written to the token store in plain text. It now waits in a short-lived handover file that is emptied the moment the agent collects it.
- The `send` operation checked the agent id against the token but not the sender, so a cloud agent could post as a local one.
- The dashboard served through the public URL was missing the Roadmap and Branches views, and `/dashboard` itself.
- A process that never touched the relay left an identity behind; the adapters now register on the first call, and a fallback identity is remembered for the session.
- `*all` reached every identity including one that had just registered and proved nothing. A fresh probe is skipped, and `*all` is limited to five an hour per sender, with an error that suggests a bulletin.

### Numbers

The room on the machine where this was built held 4,016 pending deliveries before the operator cleanup and 3,979 after it; `state.json` went from 903,911 to 714,094 bytes. With the delivery TTL in place the same room now resolves to 851 pending deliveries on its own: 3,128 deliveries expire and 118 messages are archived, with no manual step. The investigation that started this work describes a larger room (166,526 pending deliveries, 1,971 identities) that is not on this machine.

## [0.7.3] - 2026-10-24

### Added

- `agent-relay remote on --persist` installs the job that brings the gateway back when the machine boots: a launchd job on macOS, a systemd user unit on Linux, a Task Scheduler entry on Windows. `remote off --persist` removes it again.
- `agent-relay remote on --access` puts a Cloudflare Access service token in front of the gateway: every request must carry `CF-Access-Client-Id` and `CF-Access-Client-Secret`, and the gateway refuses everything else. The values come from `AGENT_RELAY_ACCESS_CLIENT_ID` and `AGENT_RELAY_ACCESS_CLIENT_SECRET`.

## [0.7.2] - 2026-10-24

### Fixed

- **The gateway no longer returns a local path.** A response that named the room's directory is rewritten so the room reads as `.` and everything inside it becomes repo-relative, in both directions.
- The gateway's audit log rotates once it passes a megabyte, keeping one previous file beside it.
- `remote add --url-in-env` now really keeps the URL out of the repository: nothing in the configuration points at it, and it is printed for the cloud environment instead.
- A token obtained by pairing is kept in memory for the session, so a cloud agent pairs once rather than on every call.
- `remote approve` without a code shows the room each waiting request would join.
- A named Cloudflare tunnel now logs in, creates the tunnel when it is not there, routes the hostname to it and keeps its configuration under the data directory.

## [0.7.1] - 2026-10-24

### Fixed

- The machine gate measured free disk and page-file usage with a five second timeout, which PowerShell start-up can exceed on a loaded Windows machine. A missing measurement let the gate pass, so the timeout is now twenty seconds.

## [0.7.0] - 2026-10-24

### Added

- **Remote agents** ([docs/remote-agents.md](docs/remote-agents.md)). A Claude Code cloud session or a Codex cloud task can now join the same relay room as your local agents.
  - `lib/gateway.mjs`: a restricted HTTP front for the local broker on `127.0.0.1:47820`. It forwards only coordination operations (register, agents, send, inbox, ack, wait, status, claim, release, tasks, branches, ownership, history, receipt, outbox, bulletin, handoffs, blocked, leave) and refuses everything else by name, with the reason. Requests carrying a local path are refused; claims inside the room are rewritten to repo-relative paths in both directions.
  - Tokens are 256-bit random values stored only as SHA-256 hashes, compared in constant time, scoped to one room and optionally one agent-ID prefix, and never written to a log. They expire, and `remote revoke` drops them at once.
  - Pairing: a cloud agent posts its repository, branch and runner, gets a six-character code, and waits. `agent-relay remote approve` lists what is waiting and asks about each one; the waiting agent then receives a token, once. Requests expire after ten minutes and at most five may wait.
  - Rooms are resolved from the cloud agent's git remote, preferring the requested branch and otherwise the main checkout. `agent-relay remote room add` sets an alias by hand when nothing matches.
  - Rate limits per token and per address return `429` with `Retry-After`, and an audit log under the data directory records the token id, runner, room, operation and result.
  - `lib/tunnels/`: one interface for Tailscale Funnel (the default, a stable URL with no domain of your own), Cloudflare quick and named tunnels, and ngrok. `remote on` picks the first one that is installed.
  - `agent-relay remote on|off|status|doctor|approve|deny|revoke|add|test|room` drives it all. `remote test` pairs, approves and calls through the public URL, then revokes the test token.
  - Remote client mode: with `AGENT_RELAY_URL` set, `lib/client.mjs` talks to the gateway and never starts or discovers a local broker. Without a token it pairs and waits, and the errors name the command that fixes them.
  - The read-only dashboard rides on the same public URL: `agent-relay remote dashboard` prints a one-time link, the secret sits in the URL fragment as it does locally, and the feeds under `/api/v1/` need it.

### Changed

- The site is now served from **https://relay.next-notes.com** (Cloudflare Workers static assets, custom domain bound), with GitHub Pages keeping the same files as a mirror. The canonical, Open Graph, Twitter, sitemap, robots and 404 URLs moved with `scripts/set-site-origin.mjs`, one command. Two workflows now run in parallel: **Cloudflare** publishes the site, and **Surveillance** watches every public page, the crawler's files, the styled 404 and the published npm version every six hours.

## [0.6.0] - 2026-10-24

### Changed

- **One design language for the website, the dashboard and the mark.** The landing page, the dashboard and the favicon now share one design system: a black canvas, floating white pills, a dot-matrix display face for headings (Bubbledot, with Geist Pixel Circle as the local fallback), Inter for prose and a monospaced face for data. Every font is self-hosted, so nothing is fetched from a third party. The mark is an SVG (a white relay cross on black) instead of an inline radar drawing.
- **The tower vocabulary is gone.** The dashboard views are now **Overview** (`/`), **Roadmap** (`/roadmap/`), **Branches** (`/branches/`), **Agents** (`/agents/`), **Messages** (`/messages/`) and **Claims** (`/claims/`). The room picker says *Project*, the clock says *UTC*, and "on the air" is now "running". The product name, Agent Relay, is unchanged: a relay is a relay.
- **Real URLs everywhere.**
  - The website is six pages instead of one long page: `/`, `/product/`, `/dashboard/`, `/architecture/`, `/security/` and `/start/`. It is still a static site with no build step and no router.
  - Every dashboard view is its own path: `/`, `/roadmap/`, `/branches/`, `/agents/`, `/messages/` and `/claims/`. The shell is served for all of them, so a reload, a copied link and browser Back and Forward land on the same view. A path without its trailing slash redirects to the canonical one.
  - The dashboard serves its assets from `/assets/*` and its read-only feeds from `/api/v1/*` (`projects`, `snapshot`, `history`, `work`, `ownership`, `usage`).
  - The broker answers `POST /api/v1/rpc`. `/rpc` still works, so a broker started by an older release keeps serving the clients it already has; the discovery file records which endpoint a broker speaks and the CLI follows it.

### Added

- `site/assets/logo.svg` and `lib/dashboard/assets/logo.svg`: the Agent Relay mark, used by the page header, the dashboard header and the favicon.
- Three landing page directions under `site/variants/` for review: problem-first, the first-person story, and one-workspace. They are marked `noindex` and are drafts, not published pages.

## [0.5.0] - 2026-10-17

### Changed

- **Broker write path** ([docs/broker-notes.md](docs/broker-notes.md#write-path-and-durability)). Writes are batched: mutations apply in memory on copy-on-write drafts and share one atomic `state.json` replacement, and every response, reads included, is released only once the state it observed is durable. Per-message validation and serialization are cached for unchanged messages, presence refreshes no longer write on their own (they ride along with the next write or a 30-second flush), and long-poll wakes scan only new messages. On a 16 MB ledger with 25 polling agents, throughput rose from 9 to 118 ops/s and `send` p99 fell from 5.0 s to 0.17 s (`node scripts/bench-broker.mjs`).
- Ledgers must keep each room's messages in ascending cursor order, which every broker-written ledger already does.

### Added

- **Compaction** (`compact`, `agent-relay compact`). Archives finished message history older than `olderThanDays` into fsynced JSONL files under `<dataDir>/archive/` and records the archived range on the room. Optionally (`--drop-identities`) it deletes dormant identities that nothing references. The maintenance sweep compacts automatically (`compactAfterDays`, default 14, `--compact-after-days`, `AGENT_RELAY_COMPACT_AFTER_DAYS`). On the benchmark ledger, prune plus compaction shrank `state.json` from 16.5 MiB to 4.3 MiB.
- `scripts/bench-broker.mjs`: a reproducible write-path benchmark on a large ledger.
- Runtime dependency `immer` (MIT, no dependencies) for copy-on-write mutations.

### Fixed

- **Windows.** The full test suite now passes on Windows with Node 20 and 22, and Windows CI is required again. Two product fixes came out of that port:
  - Task blocker references now resolve junctions and symlinks the same way claims do (`realpathSync.native`).
  - Replacing `state.json` while another process has it open is retried briefly instead of failing.
- **Presence.** A failed write no longer loses in-memory presence, and presence-only writes never hold up or fail a response.
- **Release workflow.** It waits up to five minutes for npm to serve a fresh version before creating the GitHub release.
- **Test hygiene.**
  - Test fixtures stop CLI-started brokers before deleting their data directories, so test runs no longer leave broker daemons running.
  - `npm test` runs with a five-minute per-test timeout, so a hang fails with the test's name.

## [0.4.0] - 2026-10-15

### Added

- **Registry hygiene** ([docs/registry.md](docs/registry.md)). Broadcast `*` now reaches only live agents (connected, or seen within `--within` minutes, default 120); `*all` keeps the old "every non-left agent" meaning. Send results report the audience and how many agents were skipped, and `NO_RECIPIENTS` explains how to widen it. Direct messages to a dormant identity (left but not retired) are stored in its durable inbox until it registers again. Ephemeral registrations (`join --ephemeral`, `mcp --ephemeral`, `AGENT_RELAY_EPHEMERAL=1`, or a temporary session ID) leave on exit when idle and are kept while they hold claims, handoffs, process records or open tasks. `AGENT_RELAY_AGENT_ID` (or `--as` on `agent-relay mcp`) gives pooled workers a stable identity. The new `prune` operation (`agent-relay prune`, `relay_prune`) is a dry run unless `--apply`; the broker also sweeps automatically (`pruneAfterMinutes` default 1440, `ephemeralPruneMinutes` default 15, tunable with `--prune-after-minutes`, `--ephemeral-prune-minutes` or the matching environment variables). `agents` counts and `snapshot` carry `live`, `dormant`, `retired`, `ephemeral` and `prunable`.
- **Branch ownership** ([docs/branches.md](docs/branches.md)). Repo-scoped branch claims shared by all worktrees of one repository (`agent-relay branch claim|release|list|force-release`, `agent-relay branches`, `relay_branch`), an optional per-agent git report on `status` (sent automatically by the MCP adapter and OpenCode plugin), and a read-only ownership view (`relay_ownership`) that joins git worktrees and branches, claims, live agents and tasks and flags `orphaned`, `contested`, `unclaimed` and `missing` branches. Retiring an agent now treats branch claims as obligations.
- **Work items and roadmaps** ([docs/work-items.md](docs/work-items.md)). The task ledger is now a tree of `roadmap > phase > epic > task > todo` with status `todo | in-progress | blocked | review | done | cancelled`, `parentId`, `priority`, `labels`, `branch`, `artifacts`, `dueAt` and rolled-up progress. New actions `tree`, `move`, `remove` and `import` (markdown roadmap import, atomic and re-runnable), `agent-relay work ...` commands, and the `relay_roadmap` tool. Flat tasks from earlier versions keep working unchanged.
- **Release and site automation.** GitHub Actions now run CI on macOS, Linux and Windows with Node 20 and 22 plus a packed-install check; pushing a `vX.Y.Z` tag publishes the exact packed archive to npm with provenance (trusted publishing) and creates the GitHub release; a Pages workflow publishes the landing page. Added release-note categories, Dependabot (npm and GitHub Actions, weekly), issue templates and a pull request template. See [docs/publishing.md](docs/publishing.md).
- `package.json` now sets `publishConfig.provenance` and points `homepage` at the landing page; `release-check` verifies the changelog entry, lockfile versions and provenance setting.

### Changed

- **Dashboard redesign** ([docs/dashboard.md](docs/dashboard.md)). The dashboard is now an air traffic control tower with six views: Tower, Flight plan, Runways, Strips, Radio log and Claims (keys `1` to `6`, `?view=` deep links), Dark ("night tower"), Light and System themes, and a layout that works down to 375 pixels. It stays read-only and degrades with a clear message on brokers that lack the new operations (`/api/work`, `/api/ownership`, `/api/usage`). `scripts/dashboard-fixture.mjs` seeds a throwaway broker for previewing.
- `send --to '*'` no longer reaches idle agents; use `--to '*all'` for the previous behavior.

### Security

- Dropped the `@opencode-ai/plugin` runtime dependency. The OpenCode tools now use
  Zod directly with the same `tool()` contract, which removes `effect` (a beta),
  `msgpackr` (flagged by Socket as a potential vulnerability) and the native
  `msgpackr-extract` from the installed tree (runtime packages in the shrinkwrap: 123 to 97).

## [0.3.2] - 2026-10-13

### Fixed

- Windows swap measurement for `gate` sums `Win32_PageFileUsage` instead of using commit charge, which made an idle machine report far more swap than it used and refused every heavy check.

## [0.3.1] - 2026-10-12

### Fixed

- Addressed the 0.3.0 code review: verified shutdown ownership; waiter-safe and offline restore with attachment verification; `relay_read_page` continuation that retrieves every omitted row within the 64 KiB response limit; an honest receipt ladder with missing states; direction-locked handoffs; version-bound bulletin acknowledgements; retire preflight; per-room usage; exact TOML table parsing during setup; full feature-set negotiation; CLI, MCP and OpenCode tool parity; and Unicode-safe bounded context.
- Machine-specific operational reports moved to `docs/internal/`, which is never published.

## [0.3.0] - 2026-10-11

### Added

- Capacity split between active and retained sessions, with a `retire` lifecycle.
- Sender receipts, outbox and full history search; pinned policy bulletins with per-session acknowledgement.
- Claim narrowing with a handoff workflow, claim provenance metadata, process records and structured tasks.
- Storage maintenance (`usage`, `export`, `restore`, `audit-attachments`) and broker `doctor`, `stop` and `restart`.
- Adapter reconnect with backoff, Windows attachment diagnostics, setup diagnostics, and honest gate measurement.

## [0.2.0] - 2026-10-05

### Added

- Pollable inbox (`--unread`, `--since`, `--from`, `--limit`) and resilient `watch --json-lines`.
- Machine-scope claims with audited forced release, and `gate` swap, load and disk preflight.
- Last-seen presence, `agents --active`, and explicit `leave`.
- Message summaries and durable attachments verified by SHA-256 on `fetch`.

[Unreleased]: https://github.com/Wearer-Lab/agent-relay/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/Wearer-Lab/agent-relay/releases/tag/v0.9.0
[0.8.0]: https://github.com/Wearer-Lab/agent-relay/releases/tag/v0.8.0
[0.7.3]: https://github.com/Wearer-Lab/agent-relay/releases/tag/v0.7.3
[0.7.2]: https://github.com/Wearer-Lab/agent-relay/releases/tag/v0.7.2
[0.7.1]: https://github.com/Wearer-Lab/agent-relay/releases/tag/v0.7.1
[0.7.0]: https://github.com/Wearer-Lab/agent-relay/releases/tag/v0.7.0
[0.6.0]: https://github.com/Wearer-Lab/agent-relay/releases/tag/v0.6.0
[0.5.0]: https://github.com/Wearer-Lab/agent-relay/releases/tag/v0.5.0
[0.4.0]: https://github.com/Wearer-Lab/agent-relay/releases/tag/v0.4.0
[0.3.2]: https://www.npmjs.com/package/@wearer-haitch/agent-relay/v/0.3.2
[0.3.1]: https://www.npmjs.com/package/@wearer-haitch/agent-relay/v/0.3.1
[0.3.0]: https://github.com/Wearer-Lab/agent-relay/commit/f41e531
[0.2.0]: https://github.com/Wearer-Lab/agent-relay/releases/tag/v0.2.0
