import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBroker, validateStore, MAX_TASKS } from '../lib/broker.mjs';
import { createMcpAdapter } from '../lib/mcp.mjs';
import { AgentRelayPlugin } from '../lib/opencode-plugin.mjs';
import { rpc as clientRpc } from '../lib/client.mjs';
import { renderTree, validBranch } from '../lib/workitems.mjs';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/agent-relay.mjs', import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-work-'));
  const dataDir = path.join(root, 'data'), project = path.join(root, 'project'), other = path.join(root, 'other');
  await Promise.all([dataDir, project, other].map(dir => fs.mkdir(dir)));
  let broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function request(fields, room = project) {
    const response = await fetch(broker.url + '/rpc', { method: 'POST',
      headers: { authorization: 'Bearer ' + broker.token, 'content-type': 'application/json' },
      body: JSON.stringify({ project: room, ...fields }) });
    return { status: response.status, ...(await response.json()) };
  }
  async function rpc(fields, room = project) {
    const result = await request(fields, room);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  }
  const register = (id, room = project) => rpc({ op: 'register', agentId: id, runner: 'test', sessionId: 'session-' + id }, room);
  const work = async fields => (await rpc({ op: 'tasks', action: 'upsert', agentId: 'a', ...fields })).task;
  const act = (action, fields) => rpc({ op: 'tasks', action, agentId: 'a', ...fields });
  const fails = async (fields, code, status) => {
    const result = await request({ op: 'tasks', agentId: 'a', ...fields });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error.code, code, JSON.stringify(result));
    if (status !== undefined) assert.equal(result.status, status);
  };
  const store = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  return { root, project, other, dataDir, request, rpc, register, work, act, fails, store,
    get broker() { return broker; }, async restart() { await broker.close(); broker = await createBroker({ dataDir }); return broker; } };
}
const flat = nodes => nodes.flatMap(node => [node, ...flat(node.children)]);

test('hierarchy enforces strict rank, existing parents in the same room and no cycles', async t => {
  const f = await fixture(t);
  await f.register('a');
  const r = await f.work({ id: 'r', kind: 'roadmap', title: 'Roadmap' });
  await f.work({ id: 'p', kind: 'phase', title: 'Phase', parentId: 'r' });
  await f.work({ id: 'e', kind: 'epic', title: 'Epic', parentId: 'p' });
  await f.work({ id: 't', kind: 'task', title: 'Task', parentId: 'e' });
  const d = await f.work({ id: 'd', kind: 'todo', title: 'Todo', parentId: 't' });
  assert.equal(r.kind, 'roadmap'); assert.equal(d.parentId, 't');
  // Skipping levels is fine as long as the parent outranks the child.
  assert.equal((await f.work({ id: 'skip', kind: 'todo', title: 'Skip', parentId: 'p' })).parentId, 'p');
  await f.work({ id: 'root-todo', kind: 'todo', title: 'Top-level todo' });
  await f.fails({ action: 'upsert', title: 'Bad', kind: 'phase', parentId: 'e' }, 'INVALID_HIERARCHY');
  await f.fails({ action: 'upsert', title: 'Bad', kind: 'task', parentId: 't' }, 'INVALID_HIERARCHY');
  await f.fails({ action: 'upsert', title: 'Bad', kind: 'todo', parentId: 'd' }, 'INVALID_HIERARCHY');
  await f.fails({ action: 'upsert', title: 'Bad', kind: 'roadmap', parentId: 'r' }, 'INVALID_HIERARCHY');
  await f.fails({ action: 'upsert', title: 'Bad', kind: 'task', parentId: 'nope' }, 'UNKNOWN_PARENT', 404);
  await f.fails({ action: 'upsert', title: 'Bad', kind: 'wizard' }, 'INVALID_INPUT');
  await f.fails({ action: 'upsert', id: 'e', parentId: 'e' }, 'WORK_CYCLE', 409);
  await f.fails({ action: 'move', id: 'r', parentId: 'd' }, 'WORK_CYCLE', 409);
  await f.fails({ action: 'move', id: 'p', parentId: 'd' }, 'WORK_CYCLE', 409);
  // Changing a kind must keep both its parent and its children consistent.
  await f.fails({ action: 'upsert', id: 'e', kind: 'task' }, 'INVALID_HIERARCHY');
  await f.fails({ action: 'upsert', id: 't', kind: 'phase' }, 'INVALID_HIERARCHY');
  assert.equal((await f.work({ id: 't', kind: 'task', title: 'Task renamed' })).title, 'Task renamed');
  // Parents never leak across rooms.
  await f.register('a', f.other);
  const foreign = await f.request({ op: 'tasks', action: 'upsert', agentId: 'a', title: 'Foreign', kind: 'task', parentId: 'p' }, f.other);
  assert.equal(foreign.error.code, 'UNKNOWN_PARENT');
  // A failed mutation leaves the ledger untouched.
  assert.equal((await f.rpc({ op: 'tasks', action: 'list' })).tasks.length, 7);
});

