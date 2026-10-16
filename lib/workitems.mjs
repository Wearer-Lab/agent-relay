import { createHash } from 'node:crypto';

// Hierarchical work items live in the existing room.tasks ledger: every field
// here is optional on a stored task, so flat legacy tasks keep working as
// kind 'task' with a status derived from their legacy state.
export const KINDS = ['roadmap', 'phase', 'epic', 'task', 'todo'];
export const STATUSES = ['todo', 'in-progress', 'blocked', 'review', 'done', 'cancelled'];
export const PRIORITIES = ['p0', 'p1', 'p2', 'p3'];
export const WORK_ACTIONS = ['tree', 'move', 'remove', 'import'];
export const WORK_FIELDS = ['kind', 'parentId', 'status', 'description', 'priority', 'labels', 'order', 'branch', 'artifacts', 'dueAt'];
export const WORK_FILTERS = ['kind', 'status', 'parentId', 'branch', 'label'];
const RANK = { roadmap: 4, phase: 3, epic: 2, task: 1, todo: 0 };
const TERMINAL = new Set(['done', 'cancelled']);
const MAX_DESCRIPTION = 8192, MAX_LABELS = 16, MAX_LABEL = 48, MAX_ARTIFACTS = 32, MAX_ARTIFACT = 1024;
const MAX_BRANCH = 255, MAX_TITLE = 480, MAX_MARKDOWN = 96 * 1024;
const STATUS_ALIASES = { complete: 'done', completed: 'done', canceled: 'cancelled', 'not-started': 'todo', open: 'todo',
  wip: 'in-progress', inprogress: 'in-progress', 'in-review': 'review' };

export const kindOf = task => task.kind ?? 'task';
export const statusOf = task => task.status ?? (task.state === 'complete' ? 'done' : 'todo');
export const isTerminal = status => TERMINAL.has(status);
export const rankOf = kind => RANK[kind];

