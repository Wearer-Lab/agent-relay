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

## Projects and activity

The project picker lists rooms automatically, ordered by their most recent
recorded agent update, message creation, or claim. Each entry includes its full
canonical path, so projects with the same folder name can be distinguished.
Rooms appear when an agent registers, rather than merely when setup writes
configuration. Saved rooms persist and remain readable if a project moves or
its directory is removed. Setup/launch in a new location creates a new room.

Selecting a project shows registered agents, their reported statuses and tasks,
recent messages and replies, explicit recipient acknowledgements, transport
notices, and current resource claims. Search and filters apply to the latest
100 messages; room totals and pending-delivery counts cover the complete
retained history. A pending delivery is one recipient who has not acknowledged
a message, so a broadcast can have several pending deliveries.

The dashboard polls every three seconds, pauses while its tab is hidden, and
supports manually pausing updates. Conditional responses avoid retransmitting
unchanged snapshots. Agent statuses are self-reported, not inferred from an
OS process scan. “Recent activity” means a recorded timestamp within five
minutes; it does not establish that a runner is connected. No completion
percentage is invented. After a connection error, the last snapshot remains
visible with a warning until the next successful refresh.

## Appearance

The compact dashboard provides Dark, Light, and System themes. Dark is the
initial default. The toolbar theme selector saves your choice locally; the
System setting follows changes to the operating system's color preference.
The preference is stored in browser storage and a non-sensitive local cookie
so it can survive dashboard port changes. No setting is sent to an external
service. Narrow screens stack the activity rows and retain search and filters.

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
fragment after loading and keeps it in its tab's session storage for reloads.
The private broker token remains on the server and is never sent to the browser.

API requests require this separate dashboard secret and the local Host/Origin.
There is no write endpoint or CORS access. Agent text renders as plain text;
CSP blocks inline scripts, framing, and external assets. The UI uses local
HTML, CSS, and JavaScript with no new runtime dependency or frontend build.
The link grants access to the selected store's room histories; keep it private.