test('field validation bounds description, labels, artifacts, branch, order, priority and dueAt', async t => {
  const f = await fixture(t);
  await f.register('a');
  const ok = await f.work({ id: 'x', title: 'All fields', kind: 'epic', description: 'Line one\nLine two', priority: 'p1',
    labels: ['ui', 'api', 'ui'], order: -3, branch: 'feature/work-items', artifacts: ['reports/2026-10', 'https://example.com/r'],
    dueAt: '2026-12-31T10:00:00+02:00' });
  assert.deepEqual(ok.labels, ['ui', 'api']); assert.equal(ok.order, -3); assert.equal(ok.dueAt, '2026-12-31T08:00:00.000Z');
  assert.equal(ok.description, 'Line one\nLine two');
  const bad = [{ description: 'x'.repeat(8193) }, { description: '   ' }, { priority: 'p9' }, { labels: Array.from({ length: 17 }, (_, i) => 'l' + i) },
    { labels: ['x'.repeat(49)] }, { labels: [''] }, { order: 1.5 }, { order: '1' }, { branch: 'bad branch' }, { branch: 'a..b' }, { branch: '-x' },
    { branch: 'x.lock' }, { artifacts: Array.from({ length: 33 }, (_, i) => 'a' + i) }, { artifacts: ['x'.repeat(1025)] }, { dueAt: 'soon' },
    { status: 'finished' }, { parentId: '' }];
  for (const fields of bad) await f.fails({ action: 'upsert', id: 'x', ...fields }, 'INVALID_INPUT');
  for (const name of ['feature/a-b', 'main', 'release/1.2', 'user/x_y']) assert.equal(validBranch(name), true, name);
  for (const name of ['', 'a b', 'a//b', '/a', 'a/', 'a.', 'a@{b', '@', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', '.hidden/x']) assert.equal(validBranch(name), false, name);
  const cleared = await f.work({ id: 'x', description: null, priority: null, labels: [], order: null, branch: null, artifacts: [], dueAt: null });
  for (const key of ['description', 'priority', 'labels', 'order', 'branch', 'artifacts', 'dueAt']) assert.equal(cleared[key], undefined, key);
  assert.equal(cleared.kind, 'epic');
});

test('status keeps the legacy state consistent and stamps start and completion times', async t => {
  const f = await fixture(t);
  await f.register('a');
  const legacy = await f.work({ id: 'legacy', title: 'Old style' });
  assert.equal(legacy.state, 'open'); assert.equal(legacy.status, 'todo'); assert.equal(legacy.kind, 'task');
  const stored = (await f.store()).rooms[0].tasks.find(row => row.id === 'legacy');
  assert.equal(stored.status, undefined); assert.equal(stored.kind, undefined);
  const started = await f.work({ id: 'legacy', status: 'in-progress' });
  assert.equal(started.state, 'open'); assert.ok(started.startedAt); assert.equal(started.completedAt, undefined);
  const review = await f.work({ id: 'legacy', status: 'review' });
  assert.equal(review.state, 'open'); assert.equal(review.startedAt, started.startedAt);
  const blocked = await f.work({ id: 'legacy', status: 'blocked' });
  assert.equal(blocked.blocked, true); assert.deepEqual(blocked.blockedReasons, ['status']); assert.deepEqual(blocked.blocking, []);
  assert.deepEqual((await f.rpc({ op: 'tasks', action: 'list', blocked: true })).tasks.map(row => row.id), ['legacy']);
  const done = await f.work({ id: 'legacy', status: 'done' });
  assert.equal(done.state, 'complete'); assert.ok(done.completedAt); assert.equal(done.blocked, false);
  assert.deepEqual((await f.rpc({ op: 'tasks', action: 'list', state: 'complete' })).tasks.map(row => row.id), ['legacy']);
  const reopened = await f.work({ id: 'legacy', status: 'todo' });
  assert.equal(reopened.state, 'open'); assert.equal(reopened.completedAt, undefined); assert.equal(reopened.startedAt, started.startedAt);
  const cancelled = await f.work({ id: 'legacy', status: 'cancelled' });
  assert.equal(cancelled.state, 'complete'); assert.ok(cancelled.completedAt);
  // The legacy complete action sets status done.
  await f.work({ id: 'c', title: 'Complete me', status: 'in-progress' });
  const completed = (await f.act('complete', { id: 'c', verification: 'tests pass' })).task;
  assert.equal(completed.state, 'complete'); assert.equal(completed.status, 'done'); assert.ok(completed.completedAt);
  // A legacy edit (new title) reopens a finished item and keeps status in step.
  const retitled = await f.work({ id: 'c', title: 'Complete me again' });
  assert.equal(retitled.state, 'open'); assert.equal(retitled.status, 'in-progress'); assert.equal(retitled.completedAt, undefined);
  await f.work({ id: 'legacy2', title: 'Plain' });
  assert.equal((await f.act('complete', { id: 'legacy2' })).task.status, 'done');
  assert.equal((await f.work({ id: 'legacy2', title: 'Plain again' })).status, 'todo');
  // An explicit status given with the edit wins over the reopen rule.
  assert.equal((await f.work({ id: 'c', status: 'done' })).state, 'complete');
  assert.equal((await f.work({ id: 'c', title: 'Done and renamed', status: 'done' })).status, 'done');
  // Created already terminal.
  const born = await f.work({ id: 'born', title: 'Already done', status: 'done' });
  assert.equal(born.state, 'complete'); assert.ok(born.completedAt);
  await f.restart();
  assert.equal((await f.rpc({ op: 'tasks', action: 'list' })).tasks.find(row => row.id === 'born').status, 'done');
});

test('legacy stored tasks without status or kind load, derive status and still complete', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-work-legacy-'));
  const dataDir = path.join(root, 'data'), project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let broker = await createBroker({ dataDir });
  const call = async fields => (await (await fetch(broker.url + '/rpc', { method: 'POST',
    headers: { authorization: 'Bearer ' + broker.token, 'content-type': 'application/json' },
    body: JSON.stringify({ project, ...fields }) })).json());
  await call({ op: 'register', agentId: 'a', runner: 'test', sessionId: 's' });
  await call({ op: 'tasks', action: 'upsert', agentId: 'a', id: 'open', title: 'Open' });
  await call({ op: 'tasks', action: 'upsert', agentId: 'a', id: 'closed', title: 'Closed' });
  await call({ op: 'tasks', action: 'complete', agentId: 'a', id: 'closed' });
  await broker.close();
  const file = path.join(dataDir, 'state.json'), state = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const task of state.rooms[0].tasks) { delete task.status; delete task.kind; delete task.completedAt; delete task.startedAt; }
  await fs.writeFile(file, JSON.stringify(state));
  broker = await createBroker({ dataDir });
  t.after(() => broker.close());
  const listed = (await call({ op: 'tasks', action: 'list' })).tasks;
  assert.deepEqual(listed.map(row => [row.id, row.state, row.status, row.kind]), [['open', 'open', 'todo', 'task'], ['closed', 'complete', 'done', 'task']]);
  const tree = await call({ op: 'tasks', action: 'tree' });
  assert.deepEqual(tree.counts.byStatus, { todo: 1, 'in-progress': 0, blocked: 0, review: 0, done: 1, cancelled: 0 });
  assert.equal((await call({ op: 'tasks', action: 'complete', agentId: 'a', id: 'open' })).task.status, 'done');
});

