# Remote agents: cloud Claude and Codex in the relay
Status: 0.8.0 shipped the gateway, the tunnel, pairing, the dashboard and the docs. The seven threat-model items are closed in the tree and unreleased. The hosted relay is still a plan: `remote host` writes it, a local start proved the broker and gateway come up, and no always-on host is deployed, so cloud agents still stop when this computer sleeps.
Labels: remote, cloud, roadmap

Goal: Claude Code cloud sessions and Codex cloud tasks join the same relay rooms as local agents. They send and receive messages, claim files and branches, and see the roadmap. The person setting it up only types a few `agent-relay` commands and answers yes, approve, or sign in.

Design rules:
- Everything is set up from the CLI. No config files to edit, no new passwords, no extra dashboard accounts.
- The local broker is never exposed. Cloud agents talk to a small restricted gateway, and no file path on this machine ever crosses it.
- One free sign-in at most, a single tunnel provider by default, and sensible fallbacks.
- Everything is reversible with one command (`agent-relay remote off`, `agent-relay remote revoke`).

The whole experience:

```sh
agent-relay remote on              # checks/installs the tunnel tool, one browser approval, prints the public URL
agent-relay remote add claude      # wires this repo for Claude cloud sessions (prints the one cloud setting)
agent-relay remote add codex       # same for Codex cloud tasks
# a cloud agent starts and asks to join (it shows a 6-character code)
agent-relay remote approve         # "Approve K7Q-2PX for /path/to/speechify? [y/N]" -> y
agent-relay remote status          # URL, tunnel health, connected cloud agents, pending requests
agent-relay remote off             # closes the public URL immediately
```

Tunnel choice. Tailscale Funnel is the default: it is free, gives a stable `https://<machine>.<tailnet>.ts.net` URL, needs no domain, has no monthly request cap, and is set up entirely from its CLI after one browser approval. The others stay available:

| Provider | Account | Stable URL | Why not default |
| --- | --- | --- | --- |
| Tailscale Funnel (default) | Free Tailscale sign-in | Yes | On macOS it needs the open-source `tailscale` build (Homebrew), not the App Store app |
| Cloudflare quick tunnel (`--provider quick`) | None | No, it changes every start | Development only, no SLA, no Server-Sent Events. Cloud settings need a `*.trycloudflare.com` wildcard |
| Cloudflare named tunnel (`--provider cloudflare --hostname relay.example.com`) | Cloudflare account plus a domain on Cloudflare | Yes | Requires owning a domain on Cloudflare |
| ngrok (`--provider ngrok`) | ngrok sign-in | Yes (free dev domain) | The free plan allows 20,000 requests a month. One long-polling agent uses about 100,000 a month |

Security model: the public URL is on the internet. Every gateway call needs a token, except the pairing request. A token is scoped to one room and to **one agent identity**: the first registration through it binds the token to that agent, and after that it reads only that agent's conversations and writes only as itself. Pairing requests are rate limited by the address the tunnel reports, expire after 10 minutes, and do nothing until approved locally; a request with a foreign `Origin` is refused, and `--yes` approves one named code. Tokens are random 256-bit values that are stored only as hashes, can be revoked, and expire (24 hours for paired sessions; an always-on token uses that window and renews it on use, and `--ttl-hours` sets the window). A call that names another room or another agent is refused. A token may hold four long polls. Peer messages remain coordination input, never authorization. The reasoning is in [the threat model](../threat-model.md). Its open list is empty.

## Phase 1: Remote gateway
Labels: gateway

A restricted HTTP front for the local broker. The tunnel points here, never at the broker.

### Restricted API
- [x] Add `lib/gateway.mjs`: an HTTP server on a fixed loopback port (default 47820) that forwards allowed operations to the local broker through `lib/client.mjs`
- [x] Allow only: register, agents, send (text only), inbox, ack, wait, status, claim, release, tasks (including tree), branches, ownership, history, receipt, outbox, bulletin get/ack, handoff request/respond/list, blocked, leave
- [x] Deny everything else with a clear error: fetch, attachments, restore, export, attachment audit, usage, prune, compact, process records, forced release, retire
- [x] Reject any request field that carries a local file path (attachments, out)
- [x] Keep the broker's request size limits, and add per-token and per-IP rate limits (429 with Retry-After)

