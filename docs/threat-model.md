# Threat model: the public relay endpoint

Status: review of the code as it stands · Labels: remote, security

This is a review, not a promise. Every mitigation below points at the code that
implements it today, with the file and the line. Where the code does not
answer a threat, the threat is written down as an open item with the smallest
fix that would close it. Nothing here is planned work; it is what a reviewer
can check in the next ten minutes.

Line numbers are from `lane/08-remote-hardening` (the branch this review was
written on). The names in brackets are stable, so a later line move does not
hide the claim.

The endpoint under review is the relay gateway: the small HTTP front that a
tunnel points at (`lib/gateway.mjs`). The broker itself is never exposed; it
listens on loopback (`lib/gateway.mjs:421` [`startGateway`], default
`host = '127.0.0.1'`), and the tunnel forwards the gateway's port, not the
broker's.

## What an attacker can reach

Three endpoints answer without a token:

| Endpoint | What it does | Limit |
| --- | --- | --- |
| `GET /health` | Returns `{ok: true, service: 'agent-relay-gateway'}` and nothing else | none (`lib/gateway.mjs:314`) |
| `POST /pair` | Creates a pending pairing request and returns a six-character code | 240 requests a minute for everyone, 5 requests may wait (`lib/gateway.mjs:319`, `:171`) |
| `GET /pair/<id or code>` | Polls a pairing request; returns the token once it is approved | 240 requests a minute for everyone (`lib/gateway.mjs:334`) |

Everything else needs a bearer token (`lib/gateway.mjs:357`). A request without
one is answered `401` and written to the audit log as `unauthorized`
(`lib/gateway.mjs:364`).

## Threat 1: public endpoint abuse

**The attack.** Anyone on the internet can hammer `POST /pair`, fill the
approval list with requests that name a repository the attacker does not own,
and hope the operator approves the wrong one. The same caller can keep the
gateway busy with long polls.

**What the code does today.**

- Pairing requests are capped at five waiting at once
  (`lib/gateway.mjs:39` [`MAX_PENDING_PAIRINGS`], checked at `:171`), and each
  one expires after ten minutes (`lib/gateway.mjs:41` [`PAIRING_TTL_MS`],
  swept by `expirePairings` at `:178`). The cap is per gateway, not per
  address, so one caller can hold all five slots.
- Requests are rate limited. `RateLimiter` (`lib/gateway.mjs:205`) gives every
  token 240 requests a minute and every address 240 requests a minute
  (`:206`), and the gateway answers `429` with a `Retry-After` header
  (`lib/gateway.mjs:322`, `:338`, `:369`).
- A pairing request does nothing until a person approves it. The code is
  six characters from a 32-character alphabet (`lib/gateway.mjs:42`,
  `pairingCode` at `:46`), so it is about 30 bits.
- The request body is capped at 256 KiB (`lib/gateway.mjs:38`).

**What the limits do not stop.**

- The per-address bucket is useless behind a tunnel. The address is
  `request.socket.remoteAddress` (`lib/gateway.mjs:320`), which for every
  tunnelled request is the loopback address of the tunnel. All cloud agents
  therefore share one 240-requests-a-minute bucket, and an attacker on the
  same tunnel can spend it. The pairing bucket has the same shape: the literal
  key `pair` (`lib/gateway.mjs:321`) is a global cap of 240 pairing requests a
  minute, so a burst from many addresses still lands in one bucket.
- Nothing checks the `Origin` header and no CORS header is sent. A web page
  can post `text/plain` to `/pair`; the gateway parses the body as JSON
  whatever the content type is (`readBody`, `lib/gateway.mjs:274`) and creates
  the request. The response is unreadable from the browser, but the side
  effect lands: a page can fill the five approval slots. A JSON post is
  stopped by the preflight, which answers `401` without CORS headers.
- `remote approve --yes` approves every waiting request in one go
  (`bin/agent-relay.mjs:179`). An attacker who has filled the list is one
  `--yes` away from holding a token.
- The fields in a pairing request (repository, branch, runner, session id) are
  whatever the caller sent (`lib/gateway.mjs:326`). The operator is shown the
  code, the runner and the repository (`bin/agent-relay.mjs:178`), and the
  runner is chosen by the caller. The operator's `y` is the entire
  authentication of the cloud agent.
