# Lane 04 — ack-backlog Phase 3: cleanup tools for operators and lanes

Priority: p1. Labels: cli, hygiene.

Read `docs/roadmaps/ack-backlog.md` Phase 3 and `docs/roadmaps/lanes/README.md`
(the shared foundation, the operation contract and the rules) first.

## Files you own

- a new module `lib/bulk.mjs`
- `lib/broker.mjs`, only these parts: the `leave` op, the `retire` op, the
  `blocked` op and a new `staleClaims` op.
- `docs/registry.md`
- a new test file `test/ack-bulk.test.mjs`

Do not touch `lib/registry.mjs`, `lib/compaction.mjs`, `lib/client.mjs`,
`lib/mcp.mjs`, `lib/opencode-plugin.mjs`, `bin/agent-relay.mjs`,
`lib/dashboard*`, `lib/gateway.mjs`, `lib/ledger.mjs`, or any existing test
file.

## What to build

### 1. Bulk stale cleanup

Safe, bulk, dry-run-first commands, so an owner never has to script against the
ledger.

```
op 'leave' and op 'retire', bulk form
input : {stale?: true, idleHours?: number, prefix?: string, runner?: string, apply?: boolean}
output: {dryRun, candidates: [{agentId, runner, lastSeenAgeMs}],
         kept: [{agentId, obligations}], skippedLive: [agentId], changed: number}
```

- A dry run by default; `--apply` (the `apply` field) changes something. The
  CLI flags come later, in lane 10; you add the broker fields.
- Scope by id prefix (`claude-tmp-`) and by runner.
- Report candidates, kept-with-obligations (and what they hold) and
  skipped-live. An identity that holds a claim, a task, a handoff, a process
  record or a branch claim is never stranded: it is reported as kept, with the
  obligations listed.
- Use the existing obligation set (`obligationIndex` in `lib/registry.mjs`) so
  prune, the sweep and this command agree on what an obligation is.

### 2. Every bulk action is audited

A bulk action is recorded in an audit log with who ran it and which ids
changed. The gateway already has an audit log for cloud agents
(`lib/gateway.mjs`); this one is for the local operator's bulk actions. Put it
in the data directory, keep it bounded and rotated, and never write a token or
a secret into it.

### 3. Stale claims, surfaced and optionally released

- List stale claims (owner left, retired, or idle past a window) with the age
  and the owner's state. The new `staleClaims` op returns
  `{claims: [{resource, agentId, scope, ageMs, lastSeenAgeMs, holder}]}`.
  The same list appears in the `blocked` view.
- Opt-in auto-release: a daemon option `--release-stale-claims-hours N`, off by
  default, that releases claims only for owners that are dormant or retired,
  writes a release-log entry, and notices the room. Claims held by live owners
  are never released. The daemon flag itself is a CLI concern (lane 10); you
  add the `createBroker` option and the behaviour, in the parts of
  `lib/broker.mjs` you own.

### 4. Own-backlog acknowledgement, documented

Document the "mark my backlog read" flow in `docs/registry.md`: `ack --as ME
--all` and `--through CURSOR`, and that acking for an identity you do not run
creates a false receipt. Also state the trust model plainly: agent ids are
cooperative identities, the broker token is the boundary on a single-user
machine, so `leave --as` and `ack --as` work for any known id.

The `relay_inbox` hint when an agent's backlog is larger than one page is a
surface change (lane 10 owns `lib/mcp.mjs`); describe the exact text in your
report so lane 10 can add it.

## Tests

Create `test/ack-bulk.test.mjs`:

- obligations are never stranded: an identity holding a claim is reported as
  kept and stays active;
- a dry run changes nothing (the ledger is byte-identical afterwards);
- `--apply` matches the dry run exactly (same candidate list, same result);
- scope by prefix and by runner works;
- the audit log records who ran the bulk action and which ids changed;
- claims held by live owners are never released; a dormant owner's claim is
  released only with the opt-in, and the release is logged.

## Report

Commit your work. Your final message lists: the files you changed, the exact
new broker fields and the new `createBroker` option, the audit-log path and
format, the inbox hint text lane 10 should use, the feature name the
orchestrator must add to the capability list, the roadmap items you finished,
and anything you could not do.
