# Work items: roadmaps, phases, epics, tasks and todos

The relay's task ledger doubles as a work-item tree. There is one ledger
(`room.tasks`, op `tasks`); hierarchy, fine-grained status and planning
metadata are optional fields on the same records. Flat tasks created by older
clients keep working unchanged: they are `kind: task` items with a status
derived from their legacy `state`.

Brokers advertise `work-items`, `work-tree` and `work-import`. The client
refuses to send new fields or actions to a broker that lacks the matching
feature and reports that nothing was submitted.

## Model

| Field | Meaning |
| --- | --- |
| `kind` | `roadmap`, `phase`, `epic`, `task` (default) or `todo`. |
| `parentId` | ID of an item in the same room. The parent must strictly outrank the child: `roadmap > phase > epic > task > todo`. Levels may be skipped (a todo directly under a phase). Cycles are rejected (`WORK_CYCLE`), unknown parents are `UNKNOWN_PARENT`, rank violations are `INVALID_HIERARCHY`. Changing a `kind` is checked against both the parent and the children. |
| `status` | `todo`, `in-progress`, `blocked`, `review`, `done` or `cancelled`. |
| `description` | Up to 8 KiB of text. |
| `priority` | `p0` to `p3`. |
| `labels` | Up to 16 labels of up to 48 bytes. |
| `order` | Safe integer for sibling ordering (smaller first, then creation time). |
| `branch` | A valid git branch name. |
| `artifacts` | Up to 32 report folder paths or URLs, up to 1 KiB each. |
| `dueAt` | ISO timestamp (normalized to UTC). |
| `startedAt`, `completedAt` | Set automatically by status transitions. |

Passing `null` (or `[]` for lists) to an upsert clears an optional field.

### Status and the legacy `state`

`state` stays authoritative for old clients and is kept consistent:
`done` and `cancelled` mean `state: complete`; every other status means
`state: open`. The legacy `complete` action sets `status: done`. A legacy edit
that reopens a finished item (new title or blockers) moves its status back to
`todo` (or `in-progress` when it had been started). Items stored without a
status derive it: `complete` is `done`, otherwise `todo`.

`startedAt` is stamped the first time an item enters `in-progress`;
`completedAt` when it enters `done` or `cancelled`, and it is cleared when the
item is reopened.

### Blocking

Views keep the computed `blocking` rows and `blocked` flag and add
`blockedReasons`: `blockers` (open task blockers or held claims) and/or
`status` (explicit `status: blocked`). `blocked` is true when either applies, so
`list --blocked` finds both.

## Actions on op `tasks`

All existing actions (`upsert`, `list`, `complete`) behave as before. New
fields are accepted on `upsert`; new filters on `list`.

- `list`: adds the filters `kind`, `status`, `parentId` (`null` for top-level
  items), `branch` and `label` to `state`, `blocked` and `owner`.
- `tree` `{rootId?, kind?, includeDone?}` returns `{roots, counts}`. Each node
  is the normal task view plus `children` (sorted by `order`, then creation
  time) and `progress: {done, total, percent}` rolled up over leaf
  descendants; a leaf counts itself and cancelled leaves are excluded from
  `total`. `rootId` returns one subtree, `kind` returns the items of that kind
  with their descendants, and `includeDone: false` hides finished items that
  have nothing open below them (progress is still computed over the whole
  subtree). `counts` reports `byKind` and `byStatus` for the returned nodes.
- `move` `{id, parentId|null, order?}` re-parents an item (`null` for the top
  level) with the same hierarchy checks as `upsert`.
- `remove` `{id, cascade?}` deletes an item. An item with descendants is
  refused (`HAS_CHILDREN`, 409) unless `cascade` is true. The response is
  `{removed: [ids], danglingRefs: [{id, ref}]}`; items elsewhere that still
  list a removed ID in `blockedBy` are reported, not edited.
- `import` `{markdown, parentId?, dryRun?}` creates or updates items from a
  markdown roadmap (below). A dry run needs no registered agent and returns
  `{dryRun: true, created, updated, unchanged, tree}` without changing
  anything; a real import returns the created and updated task views and the
  IDs left unchanged. Imports are atomic.

The ledger holds up to 4096 items per project (`TASK_LIMIT` beyond that).

## Markdown import

```markdown
# Agent Relay 1.0
Status: in-progress
Owner: serge
Branch: main

Free text under a heading becomes its description.

## Phase 1: Foundations
Priority: p1
Labels: core, infra

### Broker
- [x] Durable store
- [ ] Capabilities
  - [ ] Advertise features
  - [x] Gate the client
```

- `#` is a roadmap, `##` a phase, `###` an epic; headings nest by level.
- `- [ ] text` and `- [x] text` (also `*` and `+`) are tasks under the nearest
  heading; `[x]` means `done`. Indented checklist items under a task are todos
  (deeper nesting flattens to todos of the same task).
- `Status:`, `Owner:`, `Branch:`, `Priority:` and `Labels:` lines directly
  under a heading set those fields. `Owner` must be a registered agent.
  Status accepts `todo`, `in-progress`, `blocked`, `review`, `done`,
  `cancelled` and common spellings (`in progress`, `complete`, `canceled`).
- Fenced code blocks are ignored. The document is limited to 96 KiB.
- Parse and validation errors name the offending line.

Item IDs are `wi-` plus a SHA-256 prefix of the path of titles (the optional
`parentId` seeds the path; repeated sibling titles get an occurrence suffix),
so importing the same document again updates items instead of duplicating
them. Re-imports keep a progressed status (an unchecked box does not reset an
`in-progress` item) but an unchecked box reopens a finished item, and a checked
box completes one. Imported siblings are ordered by document position.
Fields the document does not mention (labels on a task, artifacts, due dates)
are left alone.

## CLI

```
agent-relay work tree [--root ID] [--kind K] [--hide-done] [--pretty]
agent-relay work list [--kind K] [--status S] [--parent ID|root] [--branch B] [--label L] [--owner ID]
agent-relay work add --as ID --kind epic --title T [--id ID] [--parent ID] [--owner A] [--branch B]
                     [--priority p1] [--label x,y] [--status S] [--desc TEXT] [--order N]
                     [--artifacts a,b] [--due ISO] [--blocked-by a,b]
agent-relay work set --as ID --id ID [--status in-progress] [--title T] [...same fields]
agent-relay work move --as ID --id ID --parent ID|root [--order N]
agent-relay work rm --as ID --id ID [--cascade]
agent-relay work import --file ROADMAP.md [--as ID] [--parent ID] [--dry-run]
```

`work tree` prints JSON; `--pretty` prints an indented tree with status marks
(`[ ]` todo, `[~]` in progress, `[!]` blocked, `[?]` review, `[x]` done, `[-]`
cancelled) and progress bars. `--parent root` means the top level. `work set`
with a status changes `state` and the timestamps as described above. The
existing `tasks`, `task-upsert` and `task-complete` commands are unchanged.

## MCP and OpenCode

`relay_tasks` keeps its name and gains the actions `tree`, `move`, `remove`
and `import` plus the fields above (`kind`, `parentId`, `status`,
`description`, `priority`, `labels`, `order`, `branch`, `artifacts`, `dueAt`,
`rootId`, `includeDone`, `cascade`, `markdown`, `dryRun`, `label`). `relay_roadmap`
is a read-only convenience for the tree view (`rootId`, `kind`, `includeDone`).
The OpenCode plugin exposes the same two tools with the same arguments.
