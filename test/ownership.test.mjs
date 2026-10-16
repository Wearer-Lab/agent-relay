import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createBroker, validateStore } from '../lib/broker.mjs';
import { gitContext, listWorktrees, listBranches, buildOwnership } from '../lib/ownership.mjs';
import { rpc as clientRpc } from '../lib/client.mjs';
import { createMcpAdapter } from '../lib/mcp.mjs';
import { AgentRelayPlugin } from '../lib/opencode-plugin.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/agent-relay.mjs', import.meta.url));
const identity = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...args) => run('git', [...identity, ...args], { cwd });
let gitAvailable = true;
try { await run('git', ['--version']); } catch { gitAvailable = false; }
const gitTest = (name, fn) => test(name, async t => {
  if (!gitAvailable) { t.skip('git is unavailable'); return; }
  await fn(t);
});

/** A repo with main, linked worktrees for each branch, and a broker whose rooms are the worktree directories. */
async function world(t, { worktrees = ['feature', 'bugfix'], broker: withBroker = true, staleMinutes } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-own-')));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, 'init', '-b', 'main');
  await fs.writeFile(path.join(repo, 'file.txt'), 'x');
  await git(repo, 'add', 'file.txt');
  await git(repo, 'commit', '-m', 'init');
  const trees = {};
  for (const name of worktrees) {
    trees[name] = path.join(root, `wt-${name}`);
    await git(repo, 'worktree', 'add', trees[name], '-b', name);
  }
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir);
  const broker = withBroker ? await createBroker({ dataDir, ...(staleMinutes === undefined ? {} : { staleMinutes }) }) : null;
  t.after(async () => { await broker?.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  async function request(fields, room = repo) {
    const response = await fetch(`${broker.url}/rpc`, { method: 'POST',
      headers: { authorization: `Bearer ${broker.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ project: room, ...fields }) });
    return { status: response.status, ...(await response.json()) };
  }
  async function call(fields, room) {
    const result = await request(fields, room);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  }
  const join = (id, room = repo) => call({ op: 'register', agentId: id, runner: 'test' }, room);
  return { root, repo, trees, dataDir, broker, request, call, join };
}

gitTest('git helpers report branch, detached HEAD, worktrees, branches and fail closed', async t => {
  const w = await world(t, { worktrees: ['feature'], broker: false });
  const ctx = await gitContext(w.trees.feature);
  assert.equal(ctx.branch, 'feature');
  assert.match(ctx.head, /^[0-9a-f]{40}$/u);
  assert.equal(ctx.worktree, w.trees.feature);
  assert.equal(ctx.commonDir, path.join(w.repo, '.git'));
  assert.equal((await gitContext(path.join(w.repo, 'nested-missing'))), null);
  assert.equal(await gitContext(w.root), null);
  assert.equal(await gitContext(undefined), null);
  await git(w.trees.feature, 'checkout', '--detach');
  assert.equal((await gitContext(w.trees.feature)).branch, null);
  const rows = await listWorktrees(ctx.commonDir);
  assert.deepEqual(rows.map(row => [row.path, row.branch, row.detached, row.bare, row.prunable]),
    [[w.repo, 'main', false, false, false], [w.trees.feature, null, true, false, false]]);
  assert.equal(await listWorktrees(w.root), null);
  assert.equal(await listWorktrees(''), null);
  await fs.rm(w.trees.feature, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  assert.equal((await listWorktrees(w.repo)).find(row => row.path.endsWith('wt-feature')).prunable, true);
  await git(w.repo, 'branch', 'topic');
  const branches = await listBranches(w.repo);
  assert.deepEqual(branches.map(row => row.name).sort(), ['feature', 'main', 'topic']);
  for (const row of branches) {
    assert.match(row.head, /^[0-9a-f]{40}$/u);
    assert.equal(row.upstream, null);
    assert.equal(new Date(row.committedAt).toISOString(), row.committedAt);
  }
  assert.equal(await listBranches(w.root), null);
});

gitTest('branch claims conflict across worktree rooms of one repo and are idempotent for the holder', async t => {
  const w = await world(t);
  await w.join('a', w.trees.feature); await w.join('b', w.trees.bugfix);
  const first = await w.call({ op: 'branches', action: 'claim', agentId: 'a', branch: 'feature', note: 'auth work', meta: { baseCommit: 'abc' } }, w.trees.feature);
  assert.equal(first.created, true);
  assert.equal(first.claim.repo, path.join(w.repo, '.git'));
  assert.deepEqual(first.claim.meta, { baseCommit: 'abc' });
  const again = await w.call({ op: 'branches', action: 'claim', agentId: 'a', branch: 'refs/heads/feature' }, w.trees.feature);
  assert.equal(again.created, false);
  assert.equal(again.claim.claimedAt, first.claim.claimedAt);
  assert.equal(again.claim.note, 'auth work');
  const refused = await w.request({ op: 'branches', action: 'claim', agentId: 'b', branch: 'feature' }, w.trees.bugfix);
  assert.equal(refused.status, 409);
  assert.equal(refused.error.code, 'CLAIM_CONFLICT');
  assert.equal(refused.error.conflicts[0].agentId, 'a');
  assert.equal(refused.error.conflicts[0].project, w.trees.feature);
  assert.equal(refused.error.conflicts[0].holder, 'active');
  assert.equal(refused.error.conflicts[0].live, true);
  // The same agent ID in another room of the repo is a different holder.
  await w.join('a', w.trees.bugfix);
  assert.equal((await w.request({ op: 'branches', action: 'claim', agentId: 'a', branch: 'feature' }, w.trees.bugfix)).error.code, 'CLAIM_CONFLICT');
  const listed = await w.call({ op: 'branches', action: 'list' }, w.trees.bugfix);
  assert.equal(listed.claims.length, 1);
  assert.equal(listed.git, true);
  assert.equal(listed.claims[0].branch, 'feature');
  // Updating the note keeps the original claim time.
  const noted = await w.call({ op: 'branches', action: 'claim', agentId: 'a', branch: 'feature', note: 'new note' }, w.trees.feature);
  assert.equal(noted.claim.note, 'new note');
  assert.equal(noted.claim.claimedAt, first.claim.claimedAt);
  for (const bad of ['', '   ', 'a\nb', 'x'.repeat(257), 7]) {
    assert.equal((await w.request({ op: 'branches', action: 'claim', agentId: 'a', branch: bad }, w.trees.feature)).error.code, 'INVALID_INPUT', String(bad));
  }
  assert.equal((await w.request({ op: 'branches', action: 'claim', agentId: 'a', branch: 'x', meta: { nope: 'x' } }, w.trees.feature)).error.code, 'INVALID_INPUT');
  assert.equal((await w.request({ op: 'branches', action: 'claim', agentId: 'ghost', branch: 'x' }, w.trees.feature)).error.code, 'UNKNOWN_AGENT');
  assert.equal((await w.request({ op: 'branches', action: 'mystery' }, w.trees.feature)).error.code, 'INVALID_INPUT');
});

gitTest('branch claims do not conflict across repos or non-git projects but do within one non-git project', async t => {
  const w = await world(t, { worktrees: [] });
  const other = path.join(w.root, 'other');
  await fs.mkdir(other);
  await git(other, 'init', '-b', 'main');
  const plain = path.join(w.root, 'plain'), plainB = path.join(w.root, 'plain-b');
  await fs.mkdir(plain); await fs.mkdir(plainB);
  await w.join('a'); await w.join('b', other); await w.join('c', plain); await w.join('d', plainB); await w.join('e', plain);
  await w.call({ op: 'branches', action: 'claim', agentId: 'a', branch: 'main' });
  await w.call({ op: 'branches', action: 'claim', agentId: 'b', branch: 'main' }, other);
  await w.call({ op: 'branches', action: 'claim', agentId: 'c', branch: 'main' }, plain);
  await w.call({ op: 'branches', action: 'claim', agentId: 'd', branch: 'main' }, plainB);
  assert.equal((await w.request({ op: 'branches', action: 'claim', agentId: 'e', branch: 'main' }, plain)).error.code, 'CLAIM_CONFLICT');
  const nonGit = await w.call({ op: 'branches', action: 'list' }, plain);
  assert.equal(nonGit.git, false);
  assert.equal(nonGit.repo, plain);
  assert.equal(nonGit.claims.length, 1);
  assert.equal((await w.call({ op: 'branches', action: 'list' }, other)).claims[0].agentId, 'b');
});

gitTest('release frees own claims and forceRelease is recorded in the audit log', async t => {
  const w = await world(t);
  await w.join('a', w.trees.feature); await w.join('b', w.trees.bugfix);
  for (const branch of ['one', 'two', 'three']) await w.call({ op: 'branches', action: 'claim', agentId: 'a', branch }, w.trees.feature);
  await w.call({ op: 'branches', action: 'claim', agentId: 'b', branch: 'four' }, w.trees.bugfix);
  // Release only touches the caller's own claims.
  assert.deepEqual((await w.call({ op: 'branches', action: 'release', agentId: 'b', branch: 'one' }, w.trees.bugfix)).released, []);
  assert.deepEqual((await w.call({ op: 'branches', action: 'release', agentId: 'a', branch: 'one' }, w.trees.feature)).released, ['one']);
  const all = await w.call({ op: 'branches', action: 'release', agentId: 'a' }, w.trees.feature);
  assert.deepEqual(all.released.sort(), ['three', 'two']);
  assert.deepEqual(all.claims.map(c => c.branch), ['four']);
  // Another agent can now take a released branch.
  await w.call({ op: 'branches', action: 'claim', agentId: 'b', branch: 'one' }, w.trees.bugfix);
  const noReason = await w.request({ op: 'branches', action: 'forceRelease', agentId: 'alice', branch: 'four' }, w.trees.feature);
  assert.equal(noReason.error.code, 'INVALID_INPUT');
  assert.equal((await w.request({ op: 'branches', action: 'forceRelease', agentId: 'alice', branch: 'nothing', reason: 'x' }, w.trees.feature)).error.code, 'UNKNOWN_CLAIM');
  const forced = await w.call({ op: 'branches', action: 'forceRelease', agentId: 'alice', branch: 'four', reason: 'holder crashed' }, w.trees.feature);
  assert.equal(forced.released[0].agentId, 'b');
  assert.equal(forced.receipt.as, 'alice');
  assert.equal(forced.receipt.scope, 'branch');
  assert.equal(forced.receipt.reason, 'holder crashed');
  assert.equal(forced.receipt.project, w.trees.feature);
  const exported = (await w.call({ op: 'export' })).state;
  assert.equal(exported.releaseLog.length, 1);
  assert.deepEqual(exported.releaseLog[0].released.map(c => c.branch), ['four']);
  assert.deepEqual(exported.branchClaims.map(c => c.branch), ['one']);
  validateStore(exported);
});

gitTest('ownership flags orphaned, contested, unclaimed and missing branches and sorts them first', async t => {
  const w = await world(t, { worktrees: ['feature', 'bugfix', 'idea', 'spare'] });
  const { trees } = w;
  await w.join('lead'); await w.join('f', trees.feature); await w.join('g', trees.bugfix); await w.join('h', trees.idea);
  // lead claims spare (nobody there), feature (contested by f), bugfix (will be orphaned) and ghost (no such branch).
  await w.call({ op: 'branches', action: 'claim', agentId: 'lead', branch: 'spare', note: 'later' });
  await w.call({ op: 'branches', action: 'claim', agentId: 'lead', branch: 'feature' });
  await w.call({ op: 'branches', action: 'claim', agentId: 'g', branch: 'bugfix' }, trees.bugfix);
  await w.call({ op: 'branches', action: 'claim', agentId: 'lead', branch: 'ghost' });
  await w.call({ op: 'leave', agentId: 'g' }, trees.bugfix);
  await w.call({ op: 'tasks', action: 'upsert', agentId: 'f', title: 'Build the feature', owner: 'f', resources: ['branch:feature'] }, trees.feature);
  const view = await w.call({ op: 'ownership' }, trees.idea);
  assert.equal(view.repo, path.join(w.repo, '.git'));
  assert.equal(view.git, true);
  assert.deepEqual(view.rooms, [w.repo, trees.bugfix, trees.feature, trees.idea].sort());
  const by = Object.fromEntries(view.branches.map(b => [b.name, b]));
  assert.deepEqual(by.feature.flags, ['contested']);
  assert.equal(by.feature.claim.agentId, 'lead');
  assert.deepEqual(by.feature.agents.map(a => [a.agentId, a.source, a.live]), [['f', 'worktree', true]]);
  assert.deepEqual(by.feature.worktrees, [{ path: trees.feature, project: trees.feature }]);
  assert.deepEqual(by.feature.tasks.map(x => [x.title, x.state, x.owner]), [['Build the feature', 'open', 'f']]);
  assert.deepEqual(by.bugfix.flags, ['orphaned']);
  assert.equal(by.bugfix.claim.holder, 'left');
  assert.equal(by.bugfix.claim.stale, true);
  assert.deepEqual(by.idea.flags, ['unclaimed']);
  assert.equal(by.idea.claim, null);
  assert.deepEqual(by.spare.flags, []);
  assert.equal(by.spare.claim.note, 'later');
  assert.equal(by.spare.claim.live, true);
  assert.deepEqual(by.ghost.flags, ['missing']);
  assert.equal(by.ghost.head, null);
  assert.deepEqual(view.unassigned.claims.map(c => [c.branch, c.reason]), [['ghost', 'missing']]);
  assert.deepEqual(view.unassigned.worktrees, []);
  // Main has the lead's live room checked out and no claim.
  assert.deepEqual(by.main.flags, ['unclaimed']);
  const names = view.branches.map(b => b.name);
  const flagged = names.filter(name => by[name].flags.length);
  assert.deepEqual(names.slice(0, flagged.length).sort(), flagged.sort());
  const claimedUnflagged = names.filter(name => by[name].claim && !by[name].flags.length);
  assert.deepEqual(names.slice(flagged.length, flagged.length + claimedUnflagged.length), claimedUnflagged);
  assert.match(view.generatedAt, /^\d{4}-/u);
  // Stale holders are orphaned too: with a zero threshold nobody is live unless connected.
  const stale = await w.call({ op: 'ownership', staleMinutes: 0 }, trees.idea);
  assert.ok(stale.branches.find(b => b.name === 'spare').flags.includes('orphaned'));
  await w.call({ op: 'status', agentId: 'lead', transport: { adapter: 'test', state: 'connected' } });
  const connected = await w.call({ op: 'ownership', staleMinutes: 0 }, trees.idea);
  assert.deepEqual(connected.branches.find(b => b.name === 'spare').flags, []);
  assert.equal((await w.request({ op: 'ownership', staleMinutes: -1 }, trees.idea)).error.code, 'INVALID_INPUT');
});

gitTest('detached worktrees, reported agents and branch-less claims land in unassigned', async t => {
  const w = await world(t, { worktrees: ['feature', 'loose'] });
  await w.join('a'); await w.join('d', w.trees.loose); await w.join('r', w.trees.feature);
  await git(w.trees.loose, 'checkout', '--detach');
  // r works outside its checkout on branch hotfix, so it is placed by its report, not by the room.
  await git(w.repo, 'branch', 'hotfix');
  await w.call({ op: 'status', agentId: 'r', git: { branch: 'hotfix', head: 'abc123', worktree: path.join(w.root, 'elsewhere') } }, w.trees.feature);
  const view = await w.call({ op: 'ownership' });
  const by = Object.fromEntries(view.branches.map(b => [b.name, b]));
  assert.deepEqual(by.hotfix.agents.map(a => [a.agentId, a.source]), [['r', 'reported']]);
  assert.deepEqual(by.hotfix.flags, ['unclaimed']);
  assert.deepEqual(by.feature.agents, []);
  assert.equal(view.unassigned.worktrees.length, 1);
  assert.equal(view.unassigned.worktrees[0].path, w.trees.loose);
  assert.equal(view.unassigned.worktrees[0].project, w.trees.loose);
  assert.deepEqual(view.unassigned.worktrees[0].agents.map(a => a.agentId), ['d']);
  // Once r reports from its own checkout, the live checkout wins again.
  await w.call({ op: 'status', agentId: 'r', git: { branch: 'hotfix', worktree: w.trees.feature } }, w.trees.feature);
  const placed = Object.fromEntries((await w.call({ op: 'ownership' })).branches.map(b => [b.name, b]));
  assert.deepEqual(placed.feature.agents.map(a => [a.agentId, a.source]), [['r', 'worktree']]);
  assert.deepEqual(placed.hotfix.agents, []);
});

test('buildOwnership reads task.branch and artifacts defensively and bounds branches', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const agent = agentId => ({ agentId, runner: 't', registeredAt: at, updatedAt: new Date().toISOString(), status: 'idle', frozen: false, resources: [], task: null });
  const state = { version: 1, nextCursor: 1, rooms: [{ project: '/r', agents: [agent('a')], messages: [], claims: [], cursor: 0,
    tasks: [
      { id: 't1', creator: 'a', title: 'one', state: 'open', createdAt: at, updatedAt: at, branch: 'refs/heads/b1', artifacts: ['report.md', 7, 'report.md', 'out/x.json'] },
      { id: 't2', creator: 'a', title: 'two', state: 'complete', owner: 'a', createdAt: at, updatedAt: at, resources: ['branch:b1', 'src/x'] },
      { id: 't3', creator: 'a', title: 'three', state: 'open', createdAt: at, updatedAt: at, artifacts: 'not-an-array' }] }] };
  const branches = Array.from({ length: 320 }, (_, i) => ({ name: `b${i}`, head: 'h', upstream: null, committedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
  const view = buildOwnership(state, { repo: '/r/.git', rooms: state.rooms, worktrees: [], branches });
  assert.equal(view.branches.length, 300);
  assert.equal(view.totalBranches, 320);
  assert.equal(view.truncated, true);
  assert.equal(view.branches[0].name, 'b319', 'unflagged, unclaimed branches sort newest first');
  const noGit = buildOwnership(state, { repo: '/r', rooms: state.rooms, worktrees: null, branches: null });
  const b1 = noGit.branches.find(b => b.name === 'b1');
  assert.deepEqual(b1.tasks.map(x => x.id), ['t1', 't2']);
  assert.deepEqual(b1.artifacts, ['report.md', 'out/x.json']);
  assert.equal(noGit.git, false);
  // Rebuild with b1 present to confirm task attachment.
  const withB1 = buildOwnership(state, { repo: '/r/.git', rooms: state.rooms, worktrees: [], branches: branches.slice(0, 2).concat([{ name: 'b1', head: 'h', upstream: null, committedAt: null }]) });
  assert.deepEqual(withB1.branches.find(b => b.name === 'b1').tasks.map(x => x.id), ['t1', 't2']);
});

gitTest('validateStore accepts old state, accepts the new fields and rejects corrupt ones; state survives restart', async t => {
  const w = await world(t, { worktrees: ['feature'] });
  await w.join('a', w.trees.feature);
  await w.call({ op: 'status', agentId: 'a', git: { branch: 'feature', worktree: w.trees.feature } }, w.trees.feature);
  await w.call({ op: 'branches', action: 'claim', agentId: 'a', branch: 'feature', note: 'n', meta: { baseCommit: 'x' } }, w.trees.feature);
  const exported = (await w.call({ op: 'export' })).state;
  assert.equal(exported.branchClaims.length, 1);
  assert.deepEqual(Object.keys(exported.rooms.find(r => r.project === w.trees.feature).agents[0].git).sort(), ['branch', 'ts', 'worktree']);
  validateStore(structuredClone(exported));
  const old = structuredClone(exported);
  delete old.branchClaims;
  for (const room of old.rooms) for (const agent of room.agents) delete agent.git;
  validateStore(old);
  const clone = () => structuredClone(exported);
  const corrupt = mutate => { const state = clone(); mutate(state); assert.throws(() => validateStore(state), /corrupt/u); };
  corrupt(s => { s.branchClaims = {}; });
  corrupt(s => { s.branchClaims[0].agentId = 'nobody'; });
  corrupt(s => { s.branchClaims[0].project = '/not/a/room'; });
  corrupt(s => { s.branchClaims[0].branch = 'a\u0000b'; });
  corrupt(s => { s.branchClaims[0].branch = 'x'.repeat(300); });
  corrupt(s => { s.branchClaims[0].repo = ''; });
  corrupt(s => { s.branchClaims[0].note = 5; });
  corrupt(s => { s.branchClaims[0].meta = { bogus: 'x' }; });
  corrupt(s => { s.branchClaims[0].transferredFrom = 'nobody'; });
  corrupt(s => { s.branchClaims.push({ ...s.branchClaims[0] }); });
  corrupt(s => { s.rooms.find(r => r.project === w.trees.feature).agents[0].git = { branch: 3, ts: 'x' }; });
  corrupt(s => { s.rooms.find(r => r.project === w.trees.feature).agents[0].git = { bogus: 'x', ts: 'x' }; });
  corrupt(s => { s.rooms.find(r => r.project === w.trees.feature).agents[0].git = { branch: 'ok' }; });
  const valid = clone();
  valid.branchClaims[0].transferredFrom = 'a'; valid.branchClaims[0].transferredAt = new Date().toISOString();
  valid.rooms.find(r => r.project === w.trees.feature).agents[0].git = { branch: null, ts: new Date().toISOString() };
  validateStore(valid);
  await w.broker.close();
  const reopened = await createBroker({ dataDir: w.dataDir });
  try {
    const response = await fetch(`${reopened.url}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${reopened.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ project: w.trees.feature, op: 'branches', action: 'list' }) });
    assert.equal((await response.json()).claims[0].note, 'n');
  } finally { await reopened.close(); }
  w.broker = null;
  // A legacy state file (no new fields) must still load.
  const legacyDir = path.join(w.root, 'legacy');
  await fs.mkdir(legacyDir);
  await fs.writeFile(path.join(legacyDir, 'state.json'), JSON.stringify(old));
  const legacy = await createBroker({ dataDir: legacyDir });
  await legacy.close();
});

