# Threat model: the public relay endpoint

Status: review of the code as it stands · Labels: remote, security

This is a review, not a promise. Every mitigation below points at the code that
implements it today, with the file and the symbol. Where the code does not
answer a threat, the threat is written down as an open item with the smallest
fix that would close it. Nothing here is planned work; it is what a reviewer
can check in the next ten minutes.

The line numbers of an earlier draft have moved with every fix since, so the
citations name the **symbol** in brackets. The symbol is stable; the line is
not.

The endpoint under review is the relay gateway: the small HTTP front that a
tunnel points at (`lib/gateway.mjs`). The broker itself is never exposed; it
listens on loopback (`lib/gateway.mjs` [`startGateway`], default
`host = '127.0.0.1'`), and the tunnel forwards the gateway's port, not the
broker's.

## What an attacker can reach

Three endpoints answer without a token:

| Endpoint | What it does | Limit |
| --- | --- | --- |
| `GET /health` | Returns `{ok: true, service: 'agent-relay-gateway'}` and nothing else | none |
| `POST /pair` | Creates a pending pairing request and returns a six-character code | the address bucket of the rate limiter, and five requests may wait |
| `GET /pair/<id>` | Polls a pairing request; returns the token once it is approved | the address bucket of the rate limiter |

Everything else needs a bearer token (`lib/gateway.mjs` [`createGatewayHandler`]).
A request without one is answered `401`, and the refusal is written to the
audit log once per minute per address (`AuditLog.shouldWrite`), so a flood
cannot drown the trail.

## Threat 1: public endpoint abuse

**The attack.** Anyone on the internet can hammer `POST /pair`, fill the
approval list with requests that name a repository the attacker does not own,
and hope the operator approves the wrong one. The same caller can keep the
gateway busy with long polls.

**What the code does today.**

- Pairing requests are capped at five **waiting** at once
  (`lib/gateway.mjs` [`MAX_PENDING_PAIRINGS`], checked in
  [`requestPairing`]), and each one expires after ten minutes
  ([`PAIRING_TTL_MS`], swept by `expirePairings`). An approved or a denied
  request frees its slot at once, so a caller cannot hold the list by
  queueing five requests and walking away.
- Requests are rate limited. `RateLimiter` (`lib/gateway.mjs`) gives every
  token its own bucket and every **address** its own bucket, and the gateway
  answers `429` with a `Retry-After` header.
- The address is the one the tunnel reports, not the socket address:
  `X-Forwarded-For` is read first (`lib/gateway.mjs`, the `ip` in
  [`createGatewayHandler`]). Behind a tunnel every caller shares one loopback
  address, so the forwarded address is the only one that separates them.
- The limit runs **before** the token is looked up, so an unauthenticated
  flood is throttled and never reaches the broker.
- A pairing request does nothing until a person approves it. The code is six
  characters from a 32-character alphabet ([`pairingCode`]), so it is about 30
  bits.
- A pairing request with a foreign `Origin` is refused (`403`). A web page on
  another site cannot fill the approval list.
- The request body is capped at 256 KiB, and every field in it is bounded and
  stripped of control characters ([`validatePairing`]): a 200 KB "repository"
  carrying ANSI escapes cannot rewrite the operator's prompt.
- `remote approve --yes` approves **one named code**. Without a code it says
  so and approves nothing (`bin/agent-relay.mjs`).

**What the limits do not stop.**

- The per-address bucket is per address, not per person: an attacker with many
  addresses can still make many requests, and the five waiting slots are per
  gateway.
- The operator still approves on trust. The request names a repository, a
  branch and a runner, and the operator's `y` is the entire authentication of
  the cloud agent. The gateway cannot tell a fork from its upstream.
- A token holder can open many long polls. `wait` is allowed and each call
  holds a socket for up to the gateway's 30 second request timeout. There is
  still no cap on concurrent waits per token.

**Residual risk.** An unauthenticated caller can deny the pairing service to
the real agent for up to ten minutes at a time, and can make the approval list
look busier than it is. An operator who approves a request they did not verify
hands over one room.

**The one-line fix, if it ever bites.**

- Cap concurrent waits per token (`lib/gateway.mjs` [`ALLOWED_OPS`]).
- Show the operator the checkout the room resolves to, not only the
  repository name, so a fork is visible at approval time.

## Threat 2: token leakage

**The attack.** A token leaks through a log, a shell history, a cloud
environment variable, a CI log or a file on disk, and whoever reads it joins
the room as the cloud agent until it is revoked or expires.

**What the code does today.**

- A token is 32 random bytes ([`randomToken`]), stored as a SHA-256 hash
  ([`sha256`]) and compared in constant time ([`timingSafeEqual`]). The value
  is never in the token file's `tokens` list, and never in the audit log.