test('tree rolls progress up over leaves, excludes cancelled leaves and sorts siblings by order then creation', async t => {
  const f = await fixture(t);
  await f.register('a');
  await f.work({ id: 'r', kind: 'roadmap', title: 'R' });
  await f.work({ id: 'p1', kind: 'phase', title: 'P1', parentId: 'r', order: 2 });
  await f.work({ id: 'p2', kind: 'phase', title: 'P2', parentId: 'r', order: 1 });
  await f.work({ id: 'p3', kind: 'phase', title: 'P3', parentId: 'r' });
  await f.work({ id: 'p0', kind: 'phase', title: 'P0', parentId: 'r' });
  await f.work({ id: 'e1', kind: 'epic', title: 'E1', parentId: 'p1' });
  await f.work({ id: 't1', kind: 'task', title: 'T1', parentId: 'e1', status: 'done' });
  await f.work({ id: 't2', kind: 'task', title: 'T2', parentId: 'e1', status: 'in-progress' });
  await f.work({ id: 't3', kind: 'task', title: 'T3', parentId: 'e1', status: 'cancelled' });
  await f.work({ id: 'd1', kind: 'todo', title: 'D1', parentId: 't2', status: 'done' });
  await f.work({ id: 'd2', kind: 'todo', title: 'D2', parentId: 't2' });
  await f.work({ id: 'only-cancelled', kind: 'epic', title: 'Dead', parentId: 'p2', status: 'cancelled' });
  const { roots, counts } = await f.rpc({ op: 'tasks', action: 'tree' });
  assert.equal(roots.length, 1);
  const [root] = roots;
  assert.deepEqual(root.children.map(node => node.id), ['p2', 'p1', 'p3', 'p0']);
  const byId = Object.fromEntries(flat(roots).map(node => [node.id, node]));
  // Leaves under e1: t1 (done), d1 (done), d2 (open); t3 is cancelled and excluded.
  assert.deepEqual(byId.e1.progress, { done: 2, total: 3, percent: 67 });
  assert.deepEqual(byId.t2.progress, { done: 1, total: 2, percent: 50 });
  assert.deepEqual(byId.t1.progress, { done: 1, total: 1, percent: 100 });
  assert.deepEqual(byId.t3.progress, { done: 0, total: 0, percent: 0 });
  assert.deepEqual(byId['only-cancelled'].progress, { done: 0, total: 0, percent: 0 });
  assert.deepEqual(byId.p1.progress, { done: 2, total: 3, percent: 67 });
  assert.deepEqual(byId.p3.progress, { done: 0, total: 1, percent: 0 });
  assert.deepEqual(byId.r.progress, { done: 2, total: 5, percent: 40 });
  assert.equal(byId.t2.status, 'in-progress'); assert.equal(byId.t2.kind, 'task'); assert.ok(Array.isArray(byId.t2.blocking));
  assert.deepEqual(counts.byKind, { roadmap: 1, phase: 4, epic: 2, task: 3, todo: 2 });
  assert.deepEqual(counts.byStatus, { todo: 7, 'in-progress': 1, blocked: 0, review: 0, done: 2, cancelled: 2 });
  // Subtree, kind and includeDone views.
  const sub = await f.rpc({ op: 'tasks', action: 'tree', rootId: 'p1' });
  assert.deepEqual(sub.roots.map(node => node.id), ['p1']); assert.equal(sub.counts.byKind.roadmap, 0);
  const epics = await f.rpc({ op: 'tasks', action: 'tree', kind: 'epic' });
  assert.deepEqual(epics.roots.map(node => node.id).sort(), ['e1', 'only-cancelled']);
  const open = await f.rpc({ op: 'tasks', action: 'tree', includeDone: false });
  const openIds = flat(open.roots).map(node => node.id);
  assert.ok(!openIds.includes('t1') && !openIds.includes('t3') && !openIds.includes('d1') && !openIds.includes('only-cancelled'));
  assert.ok(openIds.includes('t2') && openIds.includes('d2'));
  // Pruning does not distort the rolled-up percentages.
  assert.deepEqual(flat(open.roots).find(node => node.id === 'e1').progress, { done: 2, total: 3, percent: 67 });
  await f.fails({ action: 'tree', rootId: 'missing' }, 'UNKNOWN_TASK', 404);
  await f.fails({ action: 'tree', includeDone: 'no' }, 'INVALID_INPUT');
  await f.fails({ action: 'tree', kind: 'saga' }, 'INVALID_INPUT');
  assert.deepEqual((await f.rpc({ op: 'tasks', action: 'tree' }, f.other)).roots, []);
  const text = renderTree({ roots, counts });
  assert.match(text, /^\[ \] roadmap: R /u);
  assert.match(text, /\[~\] task: T2 .*50% 1\/2 .*in-progress/u);
  assert.match(text, /^ {4}\[ \] epic: E1/mu);
  assert.equal(renderTree({ roots: [] }), '(no work items)');
});

test('move, remove and cascade keep the tree consistent and report dangling blockers', async t => {
  const f = await fixture(t);
  await f.register('a');
  await f.work({ id: 'r', kind: 'roadmap', title: 'R' });
  await f.work({ id: 'e1', kind: 'epic', title: 'E1', parentId: 'r' });
  await f.work({ id: 'e2', kind: 'epic', title: 'E2', parentId: 'r' });
  await f.work({ id: 't1', kind: 'task', title: 'T1', parentId: 'e1' });
  await f.work({ id: 't2', kind: 'task', title: 'T2', parentId: 'e1' });
  await f.work({ id: 'watcher', kind: 'task', title: 'Waits', blockedBy: ['t1', 'file.txt'] });
  const moved = (await f.act('move', { id: 't1', parentId: 'e2', order: 7 })).task;
  assert.equal(moved.parentId, 'e2'); assert.equal(moved.order, 7);
  const rooted = (await f.act('move', { id: 't1', parentId: null })).task;
  assert.equal(rooted.parentId, undefined);
  await f.act('move', { id: 't1', parentId: 'e1' });
  await f.fails({ action: 'move', id: 't1' }, 'INVALID_INPUT');
  await f.fails({ action: 'move', id: 'missing', parentId: null }, 'UNKNOWN_TASK', 404);
  await f.fails({ action: 'move', id: 't1', parentId: 'r', order: 1.5 }, 'INVALID_INPUT');
  await f.fails({ action: 'move', id: 'e1', parentId: 't1' }, 'WORK_CYCLE');
  await f.fails({ action: 'move', id: 'e1', parentId: 'ghost' }, 'UNKNOWN_PARENT', 404);
  // Remove refuses a parent with children unless cascade is given.
  const refused = await f.request({ op: 'tasks', action: 'remove', agentId: 'a', id: 'e1' });
  assert.equal(refused.error.code, 'HAS_CHILDREN'); assert.equal(refused.status, 409);
  assert.deepEqual(refused.error.children.sort(), ['t1', 't2']);
  assert.equal((await f.rpc({ op: 'tasks', action: 'list' })).tasks.length, 6);
  const leaf = await f.act('remove', { id: 't2' });
  assert.deepEqual(leaf.removed, ['t2']); assert.deepEqual(leaf.danglingRefs, []);
  const cascade = await f.act('remove', { id: 'e1', cascade: true });
  assert.deepEqual(cascade.removed.sort(), ['e1', 't1']);
  assert.deepEqual(cascade.danglingRefs, [{ id: 'watcher', ref: 't1' }]);
  const left = (await f.rpc({ op: 'tasks', action: 'list' })).tasks;
  assert.deepEqual(left.map(row => row.id).sort(), ['e2', 'r', 'watcher']);
  assert.equal(left.find(row => row.id === 'watcher').blocking.find(row => row.ref === 't1').kind, 'unknown');
  await f.fails({ action: 'remove', id: 'e1' }, 'UNKNOWN_TASK', 404);
  await f.fails({ action: 'remove', id: 'r', cascade: 'yes' }, 'INVALID_INPUT');
  await f.restart();
  assert.equal((await f.rpc({ op: 'tasks', action: 'list' })).tasks.length, 3);
});