- The six-character code is also a lookup key on the poll endpoint:
  `findPairing` matches an id *or* a code (`lib/gateway.mjs:188`), so
  `GET /pair/K7Q2PX` returns the token of an approved request. The code is
  printed in the cloud agent's message and shown in the approval list, so it
  should be treated as a secret, not as an identifier.
- A token holder can open many long polls. `wait` is allowed
  (`lib/gateway.mjs:17`) and each call holds a socket for up to the gateway's
  30 second request timeout (`lib/gateway.mjs:428`). There is no limit on
  concurrent connections.

**Residual risk.** An unauthenticated caller can deny the pairing service to
the real agent for up to ten minutes at a time, and can make the approval
list lie. An operator who approves a request they did not verify hands over
one room.

**The one-line fix, if it ever bites.**

- Rate limit by the address the tunnel reports (`X-Forwarded-For`) instead of
  the socket address (`lib/gateway.mjs:320`), and give the pairing bucket its
  own limit per address as well as per gateway.
- Reject a pairing request whose `Origin` is not empty and not one of the
  caller's own origins (`lib/gateway.mjs:319`).
- Never approve more than one request per `--yes` run, or drop `--yes` for the
  list and keep it for a single explicit code (`bin/agent-relay.mjs:179`).
- Look a pairing request up by its id only, and keep the code for the human
  (`lib/gateway.mjs:188`).
- Cap concurrent waits per token (`lib/gateway.mjs:17`).

## Threat 2: token leakage

**The attack.** A token leaks through a log, a shell history, a cloud
environment variable, a CI log or a file on disk, and whoever reads it joins
the room as the cloud agent until it is revoked or expires.

**What the code does today.**

- A token is 32 random bytes (`lib/gateway.mjs:45` [`randomToken`]), stored as
  a SHA-256 hash (`lib/gateway.mjs:44` [`sha256`], written at `:128`) and
  compared in constant time (`timingSafeEqual`, `lib/gateway.mjs:145`). The
  value is never in the token file's `tokens` list, and never in the audit log
  (`AuditLog.write`, `lib/gateway.mjs:236`; the audit log records the token
  id, runner, room, operation and result only).
- A paired session token expires after 24 hours (`lib/gateway.mjs:124`
  [`issue`], default `ttlMs`), and an always-on token has no expiry
  (`:130`). `remote revoke` and `remote revoke --all` invalidate at once
  (`lib/remote.mjs:222`, `TokenStore.revoke` at `lib/gateway.mjs:154`).
- The client keeps the token in memory for the session only
  (`lib/client.mjs:134` [`sessionToken`]); it is never written down.
- `remote add` writes only the URL into the repository's `.mcp.json`, never a
  token (`lib/remote.mjs:240` [`remoteAdd`]); with `--url-in-env` the URL
  leaves the repository too.
- The token store and the audit log are written with mode `0600` inside a
  `0700` data directory (`lib/gateway.mjs:422`, `:81`, `:243`).

**What the limits do not stop.**

- **The token value is written to disk in plaintext while it waits to be
  collected.** `TokenStore.approve` puts the value in the pairing row
  (`lib/gateway.mjs:197`, `row.tokenValue = value`) and `save()` writes the
  pairing rows to `remote-tokens.json` with everything else. The value is
  erased only when the waiting agent collects it (`lib/gateway.mjs:351`). If
  the agent never polls again, the plaintext stays in the file: `expirePairings`
  drops the row from memory (`:178`) but does not rewrite the file. The
  "only a hash is stored" claim is true for the token list and false for the
  pairing list.
- The token crosses the wire in the body of the poll response
  (`lib/gateway.mjs:354`). It is inside TLS, but it lands in whatever the
  cloud agent does with it: an environment variable (`AGENT_RELAY_TOKEN`,
  `lib/client.mjs:135`), a CI log that echoes the environment, a shell
  history when the token is passed on the command line, or a crash dump.
- An always-on token never expires on its own (`lib/gateway.mjs:130`), so a
  leak is a permanent leak until someone runs `remote revoke`.