gitTest('status git report is validated, bounded, replaceable and clearable', async t => {
  const w = await world(t, { worktrees: [] });
  await w.join('a');
  const stored = await w.call({ op: 'status', agentId: 'a', git: { branch: 'refs/heads/topic', head: 'deadbeef', worktree: w.repo } });
  assert.deepEqual(Object.keys(stored.agent.git).sort(), ['branch', 'head', 'ts', 'worktree']);
  assert.equal(stored.agent.git.branch, 'topic');
  for (const bad of [[], 'x', { bogus: 1 }, {}, { branch: '' }, { branch: 'a\u0001' }, { head: 'x'.repeat(200) }, { worktree: 'relative/path' }, { branch: 'x'.repeat(300) }]) {
    assert.equal((await w.request({ op: 'status', agentId: 'a', git: bad })).error.code, 'INVALID_INPUT', JSON.stringify(bad));
  }
  const detached = await w.call({ op: 'status', agentId: 'a', git: { branch: null } });
  assert.equal(detached.agent.git.branch, null);
  assert.equal(detached.agent.git.head, undefined);
  const cleared = await w.call({ op: 'status', agentId: 'a', git: null });
  assert.equal('git' in cleared.agent, false);
  assert.equal(Object.hasOwn((await w.call({ op: 'agents' })).agents[0], 'git'), false);
});