test('list filters by kind, status, parent, branch and label alongside the legacy filters', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  await f.work({ id: 'e', kind: 'epic', title: 'E', labels: ['x'] });
  await f.work({ id: 't1', kind: 'task', title: 'T1', parentId: 'e', branch: 'feat/one', labels: ['x', 'y'], owner: 'b', status: 'in-progress' });
  await f.work({ id: 't2', kind: 'task', title: 'T2', parentId: 'e', branch: 'feat/two', labels: ['y'] });
  await f.work({ id: 'legacy', title: 'Legacy' });
  const ids = async fields => (await f.rpc({ op: 'tasks', action: 'list', ...fields })).tasks.map(row => row.id).sort();
  assert.deepEqual(await ids({ kind: 'task' }), ['legacy', 't1', 't2']);
  assert.deepEqual(await ids({ kind: 'epic' }), ['e']);
  assert.deepEqual(await ids({ status: 'in-progress' }), ['t1']);
  assert.deepEqual(await ids({ status: 'todo' }), ['e', 'legacy', 't2']);
  assert.deepEqual(await ids({ parentId: 'e' }), ['t1', 't2']);
  assert.deepEqual(await ids({ parentId: null }), ['e', 'legacy']);
  assert.deepEqual(await ids({ branch: 'feat/two' }), ['t2']);
  assert.deepEqual(await ids({ label: 'y' }), ['t1', 't2']);
  assert.deepEqual(await ids({ label: 'x', kind: 'task' }), ['t1']);
  assert.deepEqual(await ids({ owner: 'b', status: 'in-progress', state: 'open' }), ['t1']);
  assert.deepEqual(await ids({}), ['e', 'legacy', 't1', 't2']);
  for (const fields of [{ kind: 'x' }, { status: 'x' }, { branch: 5 }, { label: '' }]) {
    const result = await f.request({ op: 'tasks', action: 'list', ...fields });
    assert.equal(result.error.code, 'INVALID_INPUT', JSON.stringify(fields));
  }
});

test('old clients: upsert, list and complete keep their shapes and semantics', async t => {
  const f = await fixture(t);
  await f.register('worker'); await f.register('holder');
  await f.rpc({ op: 'claim', agentId: 'holder', resources: ['shared.txt'] });
  const created = (await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'worker', title: 'Fix route', owner: 'worker',
    blockedBy: ['shared.txt'], resources: ['shared.txt'], sourceRevision: 'abc', expectedRecipient: 'holder' })).task;
  assert.equal(created.state, 'open'); assert.equal(created.blocked, true);
  assert.deepEqual(created.blocking, [{ ref: 'shared.txt', kind: 'claim', scope: 'project', holder: 'holder', state: 'held' }]);
  for (const key of ['parentId', 'description', 'priority', 'labels', 'order', 'branch', 'artifacts', 'dueAt', 'startedAt', 'completedAt']) {
    assert.equal(created[key], undefined, key);
  }
  assert.deepEqual(created.blockedReasons, ['blockers']);
  assert.equal((await f.request({ op: 'tasks', action: 'upsert', agentId: 'worker' })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'tasks', action: 'bogus', agentId: 'worker' })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'tasks', action: 'complete', agentId: 'worker', id: 'missing' })).error.code, 'UNKNOWN_TASK');
  const done = (await f.rpc({ op: 'tasks', action: 'complete', agentId: 'worker', id: created.id, verification: 'ok' })).task;
  assert.equal(done.state, 'complete'); assert.equal(done.verification, 'ok');
  assert.deepEqual((await f.rpc({ op: 'tasks', action: 'list', state: 'open' })).tasks, []);
  assert.equal((await f.rpc({ op: 'tasks', action: 'list', state: 'complete' })).tasks.length, 1);
});