- The value of an approved-but-uncollected token waits in its own short-lived
  file (`remote-pending-tokens.json`), never in the token store, and it is
  deleted when the agent collects it **and** when the pairing expires
  (`expirePairings` deletes the pending value with the pairing). A token that
  nobody collects does not sit on the disk for the life of the installation.
- A paired session token expires after 24 hours ([`issue`], default
  `ttlMs`), and an always-on token has no expiry. `remote revoke` and
  `remote revoke --all` invalidate at once ([`TokenStore.revoke`]).
- The client keeps the token in memory for the session only
  (`lib/client.mjs` [`sessionToken`]), keyed by the gateway **and** the
  repository, so a token for one room is never sent to another. It is never
  written down.
- `remote add` writes only the URL into the repository's `.mcp.json`, never a
  token ([`remoteAdd`]); with `--url-in-env` the URL leaves the repository too.
- The token store and the audit log are written with mode `0600` inside a
  `0700` data directory.
- A revocation sticks. The gateway and the CLI both write the token file, so
  the store is written under a lock and the rows are merged by id
  ([`TokenStore.save`]); a row that has a `revokedAt` on disk is never
  overwritten with an older value from memory. A request that started before
  the revocation cannot bring the token back.

**What the limits do not stop.**

- The token crosses the wire in the body of the poll response. It is inside
  TLS, but it lands in whatever the cloud agent does with it: an environment
  variable (`AGENT_RELAY_TOKEN`), a CI log that echoes the environment, a
  shell history when the token is passed on the command line, or a crash dump.
- An always-on token never expires on its own, so a leak is a permanent leak
  until someone runs `remote revoke`.
- The value of an uncollected token is on disk in the clear for the length of
  the pairing's ten-minute life. The file is `0600`, but the claim "only a
  hash is ever stored" is true for the token store and false for the handover
  file.
- `TokenStore.find` returns at the first match, so the time it takes to find
  a token depends on where the token sits in the list. Low value to an
  attacker, but it is not constant time end to end.

**Residual risk.** A leaked always-on token is a room-wide read and write
grant until it is revoked.

**The one-line fix, if it ever bites.**

- Hand the value over out of band, so it is never on disk at all.
- Give always-on tokens an expiry too, and renew them on use.

## Threat 3: prompt-injected agents

**The attack.** A peer agent, a repository file, or a web page convinces the
cloud agent to ask the gateway for something the gateway would refuse, and the
cloud agent asks anyway. The point is to check that the gateway is the thing
that says no, and that a message can never widen what a token may do.

**What the code does today.**

- The room comes from the token, never from the request. The request's own
  `project` field is deleted, and the room is taken from `token.room`. A
  message cannot move a token to another room.
- The operation allowlist is decided before anything is forwarded
  ([`ALLOWED_OPS`]), and the operations that touch the machine are refused by
  name with a reason ([`DENIED_OPS`]).
- Some dangerous work hides inside an allowed operation, so the **shape** is
  checked too ([`deniedShape`]): a forced release (`release` with
  `force: true`) and a bulk sweep of identities (`leave` with `stale`,
  `idleHours`, `prefix` or `runner`) both need a human, and the `actor` of a
  request is the gateway's business, not the caller's.
- Requests that carry a local path are refused before the broker sees them
  ([`containsLocalPath`]), and the check looks inside nested objects, not
  only at the top level. Claims inside the room are rewritten to repo-relative
  paths in both directions ([`repoRelative`]), which compares path segments,
  so `/work/application/x` is not mistaken for a file inside `/work/app`.
- **A token is bound to one identity.** The first registration through a token
  binds it to that agent id, and after that every request that names an agent
  must name that one; the gateway imposes the identity rather than trusting
  the request. A token reads its own conversations and writes as itself.
- A cloud agent may not take over a local identity: the broker refuses a
  registration whose agent id belongs to an agent that is not cloud-marked
  (`IDENTITY_TAKEOVER`), and a send whose sender is not cloud-marked is
  refused as well.
- Peer messages are ordinary room messages. Nothing in the gateway gives a
  message any authority: there is no path from a message body to an
  operation, and the message body is not interpreted at all.

**What the limits do not stop.**

- A message is not the only way to influence an agent: the cloud agent reads
  the repository, the roadmap and the task list. The gateway cannot help
  there, and the local agent's own rules decide what a peer message means.
- A token is still a grant over one room: it can broadcast to every agent in
  it, and it can read the work items, the branches and the ownership view.
  The gateway limits the *shape* of what it may do, not the *reach* of what
  it may say.
- The cloud marker is written on register and send. Other ledger writes a
  cloud agent makes (claims, task edits, handovers) leave no marker of their
  own, so the dashboard shows the agent as cloud but not the edit as cloud.

**Residual risk.** A cloud agent inside the room can write into it, and can
say anything to everyone in it.

