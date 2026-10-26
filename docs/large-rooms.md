# Large rooms

A large room is a project where several lanes work at once. The relay is a coordination
channel, not a bus. Every broadcast you do not need is a row somebody has to clean up later.

Use this page when more than three lanes share one room, or when a room has more than a
hundred stored identities.

## Before the first lane starts

### One identity per role

A role is a name, not a session. Give each role a stable id and export it before the runner
starts:

```sh
export AGENT_RELAY_AGENT_ID=reviewer
agent-relay join --as "$AGENT_RELAY_AGENT_ID" --runner codex
```

`AGENT_RELAY_AGENT_ID` (or `--as` on `agent-relay mcp`) wins over the session id, so a pooled
worker reuses `codex-worker-3` instead of minting an identity per thread. Without it the id is
`<runner>-<session>`, and every restart leaves another identity in the room.

Precedence: `--as`, then `AGENT_RELAY_AGENT_ID`, then `<runner>-<session>`.

### Probes are ephemeral

A probe checks something and goes away. Register it as ephemeral so it leaves on its own:

```sh
agent-relay join --as probe-1 --runner other --ephemeral
# or: AGENT_RELAY_EPHEMERAL=1 agent-relay join --as probe-1 --runner other
```

An ephemeral identity leaves when its session ends and it is idle. It stays registered while it
holds a claim, a handoff, a process record or an open task, so nothing is stranded.

A fresh ephemeral identity is also skipped by `*` broadcasts: it has one minute to prove it is
there. Do not use an ephemeral id for a lane that has to hear a broadcast.

### The bulletin holds the standing rules

Rules that apply to every lane belong in the bulletin, not in a message:

```sh
agent-relay bulletin --set --title "Release rules" --body "..." --source POLICY.md --as lead
agent-relay bulletin                                              # read the current version
agent-relay bulletin --ack --as "$AGENT_RELAY_AGENT_ID" --version 3 --hash HASH
```

The bulletin is versioned and hashed, and every lane acknowledges the exact version it read. A
lane that joins later reads the current version instead of replaying chat.

## While the lanes work

### Address the lane you mean

A direct send reaches one lane. A task gives one lane one piece of work. A broadcast reaches
everybody and is the most expensive thing in the room.

```sh
# one lane
agent-relay send --as "$AGENT_RELAY_AGENT_ID" --to reviewer --message "Rebase on main, then re-run the tests"

# one lane, one piece of work, with a blocker
agent-relay task-upsert --as "$AGENT_RELAY_AGENT_ID" --title "Re-run the schema 2 tests" \
  --owner reviewer --blocked-by schema-2-merged
```

Prefer a task over a message when the work has an owner and a finish line. The task tree keeps
the state; the message only carries the news.

### `*` and `*all`

| Audience | Reaches | Cost |
| --- | --- | --- |
| `*` | live agents only (connected, or seen within `--within MIN`, default 120) | one row per recipient |
| `*all` | every agent that has not left | one row per recipient, and it is rate limited |

`--to '*all'` is limited to five broadcasts per hour per sender. The broker refuses the sixth
with `BROADCAST_ALL_RATE_LIMIT` and says so:

```
'*all' broadcast limit reached (5 per hour per sender). Use a bulletin for standing rules, or address the agents you mean directly.
```

The budget comes back on its own when the hour passes. Use `*all` for a genuine room-wide
announcement, once. For anything else, address the lanes directly.

A `*` broadcast that reaches nobody fails with `NO_RECIPIENTS` and reports how many agents were
skipped. Widen `--within MIN` or use `*all` only if you really mean everybody.

## End of lane

Run this list in order. The order matters: the report goes out before you leave, because a
left identity still receives direct messages, but a lane that has left cannot be woken by a
broadcast.

1. **Send the final report.** The orchestrator needs the result, not the lane's silence.

   ```sh
   agent-relay send --as "$AGENT_RELAY_AGENT_ID" --to "$ORCHESTRATOR" \
     --summary "lane done" --message "What changed, what did not, what the next lane must know"
   ```

2. **Read the inbox and ack it.** Reading is not acknowledgement.

   ```sh
   agent-relay inbox --as "$AGENT_RELAY_AGENT_ID" --unread
   agent-relay ack --as "$AGENT_RELAY_AGENT_ID" --all
   ```

   Ack only as yourself. An ack for an identity you do not run is a false receipt; see the
   [trust model](trust-model.md).

3. **Close or hand over the open tasks.** A task that is still open keeps your identity
   addressable and keeps the message it came from out of the archive.

   ```sh
   agent-relay task-complete --as "$AGENT_RELAY_AGENT_ID" --id TASK_ID --verification "what proves it is done"
   agent-relay handoff-request --as "$AGENT_RELAY_AGENT_ID" --to "$ORCHESTRATOR" \
     --reason "owner is gone" src/module.js
   ```

   The holder keeps the resources until the recipient accepts
   (`agent-relay handoff-respond --as ID --id HANDOFF_ID --accept`).

4. **Release the claims and the branch claims.**

   ```sh
   agent-relay release --as "$AGENT_RELAY_AGENT_ID" src/module.js build
   agent-relay branch release feature/auth --as "$AGENT_RELAY_AGENT_ID"
   ```

5. **Leave.** The MCP tool is `relay_leave`. From the CLI:

   ```sh
   agent-relay leave --as "$AGENT_RELAY_AGENT_ID"
   ```

   Leaving keeps the history resolvable. Registering again reactivates the identity.

## The orchestrator's cleanup step

The orchestrator owns the ids it created. In the same step where it removes the worktree and
the branch, it leaves every lane id it handed out:

```sh
for ID in "$LANE_A" "$LANE_B" "$LANE_C"; do
  agent-relay leave --as "$ID" --if-idle
done
```

`--if-idle` refuses to leave an identity that still holds work. It answers
`{"left": false, "kept": true, "obligations": {...}}` and names the claims, handoffs, process
records and open tasks it found. Resolve those first, then leave again.

`--if-idle` is the same guard the ephemeral close uses, so a lane that forgot to release
something is kept instead of being stranded.

## Weekly hygiene

Three read-only commands. Run them once a week, on the machine that owns the data directory.

```sh
agent-relay pending --by state
agent-relay prune
agent-relay compact --older-than-days 14
```

| Command | What it answers |
| --- | --- |
| `pending --by state` | how many deliveries a live agent can still read, and how many wait for a dormant or retired identity |
| `prune` | which identities are idle, disconnected and hold nothing, and would be swept |
| `compact` (dry run) | how many finished messages would move to the archive, and who still pins them |

`prune` and `compact` are dry runs until you add `--apply`. The broker also sweeps on its own
every ten minutes (default: 24 hours idle, 15 minutes for ephemeral identities).

For a room that is already stuck, use the [runbook](runbook-backlog.md) instead.
