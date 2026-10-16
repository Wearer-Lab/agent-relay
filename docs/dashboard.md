# Local activity dashboard

Start one view of all project rooms:

```sh
agent-relay dashboard
# Without a global installation:
npx --yes @wearer-haitch/agent-relay dashboard
```

The command discovers the existing local broker through its private discovery
file, checks its health, and reuses it. If no broker is running, it starts the
usual broker on demand. The broker is a background process, not one process per
project. No operating-system service installation is needed.

The dashboard runs in the foreground and opens the default browser. Use
`--no-open` for a printed link, `--port PORT` for a chosen local port, and
Ctrl+C to stop the dashboard. Agent sessions and the broker continue running.
A permanent npm installation is optional.

## The tower

The dashboard is an air traffic control room for a fleet of coding agents.
Agents are flight strips, branches are runways, messages are the radio log, and
the roadmap is the flight plan. It is strictly read-only: it never sends a
message, claims a resource, changes a status, or acknowledges anything.

| Key | View | What it shows |
| --- | --- | --- |
| `1` | **Tower** | Fleet health at a glance: agents on the air versus identities stored, pending acknowledgements, claims, branch conflicts, roadmap progress, a registry hygiene bar, a "needs attention" board and the latest transmissions. |
| `2` | **Plan** (flight plan) | The roadmap tree (roadmap, phase, epic, task, todo) with rolled-up progress, a lanes (kanban) layout, and filters for status, owner, branch, label and text. |
| `3` | **Runways** | Branch ownership: who holds each branch, which agents and tasks are attached, and prominent `contested`, `missing`, `orphaned` and `unclaimed` flags. |
| `4` | **Strips** | Every agent as a strip: live, idle or dormant, reported status and task, transport, pending acknowledgements and claims. A switch shows only live agents. |
| `5` | **Radio** | The conversation: threads, per-recipient receipts, search, an unacknowledged filter and paging back through older history. |
| `6` | **Claims** | Claimed files and shared resources, with stale holders marked. |

Press `/` to jump to message search, `p` to pause or resume updates, and `1`
to `6` to switch views. The current view is kept in a `?view=` query
parameter, so reloads and browser Back and Forward work. The access secret is
never placed in the URL path or query; see Access below.

Select a project room from the **Frequency** menu in the header. Rooms are
listed by their most recent recorded agent update, message or claim, each with
its full canonical path so projects with the same folder name can be
distinguished. Rooms appear when an agent registers, rather than merely when
setup writes configuration. Saved rooms persist and remain readable if a
project moves or its directory is removed.

## Registry hygiene

A broker can hold far more identities than agents that are actually running.
The tower makes that visible: the gauge counts agents on the air, and the
registry bar splits the stored identities into live, dormant, ephemeral and
retired, with a callout for identities that could be pruned. When the broker
reports a registry (`registry: {stored, live, dormant, retired, ephemeral,
prunable}` on the snapshot), those figures are used. Otherwise the dashboard
falls back to the broker's storage usage report, and failing that to the
agents in the selected room, and says which source it used.

**Live** means the broker reports the agent as live (`live: true`). For brokers
that do not report liveness, an agent counts as live when its transport is
connected or it was updated in the last five minutes. **Idle** means not live
but heard from within the hour; **dormant** is everything older. None of this
is a verified process scan: statuses and tasks are self-reported.

## Optional data and older brokers

The flight plan, runway ownership and storage headroom depend on broker
operations that older brokers do not have. The dashboard feature-detects each
one and degrades with a clear "not available on this broker" state rather than
an error:

| Endpoint | Broker operation | Fallback |
| --- | --- | --- |
| `GET /api/work?project=…` | `tasks` with `action: "tree"` | The flat task ledger (`action: "list"`) rendered as one root per task and marked as an older broker; `{available: false}` if neither works. |
| `GET /api/ownership?project=…` | `ownership` | `{available: false}`. |
| `GET /api/usage?project=…` | `usage` | `{available: false}`. |