- The agent-prefix limit does not cover the sender of a message. The gateway
  only checks `fields.agentId` (`lib/gateway.mjs:402`); the `send` operation
  names its sender in `from`, which is never checked against the prefix. A
  token issued with `--prefix cloud-` can still send a message that reads as
  if it came from `local-codex-1`.
- `TokenStore.find` returns at the first match (`lib/gateway.mjs:137`), so the
  time it takes to find a token depends on where the token sits in the list.
  Low value to an attacker, but it is not constant time end to end.

**Residual risk.** A leaked always-on token is a room-wide read and write
grant until it is revoked. The window between approval and collection is a
window in which the token exists in a file on disk.

**The one-line fix, if it ever bites.**

- Keep the token value out of the file: keep it in memory and have the
  approving process hand it over through a channel that does not need to be
  persisted (`lib/gateway.mjs:197`), or encrypt the pending value with a key
  that only the waiting agent holds.
- Check the `from` field of `send` against the token's prefix as well as
  `agentId` (`lib/gateway.mjs:402`).
- Give always-on tokens an expiry too, and renew them on use
  (`lib/gateway.mjs:130`).

## Threat 3: prompt-injected agents

**The attack.** A peer agent, a repository file, or a web page convinces the
cloud agent to ask the gateway for something the gateway would refuse, and the
cloud agent asks anyway. The point is to check that the gateway is the thing
that says no, and that a message can never widen what a token may do.

**What the code does today.**

- The room comes from the token, never from the request
  (`lib/gateway.mjs:391`). The request's own `project` field is deleted
  (`:388`). A message cannot move a token to another room.
- The operation allowlist is decided before anything is forwarded
  (`lib/gateway.mjs:16` [`ALLOWED_OPS`], checked at `:381`), and the
  operations that touch the machine are refused by name with a reason
  (`lib/gateway.mjs:23`
  [`DENIED_OPS`]): attachments, restore, export, attachment audit, usage,
  prune, compact, process records, retire and forced release.
- Requests that carry a local path are refused before the broker sees them
  (`lib/gateway.mjs:395` [`containsLocalPath`]), and claims inside the room
  are rewritten to repo-relative paths in both directions (`:394`,
  `repoRelative` at `:65`).
- A token may only act for agents inside its own prefix, when it has one
  (`lib/gateway.mjs:402`).
- Peer messages are ordinary room messages. Nothing in the gateway gives a
  message any authority: there is no path from a message body to an
  operation, and the message body is not interpreted at all. A message that
  says "run `agent-relay remote revoke --all`" is text in an inbox.

**What the limits do not stop.**

- A message is not the only way to influence an agent: the cloud agent reads
  the repository, the roadmap and the task list. The gateway cannot help
  there, and the local agent's own rules decide what a peer message means.
- The path filter is a filter over request fields, so it also reads free
  text. A message body that contains `..` or starts with `/` is refused with
  "Local paths cannot cross the gateway: body" (`lib/gateway.mjs:395`,
  `isLocalPath` at `:48`). That is a false positive: a legitimate message
  about `../README` never reaches the room through the gateway.
- The response filter is weaker than the request filter. `scrubPaths`
  (`lib/gateway.mjs:255`) rewrites the room path to a dot and nothing else, so
  a path *outside* the room that a local agent typed into a message body
  crosses the gateway unchanged.
- A token is a room-wide grant, not an inbox-wide one. `history` is allowed
  (`lib/gateway.mjs:18`) and returns every message in the room
  (`lib/broker.mjs:1135`), including the conversations of two local agents
  that never involved the cloud agent. `agents`, `tasks`, `branches` and
  `ownership` are room-wide too.

**Residual risk.** A cloud agent inside the room sees the whole room and can
write into it; the gateway limits the *shape* of what it may do, not the
*content* of what it reads. The path guarantee holds for the room root and
for structured fields, not for free text.

**The one-line fix, if it ever bites.**

- Apply the path filter to the fields that carry a path, and to a body only
  when the body is not free text (`lib/gateway.mjs:395`).
- Rewrite any absolute path in a response, not only the room root
  (`lib/gateway.mjs:255`).
- If the room's conversations should stay private, drop `history` from
  `ALLOWED_OPS` and give the cloud agent its own inbox only
  (`lib/gateway.mjs:18`).

