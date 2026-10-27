You are an adversarial code reviewer. Repo: /Users/sergekadjo/Tools/agent-relay (Node 20+, ESM, macOS, Linux and Windows).

CONTEXT: A "remote agents" feature lets cloud Claude/Codex sessions join local relay rooms through a tunnel.
  lib/remote.mjs — lifecycle: remoteOn/remoteOff/remoteStatus/remoteDoctor/remoteApprove/remoteDeny/remoteRevoke/remoteRoomAdd/remoteAdd/remoteTest/remoteDashboard/remotePersist/remoteAccess/resolveRoomFor, readState/writeState
  lib/client.mjs — remote mode: remoteRpc, pairForAccess, the session token cache, the rpc() branch on AGENT_RELAY_URL
  lib/tunnels/{base,index,tailscale,cloudflare,ngrok}.mjs
  bin/agent-relay.mjs — the `remote` command family
  lib/remote-rooms.mjs — git origin normalisation and room resolution
  lib/runtime.mjs — how the broker daemon runtime (Node vs another host) is resolved and recorded
  scripts/parallel-work.mjs — the multi-lane workflow runner

YOUR LANE: those files only. Another reviewer owns lib/gateway.mjs; do not duplicate it.

HUNT FOR (be specific, cite file:line):
1. Lifecycle bugs: does `remote on` work on a machine with no tunnel provider? Does it leave a half-started gateway when the tunnel fails? Is it idempotent? Does `remote off` kill the right processes and keep the tokens as promised? Does `remote status` tell the truth when the gateway died?
2. `remote doctor`: does each check exercise what it claims, and does a failure name a real fix?
3. `remoteAdd`: valid `.mcp.json` and valid Codex TOML in the cases the repo already supports (an existing mcpServers block, a config.toml with an inline table). Are unrelated keys preserved? Is the TOML parseable by the repo's own parser in lib/setup.mjs?
4. `remoteTest`: can it leave a token behind or approve something it should not?
5. Client remote mode: does the session token cache leak between projects? Does pairing work when the repo has no origin? Are GATEWAY_OFF, TUNNEL_DOWN, TOKEN_REJECTED, OP_DENIED and RATE_LIMITED really distinguishable, and does ECONNREFUSED detection work when the cause is an AggregateError?
6. Tunnel providers: are spawned processes reaped, are URLs parsed correctly, does the Tailscale provider detect the "enable Funnel" approval, does spawnBackground leak descriptors?
7. `remotePersist`: are the launchd plist, the systemd unit and the Task Scheduler entry correct (paths, quoting, arguments)? Is the plist valid XML? Would a wrong path break the boot job?
8. Races between the gateway process (which writes the token store) and the CLI (which approves and revokes).
9. `lib/runtime.mjs`: can the recorded runtime be stale, tampered with, or point at a binary that no longer exists, and what happens then?
10. `scripts/parallel-work.mjs`: can a lane clobber another's file, lose a finding, or leave a half-merged tree?

DO NOT MODIFY ANY FILE. Report findings only, ordered by severity, each with file:line, what breaks and under what conditions, and a concrete fix. Prefer a few real defects over a long list of style opinions.