test('markdown import builds the tree, reads metadata, re-imports idempotently and previews with dryRun', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('serge');
  const markdown = `# Agent Relay 1.0
Status: in-progress
Owner: serge
Branch: main

The big picture.

## Phase 1: Foundations
Status: done
Priority: p1
Labels: core, infra

### Epic: Broker
Owner: serge
Branch: feature/broker

- [x] Durable store
- [ ] Capabilities
  - [ ] Advertise features
  - [x] Gate the client
    - [ ] Deeper nesting flattens to a todo
- [ ] Docs

\`\`\`
# not a heading
- [ ] not an item
\`\`\`

## Phase 2: Launch
### Epic: Site
- [ ] Landing page
`;
  const dry = (await f.rpc({ op: 'tasks', action: 'import', markdown, dryRun: true })).tree;
  assert.equal((await f.rpc({ op: 'tasks', action: 'list' })).tasks.length, 0);
  const dryFlat = flat(dry);
  assert.equal(dryFlat.length, 12);
  assert.ok(dryFlat.every(node => node.action === 'created'));
  const result = await f.act('import', { markdown });
  assert.equal(result.dryRun, false); assert.equal(result.created.length, 12); assert.deepEqual(result.updated, []);
  assert.deepEqual(result.created.map(row => row.id).sort(), dryFlat.map(node => node.id).sort());
  const tree = (await f.rpc({ op: 'tasks', action: 'tree' }));
  assert.equal(tree.roots.length, 1);
  const [roadmap] = tree.roots;
  assert.equal(roadmap.title, 'Agent Relay 1.0'); assert.equal(roadmap.kind, 'roadmap'); assert.equal(roadmap.status, 'in-progress');
  assert.equal(roadmap.owner, 'serge'); assert.equal(roadmap.branch, 'main'); assert.equal(roadmap.description, 'The big picture.');
  assert.deepEqual(roadmap.children.map(node => [node.kind, node.title]), [['phase', 'Phase 1: Foundations'], ['phase', 'Phase 2: Launch']]);
  const [phase1, phase2] = roadmap.children;
  assert.equal(phase1.status, 'done'); assert.equal(phase1.priority, 'p1'); assert.deepEqual(phase1.labels, ['core', 'infra']);
  const [broker] = phase1.children;
  assert.equal(broker.kind, 'epic'); assert.equal(broker.owner, 'serge'); assert.equal(broker.branch, 'feature/broker');
  assert.deepEqual(broker.children.map(node => [node.kind, node.title, node.status]),
    [['task', 'Durable store', 'done'], ['task', 'Capabilities', 'todo'], ['task', 'Docs', 'todo']]);
  const capabilities = broker.children[1];
  assert.deepEqual(capabilities.children.map(node => [node.kind, node.title, node.status]),
    [['todo', 'Advertise features', 'todo'], ['todo', 'Gate the client', 'done'], ['todo', 'Deeper nesting flattens to a todo', 'todo']]);
  assert.deepEqual(phase2.children[0].children.map(node => node.title), ['Landing page']);
  assert.ok(!flat(tree.roots).some(node => /not a heading|not an item/u.test(node.title)));
  assert.equal(tree.counts.byKind.todo, 3);
  // Re-importing the same document is a no-op; no duplicates and no churn.
  const before = (await f.store()).rooms[0].tasks;
  const again = await f.act('import', { markdown });
  assert.equal(again.created.length, 0); assert.equal(again.updated.length, 0); assert.equal(again.unchanged.length, 12);
  assert.deepEqual((await f.store()).rooms[0].tasks, before);
  // Edited checkboxes and metadata update in place; a progressed item keeps its status.
  await f.work({ id: capabilities.id, status: 'in-progress' });
  const edited = markdown.replace('- [ ] Docs', '- [x] Docs').replace('Branch: main', 'Branch: release/1.0')
    .replace('- [ ] Landing page', '- [x] Landing page\n- [ ] Pricing page');
  const reimport = await f.act('import', { markdown: edited });
  assert.deepEqual(reimport.created.map(row => row.title), ['Pricing page']);
  assert.deepEqual(reimport.updated.map(row => row.title).sort(), ['Agent Relay 1.0', 'Docs', 'Landing page']);
  const after = await f.rpc({ op: 'tasks', action: 'list' });
  assert.equal(after.tasks.length, 13);
  const row = title => after.tasks.find(task => task.title === title);
  assert.equal(row('Docs').status, 'done'); assert.equal(row('Docs').state, 'complete');
  assert.equal(row('Agent Relay 1.0').branch, 'release/1.0');
  assert.equal(row('Capabilities').status, 'in-progress');
  // An unchecked box reopens a finished item.
  const reopen = await f.act('import', { markdown: edited.replace('- [x] Docs', '- [ ] Docs') });
  assert.equal(reopen.updated.find(task => task.title === 'Docs').state, 'open');
  // dryRun against existing items reports updates and leaves the ledger alone.
  const preview = await f.rpc({ op: 'tasks', action: 'import', markdown: edited, dryRun: true });
  assert.ok(preview.updated.length >= 1 && preview.created.length === 0);
  assert.equal(flat(preview.tree).find(node => node.title === 'Docs').action, 'updated');
  assert.equal((await f.rpc({ op: 'tasks', action: 'list' })).tasks.length, 13);
});

test('import into a parent, duplicate titles, and error reporting', async t => {
  const f = await fixture(t);
  await f.register('a');
  await f.work({ id: 'host', kind: 'epic', title: 'Host epic' });
  const result = await f.act('import', { parentId: 'host', markdown: '- [ ] Same\n- [ ] Same\n- [x] Other\n  - [ ] Child' });
  assert.equal(result.created.length, 4);
  assert.equal(new Set(result.created.map(row => row.id)).size, 4);
  const tree = (await f.rpc({ op: 'tasks', action: 'tree', rootId: 'host' })).roots[0];
  assert.deepEqual(tree.children.map(node => node.title), ['Same', 'Same', 'Other']);
  assert.deepEqual(tree.children.map(node => node.order), [0, 1, 2]);
  assert.equal((await f.act('import', { parentId: 'host', markdown: '- [ ] Same\n- [ ] Same\n- [x] Other\n  - [ ] Child' })).created.length, 0);
  // The same document under another parent is a distinct set of items.
  await f.work({ id: 'host2', kind: 'epic', title: 'Host two' });
  assert.equal((await f.act('import', { parentId: 'host2', markdown: '- [ ] Same' })).created.length, 1);
  const failsImport = async (fields, code, pattern) => {
    const result = await f.request({ op: 'tasks', action: 'import', agentId: 'a', ...fields });
    assert.equal(result.ok, false, JSON.stringify(fields)); assert.equal(result.error.code, code);
    if (pattern) assert.match(result.error.message, pattern);
  };
  await failsImport({ markdown: 'just prose' }, 'INVALID_INPUT', /No headings/u);
  await failsImport({ markdown: '' }, 'INVALID_INPUT');
  await failsImport({ markdown: 5 }, 'INVALID_INPUT');
  await failsImport({ markdown: 'x'.repeat(100 * 1024) }, 'INVALID_INPUT');
  await failsImport({ markdown: '# R\nStatus: finished-ish' }, 'INVALID_INPUT', /line 2/u);
  await failsImport({ markdown: '# R\nBranch: no good' }, 'INVALID_INPUT', /line 2/u);
  await failsImport({ markdown: '# R\nPriority: urgent' }, 'INVALID_INPUT', /line 2/u);
  await failsImport({ markdown: '# R\nOwner: nobody' }, 'UNKNOWN_AGENT', /line 2/u);
  await failsImport({ markdown: '- [ ] x', parentId: 'ghost' }, 'UNKNOWN_PARENT');
  await failsImport({ markdown: '# R', parentId: 'host' }, 'INVALID_HIERARCHY');
  await failsImport({ markdown: '- [ ] x', dryRun: 'yes' }, 'INVALID_INPUT');
  const noRoom = await f.request({ op: 'tasks', action: 'import', agentId: 'a', markdown: '- [ ] x' }, f.other);
  assert.equal(noRoom.error.code, 'UNKNOWN_ROOM');
  // A dry run needs no registered agent and previews in an empty room.
  const preview = await f.rpc({ op: 'tasks', action: 'import', markdown: '# R\n- [ ] x', dryRun: true }, f.other);
  assert.equal(preview.tree[0].children.length, 1);
  // Failed imports persist nothing: the earlier items are the only ones.
  assert.equal((await f.rpc({ op: 'tasks', action: 'list' })).tasks.length, 7);
  const mixed = await f.request({ op: 'tasks', action: 'import', agentId: 'a', markdown: '- [ ] fine\n# bad\nOwner: nobody' });
  assert.equal(mixed.ok, false);
  assert.equal((await f.rpc({ op: 'tasks', action: 'list' })).tasks.length, 7);
});