gitTest('retire is blocked by branch claims and reports them as stranded on relinquish', async t => {
  const w = await world(t, { worktrees: ['feature'] });
  await w.join('a', w.trees.feature); await w.join('b', w.trees.feature);
  await w.call({ op: 'branches', action: 'claim', agentId: 'a', branch: 'feature' }, w.trees.feature);
  const before = await fs.readFile(path.join(w.dataDir, 'state.json'), 'utf8');
  const refused = await w.request({ op: 'retire', agentId: 'a' }, w.trees.feature);
  assert.equal(refused.status, 409);
  assert.equal(refused.error.code, 'RETIRE_BLOCKED');
  assert.deepEqual(refused.error.branchClaims, ['feature']);
  assert.deepEqual(refused.error.claims, []);
  assert.equal(await fs.readFile(path.join(w.dataDir, 'state.json'), 'utf8'), before);
  const receipt = await w.call({ op: 'retire', agentId: 'a', relinquish: true }, w.trees.feature);
  assert.deepEqual(receipt.stranded.branchClaims, ['feature']);
  // The claim stays held by the retired identity until a human force-releases it.
  const view = await w.call({ op: 'ownership' }, w.trees.feature);
  const feature = view.branches.find(b => b.name === 'feature');
  assert.equal(feature.claim.holder, 'retired');
  assert.ok(feature.flags.includes('orphaned'));
  assert.equal((await w.request({ op: 'branches', action: 'claim', agentId: 'b', branch: 'feature' }, w.trees.feature)).error.code, 'CLAIM_CONFLICT');
  await w.call({ op: 'branches', action: 'forceRelease', agentId: 'human', branch: 'feature', reason: 'retired holder' }, w.trees.feature);
  await w.call({ op: 'branches', action: 'claim', agentId: 'b', branch: 'feature' }, w.trees.feature);
  assert.equal((await w.request({ op: 'retire', agentId: 'b' }, w.trees.feature)).error.code, 'RETIRE_BLOCKED');
  await w.call({ op: 'branches', action: 'release', agentId: 'b' }, w.trees.feature);
  assert.equal((await w.request({ op: 'retire', agentId: 'b' }, w.trees.feature)).ok, true);
});