## Threat 4: room confusion across forks

**The attack.** Two checkouts of the same repository, or a fork of it, and a
cloud agent that says "github.com/org/repo" lands in the wrong room: it reads
another worktree's messages, or claims files in a checkout it is not working
in.

**What the code does today.**

- The room is resolved from the repository the cloud agent reports, matched
  against the local rooms whose checkout has the same origin
  (`lib/remote-rooms.mjs:74` [`resolveRoom`]). The repository name is
  normalised, so `git@github.com:org/repo.git`, `https://github.com/org/repo`
  and `github.com/org/repo` are the same (`lib/remote-rooms.mjs:8`).
- The rules are in order: an alias the person set wins; then a checkout of the
  same repository on the requested branch; then the main checkout; then any
  checkout of it (`lib/remote-rooms.mjs:76`).
- The token is then bound to that one room, and the gateway takes the room
  from the token (`lib/gateway.mjs:391`). One token, one room.
- A fork has a different origin, so it matches nothing. The person has to
  point at it by hand: `agent-relay remote room add <alias> <path>`
  (`lib/remote.mjs:231`).
- The room path never leaves the machine: it comes back as `.`
  (`lib/gateway.mjs:255`, `:266`).

**What the limits do not stop.**

- A fork cannot be told apart from its upstream by repository name alone, so
  a fork agent only joins a room when an alias says so, and the alias is
  global for the data directory. One alias, one room: two forks of the same
  repository need two aliases, and the alias wins over the branch rule
  (`lib/remote-rooms.mjs:78`), so a fork agent always lands in the aliased
  room even when it is working on another branch.
- When several worktrees share an origin and none is on the branch the cloud
  agent reports, the main checkout wins (`lib/remote-rooms.mjs:95`). The cloud
  agent is then in a different checkout than its own, and its claims are
  relative to a tree it cannot see. Claims travel as repo-relative paths
  (`lib/gateway.mjs:394`), so both sides agree on the *name* and not on the
  *file*.
- The repository in the pairing request is chosen by the caller
  (`lib/gateway.mjs:326`), so an attacker can ask to be placed in the room of
  a repository they do not have. Only the operator's approval stops it.

**Residual risk.** A cloud agent can end up in a room that is not the checkout
it is working in, and its claims then name files that do not exist for the
other agents.

**The one-line fix, if it ever bites.**

- Require a branch that matches a checkout, and refuse to fall back to the
  main checkout when the caller named a branch (`lib/remote-rooms.mjs:93`).
- Make the alias per branch, or make the alias a fallback rather than a
  first choice (`lib/remote-rooms.mjs:76`).

## Threat 5: the gateway's own surroundings

**The attack.** Not the endpoint: the machine around it. A misconfigured
environment, a stale link, or a resource limit turns a safe gateway into an
open one.

**What the code does today.**

- The gateway binds to loopback (`lib/gateway.mjs:421`), so the broker is not
  reachable from the network even if the tunnel is wide open.
- An optional Cloudflare Access service token is checked with a constant-time
  comparison before anything else (`lib/gateway.mjs:295`), so the public URL
  can require a second secret.
- The dashboard rides on the same URL behind its own secret
  (`lib/gateway.mjs:305`), and the secret sits in the URL fragment, so it is
  not sent to the server by the browser.
- `remote off` stops the tunnel and the gateway (`lib/remote.mjs:123`), and
  `remote revoke --all` drops every token (`lib/remote.mjs:134`).

**What the limits do not stop.**

- The gateway's call into the broker is the ordinary client
  (`lib/gateway.mjs:11`, `call = rpc`), and the ordinary client prefers the
  remote mode when `AGENT_RELAY_URL` is set (`lib/client.mjs:171`). A gateway
  started from a shell that has `AGENT_RELAY_URL` in its environment sends
  the cloud agent's messages back out to that URL instead of to the local
  broker.
- The dashboard link does not expire. The secret is written to
  `remote-state.json` (`lib/remote.mjs:37`) and read back from there
  (`lib/remote.mjs:428`), so it survives a restart, and there is no command
  that invalidates it. The roadmap's "links expire after 24 hours" and
  "`remote dashboard --revoke`" are not in the code.