**The one-line fix, if it ever bites.**

- Stamp the cloud marker on every operation that writes to the ledger
  (`lib/broker.mjs`).
- Give the token a per-room audience as well as an identity.

## Threat 4: room confusion across forks

**The attack.** Two checkouts of the same repository, or a fork of it, and a
cloud agent that says "github.com/org/repo" lands in the wrong room: it reads
another worktree's messages, or claims files in a checkout it is not working
in.

**What the code does today.**

- The room is resolved from the repository the cloud agent reports, matched
  against the local rooms whose checkout has the same origin
  (`lib/remote-rooms.mjs` [`resolveRoom`]). The repository name is
  normalised, so `git@github.com:org/repo.git`, `https://github.com/org/repo`
  and `github.com/org/repo` are the same.
- A linked worktree resolves: the branch comes from the worktree's own git
  directory and the origin from the common one ([`branchOf`], [`originOf`]),
  so a worktree is not invisible.
- The rules are in order: an alias the person set wins; then a checkout of the
  same repository on the requested branch; then the main checkout; then any
  checkout of it. An alias is looked up by its normalised name only, so the
  caller's raw string cannot select a room.
- The token is then bound to that one room, and the gateway takes the room
  from the token. One token, one room.
- A fork has a different origin, so it matches nothing. The person has to
  point at it by hand: `agent-relay remote room add <alias> <path>`, and the
  alias is stored as the real path, so it matches the room the broker reports.
- The room path never leaves the machine: it comes back as `.`, in the pairing
  answer as well as in every response ([`scrubPaths`]).

**What the limits do not stop.**

- A fork cannot be told apart from its upstream by repository name alone, so
  a fork agent only joins a room when an alias says so, and the alias is
  global for the data directory. One alias, one room: two forks of the same
  repository need two aliases, and the alias wins over the branch rule.
- When several worktrees share an origin and none is on the branch the cloud
  agent reports, the main checkout wins. The cloud agent is then in a
  different checkout than its own, and its claims are relative to a tree it
  cannot see. Claims travel as repo-relative paths, so both sides agree on
  the *name* and not on the *file*.
- The repository in the pairing request is chosen by the caller, so an
  attacker can ask to be placed in the room of a repository they do not have.
  Only the operator's approval stops it.

**Residual risk.** A cloud agent can end up in a room that is not the checkout
it is working in, and its claims then name files that do not exist for the
other agents.

**The one-line fix, if it ever bites.**

- Require a branch that matches a checkout, and refuse to fall back to the
  main checkout when the caller named a branch (`lib/remote-rooms.mjs`
  [`resolveRoom`]).
- Make the alias per branch, or make the alias a fallback rather than a
  first choice.

## Threat 5: the gateway's own surroundings

**The attack.** Not the endpoint: the machine around it. A misconfigured
environment, a stale link, or a resource limit turns a safe gateway into an
open one.

**What the code does today.**

- The gateway binds to loopback, so the broker is not reachable from the
  network even if the tunnel is wide open.
- An optional Cloudflare Access service token is checked with a constant-time
  comparison before anything else.
- The dashboard rides on the same URL behind its own secret, and the secret
  sits in the URL fragment, so it is not sent to the server by the browser.
  The link expires after 24 hours, `agent-relay remote dashboard --revoke`
  invalidates it, and `remote off` and `remote revoke --all` drop it
  (`lib/remote.mjs` [`remoteDashboard`], [`remoteOff`]).
- The gateway always talks to the **local** broker ([`startGateway`] uses
  `localRpc`), so a gateway started from a shell that has `AGENT_RELAY_URL` in
  its environment cannot call the relay it is serving.
- `remote off` stops the tunnel and the gateway. The tunnel providers kill the
  child they started, and the Tailscale funnel is reset with the argument-free
  form (`tailscale funnel reset`), which is the one that actually closes it.

**What the limits do not stop.**

- The dashboard's origin check accepts the loopback address and the public
  URL, so a request that arrives with a known Host is served. The secret
  still stands in front of the feeds.
- The client keeps no timeout of its own in remote mode; the gateway's 30
  second request timeout is what ends a long poll.

**Residual risk.** A dashboard link is a bearer secret for a read-only view of
one room, with a 24-hour life.

**The one-line fix, if it ever bites.**

- Put the fix command in every transport error, not only in the refused
  connection case (`lib/client.mjs`).

## The open items, in one list

These are the ones the code does not answer today.

