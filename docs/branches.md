# Branch ownership

Rooms are keyed by checkout path, so a repo with several worktrees has several rooms and no single answer to "who owns which branch". Branch ownership adds that answer: repo-scoped branch claims, an optional per-agent git report, and a read-only ownership view that joins git, claims, agents and tasks.

Capabilities: `branch-claims`, `ownership`, `git-context`. Clients check them before sending the new ops or fields, so an older broker refuses with `UNSUPPORTED_FEATURE` and nothing is submitted.

## Branch claims

A branch claim is a coordination record, not git protection. Nothing stops a checkout or push; it tells other agents (and humans) who is responsible for a branch.

Claims are scoped to a repo: the git common dir of the claiming room (`git rev-parse --git-common-dir`), so every worktree room of one repo shares one claim namespace. Outside git the room's project path is the scope. The same branch name in two repos never conflicts.

Stored in `state.branchClaims`, bounded by the same limit as path claims (4096):

```json
{ "repo": "/work/app/.git", "branch": "feature/auth", "agentId": "a", "project": "/work/wt-auth",
  "claimedAt": "…", "note": "auth rewrite", "meta": { "baseCommit": "abc" },
  "transferredFrom": "…", "transferredAt": "…" }
```

The holder is the pair (project, agentId): the same agent ID in a different room is a different holder. `meta` reuses the claim provenance keys (`baseCommit`, `patchHash`, `resultingCommit`, `verification`). `validateStore` requires the holder to exist in that project's room, branch names to be bounded strings without control characters (at most 256 bytes), and one claim per repo and branch. State without `branchClaims` loads unchanged.

Branch names are used as given except that a leading `refs/heads/` is stripped and the result is trimmed (so ` x` after the prefix is `x`). Work items (the `branch` field and `work list --branch`) use the same bare form.

### Broker op `branches`

| action | fields | result |
| --- | --- | --- |
| `claim` | `agentId`, `branch`, `note?`, `meta?` | `{claim, created, owned}`. `CLAIM_CONFLICT` (409) with `conflicts:[{agentId, project, claimedAt, note, holder, live, stale, …}]` when another holder has it. Idempotent for the holder; a new `note` or `meta` updates the claim and keeps `claimedAt`. |
| `release` | `agentId`, `branch?` | `{released:[branch], claims}`. Only the caller's own claims; all of them when `branch` is omitted. |
| `forceRelease` | `agentId` (human ID), `branch`, `reason` | `{released:[claim], claims, receipt}`. Appended to `state.releaseLog` as `{as, at, project, scope:'branch', repo, reason, released}`. `UNKNOWN_CLAIM` (404) when nothing is claimed, so a typo leaves no audit entry. |
| `list` | `staleMinutes?` | `{repo, git, claims}` with holder liveness on each claim. |

Holder liveness: `holder` is `active`, `stale` (not connected and not seen within `staleMinutes`), `left`, `retired` or `missing`. `live` is true only for `active`; `stale` is its negation. The classification is `liveness()` in `lib/registry.mjs`, the same definition behind live broadcast, registry counts and prune; ownership only supplies `staleMinutes` as the window.

A holder that leaves keeps its claims; they show as `orphaned` until released or force-released. Retiring a holder is blocked by branch claims (below).

## Per-agent git report

`status` accepts `git: {branch?, head?, worktree?}` for agents that work outside their room's checkout. `branch` may be `null` (detached HEAD), `worktree` must be absolute, `head` is at most 128 bytes. The broker stamps `ts` and stores it as `agent.git`. `git: null` clears it.

The MCP adapter (on start) and the OpenCode plugin (after registration) report `gitContext(project)` automatically. Both are best effort: not a git checkout, git failure, or a broker without `git-context` are ignored. `relay_status` also takes `git` for manual reports.

## Ownership view

`ownership` (read-only) joins everything for the room's repo. The broker computes the repo with `gitCommonDir(project)`, then gathers rooms (the asking room, group members with the same common dir, and other rooms whose git common dir matches, probed once per call), `git worktree list --porcelain`, and `git for-each-ref refs/heads` (newest 500).

```json
{ "repo": "…/.git", "git": true, "rooms": ["…"],
  "branches": [{ "name", "head", "upstream", "committedAt",
    "worktrees": [{ "path", "project" }],
    "claim": { "agentId", "project", "claimedAt", "note", "live", "stale", "holder" },
    "agents": [{ "agentId", "project", "live", "source": "worktree|reported" }],
    "tasks": [{ "id", "title", "kind", "status", "state", "owner", "project" }],
    "artifacts": ["…"], "flags": ["orphaned|contested|unclaimed|missing"] }],
  "totalBranches": 12, "truncated": false,
  "unassigned": { "claims": [], "worktrees": [] }, "generatedAt": "…" }
```

* `agents` are non-left agents of the repo's rooms. `live` means transport connected or seen within `staleMinutes`. An agent is placed by its room's checkout (`source: "worktree"`). If it reported a different branch from outside that checkout, the report places it (`source: "reported"`). A report made from the room's own worktree never overrides what that checkout has now.
* `tasks` carry the work-item `kind` and the reported `status` (derived for parents without a stored status, see work-items.md). They are tasks from those rooms whose `branch` field is the branch or whose `resources` include `branch:<name>`. `artifacts` are the strings in those tasks' `artifacts` field. Both fields are read defensively and are optional.
* `worktrees` lists linked checkouts of the branch; `project` is the registered room for that worktree or `null`. Bare and prunable worktrees are ignored.

Flags:

| flag | meaning |
| --- | --- |
| `orphaned` | the claim holder left, was retired, is missing, or is stale |
| `contested` | live agents are on the branch and none is the claim holder |
| `unclaimed` | live agents are on the branch and nobody holds a claim |
| `missing` | a claim exists for a branch git no longer has |

Branches sort flagged first, then claimed, then by `committedAt` descending, and are bounded to 300 (`totalBranches` and `truncated` say what was cut). `unassigned.claims` holds claims that match no git branch (`reason: "missing"`, or `"no-git"` outside a repo); `unassigned.worktrees` holds detached-HEAD worktrees with their agents. Outside git the view still lists claims, rooms and tasks, with `git: false`.

Git is advisory: every helper (`gitContext`, `listWorktrees`, `listBranches` in `lib/ownership.mjs`) has a timeout and returns `null` instead of throwing.

## Retire interplay

`retire` counts branch claims (and open owned work items) as obligations. Without `relinquish:true` it fails with `RETIRE_BLOCKED` and `branchClaims:[branch…]` and `tasks:[id…]` beside the existing `claims`, `machineClaims`, `handoffs` and `processes`. With `relinquish:true` the receipt reports them under `stranded.branchClaims`; they stay held by the retired identity (shown `orphaned`, holder `retired`) until `branch force-release`.

## Surfaces

CLI (JSON output):

```
agent-relay branches [--stale-minutes MIN]
agent-relay branch claim NAME --as ID [--note TEXT] [--meta JSON]
agent-relay branch release [NAME] --as ID
agent-relay branch list
agent-relay branch force-release NAME --as HUMAN --reason TEXT
```

MCP and OpenCode tools:

* `relay_ownership` — the ownership view.
* `relay_branch` — `action` `claim`, `release` or `list`, with `branch`, `note` and `meta`. The caller's identity comes from the session, never from arguments. Force release is deliberately not an agent tool.
