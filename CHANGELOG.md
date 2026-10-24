# Changelog

All notable changes to `@wearer-haitch/agent-relay` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may add or change behavior).

## [Unreleased]

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

[Unreleased]: https://github.com/Wearer-Lab/agent-relay/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Wearer-Lab/agent-relay/releases/tag/v0.5.0
[0.4.0]: https://github.com/Wearer-Lab/agent-relay/releases/tag/v0.4.0
[0.3.2]: https://www.npmjs.com/package/@wearer-haitch/agent-relay/v/0.3.2
[0.3.1]: https://www.npmjs.com/package/@wearer-haitch/agent-relay/v/0.3.1
[0.3.0]: https://github.com/Wearer-Lab/agent-relay/commit/f41e531
[0.2.0]: https://github.com/Wearer-Lab/agent-relay/releases/tag/v0.2.0