gitTest('capabilities advertise the new features and the client gates the new ops and fields', async t => {
  const w = await world(t, { worktrees: [] });
  const caps = await w.call({ op: 'capabilities' });
  for (const feature of ['branch-claims', 'ownership', 'git-context']) assert.ok(caps.features.includes(feature), feature);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-own-gate-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }));
  await fs.writeFile(path.join(dir, 'broker.json'), JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:12399', token: 'fixture' }));
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const cases = [
    [{ op: 'branches', action: 'list' }, 'branch-claims'], [{ op: 'ownership' }, 'ownership'],
    [{ op: 'status', agentId: 'a', git: { branch: 'x' } }, 'git-context']];
  for (const [fields, feature] of cases) {
    const seen = [];
    globalThis.fetch = async (url, opts) => {
      if (url.endsWith('/health')) return { ok: true };
      const input = JSON.parse(opts.body); seen.push(input.op);
      return { ok: true, json: async () => ({ ok: true, features: input.op === 'capabilities' ? [] : undefined }) };
    };
    const error = await clientRpc('/tmp', fields, { dataDir: dir }).then(() => null, e => e);
    assert.equal(error?.code, 'UNSUPPORTED_FEATURE', feature);
    assert.ok(error.message.includes(feature));
    assert.deepEqual(seen, ['capabilities']);
  }
  // A status without git stays ungated so old brokers keep working.
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    if (url.endsWith('/health')) return { ok: true };
    seen.push(JSON.parse(opts.body).op);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await clientRpc('/tmp', { op: 'status', agentId: 'a', status: 'idle' }, { dataDir: dir });
  assert.deepEqual(seen, ['status']);
});