test('MAX_TASKS is 4096: imports beyond the bound are rejected atomically', async t => {
  assert.equal(MAX_TASKS, 4096);
  const f = await fixture(t);
  await f.register('a');
  const items = count => Array.from({ length: count }, (_, i) => `- [ ] item ${String(i).padStart(4, '0')}`).join('\n');
  const over = await f.request({ op: 'tasks', action: 'import', agentId: 'a', markdown: items(4097) });
  assert.equal(over.error.code, 'TASK_LIMIT'); assert.equal(over.status, 409);
  assert.equal((await f.rpc({ op: 'tasks', action: 'list' })).tasks.length, 0);
  const full = await f.act('import', { markdown: items(4096) });
  assert.equal(full.created.length, 4096);
  const usage = await f.rpc({ op: 'usage' });
  assert.deepEqual(usage.tasks, { used: 4096, limit: 4096 });
  const refused = await f.request({ op: 'tasks', action: 'upsert', agentId: 'a', title: 'One too many' });
  assert.equal(refused.error.code, 'TASK_LIMIT');
  const reimport = await f.act('import', { markdown: items(4096) });
  assert.equal(reimport.unchanged.length, 4096);
});

function room(tasks, extra = {}) {
  const at = '2026-01-01T00:00:00.000Z';
  return { version: 1, nextCursor: 1, rooms: [{ project: path.resolve('/tmp/work-room'), cursor: 0, messages: [], claims: [],
    agents: [{ agentId: 'a', runner: 'x', registeredAt: at, updatedAt: at, status: 'idle', frozen: false, resources: [], task: null }],
    tasks: tasks.map(task => ({ creator: 'a', state: 'open', createdAt: at, updatedAt: at, ...task })), ...extra }] };
}
test('validateStore accepts old and new task shapes and rejects invalid work-item fields', () => {
  assert.doesNotThrow(() => validateStore(room([{ id: 'old', title: 'Old' }, { id: 'old2', title: 'Old', state: 'complete' }])));
  assert.doesNotThrow(() => validateStore(room([])));
  assert.doesNotThrow(() => validateStore(room([
    { id: 'r', title: 'R', kind: 'roadmap', status: 'in-progress', startedAt: '2026-01-02T00:00:00.000Z' },
    { id: 'e', title: 'E', kind: 'epic', parentId: 'r', priority: 'p0', labels: ['a'], order: 4, branch: 'feat/x',
      artifacts: ['reports/a'], dueAt: '2026-02-01T00:00:00.000Z', description: 'text' },
    { id: 'd', title: 'D', kind: 'task', parentId: 'e', status: 'done', state: 'complete', completedAt: '2026-01-03T00:00:00.000Z' },
    { id: 'legacy', title: 'L', parentId: 'e' }])));
  const invalid = [
    { kind: 'saga' }, { status: 'finished' }, { status: 'done' }, { status: 'todo', state: 'complete' }, { status: 'cancelled' },
    { parentId: 'missing' }, { parentId: 'bad' }, { parentId: '' }, { description: '' }, { description: 'x'.repeat(8193) },
    { priority: 'p5' }, { labels: [] }, { labels: ['a', 'a'] }, { labels: Array.from({ length: 17 }, (_, i) => 'l' + i) }, { labels: [5] },
    { order: 1.5 }, { order: Number.MAX_SAFE_INTEGER + 2 }, { branch: 'no good' }, { artifacts: [] },
    { artifacts: Array.from({ length: 33 }, (_, i) => 'a' + i) }, { dueAt: 'tomorrow' }, { startedAt: 5 }, { completedAt: '' },
  ];
  for (const bad of invalid) {
    assert.throws(() => validateStore(room([{ id: 'p', title: 'P', kind: 'epic' }, { id: 'bad', title: 'Bad', ...bad }])), /corrupt/u, JSON.stringify(bad));
  }
  // Hierarchy: parent must strictly outrank the child; no self-parenting or cycles.
  assert.throws(() => validateStore(room([{ id: 'a1', title: 'A', kind: 'task' }, { id: 'a2', title: 'B', kind: 'task', parentId: 'a1' }])), /corrupt/u);
  assert.throws(() => validateStore(room([{ id: 'a1', title: 'A', kind: 'epic', parentId: 'a1' }])), /corrupt/u);
  assert.throws(() => validateStore(room([{ id: 'a1', title: 'A', kind: 'epic', parentId: 'a2' },
    { id: 'a2', title: 'B', kind: 'epic', parentId: 'a1' }])), /corrupt/u);
  assert.throws(() => validateStore(room([{ id: 't', title: 'T', kind: 'todo' }, { id: 'e', title: 'E', kind: 'epic', parentId: 't' }])), /corrupt/u);
  // Bounds on the ledger itself.
  const many = count => Array.from({ length: count }, (_, i) => ({ id: 'id-' + i, title: 'T' + i }));
  assert.doesNotThrow(() => validateStore(room(many(MAX_TASKS))));
  assert.throws(() => validateStore(room(many(MAX_TASKS + 1))), /corrupt/u);
});

test('client gates work-item fields and actions on the advertised capabilities', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-work-capability-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'broker.json'), JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:12399', token: 'fixture' }));
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const cases = [
    [{ op: 'tasks', action: 'list' }, ['tasks'], []],
    [{ op: 'tasks', action: 'upsert', agentId: 'a', title: 'x' }, ['tasks'], []],
    [{ op: 'tasks', action: 'complete', agentId: 'a', id: 'x' }, ['tasks'], []],
    [{ op: 'tasks', action: 'upsert', agentId: 'a', title: 'x', kind: 'epic' }, ['tasks'], ['work-items']],
    [{ op: 'tasks', action: 'upsert', agentId: 'a', title: 'x', parentId: null }, ['tasks'], ['work-items']],
    [{ op: 'tasks', action: 'list', label: 'x' }, ['tasks'], ['work-items']],
    [{ op: 'tasks', action: 'move', agentId: 'a', id: 'x', parentId: null }, ['tasks'], ['work-items']],
    [{ op: 'tasks', action: 'remove', agentId: 'a', id: 'x' }, ['tasks', 'work-items'], []],
    [{ op: 'tasks', action: 'tree' }, ['tasks', 'work-items'], ['work-tree']],
    [{ op: 'tasks', action: 'tree' }, ['tasks', 'work-tree'], ['work-items']],
    [{ op: 'tasks', action: 'tree' }, ['tasks', 'work-items', 'work-tree'], []],
    [{ op: 'tasks', action: 'import', agentId: 'a', markdown: '# x' }, ['tasks', 'work-items'], ['work-import']],
    [{ op: 'tasks', action: 'import', agentId: 'a', markdown: '# x' }, ['tasks', 'work-items', 'work-import'], []],
    [{ op: 'tasks', action: 'upsert', agentId: 'a', title: 'x', kind: 'epic' }, [], ['tasks', 'work-items']],
  ];
  for (const [fields, advertised, missing] of cases) {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      if (url.endsWith('/health')) return { ok: true };
      const input = JSON.parse(opts.body); calls.push(input.op);
      if (input.op === 'capabilities') return { ok: true, json: async () => ({ ok: true, features: advertised }) };
      return { ok: true, json: async () => ({ ok: true }) };
    };
    if (missing.length) {
      const error = await clientRpc('/tmp', fields, { dataDir: dir }).then(() => null, e => e);
      assert.equal(error?.code, 'UNSUPPORTED_FEATURE', JSON.stringify(fields));
      for (const name of missing) assert.ok(error.message.includes(name), error.message);
      assert.deepEqual(calls, ['capabilities']);
    } else {
      await clientRpc('/tmp', fields, { dataDir: dir });
      assert.deepEqual(calls, ['capabilities', 'tasks']);
    }
  }
});

