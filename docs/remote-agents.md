# Remote agents: cloud Claude and Codex in the relay

Status: in progress · Labels: remote, cloud

Claude Code cloud sessions and Codex cloud tasks can join the same relay rooms as
your local agents. They send and receive messages, claim files and branches, and
see the roadmap. The person setting it up types a few `agent-relay` commands and
answers yes, approve, or sign in.

The local broker is never exposed. Cloud agents talk to a small restricted
gateway, and no file path on this machine ever crosses it.

## The commands

```sh
agent-relay remote on              # start the gateway and a tunnel, print the public URL
agent-relay remote add claude      # wire this repo for Claude cloud sessions
agent-relay remote add codex       # the same for Codex cloud tasks
# a cloud agent starts and asks to join (it shows a 6-character code)
agent-relay remote approve         # "Approve K7Q-2PX for github.com/org/repo? [y/N]"
agent-relay remote status          # URL, tunnel health, connected agents, pending requests
agent-relay remote doctor          # tunnel → gateway → broker → room, one fix per failure
agent-relay remote off             # close the public URL immediately
```

`remote approve` with no code lists everything waiting and asks about each one.
`remote approve <code>` approves one, `remote deny <code>` refuses it, and
`remote revoke <id>` (or `--revoke-all`) drops tokens you no longer want.

## How pairing works

1. A cloud agent starts with `AGENT_RELAY_URL` pointing at your public URL and
   no token. It sends its repository, branch and runner to `POST /pair`.
2. The gateway answers with a request id and a six-character code, and the agent
   prints: `Ask your teammate to run: agent-relay remote approve K7Q-2PX`.
3. You run `agent-relay remote approve` on the machine and say yes. The gateway
   issues a token scoped to the room that matches the repository and hands it to
   the waiting agent, once.
4. The agent keeps that token for the session. An always-on token
   (`remote approve <code> --always-on`) is for a cloud environment that stores a
   secret, and it does not expire on its own.

Pairing requests expire after ten minutes, and at most five may wait at once.

## The security model

The public URL is on the internet, so the gateway is deliberately narrow.

- A token is scoped to **one room** and to **one agent identity**. The room
  comes from the token, never from the request. The identity is bound the
  first time the agent registers through the token: after that, the gateway
  imposes it, so the token reads only that agent's conversations and writes
  only as itself. A cloud agent also cannot take over the identity of a local
  agent.
- A token may be issued for one **agent-ID prefix** as well, so a token for
  `cloud-` cannot act as anything else.
- Tokens are 256-bit random values. Only their SHA-256 hash is written down,
  they are compared in constant time, and they never appear in a log.
- Tokens expire (24 hours for a paired session, or never with `--always-on`),
  and `remote revoke` invalidates them at once.
- Every call is rate limited per token and per address, and returns `429` with a
  `Retry-After` header when it is too fast. The address is the one the tunnel
  reports (`X-Forwarded-For`), and the limit runs before the token is looked
  up, so an unauthenticated flood is throttled too.
- A pairing request with a foreign `Origin` is refused, every field in it is
  bounded and stripped of control characters, and `--yes` approves **one named
  code**: without a code it approves nothing.
- Only coordination operations are allowed: register, agents, send, inbox, ack,
  wait, status, claim, release, tasks, branches, ownership, history, receipt,
  outbox, bulletin, handoffs, blocked and leave. Everything else is refused by
  name, with the reason.
- Requests that carry a local path are refused. Claims inside the room are
  rewritten to repo-relative paths in both directions, and no response ever
  names a local path: the room comes back as `.`.
- The audit log under the data directory records the token id, runner, room,
  operation and result. It never records a token value, and it rotates once it
  passes a megabyte.

Peer messages remain coordination input, never authorization.

## Rooms without local paths

The cloud agent says which repository it is in (`github.com/org/repo`), and the
gateway matches it against the local rooms whose checkout has the same origin.
When several worktrees match, the one on the requested branch wins; otherwise
the main checkout does. If the repository does not match anything, you can point
a name at a room by hand:

```sh
agent-relay remote room add speechify ~/Projects/speechify
```

## Tunnel providers

