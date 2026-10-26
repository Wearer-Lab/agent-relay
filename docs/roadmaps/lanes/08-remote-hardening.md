# Lane 08 — remote-agents Phase 2 and Phase 6: the remote client tests, the end-to-end test and the threat model

Priority: p1. Labels: docs, release, tests.

Read `docs/roadmaps/remote-agents.md` (Phase 2 and Phase 6) and
`docs/roadmaps/lanes/README.md` first.

## Files you own

- a new test helper `test/support/fake-tunnel.mjs`
- a new test file `test/remote-e2e.test.mjs`
- a new document `docs/threat-model.md`
- a new module `lib/remote-host.mjs`

Do not touch `lib/gateway.mjs` (lane 07 owns it), `lib/remote.mjs`,
`lib/client.mjs`, `lib/broker.mjs`, `lib/tunnels/*`, `lib/mcp.mjs`,
`lib/opencode-plugin.mjs`, `bin/agent-relay.mjs`, `lib/dashboard*`, or any
existing test file.

## What to build

### 1. The remote-mode client tests (Phase 2)

The roadmap's open item: "a remote-mode client never spawns a broker; pairing
round trip; tools behave the same through the gateway".

- A remote-mode client (with `AGENT_RELAY_URL` set) must never start or
  discover a local broker. Assert it: no broker process, no `broker.json`, no
  data directory written.
- The pairing round trip: the cloud agent asks to pair, gets a code, waits,
  the local operator approves, the agent receives a token, and the token works.
  Use the real gateway in `lib/gateway.mjs` over a loopback port with an
  ephemeral port (never a fixed one; the parallel lanes run at the same time).
- The tools behave the same through the gateway: for a set of operations
  (`register`, `send`, `inbox`, `ack`, `wait`, `claim`, `release`, `agents`,
  `status`), the result through the gateway equals the result against a local
  broker, modulo the paths the gateway scrubs.

### 2. The end-to-end test with a fake tunnel provider (Phase 6)

- Write a fake tunnel provider in `test/support/fake-tunnel.mjs`: it implements
  the provider interface in `lib/tunnels/base.mjs` (detect, install hint,
  sign in, start, stop, status, public URL) but instead of a real tunnel it
  serves the gateway over a loopback port and hands back a URL. It must never
  touch the network and never leave a process behind.
- The end-to-end test uses it to run the whole story: start the gateway
  through the fake provider, pair, approve, send, wait, claim and revoke, and
  assert the audit log and the revocation.
- The test must run on macOS, Linux and Windows CI: no shell scripts, no
  fixed ports, no sleeps where a condition can be awaited, and a bounded
  runtime.
- Also cover the tunnel-down case: the gateway is not reachable, and the
  client error says exactly what to run to fix it.

### 3. The threat-model review (Phase 6)

Write `docs/threat-model.md`: the public endpoint as an attacker sees it.

- Public endpoint abuse: what an unauthenticated caller can do, what the rate
  limits and the pending-pairing cap actually stop, and what they do not.
- Token leakage: where a token can end up (a log, a shell history, a cloud
  environment variable, a CI log), what is stored (only a hash), and how a
  token is revoked.
- Prompt-injected agents: a message from a peer is coordination input, never
  authorization. What happens when a message asks an agent to do something the
  gateway would refuse.
- Room confusion across forks: two checkouts of the same repo, one token per
  room, and what a cloud agent can and cannot reach.
- For each threat: the mitigation that exists today, the residual risk, and
  the one-line fix if it ever bites.

Write it as a review, not as a promise. Every mitigation you claim must point
at the code that implements it (`file:line` is fine).

### 4. `agent-relay remote host` (the "later" item)

The roadmap's open item: "An always-on host, so cloud agents keep working while
this computer sleeps."

- `lib/remote-host.mjs` generates the deployment artifacts for a small
  always-on host (a VM or a container platform): the broker plus the gateway
  running as services, the tunnel on the host, and the tokens and rooms the
  same way. Produce the artifacts (a compose file, a systemd unit, a
  cloud-init snippet) and the exact steps, printed like `remote add` does.
- The local side points at the hosted relay with the same tokens and rooms: a
  client that is told about the hosted URL uses it instead of the local broker.
  The hosted relay keeps the same room names, so local agents and cloud agents
  meet in the same room.
- Do not deploy anything. This lane produces the artifacts and the steps; the
  owner runs them.
- The CLI command (`agent-relay remote host`) is lane 10's; you provide the
  module and report the exact function names and the artifact contents.

## Tests

Create `test/remote-e2e.test.mjs`. It must pass on macOS, Linux and Windows:

- the remote-mode client never spawns a broker;
- the pairing round trip works and the token is scoped to one room;
- the tools behave the same through the gateway;
- the whole story through the fake tunnel: pair, approve, send, wait, claim,
  revoke;
- the gateway refuses a local path and an operation that is not on the
  allowlist;
- the rate limit answers 429 with a `Retry-After`.

Keep the whole file under about 30 seconds.

## Report

Commit your work. Your final message lists: the files you changed, the exact
function names and artifact contents lane 10 needs for `agent-relay remote
host`, the roadmap items you finished, the threats you found that the code does
not yet answer, and anything you could not do.
