# Lane 09 — ack-backlog Phase 7: docs and guidance for agent teams

Priority: p1. Labels: docs.

Read `docs/roadmaps/ack-backlog.md` Phase 7 and `docs/roadmaps/lanes/README.md`
first. This lane runs **after** the code lanes, so the behaviour you describe
is the behaviour that shipped.

## Files you own

- `README.md`
- `CHANGELOG.md`
- a new page `docs/large-rooms.md`
- a new page `docs/runbook-backlog.md`
- a new page `docs/trust-model.md`

Do not touch any other file, and never touch the roadmap markdown.

## What to write

### 1. A best-practices page for large rooms (`docs/large-rooms.md`)

- A stable `AGENT_RELAY_AGENT_ID` per role.
- `--ephemeral` for probes.
- Direct sends or tasks instead of broadcasts for named lanes.
- Bulletins for standing rules.
- `*all` only rarely (it is rate limited now).
- `relay_leave` at the end of every lane.
- An end-of-lane checklist: final report sent, inbox acked, open tasks
  completed or handed off, claims and branch claims released or handed off,
  then `relay_leave`.
- Orchestrators run `leave --if-idle` for every lane id they created, in the
  same step as the worktree and branch cleanup.
- A weekly hygiene check (`pending`, `prune` and `compact` dry runs).

Write it as instructions someone follows at 2 a.m., not as prose.

### 2. A one-page runbook for a stuck backlog (`docs/runbook-backlog.md`)

- Diagnose with `pending` and `compact` dry runs.
- Clean with `leave --stale`.
- Archive with `compact`.
- What each step prints, what "safe to do" means, and when to stop.

### 3. The trust model (`docs/trust-model.md`)

Explain plainly:

- acks and agent ids are cooperative: the broker token is the trust boundary on
  a single-user machine;
- `leave --as` and `ack --as` work for any known id, and why that is a
  deliberate design choice, not a hole;
- acking for an identity you do not run creates a false receipt, and what that
  costs;
- the stale-claim policy: stale claims are surfaced by default, auto-release is
  opt-in for dormant or retired owners only, and every release is audited.

### 4. The README and the changelog

- `README.md`: add the new commands (`pending`, `leave --stale`,
  `retire --stale`, `migrate --to 2`) and point at the three new pages. Keep it
  the same voice and the same length discipline; do not rewrite the whole file.
- `CHANGELOG.md`: one entry for this release, with the before and after
  numbers from the reported room (the Phase 0 report is at
  `docs/roadmaps/reports/phase0-operator.md`; read it for the real numbers and
  quote them). If the report is not there yet, say so in your report and write
  the entry without the numbers.

## Rules

- The docs must match the code. Check every command you document against the
  CLI's actual `--help` output and the actual flags.
- No marketing language, no "we are excited". The house style is short
  sentences and exact commands.
- Do not invent flags. If a command does not exist yet, either leave it out or
  mark it as coming, and say so in your report.

## Report

Commit your work. Your final message lists: the files you wrote, the before and
after numbers you quoted, every command you documented (so the orchestrator can
check them against the CLI), anything you could not verify, and anything you
found that the code does not do yet.
