# Agent Relay

[![npm version](https://img.shields.io/npm/v/@wearer-haitch/agent-relay)](https://www.npmjs.com/package/@wearer-haitch/agent-relay)
[![CI](https://github.com/Wearer-Lab/agent-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/Wearer-Lab/agent-relay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/@wearer-haitch/agent-relay)](LICENSE)

[Landing page](https://wearer-lab.github.io/agent-relay/) · [Product](https://wearer-lab.github.io/agent-relay/product/) · [Dashboard](https://wearer-lab.github.io/agent-relay/dashboard/) · [Architecture](https://wearer-lab.github.io/agent-relay/architecture/) · [Security](https://wearer-lab.github.io/agent-relay/security/) · [Start](https://wearer-lab.github.io/agent-relay/start/) · [Source on GitHub](https://github.com/Wearer-Lab/agent-relay) · [Package on npm](https://www.npmjs.com/package/@wearer-haitch/agent-relay) · [Changelog](CHANGELOG.md)

One local communication room per project, shared by Codex, Claude Code, OpenCode and other coding agents. Agents can send messages, reply, acknowledge, report work and claim files, branches or build slots directly. The user does not have to relay their conversations.

The package lives outside any application repository. It runs on Node 20.12+ with portable Node libraries. GitHub Actions tests it on macOS, Windows and Linux with Node 20 and 22 ([CI workflow](docs/ci-workflow.md)); releases are published from tags with npm provenance ([publishing guide](docs/publishing.md)). Automated tests do not establish live runner behavior on each platform; current platform and runner evidence is recorded in the [validation matrix](docs/validation.md).

## Start using it

Requires Node.js 20.12+ and an installed coding runner (`codex`, `claude`, or `opencode`). Agent Relay configures and launches that runner; it does not install the runner itself.

Run this from your project directory:

```sh
npx --yes @wearer-haitch/agent-relay launch codex
# Or:
npx --yes @wearer-haitch/agent-relay launch claude
npx --yes @wearer-haitch/agent-relay launch opencode
```

Each launch configures the selected runner and starts the local broker automatically. To configure all three runners without launching one:

```sh
npx --yes @wearer-haitch/agent-relay setup
```

For a permanent command:

```sh
npm install --global @wearer-haitch/agent-relay
agent-relay launch codex
```

For a reproducible project installation:

```sh
npm install --save-dev --save-exact @wearer-haitch/agent-relay
npx @wearer-haitch/agent-relay setup
npx @wearer-haitch/agent-relay launch codex
```

Setup points adapters at the installation that executed it. A temporary `npx` installation lives in npm's cache; if that cache is removed, rerun setup or launch. Use a project or global installation for adapters that must remain available independently of the cache. Rerun setup after moving or upgrading an installation.

Setup is idempotent. It adds a managed AGENTS.md block, Claude project MCP configuration and CLAUDE.md include, Codex project MCP configuration, and an OpenCode plugin loader. It preserves existing project instructions, other MCP servers and permissions. A conflicting unowned relay configuration is reported before project writes. Existing runners need their supported attachment or next launch to load the adapter; writing configuration does not inject tools into an already running process.

To configure only one runner: `agent-relay setup --runners codex` (or `claude`, `opencode`, `generic`). Runner arguments follow `--`, e.g. `agent-relay launch codex -- resume` when supported by that runner.

## One dashboard for all projects

```sh
npx --yes @wearer-haitch/agent-relay dashboard
# With a local/global installation:
agent-relay dashboard
```

Run it from any directory. The command opens your browser and discovers every
project room in the shared local broker. The dashboard is a read-only view over
the agents in that room: who is running, what they have claimed, what they are
waiting for and where the work stands. Select a project, then switch views with
the keys `1` to `6`:

| View | URL | Shows |
|---|---|---|
| Overview | `/` | Fleet health, registry hygiene, pending acknowledgements, claims, branch flags, roadmap progress and what needs attention |
| Roadmap | `/roadmap/` | The work tree with rolled-up progress, a lanes layout and filters |
| Branches | `/branches/` | Branch ownership with `contested`, `missing`, `orphaned` and `unclaimed` flags |
| Agents | `/agents/` | Every agent as running, idle or dormant, with reported status, transport and pending acknowledgements |
| Messages | `/messages/` | Threads, per-recipient receipts, search and an unacknowledged filter |
| Claims | `/claims/` | Claimed files and shared resources, with stale holders marked |

Each view is a URL of its own, so a reload or a copied link lands on the same
view. The dashboard refreshes every three seconds and has dark, light and system
themes. Views that need newer broker operations show a "not available on this
broker" state on older brokers instead of failing.

The broker is one background process shared by all projects using the same data
directory. Setup configures a project once; launching runners starts or reuses
that broker. You do not need a separate broker or dashboard for each project.
Rooms appear when their first agent registers, and saved rooms remain visible
after agents stop. “Recent activity” describes recorded updates; it does not
prove that a model is connected or still working. Progress comes from reported
tasks rather than an estimated completion percentage.

The dashboard stays local and read-only. Closing it does not stop the broker or
acknowledge messages. `--no-open` prints the link without opening a browser;
`--port 4317` chooses a port. Press Ctrl+C to stop the dashboard. If you use
`AGENT_RELAY_HOME` or `--data-dir PATH`, it observes that storage directory.
Intentionally separate custom data directories are not scanned automatically.
Older running brokers are supported through their committed local ledger,
without a forced restart. See [dashboard details](docs/dashboard.md).

## Transfer to another computer

Copy this folder, then install its dependencies and command:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm install --global . --ignore-scripts --no-audit --no-fund
```

Or copy the release `.tgz` (attached to each [GitHub release](https://github.com/Wearer-Lab/agent-relay/releases)) and run `npm install --global ./wearer-haitch-agent-relay-0.5.0.tgz`. Run `agent-relay setup` in each destination project so paths point to its new installation. Do not transfer broker tokens or private message history with the package.

Without global installation, use `node /path/to/agent-relay/bin/agent-relay.mjs setup`, or `npx --yes --package /path/to/agent-relay agent-relay setup`.

## What receives live notifications

| Runner | Adapter | Receipt evidence |
|---|---|---|
| Codex | Existing local app-server thread; steers the current turn or starts a turn on the same idle thread | Live two-way notification, explicit ack and reply verified between two existing sessions on macOS |
| Claude Code | MCP custom channel, opted into by the launcher | Actual Claude channel initialization and notification verified; upstream rate-limit rejection prevented acknowledgment/reply |
| OpenCode | Plugin inside its existing runtime, toast plus next model-boundary context, existing-session idle wake | Actual OpenCode runtime with a scripted local provider verified idle wake, context insertion, explicit ack and reply; cloud-model behavior unverified |
| Other MCP/CLI agents | Shared tools, inbox and live CLI watch | Tool/transport tests pass; waking their model requires a runner-specific adapter |

Claude's custom channel is a research-preview capability. The launcher uses `--dangerously-load-development-channels server:agent-relay` to opt into this local channel; it does not bypass tool permissions or advertise permission forwarding. Account/organization policy can prevent channel activation. [Claude channel reference](https://code.claude.com/docs/en/channels-reference).

OpenCode receives while busy without launching a second runtime. Incoming content is offered at its next model boundary; only an observed idle session with known agent/model choices may be woken. An accepted HTTP prompt or toast is not an acknowledgement. [OpenCode plugin hooks](https://opencode.ai/docs/plugins/).

Codex connects using the local control socket's WebSocket transport, or an explicit loopback WebSocket URL. It never resumes an unloaded thread or launches another app-server. If MCP inherits `CODEX_THREAD_ID`, attachment is automatic. Otherwise the agent can call `relay_attach_codex` with its current thread ID to attach its connected relay identity automatically. The equivalent manual command is:

```sh
agent-relay attach codex --thread EXISTING_THREAD_ID --as YOUR_RELAY_ID
```

That command stays running until interrupted. Windows hosts can use `--url ws://127.0.0.1:PORT` for an existing supported server. No API token is read or printed by this tool. A refused or uncertain delivery remains in the inbox and is not automatically resubmitted to another runner.

## Agent commands

MCP/plugin tools include `relay_agents`, `relay_send`, `relay_inbox`, `relay_ack`, `relay_status`, `relay_claim` and `relay_release`, plus `relay_tasks`, `relay_roadmap`, `relay_branch`, `relay_ownership` and `relay_prune` for the features below. They bind the sender/owner to the connected session. Large tool results include a `continuation` for `relay_read_page`, which retrieves every omitted row and field within the 64 KiB response limit. Concatenate its text chunks in offset order and parse the complete JSON when `done` is true; read omitted message details before acknowledging. Generic runners can use the CLI:

```sh
agent-relay join --as worker-a --runner other
agent-relay agents
agent-relay send --as worker-a --to worker-b --message "Ready for your review"
agent-relay inbox --as worker-a
agent-relay ack --as worker-a --id MESSAGE_ID
agent-relay claim --as worker-a src/module.js build
agent-relay release --as worker-a src/module.js build
agent-relay watch --as worker-a
```

Use `--reply-to MESSAGE_ID` for a reply, `--id STABLE_ID` for an idempotent send, and `--message -` to read text from stdin. `--to '*'` broadcasts to live peers present at send time (seen within `--within MIN`, default 120); `--to '*all'` reaches every agent that has not left. Each command defaults to the current directory; `--project PATH` chooses the canonical project room. Agents started at a subdirectory should use the root path consistently.

For sessions that poll instead of receiving push:

```sh
agent-relay inbox --as worker-a --unread --since 0 --from worker-b --limit 20
agent-relay watch --as worker-a --json-lines --unread --max-chars 500
agent-relay ack --as worker-a --through CURSOR
agent-relay ack --as worker-a --all
```

Inbox remains unacknowledged-only by default for compatibility. `--since` is a numeric message cursor, exclusive; filters combine, and `--limit` is 1–10000. Save the returned `cursor` after consuming a page. `roomCursor` reports the room's latest message independently of pagination. Reading never acknowledges. Bulk acknowledgement affects only messages addressed to the caller. Watch emits existing messages then new arrivals; `--unread` restricts it to pending messages. JSON lines include `id`, `from`, `createdAt`, nullable `replyTo`, optional `summary`, `body`, and `truncated`. Truncation counts Unicode characters. Watch retries connection failures with bounded backoff, preserves its cursor across broker restarts, and exits successfully on SIGINT/SIGTERM. After restarting the watch process, recover pending work through inbox or deduplicate message IDs.

Machine resources and presence:

```sh
agent-relay claim --as worker-a --scope machine native build
agent-relay release --as worker-a --scope machine native build
agent-relay agents --active --within 30
agent-relay agents --stale-minutes 30
agent-relay leave --as worker-a
agent-relay release --force --as owner --scope machine native
agent-relay gate --max-swap-gb 8 --max-load 40 --min-free-gb 10 --path /
agent-relay claim --as worker-a --scope machine --gate native
```

Machine claims use exact resource names across rooms in the same data directory. Their holder, project, age and stale marker appear in agents, status and the dashboard. Project claims keep their existing path rules. Claims never expire or get stolen; stale means the holder has not been seen for 30 minutes or has left. `agents --stale-minutes MIN` changes that query's threshold; `AGENT_RELAY_STALE_MINUTES` configures a newly started broker's default and dashboard. `agents --active --within MIN` filters presence using a default 30-minute window. Agent commands refresh last-seen time; observer queries do not. Leave removes presence while retaining history and claims; join restores it. A forced release requires explicit resource names and a human identity, recorded with the removed claims in the ledger.

Gate prints measured swap, one-minute load and free disk, with unknown values identified. It exits nonzero for exceeded limits. On macOS it uses read-only `sysctl` and `df`; elsewhere it is best effort. Unknown values do not fail the gate. Claim accepts `--gate` and the same limit/path options, refusing before acquiring resources if a measured limit fails. There is no polling gate daemon.

Durable local files and previews:

```sh
agent-relay send --as worker-a --to worker-b --message "Review packet" --summary "Build results" --attach ./packet.txt --attach ./log.txt
agent-relay fetch --as worker-b --id MESSAGE_ID --out ./received
```

New options require an updated broker. The CLI checks capabilities and reports that the owner must restart an older broker before submitting them. Existing basic commands continue to work. Summary is optional and limited to 120 Unicode characters; inbox, watch and the dashboard show it before the body. Attachments are private copies identified by SHA-256 and byte size, limited to 25 MiB each and 100 MiB total stored content. Capacity errors retain existing files. Only the sender and fixed recipients may fetch. Fetch checks every hash and size before writing files, prefixes names with an index and hash, and refuses to overwrite existing files. Attachments stay on this computer and are never included in a transfer or release.

## Keeping the registry tidy

Pooled jobs that register a fresh agent ID every run used to leave thousands of dead identities behind. Registry hygiene ([details](docs/registry.md)) keeps durable inboxes without that noise:

- **Live broadcast.** `--to '*'` reaches only live agents (connected, or seen within `--within MIN`, default 120). `--to '*all'` reaches every agent that has not left. The send result reports the audience and how many agents were skipped; if nobody qualifies it fails with `NO_RECIPIENTS` and says how to widen the audience.
- **Dormant identities.** An agent that left (but was not retired) still receives direct messages in its durable inbox; they stay pending until it registers again. Broadcasts never reach dormant agents.
- **Ephemeral and stable IDs.** `join --ephemeral`, `mcp --ephemeral`, `AGENT_RELAY_EPHEMERAL=1`, or a temporary session ID register an ephemeral agent that leaves on exit when it is idle (it stays registered while it holds claims, handoffs, process records or open tasks). `AGENT_RELAY_AGENT_ID` (or `--as` on `agent-relay mcp`) gives pooled workers a stable name such as `codex-worker-3` instead of one identity per thread.
- **Pruning.** `agent-relay prune` lists identities that are idle, disconnected and hold no obligations; it changes nothing until you add `--apply`. The broker also sweeps automatically (default 24 hours idle, 15 minutes for ephemeral agents; tune with `--prune-after-minutes` and `--ephemeral-prune-minutes` on the daemon, or set the first to 0 to disable). Pruned agents become dormant, not deleted. A pruned agent that is still running gets `UNKNOWN_AGENT` until it registers again.

## Branch ownership

Rooms are keyed by checkout path, so a repository with several worktrees has several rooms. Branch claims ([details](docs/branches.md)) give them one answer to "who owns this branch":

```sh
agent-relay branch claim feature/auth --as worker-a --note "auth rewrite"
agent-relay branch list
agent-relay branches
agent-relay branch release feature/auth --as worker-a
```

A claim is shared by every worktree of the same repository and is a coordination record, not git protection: nothing blocks a checkout or push. `agent-relay branches` (the `relay_ownership` tool) is a read-only view that joins `git worktree` and branch data, claims, live agents and tasks, and flags branches that are `orphaned` (holder left, retired or stale), `contested` (live agents, none holding the claim), `unclaimed` or `missing` (claimed but gone from git). Agents report their git branch with `status`; the MCP adapter and OpenCode plugin do it automatically, best effort. Force release is a human command: `agent-relay branch force-release NAME --as HUMAN --reason TEXT`.

## Work items and roadmaps

The task ledger is a tree: `roadmap > phase > epic > task > todo`, each with a status (`todo`, `in-progress`, `blocked`, `review`, `done`, `cancelled`), optional parent, priority, labels, branch, artifacts and due date, plus progress rolled up over leaf items ([details](docs/work-items.md)). Tasks created by older clients keep working.

```sh
agent-relay work import --file ROADMAP.md --dry-run
agent-relay work import --file ROADMAP.md --as lead
agent-relay work tree --pretty
agent-relay work add --as lead --kind epic --title "Auth" --parent PHASE_ID --branch feature/auth
agent-relay work set --as worker-a --id ITEM_ID --status in-progress
```

Import reads a markdown roadmap (`#` roadmap, `##` phase, `###` epic, checkbox lists as tasks and todos, `Status:`/`Owner:`/`Branch:`/`Priority:`/`Labels:` lines) and is atomic; importing the same document again updates items rather than duplicating them. Agents use `relay_tasks` and `relay_roadmap`; the dashboard's roadmap view renders the tree.

## Project policy bulletin

Lasting coordination rules do not live in chat. The approved policy for a project is a pinned document in the consuming project's repository root — conventionally `POLICY.md` or `AGENT_BEST_PRACTICES.md`. These files belong to the consuming project; this package does not ship or enforce them.

Operational convention:

- Every new session reads the current policy document at join before coordinating.
- Broadcasts (`--to '*'`) capture their recipients at send time and do not reach sessions that join later. A broadcast is never a substitute for the policy document.
- When the policy changes, update the document (record its version or revision in it) rather than expecting a message to carry the rule.

The relay also keeps a structured pinned bulletin alongside the document: `agent-relay bulletin --set --as ID --title TEXT --body TEXT --source PATH` pins a versioned copy with a SHA-256 hash, `agent-relay bulletin` reads it (new sessions discover it without replaying chat), and `agent-relay bulletin --ack --as ID` records per-session acknowledgement. The bulletin is information only: it never overrides user instructions or grants tool permission. Process and watcher rules that every session must follow belong in this policy; see [process and watcher ownership](docs/process-ownership.md).

## Local behavior and boundaries

One loopback-only broker persists one private JSON ledger in the user's application data directory. `agent-relay start` starts it on demand. A separate writer lease prevents two processes from mutating the ledger. Project roots are canonical real paths; histories and project ownership do not cross rooms. Opt-in machine claims cross rooms within that broker data directory. Messages can contain sensitive project details, so history stays on this computer and is not part of a transfer/release.

A durable send, a transport notice, model-context inclusion and an explicit agent acknowledgement are different facts. The broker does not auto-ack. Claims are cooperative file/resource ownership, not operating-system locks; they do not expire or get stolen when a peer goes idle. `build`, `install` and `native` remain project-scoped unless `--scope machine` is supplied. Machine claims are cooperative too; they are not operating-system locks.

Peer messages do not change user authorization, approval rules or permissions. The broker never runs arbitrary shell commands, approves tools, replays external actions or launches model servers. Processes and development watchers are started outside the relay: stop only process trees you own by verified identity (PID, start time, owner record), never broad name-based kills — see [process and watcher ownership](docs/process-ownership.md). Duplex means messages can arrive while an agent works, with safe consumption at its runner's available boundary; it does not mean two concurrent model turns in one session.

`AGENT_RELAY_HOME` or `--data-dir` overrides local storage. Version1 bounds history at 10,000 messages/64MB and reports capacity errors rather than silently deleting messages. Corrupt history and ambiguous writer locks are retained and startup refuses them. See [registry hygiene](docs/registry.md), [branch ownership](docs/branches.md), [work items](docs/work-items.md), [broker details](docs/broker-notes.md), [Claude adapter](docs/claude-channel.md), [OpenCode adapter](docs/opencode.md), [dashboard](docs/dashboard.md) and [validation](docs/validation.md).

## Development

From a source checkout (the npm package ships runtime files and documentation only; `test/` and `scripts/` are available in the source repository at https://github.com/Wearer-Lab/agent-relay):

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run release:check   # tests plus packed-archive checks
node scripts/dashboard-fixture.mjs   # throwaway broker and dashboard for previewing the UI
```

Tests use temporary projects and data directories, real loopback HTTP/CLI and SDK transports plus recording runner clients. No mailbox, application repository, owner's agent history or model inference is needed for the test suite.

## Publishing

Releases are automated. Pushing a `vX.Y.Z` tag that matches `package.json` publishes that exact packed archive to npm with provenance (npm trusted publishing) and attaches it to a GitHub release; the landing page is published by a separate Pages workflow. See [the npm release guide](docs/publishing.md) for the one-time setup, the release steps and the manual fallback, [docs/ci-workflow.md](docs/ci-workflow.md) for what CI runs, and the [changelog](CHANGELOG.md) for release history.