gitTest('MCP adapter exposes relay_ownership and relay_branch and auto-reports git context best effort', async t => {
  const calls = [];
  const rpcImpl = async (_project, fields) => { calls.push(fields); return { ok: true, ...fields }; };
  async function connect(options = {}) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const adapter = await createMcpAdapter({ project: '/fixture/project', runner: 'generic', sessionId: 's1', rpcImpl, waitImpl: () => { throw new Error('unused'); }, ...options });
    const client = new Client({ name: 'own', version: '1' });
    await adapter.start(a); await client.connect(b);
    t.after(() => client.close());
    return { adapter, client };
  }
  const reported = await connect({ gitContextImpl: async () => ({ branch: 'feat', head: 'abc', worktree: '/fixture/project', commonDir: '/fixture/project/.git' }) });
  assert.deepEqual(calls.map(c => c.op), ['register', 'status', 'status']);
  assert.deepEqual(calls[2], { op: 'status', agentId: 'generic-s1', git: { branch: 'feat', head: 'abc', worktree: '/fixture/project' } });
  const tools = (await reported.client.listTools()).tools;
  assert.ok(tools.find(x => x.name === 'relay_ownership').annotations.readOnlyHint);
  assert.equal(tools.find(x => x.name === 'relay_branch').annotations.readOnlyHint, false);
  calls.length = 0;
  const call = async (name, args) => JSON.parse((await reported.client.callTool({ name, arguments: args })).content[0].text);
  await call('relay_ownership', {});
  await call('relay_branch', { action: 'claim', branch: 'feat', note: 'mine', meta: { baseCommit: 'abc' } });
  await call('relay_branch', { action: 'release', branch: 'feat' });
  await call('relay_branch', { action: 'list' });
  await call('relay_status', { git: { branch: 'x' } });
  assert.deepEqual(calls, [
    { op: 'ownership' },
    { op: 'branches', action: 'claim', agentId: 'generic-s1', branch: 'feat', note: 'mine', meta: { baseCommit: 'abc' } },
    { op: 'branches', action: 'release', agentId: 'generic-s1', branch: 'feat' },
    { op: 'branches', action: 'list', agentId: 'generic-s1' },
    { op: 'status', agentId: 'generic-s1', git: { branch: 'x' } }]);
  for (const [name, args] of [['relay_branch', {}], ['relay_branch', { action: 'steal' }], ['relay_branch', { action: 'claim', project: '/x' }],
    ['relay_ownership', { branch: 'x' }], ['relay_status', { git: { bogus: 1 } }], ['relay_status', { git: [] }]]) {
    assert.equal((await reported.client.callTool({ name, arguments: args })).isError, true, `${name} ${JSON.stringify(args)}`);
  }
  // Not a repo, git helper failure and a broker without the feature never block start.
  calls.length = 0;
  await connect({ gitContextImpl: async () => null });
  assert.deepEqual(calls.map(c => c.op), ['register', 'status']);
  calls.length = 0;
  await connect({ gitContextImpl: async () => { throw new Error('git exploded'); } });
  assert.deepEqual(calls.map(c => c.op), ['register', 'status']);
  const unsupported = async (_project, fields) => {
    calls.push(fields);
    if (fields.git) { const error = new Error('This broker does not advertise git-context'); error.code = 'UNSUPPORTED_FEATURE'; throw error; }
    return { ok: true };
  };
  calls.length = 0;
  await connect({ rpcImpl: unsupported, gitContextImpl: async () => ({ branch: 'x', head: 'y', worktree: '/w' }) });
  assert.deepEqual(calls.map(c => c.op), ['register', 'status', 'status']);
});