### Rooms without local paths
- [x] Resolve the room from the cloud agent's git remote (for example `github.com/org/repo`): match it to local rooms whose checkout has the same origin
  - [x] When several local worktrees match, prefer the room on the requested branch, else the main checkout
  - [x] Allow an explicit alias as a fallback (`agent-relay remote room add speechify ~/Projects/speechify`)
- [x] Never accept or return absolute local paths over the gateway; rewrite claims to repo-relative paths in both directions

### Tokens and pairing
- [x] Token store in the data dir: hashed tokens with room, agent-ID prefix, runner, created/expires/last-used, and an id for revocation
- [x] `POST /pair` (unauthenticated, rate-limited): the cloud agent sends repo, branch, runner and session id, and gets a request id plus a 6-character code to show its user
- [x] Local approval: `agent-relay remote approve` lists pending requests with code, runner, repo and room, and asks y/N for each. On yes, the waiting agent receives a token scoped to that room
- [x] `--yes` flag and `remote approve <code>` for one-shot approval; `remote deny <code>`
- [x] Always-on tokens for cloud environments that store a secret (`remote add claude --always-on`)
- [x] `agent-relay remote revoke <id|all>` and automatic expiry

### Hardening
- [x] Constant-time token comparison and no token values in logs
- [x] Audit log (token id, runner, room, op, result) under the data dir, rotated
- [x] Rate limits and a pending-pairing cap (5) so the public endpoint can't flood the approval list
- [x] Tests for the op allowlist, path rejection, room resolution, pairing expiry and rate limits

## Phase 2: Remote client mode
Labels: client

Cloud agents use the same `relay_*` tools as local agents. Only the transport changes.

### Client transport
- [x] When `AGENT_RELAY_URL` is set, `lib/client.mjs` sends RPCs to the gateway and never starts or discovers a local broker
- [x] Credentials: `AGENT_RELAY_TOKEN` when present, otherwise rely on a token the cloud proxy injects, otherwise start pairing
- [x] Pairing in the MCP adapter: print "Ask your teammate to run: agent-relay remote approve (code K7Q-2PX)", wait up to 10 minutes, then keep the token in memory for the session only
- [x] Send the repo origin, branch and runner automatically. The agent never has to know a room name
- [x] Clear errors for gateway-off, tunnel-down, expired-token and denied-op, each with the one command that fixes it

### Repository wiring
- [x] `agent-relay remote add claude`: write the remote-mode server into the repo's `.mcp.json` (URL only, never a token), and print the commit hint
- [x] `agent-relay remote add codex`: write the matching Codex config, and print the Codex environment steps
- [x] For public repos, offer `--url-in-env`, which keeps the URL out of git and prints it for the cloud environment's variables instead
- [x] Tests: a remote-mode client never spawns a broker; pairing round trip; tools behave the same through the gateway

## Phase 3: Tunnel providers
Labels: tunnel

One provider interface: detect, install hint, sign in, start, stop, status and public URL. `remote on` picks the best available provider automatically.

### Provider interface
- [x] `lib/tunnels/` with a common interface, plus auto-detection order: Tailscale, Cloudflare named tunnel (if configured), Cloudflare quick tunnel, ngrok
- [x] Each provider reports what the user must do next as one command or one approval, never a wall of text
- [x] Health check from the outside: `remote doctor` calls the public URL `/health` through the tunnel and reports latency

### Tailscale Funnel (default)
- [x] Detect `tailscale`. If missing, show the exact install command for the OS (macOS: `brew install tailscale` and start the open-source daemon)
- [x] If not signed in, run `tailscale up` (opens the browser once), then continue automatically
- [x] Start `tailscale funnel --bg 47820` and capture the `*.ts.net` URL. The first run triggers Tailscale's one-click "enable Funnel" approval; detect it and wait
- [x] `remote off` runs `tailscale funnel reset` (or the equivalent). The reset is for the machine, not for one port: Tailscale has no per-port form