All three are authenticated, GET-only, project-scoped and support `ETag`
conditional requests like the snapshot (a changing `generatedAt` does not
defeat them). A broker that is too old for any of these is left running and
untouched.

## Activity and polling

Selecting a project shows registered agents, their reported statuses and tasks,
recent messages and replies, explicit recipient acknowledgements, transport
notices, and current resource claims. Search and filters apply to the loaded
message window (the latest 100 messages, plus any older pages you load); room
totals and pending-delivery counts cover the complete retained history. A
pending delivery is one recipient who has not acknowledged a message, so a
broadcast can have several pending deliveries.

The dashboard polls every three seconds, pauses while its tab is hidden, and
supports manually pausing updates. Conditional responses avoid retransmitting
unchanged data, and an unchanged poll rebuilds nothing, so controls are never
replaced under the pointer. Optional feeds that a broker lacks are retried only
occasionally. After a connection error, the last snapshot remains visible with
a warning until the next successful refresh.

## Appearance

The dashboard provides Dark ("night tower": phosphor on slate green), Light
("day tower": strip paper and grease-pencil ink), and System themes. Dark is
the initial default. The header theme selector saves your choice locally; the
System setting follows changes to the operating system's color preference. The
preference is stored in browser storage and a non-sensitive local cookie so it
can survive dashboard port changes. No setting is sent to an external service.

Fonts are local stacks only (nothing is downloaded): a condensed display face,
a monospaced face for callsigns and data, and a serif for message prose. Load
animations run once per view and never replay on polling. They, and every
transition, are disabled when the system asks for reduced motion. Everything
is keyboard accessible, and the layout works down to 375 pixels wide: the view
switcher becomes a bottom bar and tables and strips restack, with no horizontal
page scroll.

## Storage and compatibility

Default installations use one shared broker and one storage directory for all
projects. `AGENT_RELAY_HOME` and `--data-dir PATH` select a different, isolated
broker/store. The dashboard observes all rooms in the selected store; it does
not scan arbitrary directories, access remote computers, or merge intentionally
isolated stores.

New brokers provide authenticated, read-only `rooms` and `snapshot` RPCs.
These reads do not create rooms, register dashboard agents, update statuses,
claim resources, or acknowledge messages. Snapshots are bounded to at most
200 messages; the dashboard requests 100.

For an older running broker lacking these operations, the dashboard reads the
atomically committed `state.json` file from the selected data directory. It
validates that ledger and caches it until its file identity changes. It never
acquires a writer lease, rewrites the ledger, or restarts the older broker.
Broker health is still checked before showing the project list.

## Access

The server listens only on `127.0.0.1`. The CLI prints a per-dashboard link with
a random read-only access secret in its URL fragment. The browser removes the
fragment after loading and keeps it in its tab's session storage for reloads;
view selection uses a separate query parameter and never touches the secret.
The private broker token remains on the server and is never sent to the browser.

API requests require this separate dashboard secret and the local Host/Origin.
There is no write endpoint or CORS access. Agent text renders as plain text;
CSP (`default-src 'none'; script-src 'self'; style-src 'self'; connect-src
'self'`) blocks inline scripts and styles, framing, and external assets. The UI
uses local HTML, CSS, and JavaScript with no new runtime dependency or frontend
build. The link grants access to the selected store's room histories; keep it
private.

## Previewing the design

`scripts/dashboard-fixture.mjs` starts a throwaway broker in a temporary data
directory, registers a small fleet, sends messages, creates claims and (when the
broker supports them) work items, then serves the dashboard and prints its link:

```sh
node scripts/dashboard-fixture.mjs [--mock] [--port N] [--open] [--keep]
```

`--mock` overlays synthetic roadmap, branch ownership, registry and liveness
data, which previews every view even on a broker that cannot report them yet.
The temporary directory is removed on Ctrl+C unless `--keep` is given.