test('broker advertises the work-item features', async t => {
  const f = await fixture(t);
  const { features } = await f.rpc({ op: 'capabilities' });
  for (const name of ['tasks', 'work-items', 'work-tree', 'work-import']) assert.ok(features.includes(name), name);
});

test('MCP relay_tasks and relay_roadmap expose the hierarchy end to end', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-mcp-work-'));
  const dataDir = path.join(root, 'data'), project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  const broker = await createBroker({ dataDir });
  const saved = process.env.AGENT_RELAY_TEST_ROOM; delete process.env.AGENT_RELAY_TEST_ROOM;
  t.after(async () => { if (saved !== undefined) process.env.AGENT_RELAY_TEST_ROOM = saved; await broker.close(); await fs.rm(root, { recursive: true, force: true }); });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const adapter = await createMcpAdapter({ project, runner: 'claude', sessionId: 'work-mcp',
    rpcImpl: async (target, fields) => (await fetch(broker.url + '/rpc', { method: 'POST',
      headers: { authorization: 'Bearer ' + broker.token, 'content-type': 'application/json' },
      body: JSON.stringify({ project: target, ...fields }) })).json(),
    waitImpl: async () => assert.fail('no watcher') });
  const client = new Client({ name: 'work', version: '1' });
  await adapter.start(serverTransport); await client.connect(clientTransport);
  t.after(async () => { try { await adapter.close(); } catch {} try { await client.close(); } catch {} });
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  const tools = (await client.listTools()).tools;
  const roadmapTool = tools.find(tool => tool.name === 'relay_roadmap');
  assert.equal(roadmapTool.annotations.readOnlyHint, true);
  assert.ok(tools.find(tool => tool.name === 'relay_tasks').inputSchema.properties.kind.enum.includes('roadmap'));
  const r = (await call('relay_tasks', { action: 'upsert', id: 'r', title: 'R', kind: 'roadmap', priority: 'p0', labels: ['a'] })).task;
  assert.equal(r.kind, 'roadmap'); assert.deepEqual(r.labels, ['a']);
  await call('relay_tasks', { action: 'upsert', id: 'e', title: 'E', kind: 'epic', parentId: 'r', branch: 'feat/e', order: 1 });
  await call('relay_tasks', { action: 'upsert', id: 't', title: 'T', kind: 'task', parentId: 'e', status: 'done', artifacts: ['reports/x'] });
  const tree = await call('relay_roadmap', {});
  assert.equal(tree.roots[0].children[0].children[0].id, 't');
  assert.equal(tree.roots[0].progress.percent, 100);
  assert.equal((await call('relay_roadmap', { kind: 'epic' })).roots[0].branch, 'feat/e');
  assert.equal((await call('relay_roadmap', { rootId: 'e', includeDone: false })).roots[0].children.length, 0);
  assert.equal((await call('relay_tasks', { action: 'list', kind: 'task', label: 'a' })).tasks.length, 0);
  assert.equal((await call('relay_tasks', { action: 'move', id: 'e', parentId: null })).task.parentId, undefined);
  const imported = await call('relay_tasks', { action: 'import', markdown: '# Imported\n- [ ] one', dryRun: true });
  assert.equal(imported.dryRun, true);
  assert.equal((await call('relay_tasks', { action: 'import', markdown: '# Imported\n- [ ] one' })).created.length, 2);
  const removed = await call('relay_tasks', { action: 'remove', id: 'r', cascade: true });
  assert.ok(removed.removed.includes('r'));
  for (const [name, args] of [['relay_tasks', { action: 'upsert', kind: 'saga' }], ['relay_tasks', { action: 'list', labels: Array.from({ length: 17 }, (_, i) => 'l' + i) }],
    ['relay_tasks', { action: 'upsert', parentId: 5 }], ['relay_tasks', { action: 'remove', cascade: 'yes' }], ['relay_roadmap', { kind: 'saga' }], ['relay_roadmap', { extra: 1 }]]) {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, true, JSON.stringify([name, args]));
  }
  const failure = await call('relay_tasks', { action: 'upsert', title: 'Bad', kind: 'task', parentId: 'ghost' });
  assert.equal(failure.ok, false);
});