gitTest('OpenCode plugin exposes relay_ownership and relay_branch and auto-reports git context best effort', async t => {
  const directory = path.resolve('/tmp/relay-own-project');
  const sessionID = 'ses_own';
  const calls = [];
  const transport = {
    async rpc(project, fields) {
      calls.push({ project, ...fields });
      if (fields.git && fields.failGit) throw new Error('unreachable');
      if (fields.op === 'inbox') return { ok: true, messages: [], cursor: 0 };
      return { ok: true, ...fields };
    },
    wait: (_project, _agent, _after, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  };
  const client = { tui: { async showToast() { return { data: true }; } }, session: { async status() { return { data: {} }; }, async promptAsync() { return { data: undefined }; } } };
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
  const ctx = () => ({ sessionID, directory, worktree: directory, agent: 'build', abort: new AbortController().signal });
  const hooks = await AgentRelayPlugin({ client, directory, worktree: directory }, { transport,
    gitContext: async () => ({ branch: null, head: 'abc', worktree: directory, commonDir: `${directory}/.git` }) });
  t.after(() => hooks.dispose());
  assert.ok(hooks.tool.relay_ownership && hooks.tool.relay_branch);
  await hooks.tool.relay_ownership.execute({}, ctx());
  await flush();
  assert.deepEqual(calls.find(c => c.git), { project: directory, op: 'status', agentId: `opencode:${sessionID}`, git: { branch: null, head: 'abc', worktree: directory } });
  calls.length = 0;
  await hooks.tool.relay_branch.execute({ action: 'claim', branch: 'feat', note: 'n' }, ctx());
  await hooks.tool.relay_branch.execute({ action: 'release' }, ctx());
  await hooks.tool.relay_branch.execute({ action: 'list' }, ctx());
  assert.deepEqual(calls.filter(c => c.op === 'branches').map(({ project, ...fields }) => fields), [
    { op: 'branches', action: 'claim', branch: 'feat', note: 'n', agentId: `opencode:${sessionID}` },
    { op: 'branches', action: 'release', agentId: `opencode:${sessionID}` },
    { op: 'branches', action: 'list', agentId: `opencode:${sessionID}` }]);
  assert.deepEqual(calls.filter(c => c.op === 'ownership'), []);
  await assert.rejects(hooks.tool.relay_ownership.execute({}, { ...ctx(), directory: '/tmp/foreign' }), /different project/);
  // Failure of the optional report never breaks registration or tools.
  const failing = [];
  const failingHooks = await AgentRelayPlugin({ client, directory, worktree: directory }, { transport: { ...transport,
    async rpc(project, fields) { failing.push(fields.op); if (fields.git) throw Object.assign(new Error('unsupported'), { code: 'UNSUPPORTED_FEATURE' }); return transport.rpc(project, fields); } },
    gitContext: async () => ({ branch: 'x', head: 'y', worktree: directory }) });
  t.after(() => failingHooks.dispose());
  assert.match(await failingHooks.tool.relay_ownership.execute({}, ctx()), /ownership/u);
  await flush();
  assert.ok(failing.includes('status'));
  const quiet = [];
  const quietHooks = await AgentRelayPlugin({ client, directory, worktree: directory }, { transport: { ...transport,
    async rpc(project, fields) { quiet.push(fields.op); return transport.rpc(project, fields); } }, gitContext: async () => null });
  t.after(() => quietHooks.dispose());
  await quietHooks.tool.relay_branch.execute({ action: 'list' }, ctx());
  await flush();
  assert.equal(quiet.includes('status'), false);
});

gitTest('real CLI exposes branches, branch claim/release/list and force-release against a live broker', async t => {
  const w = await world(t, { worktrees: ['feature'], broker: false });
  t.after(async () => {
    try {
      const { pid } = JSON.parse(await fs.readFile(path.join(w.dataDir, 'broker.json'), 'utf8'));
      process.stderr.write(`[diag] teardown kill ${pid}\n`);
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 100)); } catch { break; } }
      process.stderr.write(`[diag] teardown killed\n`);
    } catch { /* never started */ }
  });
  const env = { ...process.env, AGENT_RELAY_HOME: w.dataDir };
  const T0 = Date.now(), dbg = m => process.stderr.write(`[diag +${Date.now() - T0}ms] ${m}\n`);
  const exec = async (project, ...args) => { dbg(`start ${args.slice(0, 2).join(' ')}`); try { const r = await run(process.execPath, [cli, ...args, '--project', project, '--data-dir', w.dataDir], { timeout: 20000, env }); dbg(`done ${args.slice(0, 2).join(' ')}`); return JSON.parse(r.stdout); } catch (e) { dbg(`fail ${args.slice(0, 2).join(' ')} ${e.code ?? ''} ${e.killed ?? ''}`); throw e; } };
  await exec(w.trees.feature, 'join', '--as', 'a', '--runner', 'codex');
  await exec(w.repo, 'join', '--as', 'b', '--runner', 'codex');
  const claimed = await exec(w.trees.feature, 'branch', 'claim', 'feature', '--as', 'a', '--note', 'cli note');
  assert.equal(claimed.claim.note, 'cli note');
  await assert.rejects(exec(w.repo, 'branch', 'claim', 'feature', '--as', 'b'), /already claimed|conflict/iu);
  assert.equal((await exec(w.repo, 'branch', 'list')).claims.length, 1);
  const view = await exec(w.repo, 'branches');
  assert.equal(view.branches.find(b => b.name === 'feature').claim.agentId, 'a');
  await assert.rejects(exec(w.repo, 'branch', 'force-release', 'feature', '--as', 'human'), /reason/u);
  const forced = await exec(w.repo, 'branch', 'force-release', 'feature', '--as', 'human', '--reason', 'testing');
  assert.equal(forced.receipt.as, 'human');
  await exec(w.repo, 'branch', 'claim', 'main', '--as', 'b');
  assert.deepEqual((await exec(w.repo, 'branch', 'release', '--as', 'b')).released, ['main']);
  await assert.rejects(exec(w.repo, 'branch', 'claim', '--as', 'b'), /branch claim NAME/u);
  await assert.rejects(exec(w.repo, 'branch', 'bogus'), /claim\|release/u);
});