export function validBranch(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= MAX_BRANCH
    && !/[\u0000- \u007f~^:?*[\\]/u.test(value) && !value.includes('..') && !value.includes('@{')
    && !value.includes('//') && !/^[-/]|[/.]$/u.test(value) && value !== '@'
    && !value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'));
}
const validDescription = value => typeof value === 'string' && value.trim().length > 0
  && Buffer.byteLength(value) <= MAX_DESCRIPTION && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
const validIso = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && Number.isFinite(Date.parse(value));
const validShort = (value, max) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max
  && !/[\u0000-\u001f]/u.test(value);
const validList = (value, count, max) => Array.isArray(value) && value.length > 0 && value.length <= count
  && new Set(value).size === value.length && value.every(item => validShort(item, max));

// Structural validation of the work-item fields of a whole ledger (store load
// and every commit). Absent fields are always valid.
export function validWorkLedger(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  return tasks.every(task => {
    if (task.kind !== undefined && !KINDS.includes(task.kind)) return false;
    if (task.status !== undefined && (!STATUSES.includes(task.status)
        || TERMINAL.has(task.status) !== (task.state === 'complete'))) return false;
    if (task.parentId !== undefined) {
      const parent = byId.get(task.parentId);
      if (!parent || parent.id === task.id || RANK[kindOf(parent)] <= RANK[kindOf(task)]) return false;
    }
    return (task.description === undefined || validDescription(task.description))
      && (task.priority === undefined || PRIORITIES.includes(task.priority))
      && (task.labels === undefined || validList(task.labels, MAX_LABELS, MAX_LABEL))
      && (task.order === undefined || Number.isSafeInteger(task.order))
      && (task.branch === undefined || validBranch(task.branch))
      && (task.artifacts === undefined || validList(task.artifacts, MAX_ARTIFACTS, MAX_ARTIFACT))
      && ['dueAt', 'startedAt', 'completedAt'].every(key => task[key] === undefined || validIso(task[key]));
  });
}

// Reported alongside the legacy computed blockers: an explicit 'blocked' status
// also counts as blocked, and the reasons are listed.
export function workView(task, view) {
  const reasons = [];
  if (view.blocked) reasons.push('blockers');
  if (task.status === 'blocked') reasons.push('status');
  return Object.assign(view, { kind: kindOf(task), status: statusOf(task), blockedReasons: reasons, blocked: reasons.length > 0 });
}

export function setStatus(task, status, now) {
  const wasTerminal = task.state === 'complete';
  task.status = status;
  task.state = TERMINAL.has(status) ? 'complete' : 'open';
  if (status === 'in-progress' && task.startedAt === undefined) task.startedAt = now;
  if (TERMINAL.has(status)) { if (!wasTerminal || task.completedAt === undefined) task.completedAt = now; }
  else delete task.completedAt;
}

export function createWork(fail) {
  const bad = (message, code = 'INVALID_INPUT', status = 400, details) => fail(code, message, status, details);
  const oneOf = (value, list, field) => list.includes(value) ? value : bad(`${field} must be one of ${list.join(', ')}.`);
  const short = (value, field, max) => validShort(value, max) ? value.trim() : bad(`${field} must be a nonempty bounded string.`);
  const bool = (value, field, fallback) => value === undefined ? fallback
    : typeof value === 'boolean' ? value : bad(`${field} must be boolean.`);
  const list = (value, field, count, max) => {
    if (!Array.isArray(value) || value.length > count) bad(`${field} must be up to ${count} strings.`);
    return [...new Set(value.map(item => short(item, field, max)))];
  };
  const find = (ledger, id) => ledger.find(task => task.id === id);

  // Validated, normalized patch. Absent key = unchanged, null = clear.
  function parseFields(input) {
    const patch = {};
    const has = key => input[key] !== undefined;
    const nullable = (key, parse) => { if (has(key)) patch[key] = input[key] === null ? null : parse(input[key]); };
    if (has('kind')) patch.kind = oneOf(input.kind, KINDS, 'kind');
    if (has('status')) patch.status = oneOf(input.status, STATUSES, 'status');
    nullable('parentId', value => short(value, 'parentId', 128));
    nullable('description', value => validDescription(value) ? value : bad('description must be nonempty text up to 8 KiB.'));
    nullable('priority', value => oneOf(value, PRIORITIES, 'priority'));
    nullable('order', value => Number.isSafeInteger(value) ? value : bad('order must be a safe integer.'));
    nullable('branch', value => validBranch(value) ? value : bad('branch must be a valid git branch name.'));
    nullable('dueAt', value => typeof value === 'string' && Number.isFinite(Date.parse(value))
      ? new Date(Date.parse(value)).toISOString() : bad('dueAt must be an ISO timestamp.'));
    for (const [key, count, max] of [['labels', MAX_LABELS, MAX_LABEL], ['artifacts', MAX_ARTIFACTS, MAX_ARTIFACT]]) {
      nullable(key, value => { const items = list(value, key, count, max); return items.length ? items : null; });
    }
    return patch;
  }

  // The kind/parent combination must be consistent with the rest of the tree.
  function placement(ledger, task, kind, parentId) {
    const rank = RANK[kind];
    if (parentId !== null) {
      if (parentId === task.id) bad('An item cannot be its own parent.', 'WORK_CYCLE', 409);
      const parent = find(ledger, parentId);
      if (!parent) bad('No parent item with that ID exists in this project.', 'UNKNOWN_PARENT', 404);
      const seen = new Set();
      for (let at = parent; at; at = at.parentId === undefined ? undefined : find(ledger, at.parentId)) {
        if (at.id === task.id) bad('That parent would create a cycle.', 'WORK_CYCLE', 409);
        if (seen.has(at.id)) break;
        seen.add(at.id);
      }
      if (RANK[kindOf(parent)] <= rank) {
        bad(`A ${kind} needs a parent of higher rank (${parent.id} is a ${kindOf(parent)}); order is roadmap > phase > epic > task > todo.`,
          'INVALID_HIERARCHY');
      }
    }
    const child = ledger.find(candidate => candidate.parentId === task.id && RANK[kindOf(candidate)] >= rank);
    if (child) bad(`A ${kind} cannot hold ${kindOf(child)} ${child.id}; children must have lower rank.`, 'INVALID_HIERARCHY');
  }

  function apply(ledger, task, patch, now) {
    const kind = patch.kind ?? kindOf(task);
    const parentId = patch.parentId === undefined ? task.parentId ?? null : patch.parentId;
    if (patch.kind !== undefined || patch.parentId !== undefined) placement(ledger, task, kind, parentId);
    for (const key of WORK_FIELDS) {
      if (patch[key] === undefined || key === 'status') continue;
      if (patch[key] === null) delete task[key]; else task[key] = patch[key];
    }
    if (patch.status !== undefined) setStatus(task, patch.status, now);
  }

  function reopened(task) {
    // Legacy upserts reopen a completed task; keep an explicit status in step.
    if (task.state === 'open' && task.status !== undefined && TERMINAL.has(task.status)) {
      task.status = task.startedAt === undefined ? 'todo' : 'in-progress';
      delete task.completedAt;
    }
  }

  function listFilter(input) {
    const kind = input.kind === undefined ? undefined : oneOf(input.kind, KINDS, 'kind');
    const status = input.status === undefined ? undefined : oneOf(input.status, STATUSES, 'status');
    const parentId = input.parentId === undefined || input.parentId === null ? input.parentId : short(input.parentId, 'parentId', 128);
    const branch = input.branch === undefined ? undefined : short(input.branch, 'branch', MAX_BRANCH);
    const label = input.label === undefined ? undefined : short(input.label, 'label', MAX_LABEL);
    return task => (kind === undefined || kindOf(task) === kind) && (status === undefined || statusOf(task) === status)
      && (parentId === undefined || (task.parentId ?? null) === parentId) && (branch === undefined || task.branch === branch)
      && (label === undefined || (task.labels ?? []).includes(label));
  }

  function sorter(ledger) {
    const index = new Map(ledger.map((task, i) => [task.id, i]));
    return (a, b) => (a.order ?? Infinity) === (b.order ?? Infinity)
      ? (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : index.get(a.id) - index.get(b.id))
      : (a.order ?? Infinity) < (b.order ?? Infinity) ? -1 : 1;
  }
  function childMap(ledger) {
    const ids = new Set(ledger.map(task => task.id)), map = new Map(), compare = sorter(ledger);
    for (const task of ledger) {
      const key = task.parentId !== undefined && ids.has(task.parentId) ? task.parentId : null;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(task);
    }
    for (const rows of map.values()) rows.sort(compare);
    return map;
  }

  function tree(ledger, input, view) {
    const rootId = input.rootId === undefined ? undefined : short(input.rootId, 'rootId', 128);
    const kind = input.kind === undefined ? undefined : oneOf(input.kind, KINDS, 'kind');
    const includeDone = bool(input.includeDone, 'includeDone', true);
    const byId = new Map(ledger.map(task => [task.id, task])), kids = childMap(ledger);
    if (rootId !== undefined && !byId.has(rootId)) bad('No item with that ID exists in this project.', 'UNKNOWN_TASK', 404);
    const memo = new Map();
    const leaves = task => {
      if (memo.has(task.id)) return memo.get(task.id);
      const children = kids.get(task.id) ?? [], sum = { done: 0, total: 0 };
      if (!children.length) {
        const status = statusOf(task);
        if (status !== 'cancelled') { sum.total = 1; sum.done = status === 'done' ? 1 : 0; }
      } else for (const child of children) { const part = leaves(child); sum.done += part.done; sum.total += part.total; }
      memo.set(task.id, sum);
      return sum;
    };
    const counts = { byKind: Object.fromEntries(KINDS.map(name => [name, 0])),
      byStatus: Object.fromEntries(STATUSES.map(name => [name, 0])) };
    const node = task => {
      const children = (kids.get(task.id) ?? []).map(node).filter(Boolean);
      if (!includeDone && TERMINAL.has(statusOf(task)) && !children.length) return null;
      counts.byKind[kindOf(task)]++; counts.byStatus[statusOf(task)]++;
      const { done, total } = leaves(task);
      return { ...view(task), children, progress: { done, total, percent: total ? Math.round(done / total * 100) : 0 } };
    };
    const scope = rootId === undefined ? ledger : ledger.filter(task => {
      for (let at = task, hops = 0; at && hops < 16; at = byId.get(at.parentId), hops++) if (at.id === rootId) return true;
      return false;
    });
    const roots = kind !== undefined ? scope.filter(task => kindOf(task) === kind).sort(sorter(ledger))
      : rootId !== undefined ? [byId.get(rootId)] : kids.get(null) ?? [];
    return { roots: roots.map(node).filter(Boolean), counts };
  }

  function move(ledger, input, now) {
    const id = short(input.id, 'id', 128), task = find(ledger, id);
    if (!task) bad('No item with that ID exists in this project.', 'UNKNOWN_TASK', 404);
    if (input.parentId === undefined) bad('move requires parentId (an item ID, or null for the top level).');
    const patch = parseFields({ parentId: input.parentId, order: input.order });
    apply(ledger, task, { parentId: patch.parentId, ...(patch.order === undefined ? {} : { order: patch.order }) }, now);
    task.updatedAt = now;
    return task;
  }

  function remove(ledger, input) {
    const id = short(input.id, 'id', 128), cascade = bool(input.cascade, 'cascade', false);
    if (!find(ledger, id)) bad('No item with that ID exists in this project.', 'UNKNOWN_TASK', 404);
    const gone = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const task of ledger) if (!gone.has(task.id) && gone.has(task.parentId)) { gone.add(task.id); grew = true; }
    }
    if (gone.size > 1 && !cascade) {
      bad(`Item ${id} has ${gone.size - 1} descendant(s); pass cascade to remove them too.`, 'HAS_CHILDREN', 409,
        { children: ledger.filter(task => task.parentId === id).map(task => task.id) });
    }
    const danglingRefs = [];
    for (const task of ledger) {
      if (gone.has(task.id)) continue;
      for (const ref of task.blockedBy ?? []) if (gone.has(ref)) danglingRefs.push({ id: task.id, ref });
    }
    const removed = ledger.filter(task => gone.has(task.id)).map(task => task.id);
    for (let i = ledger.length - 1; i >= 0; i--) if (gone.has(ledger[i].id)) ledger.splice(i, 1);
    return { removed, danglingRefs };
  }

  // ---- Markdown import ----------------------------------------------------
  const HEADING = /^(#{1,3})\s+(.+?)(?:\s+#+)?\s*$/u;
  const ITEM = /^(\s*)[-*+]\s+\[([ xX])\]\s+(\S.*?)\s*$/u;
  const META = /^\s*(?:[-*+]\s+)?\**(status|owner|branch|priority|labels?)\**\s*:\s*\**\s*(\S.*?)\s*$/iu;
  const HEADING_KIND = ['roadmap', 'phase', 'epic'];

  function normalizeStatus(value, line) {
    const key = value.trim().toLowerCase().replace(/[\s_]+/gu, '-');
    const status = STATUS_ALIASES[key] ?? key;
    return STATUSES.includes(status) ? status : bad(`line ${line}: unknown status "${value}".`);
  }
  function itemId(path) {
    return `wi-${createHash('sha256').update(path.join('\u0000')).digest('hex').slice(0, 16)}`;
  }
  function parseMarkdown(markdown, base) {
    if (typeof markdown !== 'string' || !markdown.trim() || Buffer.byteLength(markdown) > MAX_MARKDOWN) {
      bad('markdown must be a nonempty string up to 96 KiB.');
    }
    const plan = [], stack = [], seen = new Map(), counters = new Map();
    let metaOpen = false, describing = null, lastTask = null, fenced = false;
    const add = (kind, title, parent, line, indent = 0) => {
      title = title.replace(/\s+/gu, ' ').trim();
      if (!validShort(title, MAX_TITLE)) bad(`line ${line}: title must be a nonempty string up to ${MAX_TITLE} bytes.`);
      const key = [...(parent ? parent.path : [base ?? '']), title].join('\u0000');
      const occurrence = (seen.get(key) ?? 0) + 1;
      seen.set(key, occurrence);
      const path = [...(parent ? parent.path : [base ?? '']), occurrence > 1 ? `${title}\u0000#${occurrence}` : title];
      const slot = parent ? parent.id : '';
      const order = counters.get(slot) ?? 0;
      counters.set(slot, order + 1);
      const item = { id: itemId(path), kind, title, parent, line, indent, path, order, fields: {}, description: [] };
      plan.push(item);
      return item;
    };
    const lines = markdown.replace(/\r\n?/gu, '\n').replace(/\t/gu, '    ').split('\n');
    lines.forEach((raw, at) => {
      const line = at + 1;
      if (/^\s*(```|~~~)/u.test(raw)) { fenced = !fenced; metaOpen = false; return; }
      if (fenced) return;
      const heading = HEADING.exec(raw);
      if (heading) {
        const kind = HEADING_KIND[heading[1].length - 1];
        while (stack.length && RANK[stack.at(-1).kind] <= RANK[kind]) stack.pop();
        const item = add(kind, heading[2], stack.at(-1) ?? null, line);
        stack.push(item); metaOpen = true; describing = item; lastTask = null;
        return;
      }
      const checkbox = ITEM.exec(raw);
      if (checkbox) {
        const indent = checkbox[1].length;
        const nested = lastTask !== null && indent > lastTask.indent;
        const item = add(nested ? 'todo' : 'task', checkbox[3], nested ? lastTask : stack.at(-1) ?? null, line, indent);
        item.checked = checkbox[2] !== ' ';
        if (!nested) lastTask = item;
        metaOpen = false; describing = null;
        return;
      }
      if (!raw.trim()) return;
      const meta = metaOpen && describing ? META.exec(raw) : null;
      if (meta) {
        const key = meta[1].toLowerCase(), value = meta[2];
        const fields = describing.fields;
        if (key === 'status') fields.status = normalizeStatus(value, line);
        else if (key === 'owner') { fields.owner = short(value, `line ${line}: owner`, 128); describing.ownerLine = line; }
        else if (key === 'branch') fields.branch = validBranch(value) ? value : bad(`line ${line}: "${value}" is not a valid git branch name.`);
        else if (key === 'priority') fields.priority = oneOf(value.toLowerCase(), PRIORITIES, `line ${line}: priority`);
        else fields.labels = list(value.split(',').map(part => part.trim()).filter(Boolean), `line ${line}: labels`, MAX_LABELS, MAX_LABEL);
        return;
      }
      metaOpen = false;
      if (describing) describing.description.push(raw.trim());
    });
    if (!plan.length) bad('No headings or checklist items found to import.');
    for (const item of plan) {
      let text = item.description.join('\n').trim();
      while (Buffer.byteLength(text) > MAX_DESCRIPTION) text = text.slice(0, -1);
      item.fields.description = text.trim() || undefined;
      delete item.description;
    }
    return plan;
  }

  function parseImport(input) {
    const parentId = input.parentId === undefined || input.parentId === null ? undefined : short(input.parentId, 'parentId', 128);
    return { plan: parseMarkdown(input.markdown, parentId), parentId, dryRun: bool(input.dryRun, 'dryRun', false) };
  }

  // Applies a parsed plan to a ledger. Existing IDs are updated in place
  // (idempotent re-import); for dry runs the caller passes a scratch copy.
  function importInto(ledger, request, { creator, hasAgent, limit, now }) {
    const created = [], updated = [], unchanged = [], actions = new Map();
    for (const item of request.plan) {
      const owner = item.fields.owner;
      if (owner !== undefined && !hasAgent(owner)) bad(`line ${item.ownerLine ?? item.line}: owner ${owner} is not a registered agent.`, 'UNKNOWN_AGENT', 404);
      let task = find(ledger, item.id);
      const fresh = task === undefined;
      if (fresh) {
        if (ledger.length >= limit) bad('Task records reached their bound.', 'TASK_LIMIT', 409);
        task = { id: item.id, creator, title: item.title, state: 'open', createdAt: now, updatedAt: now };
      }
      const before = JSON.stringify(task);
      let status = item.fields.status;
      if (status === undefined && item.checked === true) status = 'done';
      else if (status === undefined && (fresh || (item.checked === false && TERMINAL.has(statusOf(task))))) status = 'todo';
      const { status: _status, owner: _owner, ...rest } = item.fields;
      const patch = parseFields({ ...rest, kind: item.kind, order: item.order,
        parentId: item.parent ? item.parent.id : request.parentId ?? null });
      if (status !== undefined) patch.status = status;
      task.title = item.title;
      if (owner !== undefined) task.owner = owner;
      if (fresh) ledger.push(task);
      apply(ledger, task, patch, now);
      if (fresh) { created.push(task); actions.set(item.id, 'created'); }
      else if (JSON.stringify(task) !== before) { task.updatedAt = now; updated.push(task); actions.set(item.id, 'updated'); }
      else { unchanged.push(task); actions.set(item.id, 'unchanged'); }
    }
    return { created, updated, unchanged, actions };
  }

  // The would-be tree of an import, nested by document structure.
  function planTree(request, ledger, actions) {
    const nodes = new Map(request.plan.map(item => {
      const task = find(ledger, item.id);
      return [item.id, { id: item.id, kind: item.kind, title: item.title, status: statusOf(task),
        ...(task.owner === undefined ? {} : { owner: task.owner }), ...(task.branch === undefined ? {} : { branch: task.branch }),
        action: actions.get(item.id), children: [] }];
    }));
    const roots = [];
    for (const item of request.plan) (item.parent ? nodes.get(item.parent.id).children : roots).push(nodes.get(item.id));
    return roots;
  }

  return { parseFields, apply, reopened, listFilter, tree, move, remove, parseImport, importInto, planTree };
}

// Human-readable indented tree with progress bars (`work tree --pretty`).
export function renderTree(result, width = 10) {
  const marks = { todo: '[ ]', 'in-progress': '[~]', blocked: '[!]', review: '[?]', done: '[x]', cancelled: '[-]' };
  const lines = [];
  const walk = (node, depth) => {
    const { done, total, percent } = node.progress;
    const filled = Math.round(percent / 100 * width);
    const bar = `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}]`;
    const extra = [node.status, node.priority, node.owner && `@${node.owner}`, node.branch].filter(Boolean).join(', ');
    lines.push(`${'  '.repeat(depth)}${marks[node.status] ?? '[ ]'} ${node.kind}: ${node.title}  ${bar} ${String(percent).padStart(3)}% ${done}/${total}  (${extra})  ${node.id}`);
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of result.roots) walk(root, 0);
  if (!lines.length) lines.push('(no work items)');
  const byKind = Object.entries(result.counts?.byKind ?? {}).filter(([, count]) => count).map(([name, count]) => `${count} ${name}`);
  if (byKind.length) lines.push('', byKind.join(', '));
  return lines.join('\n');
}