test('OpenCode relay_tasks and relay_roadmap mirror the hierarchy tools', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-opencode-work-'));
  const dataDir = path.join(root, 'data'), project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true }); });
  const transport = {
    async rpc(target, fields) {
      return (await fetch(broker.url + '/rpc', { method: 'POST', headers: { authorization: 'Bearer ' + broker.token, 'content-type': 'application/json' },
        body: JSON.stringify({ project: target, ...fields }) })).json();
    },
    wait(target, agentId, after, { signal }) {
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
  };
  const client = { tui: { async showToast() { return { data: true }; } },
    session: { async status() { return { data: {} }; }, async promptAsync() { return { data: undefined }; } } };
  const hooks = await AgentRelayPlugin({ client, directory: project, worktree: project }, { transport });
  t.after(() => hooks.dispose());
  const ctx = () => ({ sessionID: 'ses_work', directory: project, worktree: project, abort: new AbortController().signal });
  const schemas = Object.fromEntries(Object.entries(hooks.tool).map(([name, definition]) => [name, z.object(definition.args)]));
  schemas.relay_tasks.parse({ action: 'upsert', title: 'x', kind: 'epic', parentId: null, status: 'in-progress', labels: ['a'], order: 3,
    artifacts: ['a'], branch: 'b', priority: 'p2', dueAt: '2026-01-01', description: 'd' });
  schemas.relay_tasks.parse({ action: 'tree' }); schemas.relay_tasks.parse({ action: 'import', markdown: '# x', dryRun: true });
  assert.throws(() => schemas.relay_tasks.parse({ action: 'upsert', kind: 'saga' }));
  assert.throws(() => schemas.relay_tasks.parse({ action: 'purge' }));
  schemas.relay_roadmap.parse({}); schemas.relay_roadmap.parse({ rootId: 'x', kind: 'epic', includeDone: false });
  assert.throws(() => schemas.relay_roadmap.parse({ kind: 'saga' }));
  const call = async (name, args) => JSON.parse(await hooks.tool[name].execute(args, ctx()));
  await call('relay_tasks', { action: 'upsert', id: 'r', title: 'R', kind: 'roadmap' });
  await call('relay_tasks', { action: 'upsert', id: 't', title: 'T', kind: 'task', parentId: 'r', status: 'done' });
  const tree = await call('relay_roadmap', {});
  assert.equal(tree.roots[0].children[0].id, 't'); assert.equal(tree.roots[0].progress.percent, 100);
  assert.equal((await call('relay_roadmap', { kind: 'task', includeDone: false })).roots.length, 0);
  assert.equal((await call('relay_tasks', { action: 'move', id: 't', parentId: null })).task.parentId, undefined);
  assert.equal((await call('relay_tasks', { action: 'list', kind: 'roadmap' })).tasks.length, 1);
  assert.equal((await call('relay_tasks', { action: 'import', markdown: '# Imp\n- [ ] x' })).created.length, 2);
  assert.deepEqual((await call('relay_tasks', { action: 'remove', id: 't' })).removed, ['t']);
});

test('real CLI manages work items with add, set, move, tree --pretty, import and rm', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-cli-work-'));
  const project = path.join(root, 'project'), dataDir = path.join(root, 'data');
  await fs.mkdir(project);
  t.after(async () => {
    try { const { pid } = JSON.parse(await fs.readFile(path.join(dataDir, 'broker.json'), 'utf8')); process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 20)); } catch { break; } } } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });
  const raw = async (...args) => (await exec(process.execPath, [cli, ...args, '--project', project, '--data-dir', dataDir], { timeout: 20000 })).stdout;
  const run = async (...args) => JSON.parse(await raw(...args));
  await run('join', '--as', 'a', '--runner', 'codex');
  await run('join', '--as', 'serge', '--runner', 'claude');
  const roadmap = await run('work', 'add', '--as', 'a', '--kind', 'roadmap', '--title', 'Plan', '--id', 'plan');
  assert.equal(roadmap.task.kind, 'roadmap');
  const epic = await run('work', 'add', '--as', 'a', '--kind', 'epic', '--title', 'Epic', '--parent', 'plan', '--owner', 'serge',
    '--branch', 'feat/epic', '--priority', 'p1', '--label', 'x,y', '--id', 'epic', '--order', '2');
  assert.deepEqual([epic.task.parentId, epic.task.owner, epic.task.branch, epic.task.priority, epic.task.labels, epic.task.order],
    ['plan', 'serge', 'feat/epic', 'p1', ['x', 'y'], 2]);
  await run('work', 'add', '--as', 'a', '--kind', 'task', '--title', 'Task', '--parent', 'epic', '--id', 'task');
  const set = await run('work', 'set', '--as', 'a', '--id', 'task', '--status', 'in-progress');
  assert.equal(set.task.status, 'in-progress'); assert.ok(set.task.startedAt);
  assert.equal((await run('work', 'set', '--as', 'a', '--id', 'task', '--status', 'done')).task.state, 'complete');
  const tree = await run('work', 'tree');
  assert.equal(tree.roots[0].progress.percent, 100);
  assert.deepEqual((await run('work', 'tree', '--kind', 'epic')).roots.map(node => node.id), ['epic']);
  assert.equal((await run('work', 'tree', '--root', 'epic', '--hide-done')).roots[0].children.length, 0);
  const pretty = await raw('work', 'tree', '--pretty');
  assert.match(pretty, /roadmap: Plan .*100%/u); assert.match(pretty, /^ {2}\[ \] epic: Epic/mu); assert.match(pretty, /@serge/u);
  assert.equal((await run('work', 'list', '--kind', 'task')).tasks.length, 1);
  assert.equal((await run('work', 'list', '--parent', 'root')).tasks.length, 1);
  assert.equal((await run('work', 'list', '--label', 'x')).tasks[0].id, 'epic');
  const moved = await run('work', 'move', '--as', 'a', '--id', 'task', '--parent', 'root');
  assert.equal(moved.task.parentId, undefined);
  await run('work', 'move', '--as', 'a', '--id', 'task', '--parent', 'epic', '--order', '5');
  await assert.rejects(run('work', 'rm', '--as', 'a', '--id', 'epic'), /descendant/u);
  await assert.rejects(run('work', 'move', '--as', 'a', '--id', 'task'), /--parent/u);
  await assert.rejects(run('work', 'add', '--as', 'a', '--kind', 'task', '--title', 'x', '--order', 'abc'), /integer/u);
  await assert.rejects(run('work', 'bogus'), /work tree/u);
  const file = path.join(root, 'ROADMAP.md');
  await fs.writeFile(file, '# Imported\nOwner: serge\n\n## Phase A\n- [ ] first\n- [x] second\n');
  const dry = await run('work', 'import', '--file', file, '--dry-run');
  assert.equal(dry.dryRun, true); assert.equal(dry.created.length, 4);
  const imported = await run('work', 'import', '--file', file, '--as', 'a');
  assert.equal(imported.created.length, 4);
  assert.equal((await run('work', 'import', '--file', file, '--as', 'a')).unchanged.length, 4);
  const nested = await run('work', 'import', '--file', file, '--as', 'a', '--parent', 'plan').catch(error => error);
  assert.match(String(nested.stderr ?? nested), /rank|hierarchy/iu);
  const removed = await run('work', 'rm', '--as', 'a', '--id', 'plan', '--cascade');
  assert.deepEqual(removed.removed.sort(), ['epic', 'plan', 'task']);
  assert.equal((await run('tasks')).tasks.length, 4);
  // Legacy commands still work against the same ledger.
  const legacy = await run('task-upsert', '--as', 'a', '--title', 'Legacy');
  assert.equal(legacy.task.status, 'todo');
  assert.equal((await run('task-complete', '--as', 'a', '--id', legacy.task.id)).task.state, 'complete');
});
