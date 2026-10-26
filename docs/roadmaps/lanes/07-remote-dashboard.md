# Lane 07 — remote-agents Phase 5: the dashboard over the same public URL

Priority: p1. Labels: dashboard.

Read `docs/roadmaps/remote-agents.md` (Phase 5) and `docs/roadmaps/lanes/README.md`
first.

## Files you own

- `lib/dashboard.mjs`
- `lib/dashboard/index.html`
- `lib/dashboard/assets/dashboard.js`, `lib/dashboard/assets/dashboard.css`,
  `lib/dashboard/assets/model.js` (the other asset files are shared, leave them
  alone)
- `lib/gateway.mjs`
- a new test file `test/remote-dashboard.test.mjs`

Do not touch `lib/broker.mjs`, `lib/registry.mjs`, `lib/observability.mjs`,
`lib/client.mjs`, `lib/remote.mjs`, `lib/remote-rooms.mjs`, `lib/tunnels/*`,
`lib/mcp.mjs`, `lib/opencode-plugin.mjs`, `bin/agent-relay.mjs`, or any
existing test file.

## What to build

### 1. Mark the cloud agents

A cloud agent that joined through the gateway must look different from a local
one, so a person reading the dashboard knows who is actually on the other side
of the tunnel.

- Mark cloud agents in the Strips (the agent cards) and in the Radio log (the
  message stream) with a runner badge and a "via gateway" marker.
- The dashboard runs against the local broker, so the broker's agent rows and
  message rows must carry the information the dashboard needs. The gateway
  knows the token's runner and prefix; the gateway is the only place that
  knows a request came through it. Work out the cleanest way to carry that
  from the gateway to the broker (the gateway already rewrites the room and
  scrubs paths; the runner and the agent-id prefix are safe to carry) and
  implement it. Keep the change inside the files you own; if it needs a broker
  field that only lane 01 or lane 03 can add, report the exact field name and
  shape instead of inventing a second mechanism.
- The badge must degrade: a local agent shows no badge, and an agent row that
  predates the feature must render as before.

### 2. Pending pairing requests in the Tower view

- The Tower view (the overview) shows the pairing requests that are waiting
  for a human, read-only. The gateway's token store already keeps them
  (`TokenStore.pendingPairings()` in `lib/gateway.mjs`).
- The Tower view must show them without letting the dashboard approve or deny
  anything: the dashboard is read-only everywhere.
- The local dashboard (not behind a tunnel) has no gateway; it must show
  nothing, or a clear "not running a gateway" note, and never fail.
- The requests expire after 10 minutes, so the view must not keep a stale one
  on screen: refresh it with the rest of the tower.

### 3. The honest counts in the Tower and the Strips

Lane 03 is adding the split of pending deliveries (awaiting live, held for
dormant, held for retired, expired) to the `snapshot` and `usage` ops, and
per-agent pending counts. The dashboard must show them.

- The fields lane 03 adds are not in your branch. Render them defensively:
  when they are missing, fall back to today's view, and never show `undefined`.
  Report the exact field names you render so the orchestrator can check they
  match lane 03's.
- The headline becomes "Awaiting live agents"; the other groups are secondary
  figures with a tooltip that explains why a durable inbox is not a bug.
- The per-agent pending counts in the Strips use the same split.

## Tests

Create `test/remote-dashboard.test.mjs`:

- a cloud agent row renders a runner badge and the "via gateway" marker, and a
  local agent does not;
- the Radio log marks a message that came through the gateway;
- the Tower view lists the pending pairing requests, read-only: no approve, no
  deny, no mutation of the token store;
- the local dashboard without a gateway renders without the pairing panel and
  does not fail;
- the tower shows the four pending groups when they are present and falls back
  to the old single number when they are not.

The dashboard tests use the in-repo DOM harness (`test/dashboard-dom.mjs`) and
`test/dashboard-views.test.mjs`. Follow those two files for the house style.

## Report

Commit your work. Your final message lists: the files you changed, the exact
field names the dashboard renders for the cloud marker and for the pending
split, any broker field you need lane 01 or lane 03 to add (with the exact
name and shape), the roadmap items you finished, and anything you could not do.
