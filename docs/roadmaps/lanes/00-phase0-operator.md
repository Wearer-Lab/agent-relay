# Lane 00 — Phase 0: clean the reported room now

Priority: p0. Labels: operations, urgent.

You are the operator for the live room described in `docs/roadmaps/ack-backlog.md`.
The room is real: it lives in the data directory on this machine and holds about
166,526 pending deliveries. The owner has explicitly approved the full cleanup,
including the mutating commands. Your job is to run it safely and write down
exactly what you did and what it changed.

Read `docs/roadmaps/ack-backlog.md` (Phase 0) and `docs/registry.md` first.

## Where the data lives

The default data directory is `agent-relay defaultDataDir()`:

- macOS: `~/Library/Application Support/agent-relay`
- Linux: `$XDG_DATA_HOME/agent-relay` or `~/.local/share/agent-relay`
- Windows: `%LOCALAPPDATA%\agent-relay`

`AGENT_RELAY_HOME` overrides it. Find the real one before doing anything:

```sh
node -e "import('./lib/client.mjs').then(m=>console.log(m.defaultDataDir()))"
```

The ledger is `state.json` in that directory. The CLI is `node bin/agent-relay.mjs`
(run it from the repo root; pass `--data-dir <dir>` explicitly for every call).

## Do this, in this order

1. **Stop the broker** if one is running (`agent-relay stop`), and confirm with
   `agent-relay doctor` that no broker owns the directory. Never mutate the
   ledger while a broker is writing it.
2. **Back up** `state.json` next to it with mode 600
   (`cp` then `chmod 600`), and also copy `archive/` if it exists. Record the
   exact paths and sizes.
3. **Measure before**: `agent-relay usage`, and the pending figure for the room.
   The investigation expects about 166,526 pending deliveries, 1,971 identities
   (29 live), 6,824 messages and 1,971 stored identities. Record the real
   numbers you find; if they differ wildly from the investigation, say so
   loudly in the report and stop before mutating.
4. **Dry runs only first**: `agent-relay prune` and `agent-relay compact
   --older-than-days 3` (both are dry runs by default). Record the counts.
5. **List the idle identities**: `agent-relay agents --json` and pick the
   non-left identities idle for more than 24 hours (the investigation says 28).
   For every one of them that still reports `transport.state = connected`,
   check whether a matching Claude/Codex/MCP process is actually running on
   this machine (`ps aux | grep -i -e claude -e codex`) before treating it as
   gone. Note the evidence for each decision.
6. **Leave the confirmed-gone identities**: `agent-relay leave --as <id>
   --if-idle`. For the identities that still hold obligations (the investigation
   says six), do NOT leave them: report who holds what (claims, tasks, handoffs,
   branch claims) so the owner can resolve or hand it over first.
7. **Compact**: `agent-relay compact --older-than-days 3 --apply`, then
   optionally `agent-relay compact --drop-identities --apply`.
8. **Measure after** and record the before/after pending figure. The
   investigation expects about 166,526 to drop to roughly 7,400.
9. **Restart the broker** if you stopped it (`agent-relay start`) and confirm
   `agent-relay doctor` is healthy.

## Rules

- This lane changes no source file. The only file you create is your report.
- If a step fails, stop, record the exact error, and continue with the next
  independent step. Never retry a mutation blindly.
- Never delete `state.json` or the archive. The cleanup is reversible because
  the archives stay on disk.
- Do not touch the real room's identities that are live (seen recently) or that
  hold obligations.

## Report

Write `docs/roadmaps/reports/phase0-operator.md` with:

- the data directory and the backup paths,
- the before/after numbers (pending deliveries, identities, live identities,
  messages),
- the exact list of identities you left, with the evidence that they were gone,
- the identities you left alone because they hold obligations, and what they
  hold,
- the dry-run output of prune and compact before you applied anything,
- anything that surprised you, and what is still outstanding for the owner
  (the remaining backlog, the obligations, the ack of the live agents' own
  backlogs).

Your final message is a summary: the before/after numbers, what you did, what
is left, and anything you refused to do.
