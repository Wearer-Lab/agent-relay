# Lane 05 — ack-backlog Phase 4: fewer identities

Priority: p1. Labels: registry, adapters.

Read `docs/roadmaps/ack-backlog.md` Phase 4 and `docs/roadmaps/lanes/README.md`
first.

## Files you own

- a new module `lib/registration.mjs`
- `lib/mcp.mjs`
- `lib/opencode-plugin.mjs`
- `lib/broker.mjs`, only these parts: the `register` op and the `send` op.
- a new test file `test/ack-registration.test.mjs`

Do not touch `lib/registry.mjs`, `lib/compaction.mjs`, `lib/client.mjs`,
`bin/agent-relay.mjs`, `lib/dashboard*`, `lib/gateway.mjs`, `lib/ledger.mjs`,
or any existing test file. Lane 10 wires the CLI, the MCP tools and the
OpenCode tools later, so do not add new tools: change how the existing ones
register.

## What to build

### 1. Lazy registration

Short-lived processes must not become permanent identities.

- The MCP adapter (`lib/mcp.mjs`) and the OpenCode plugin
  (`lib/opencode-plugin.mjs`) register on the first relay tool call or the
  first watch start, not when the process launches.
- A process that never touches the relay creates no identity at all. Today a
  `codex-tmp-*` identity is registered at startup and left behind, which is
  where the 658 sub-minute registrations came from.
- The adapters already have a `register` path and a `registered` promise
  (`lib/opencode-plugin.mjs`) and a `registeredOnce` flag (`lib/mcp.mjs`).
  Move the registration to the first use, keep the re-registration on
  `UNKNOWN_AGENT`, and keep the ephemeral leave-on-close behaviour.
- The identity a process uses must not change when registration is deferred:
  `relay_agents`, the inbox and the plugin's own state all key on the agent id.

### 2. Reuse a session's identity

- One identity per runner session id. A second process with the same session id
  attaches to the existing identity instead of creating a tmp one. Today the
  MCP adapter derives `agentId` from `runner` plus `sessionId`, and the plugin
  derives `opencode:<sessionID>`; make the broker agree with one rule and put
  that rule in `lib/registration.mjs` so both adapters and the broker share it.
- Fallback tmp identities persist their id in the data dir per parent process
  tree for the session lifetime, so a restart inside the same session reuses
  it instead of leaving another identity behind. `lib/registration.mjs` is
  where that file lives (it needs the data dir, so the helper takes it as an
  argument).

### 3. Broadcast audience guard

- Never fan a `*` broadcast to identities registered less than a minute ago
  with no transport report. A probe that just registered has not proved it is
  there. Use the `registeredAt` timestamp and `transport` from the agent row.
- Rate-limit `*all` per sender (for example 5 an hour) with a clear error that
  suggests a bulletin instead. The error code and message must be stable; the
  CLI and the MCP tool show them verbatim.
- `*all` is a deliberate, expensive operation. The limit is per sender, per
  hour, and it recovers on its own.

## Tests

Create `test/ack-registration.test.mjs`:

- an adapter that starts and exits without a tool call leaves no record
  (the MCP adapter and the OpenCode plugin, both);
- two MCP processes of one session share an identity;
- a restart within the session reuses the identity;
- a fresh probe identity is excluded from a `*` broadcast;
- the `*all` limit triggers and then recovers;
- the `*all` error message suggests a bulletin.

`lib/mcp.mjs` and `lib/opencode-plugin.mjs` are tested with the in-memory MCP
transport in `test/mcp.test.mjs` and `test/opencode-plugin.test.mjs`. Follow
those files for the house style; do not edit them.

## Report

Commit your work. Your final message lists: the files you changed, the exact
identity rule (the function name and signature in `lib/registration.mjs`), the
new error code and message for the `*all` limit, the feature name the
orchestrator must add to the capability list, the roadmap items you finished,
and anything you could not do.