- The client keeps no timeout on its own requests in remote mode
  (`lib/client.mjs:153`); the gateway's 30 second request timeout
  (`lib/gateway.mjs:428`) is what ends a long poll.
- An error that is not a refused connection is reported as "could not be
  reached" (`lib/client.mjs:158`) with no command to run. Only the refused
  connection case names one (`agent-relay remote on`, `lib/client.mjs:157`).

**Residual risk.** A gateway with a stale environment variable talks to the
wrong place, and a dashboard link lives forever.

**The one-line fix, if it ever bites.**

- Clear `AGENT_RELAY_URL` in the gateway process when it starts
  (`lib/gateway.mjs:421`), or pass the broker URL to `call` instead of the
  environment-dependent client.
- Give the dashboard secret an expiry and a revoke command
  (`lib/remote.mjs:37`, `:428`).
- Put the fix command in every transport error, not only in the refused
  connection case (`lib/client.mjs:158`).

## The open items, in one list

| # | Threat | Fix, in one line |
| --- | --- | --- |
| 1 | The tunnel makes every caller share one rate-limit bucket | Rate limit by the address the tunnel reports, not by the socket address (`lib/gateway.mjs:320`) |
| 2 | A web page can fill the approval list | Reject a pairing request with a foreign `Origin` (`lib/gateway.mjs:319`) |
| 3 | `remote approve --yes` approves an attacker's request too | Approve one code at a time (`bin/agent-relay.mjs:179`) |
| 4 | The pairing code is also a bearer secret for the token | Look a request up by id only (`lib/gateway.mjs:188`) |
| 5 | The token value sits in the token file in plaintext until it is collected | Keep the pending value out of the file (`lib/gateway.mjs:197`) |
| 6 | `send` may name any sender, even with a prefix-scoped token | Check `from` against the prefix too (`lib/gateway.mjs:402`) |
| 7 | Free text that looks like a path is refused, and free text that *is* a path is not | Filter path fields, not bodies, and scrub every absolute path in a response (`lib/gateway.mjs:255`, `:395`) |
| 8 | A token reads the whole room, not just its own inbox | Drop `history` from the allowlist, or scope it to the token's agent (`lib/gateway.mjs:18`) |
| 9 | A cloud agent can land in the wrong worktree | Refuse the main-checkout fallback when a branch was named (`lib/remote-rooms.mjs:93`) |
| 10 | The dashboard link never expires and cannot be revoked | Give the secret an expiry and a revoke command (`lib/remote.mjs:37`) |
| 11 | A gateway started with `AGENT_RELAY_URL` set calls the wrong relay | Clear the variable when the gateway starts (`lib/gateway.mjs:421`) |
| 12 | Long polls are unbounded | Cap concurrent waits per token (`lib/gateway.mjs:17`) |

## How to check this review

The claims above are checkable without a tunnel and without a network.

```sh
# the token value is in the token file until the agent collects it
node --input-type=module -e "
  import {promises as fs} from 'node:fs'; import os from 'node:os'; import path from 'node:path';
  import {startGateway, TokenStore} from './lib/gateway.mjs';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-'));
  const gateway = await startGateway({dataDir: dir, port: 0, call: async () => ({ok: true})});
  const paired = await fetch(gateway.url + '/pair', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({repo:'r'})});
  const request = await paired.json();
  const store = await new TokenStore(dir).load();
  const token = store.issue({room: '/work/alpha'});
  store.approve(store.findPairing(request.code), token, token.value);
  await store.save();
  console.log('token on disk:', (await fs.readFile(path.join(dir, 'remote-tokens.json'), 'utf8')).includes(token.value));
  await gateway.close();
"
```

The same file, `test/remote-e2e.test.mjs`, holds the end-to-end checks: the
pairing round trip, the allowlist, the path refusal, the rate limit and the
tunnel-down message.

## What this review does not cover

- The tunnel providers themselves (Tailscale, Cloudflare, ngrok) and what
  their vendors log.
- The broker's own authorisation model for local agents, which is a different
  trust boundary: a local agent runs with the user's own rights.
- The cloud environment itself, which holds the token and decides what the
  agent may read.
