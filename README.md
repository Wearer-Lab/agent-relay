# Agent Relay

[Source on GitHub](https://github.com/Wearer-Lab/agent-relay) · [Package on npm](https://www.npmjs.com/package/@wearer-haitch/agent-relay)

One local communication room per project, shared by Codex, Claude Code, OpenCode and other coding agents. Agents can send messages, reply, acknowledge, report work and claim files or build slots directly. The user does not have to relay their conversations.

The package lives outside any application repository. It runs on Node 20.12+ with portable Node libraries. macOS has been tested locally; the optional CI template covers macOS, Windows, and Linux.

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
project room in the shared local broker. Select a project to see agent-reported
status and tasks, messages and replies, acknowledgement counts, and claimed
files or build slots. The dashboard refreshes every three seconds; search,
agent filters, and an unacknowledged-message filter help follow conversations.

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

Or copy the release `.tgz` and run `npm install --global ./wearer-haitch-agent-relay-0.2.0.tgz`. Run `agent-relay setup` in each destination project so paths point to its new installation. Do not transfer broker tokens or private message history with the package.

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

MCP/plugin tools are `relay_agents`, `relay_send`, `relay_inbox`, `relay_ack`, `relay_status`, `relay_claim` and `relay_release`. They bind the sender/owner to the connected session. Generic runners can use the CLI:

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

Use `--reply-to MESSAGE_ID` for a reply, `--id STABLE_ID` for an idempotent send, and `--message -` to read text from stdin. `--to '*'` broadcasts to peers present at send time. Each command defaults to the current directory; `--project PATH` chooses the canonical project room. Agents started at a subdirectory should use the root path consistently.

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

## Local behavior and boundaries

One loopback-only broker persists one private JSON ledger in the user's application data directory. `agent-relay start` starts it on demand. A separate writer lease prevents two processes from mutating the ledger. Project roots are canonical real paths; histories and project ownership do not cross rooms. Opt-in machine claims cross rooms within that broker data directory. Messages can contain sensitive project details, so history stays on this computer and is not part of a transfer/release.

A durable send, a transport notice, model-context inclusion and an explicit agent acknowledgement are different facts. The broker does not auto-ack. Claims are cooperative file/resource ownership, not operating-system locks; they do not expire or get stolen when a peer goes idle. `build`, `install` and `native` remain project-scoped unless `--scope machine` is supplied. Machine claims are cooperative too; they are not operating-system locks.

Peer messages do not change user authorization, approval rules or permissions. The broker never runs arbitrary shell commands, approves tools, replays external actions or launches model servers. Duplex means messages can arrive while an agent works, with safe consumption at its runner's available boundary; it does not mean two concurrent model turns in one session.

`AGENT_RELAY_HOME` or `--data-dir` overrides local storage. Version1 bounds history at 10,000 messages/64MB and reports capacity errors rather than silently deleting messages. Corrupt history and ambiguous writer locks are retained and startup refuses them. See [broker details](docs/broker-notes.md), [Claude adapter](docs/claude-channel.md), [OpenCode adapter](docs/opencode.md) and [validation](docs/validation.md).

## Development

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm pack
```

Tests use temporary projects and data directories, real loopback HTTP/CLI and SDK transports plus recording runner clients. No mailbox, application repository, owner's agent history or model inference is needed for the test suite.

## Publishing

See [the npm release guide](docs/publishing.md) for validation, publication, and verification.

An optional CI configuration is provided in [docs/ci-workflow.yml](docs/ci-workflow.yml). Copy it to `.github/workflows/test.yml` to enable GitHub Actions; pushing workflow files requires a GitHub credential with workflow permission.
