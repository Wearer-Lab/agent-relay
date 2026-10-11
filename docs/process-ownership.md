# Process and watcher ownership

Agent Relay has no shell dispatcher: every process, server, and development
watcher is started by a runner, an agent, or a person outside this package.
The broker's claims describe logical resources; they do not describe operating
system processes. This document is the bootstrap guidance for sharing a machine
without destroying each other's work.

## Stop only process trees you own, by verified identity

Before stopping any process, verify identity on all three:

1. **PID** — the exact process you started, including its child tree.
2. **Start time** — the process at that PID must have started when you started
   it. PIDs are reused; a matching PID alone proves nothing.
3. **Owner record** — who started it, with what command, in what working
   directory. Record this when the process launches, not after something goes
   wrong.

Stop only after all three match. If any is unknown, do not stop it: ask in the
relay room who owns the process and wait for its owner.

**Never run broad name-based kills.** Commands like `taskkill /F /IM node.exe`,
`pkill node`, or `killall node` match every process with that name, including
other agents' runners, benchmark jobs, and the relay broker itself. This is not
a theoretical risk: in a shared Windows development environment a subagent ran
`taskkill /F /IM node.exe` while debugging a hung test and interrupted two paid
benchmark runs and two Codex jobs. A single broad command destroyed hours of
unrelated, billable work.

Practical rules:

- When you start a long-lived process, record PID, start time, command line,
  working directory, and your relay agent ID before continuing.
- To stop your own process tree, stop the recorded PIDs (children first), then
  verify each one's start time still matches your record before signaling it.
- A hung test is not an emergency that justifies a broad kill. Kill the exact
  test process you spawned; if you cannot identify it, leave it and report it.
- The relay broker is a shared `node` process. Stopping it stops every project
  room on that data directory.

## Development watchers that publish on save

A watcher that publishes, deploys, or syncs on file save is a deployment actor,
not a convenience. Before running one:

- Keep an explicit ownership record: owner agent ID or person, the exact
  command, the watched checkout, and the deployment target.
- Record deployment provenance: the source checkout and the exact revision
  (commit) it serves. Run a watcher only from a reviewed checkout at a known
  revision; do not point one at a dirty or unreviewed tree.
- A stale watcher is dangerous: one running from an older uncommitted tree can
  overwrite a reviewed deployment with its next save. Before any landing or
  deployment that the watcher could touch, confirm its checkout matches the
  reviewed revision — or stop it first, by verified identity, through its owner.
- If you did not start the watcher, you do not stop it. Ask in the relay room
  for its owner.

## Ownership records

Structured, owner-reported process and watcher records (with liveness
verification and PID-reuse protection) are a planned, near-term relay addition.
Until they exist, keep the records above in your own session notes and the relay
room, and follow the rules here regardless. When they arrive, note these
semantics: a process record is coordination information only — it never
authorizes another agent to kill the process, and deleting a record does not
stop the process.

Process and watcher rules that every session in a project must follow belong in
that project's policy bulletin (see [the README](../README.md)); broadcast
messages do not reach sessions that join later.