| # | Threat | Fix, in one line |
| --- | --- | --- |
| 1 | A token holder can open unbounded long polls | Cap concurrent waits per token (`lib/gateway.mjs` [`ALLOWED_OPS`]) |
| 2 | The operator approves on trust: the request names a repository it cannot verify | Show the checkout the room resolves to at approval time (`lib/remote.mjs` [`remoteApprove`]) |
| 3 | A cloud agent can land in the wrong worktree when no checkout is on the branch it named | Refuse the main-checkout fallback when a branch was named (`lib/remote-rooms.mjs` [`resolveRoom`]) |
| 4 | An always-on token never expires | Give always-on tokens an expiry, renewed on use (`lib/gateway.mjs` [`issue`]) |
| 5 | The uncollected token value is on disk in the clear for ten minutes | Hand the value over out of band (`lib/gateway.mjs` [`TokenStore.approve`]) |
| 6 | Only register and send carry the cloud marker | Stamp the marker on every operation that writes to the ledger (`lib/broker.mjs`) |
| 7 | A token is a grant over one room, not over one conversation | Give the token a per-room audience as well as an identity |

## Closed since the first draft of this review

Each of these was an open item in the first version of this document. The fix
is in the code, and a test names it.

| Was | Now | Where |
| --- | --- | --- |
| The tunnel made every caller share one rate-limit bucket | The limit runs on the address the tunnel reports, before the token is looked up | `lib/gateway.mjs` [`createGatewayHandler`] |
| A web page could fill the approval list | A pairing request with a foreign `Origin` is refused | `lib/gateway.mjs` [`createGatewayHandler`] |
| `remote approve --yes` approved an attacker's request too | `--yes` approves one named code, and nothing without one | `bin/agent-relay.mjs` |
| The pairing code was also a bearer secret for the token | The public route looks a request up by its id only | `lib/gateway.mjs` [`findPairingById`] |
| The token value sat in the token file in plaintext until it was collected | The value waits in a separate handover file and is deleted with the pairing | `lib/gateway.mjs` [`TokenStore.approve`], [`expirePairings`] |
| `send` could name any sender, even with a prefix-scoped token | Every field that names an agent is checked, and the token is bound to one identity | `lib/gateway.mjs` [`createGatewayHandler`] |
| Free text that looked like a path was refused, and free text that *was* a path was not | The filter looks at path fields and inside nested objects, and every absolute path is scrubbed from a response | `lib/gateway.mjs` [`containsLocalPath`], [`scrubPaths`] |
| A token read the whole room, not just its own inbox | A token is bound to one identity, and the gateway imposes it | `lib/gateway.mjs` [`createGatewayHandler`] |
| The dashboard link never expired and could not be revoked | The link expires after 24 hours and `remote dashboard --revoke` invalidates it | `lib/remote.mjs` [`remoteDashboard`] |
| A gateway started with `AGENT_RELAY_URL` set called the wrong relay | The gateway always calls the local broker | `lib/gateway.mjs` [`startGateway`] |
| A burst of pairing requests could take the gateway down | Every write has a unique temporary name, the store is written under a lock, and a handler error is answered instead of thrown | `lib/gateway.mjs` [`writeJson`], [`withLock`] |
| A revocation could be undone by a write that started before it | The store merges by id and never resurrects a revoked row | `lib/gateway.mjs` [`TokenStore.save`] |
| A pairing request could carry a 200 KB repository with escape codes | Every field is bounded and stripped of control characters | `lib/gateway.mjs` [`validatePairing`] |
| The room path was handed to the cloud agent in the pairing answer | The answer says `.` | `lib/gateway.mjs` [`createGatewayHandler`] |
| A cloud agent could take over a local identity | The broker refuses a registration or a send that borrows a local identity | `lib/broker.mjs` (`IDENTITY_TAKEOVER`) |
| A binary named by the repository could be executed to run the broker | A repo-supplied path is read and reported, never executed | `lib/runtime.mjs` [`resolveNodeRuntime`] |

## How to check this review

The claims above are checkable without a tunnel and without a network.

```sh
# the token value is not in the token store, and a revocation sticks
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
  const tokens = await fs.readFile(path.join(dir, 'remote-tokens.json'), 'utf8');
  console.log('value in the token store:', tokens.includes(token.value));
  const pending = await fs.readFile(path.join(dir, 'remote-pending-tokens.json'), 'utf8');
  console.log('value in the handover file:', pending.includes(token.value));
  await gateway.close();
"
```

In a source checkout, `test/remote-e2e.test.mjs` holds the end-to-end checks:
the pairing round trip, the allowlist, the path refusal, the rate limit, the
one-identity rule and the takeover refusal. `test/remote.test.mjs` holds the
gateway's own: the scope checks, the shape checks, the merge and the lock.
The published package ships neither the tests nor the fixtures.

## What this review does not cover

- The tunnel providers themselves (Tailscale, Cloudflare, ngrok) and what
  their vendors log.
- The broker's own authorisation model for local agents, which is a different
  trust boundary: a local agent runs with the user's own rights.
- The cloud environment itself, which holds the token and decides what the
  agent may read.