### Cloudflare
- [x] Quick tunnel: `cloudflared tunnel --url http://127.0.0.1:47820`, parse the trycloudflare URL, and warn that it changes on every start (cloud settings need `*.trycloudflare.com`)
- [x] Named tunnel: `remote on --provider cloudflare --hostname relay.example.com` runs `cloudflared tunnel login` (browser once), creates the tunnel and DNS route, and stores the config under the data dir
- [x] Optional Cloudflare Access service token in front (`--access`), injected as two headers by the cloud environment's secret

### ngrok
- [x] `remote on --provider ngrok`: check the authtoken, then `ngrok http --url=<dev domain> 47820`
- [x] Warn about the free plan's monthly request cap, and lengthen remote long-poll intervals when ngrok is the provider

## Phase 4: One-command experience
Labels: cli, ux

### Lifecycle commands
- [x] `agent-relay remote on [--provider …]`: start gateway plus tunnel as managed background processes (like the broker daemon), idempotent, print the URL and next step
- [x] `agent-relay remote status`: URL, provider, tunnel health, gateway uptime, connected cloud agents, pending pairings, token count
- [x] `agent-relay remote off`: stop the tunnel, then the gateway; tokens stay unless `--revoke-all`
- [x] `agent-relay remote doctor`: end-to-end check (tunnel → gateway → broker → room resolution) with one fix per failure
- [x] Survive restarts: `agent-relay remote on --persist` installs a launchd (macOS), systemd user (Linux) or Task Scheduler (Windows) entry, and `remote off --persist` removes it

### Cloud environment setup, printed not documented
- [x] `remote add claude` prints the single Claude cloud environment change and copies it to the clipboard: allow the relay host (Custom network access), or with `--always-on` a network secret for that host with the gateway token
- [x] `remote add codex` prints the Codex environment change: enable agent internet for the relay host with POST allowed, plus the secret for `--always-on`
- [x] `remote test claude|codex` simulates the cloud agent's first call from this machine through the public URL, so problems show up before a cloud session starts

## Phase 5: Dashboard over the same URL
Labels: dashboard

People can follow cloud and local agents from any browser. Agents never need the dashboard.

### Remote read-only dashboard
- [x] Serve the dashboard through the gateway on its own routes (`/`, `/roadmap/`, `/branches/`, `/agents/`, `/messages/`, `/claims/`), read-only, behind a one-time link from `agent-relay remote dashboard` (secret in the URL fragment, as locally)
- [x] Mark cloud agents with a runner badge (Agents and Messages views), and show pending pairing requests read-only
- [x] Links expire after 24 hours; `remote dashboard --revoke` invalidates them all

## Phase 6: Docs, tests and release
Labels: docs, release

### Ship it
- [x] `docs/remote-agents.md`: the six commands above, how pairing works, security model, provider table, troubleshooting
- [x] End-to-end test with a fake tunnel provider: pair, approve, send, wait, claim and revoke through the gateway on macOS, Linux and Windows CI
- [x] Threat-model review: public endpoint abuse, token leakage, prompt-injected agents, room confusion across forks
- [x] Release as a minor version with a changelog entry and a short "connect a cloud agent in two minutes" section in the README

## Still to do

- [x] Marking cloud agents in the tower, and showing pending pairings there.
- [x] An end-to-end test with a fake tunnel provider.


- [x] The dashboard over the same public URL (Phase 5).
- [ ] An always-on host that stays up while this computer sleeps. `remote host` writes the plan. A local start proved the broker and gateway come up, then they were stopped. Nothing is deployed.
- [x] A threat-model review of the public endpoint.
- [x] A release with the changelog entry and the README section.

## Later: relay without this machine
Labels: future

### Hosted relay option
- [ ] Run the broker plus gateway on a small always-on host (a VM or a container platform), so cloud agents keep working while this computer sleeps. The plan's broker and gateway were started locally from the unit commands and came up, then were stopped. That is not a host that stays up.
- [x] `agent-relay remote host` writes the host plan and the steps that point local agents at it, using the same tokens and rooms