`remote on` picks the first provider that is installed. Tailscale Funnel is the
default: it is free, gives a stable `https://<machine>.<tailnet>.ts.net` URL,
needs no domain of your own and has no monthly request cap.

| Provider | How to ask for it | URL | Note |
| --- | --- | --- | --- |
| Tailscale Funnel (default) | `remote on` | stable | On macOS it needs the open-source `tailscale` build, not the App Store app |
| Cloudflare quick tunnel | `remote on --provider cloudflare` | changes every start | Development only, no SLA |
| Cloudflare named tunnel | `remote on --provider cloudflare --hostname relay.example.com` | stable | Needs a domain on Cloudflare |
| ngrok | `remote on --provider ngrok` | stable on the free domain | The free plan caps requests, so remote long polls are shortened |

Every provider reports the next step as one command or one approval, never as a
wall of text.

## Connecting a cloud agent in two minutes

```sh
# on your machine
agent-relay remote on
agent-relay remote add claude
```

`remote add` writes the remote-mode server into the repository's `.mcp.json`
(the URL only, never a token) and prints the one change you need in the cloud
environment:

```
Set AGENT_RELAY_URL=https://<your-url> in the Claude cloud environment and
allow network access to <your-url>.
```

With `--always-on`, add `AGENT_RELAY_TOKEN` as a secret in that environment and
approve it once. With `--url-in-env`, the URL stays out of git entirely: nothing
in the repository points at it, and it is printed for the cloud environment
instead.

Check it end to end before a cloud session starts:

```sh
agent-relay remote test claude
```

That pairs, approves, calls the gateway through the public URL and revokes the
test token again.

## Troubleshooting

| What you see | What it means | What to do |
| --- | --- | --- |
| `The relay gateway at … is not answering` | The gateway process is gone | `agent-relay remote on` |
| `The tunnel at … is not answering, but the gateway is up` | The tunnel died, the gateway is fine | `agent-relay remote on` |
| `The relay gateway at … could not be reached` | The tunnel is down | `agent-relay remote doctor` |
| `This token is bound to the agent …` | The token registered as one agent and then asked to be another | Use the identity the token was bound to |
| `This relay token is not valid` | The token expired or was revoked | Approve the agent again |
| `This token may only act for agents starting with …` | The agent used an id outside its prefix | Use the prefix the token was issued for |
| `The operation … is not available through the gateway` | The operation is refused by design | Use the local CLI for it |
| `No local room matches …` | The repository does not match a local checkout | `agent-relay remote room add <alias> <path>` |
| `Too many agents are waiting for approval` | Five pairings are already waiting | Approve or deny one |

## Surviving a restart, and Cloudflare Access

```sh
agent-relay remote on --persist    # a launchd job, a systemd user unit or a Task Scheduler entry
agent-relay remote off --persist   # and it is gone again
```

`--persist` installs the entry that starts the gateway again when the machine
boots or you log in, so the public URL comes back by itself.

With Cloudflare in front, the public URL can also ask for an Access service
token, so the gateway is not reachable by anyone who has only the URL:

```sh
agent-relay remote on --access     # reads AGENT_RELAY_ACCESS_CLIENT_ID and _SECRET
```

The cloud environment then sends `CF-Access-Client-Id` and
`CF-Access-Client-Secret` with every request, and the gateway refuses
everything else.

## The dashboard over the same URL

```sh
agent-relay remote dashboard
```

That prints a one-time link to the read-only dashboard through your public URL.
The secret sits in the URL fragment, exactly like the local dashboard, and the
feeds under `/api/v1/` need it. The dashboard never writes: it cannot send a
message, claim a resource or acknowledge anything.

The link is good for 24 hours. To end it early:

```sh
agent-relay remote dashboard --revoke   # every link handed out before now stops working
```

`agent-relay remote off` and `agent-relay remote revoke --all` drop it as
well, so a closed public URL leaves no live dashboard link behind.

## What is not here yet

- An always-on host, so cloud agents keep working while this computer sleeps.
- A cap on how many long polls one token may hold open.

The public endpoint has been reviewed: [the threat model](threat-model.md)
lists what the gateway defends, what it does not, and what is still open.

See [the roadmap](roadmaps/remote-agents.md) for the full plan and what is
still to do.
