import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createBroker} from '../lib/broker.mjs';
import {AUDIT_FILE_NAME} from '../lib/bulk.mjs';

const HOUR = 3600000;
const ago = hours => new Date(Date.now() - hours * HOUR).toISOString();

// Real HTTP handler, serial writer and durable ledger without binding TCP. `restart` rewrites the
// stored ledger between runs, so an identity can be made idle or a claim old.
async function fixture(t, brokerOptions = { pruneAfterMinutes: 0 }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-bulk-'));
  const dataDir = path.join(root, 'data'), project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(p => fs.mkdir(p)));
  let handler, broker, options = brokerOptions;
  const serverFactory = callback => {
    handler = callback;
    const server = new EventEmitter();
    server.listen = (port, host, ready) => queueMicrotask(ready);
    server.address = () => ({ port: 0 });
    server.close = done => done?.();
    return server;
  };
  const open = () => createBroker({ dataDir, serverFactory, ...options });
  broker = await open();
  t.after(async () => {
    await broker.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  });
  async function request(fields, room = project) {
    let status, result;
    const response = new EventEmitter();
    response.writeHead = code => { status = code; };
    response.end = body => { result = JSON.parse(body); };
    const incoming = {
      method: 'POST', url: '/rpc', headers: { authorization: 'Bearer ' + broker.token },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ project: room, ...fields })); }
    };
    await handler(incoming, response);
    return { status, ...result };
  }
  const rpc = async (fields, room) => {
    const result = await request(fields, room);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  const stateFile = path.join(dataDir, 'state.json');
  const agentRow = (state, id) => state.rooms[0].agents.find(a => a.agentId === id);
  return {
    root, dataDir, project, stateFile, request, rpc,
    register: (agentId, extra = {}) => rpc({ op: 'register', agentId, runner: 'test', ...extra }),
    readState: async () => JSON.parse(await fs.readFile(stateFile, 'utf8')),
    readBytes: async () => fs.readFile(stateFile),
    auditEntries: async () => {
      try {
        const text = await fs.readFile(path.join(dataDir, AUDIT_FILE_NAME), 'utf8');
        return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
      } catch { return []; }
    },
    async restart(mutate, nextOptions) {
      await broker.close();
      if (mutate) {
        const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        mutate(state);
        await fs.writeFile(stateFile, JSON.stringify(state));
      }
      if (nextOptions) options = nextOptions;
      broker = await open();
    },
    agentRow
  };
}

// Make identities look idle, and claims look old, without touching the broker.
const idle = (ids, hours) => state => {
  for (const room of state.rooms) {
    for (const agent of room.agents) if (ids.includes(agent.agentId)) agent.updatedAt = ago(hours);
  }
};
const ageClaims = hours => state => {
  for (const room of state.rooms) for (const claim of room.claims) claim.claimedAt = ago(hours);
};

async function orphanFixture(t) {
  const f = await fixture(t);
  for (const id of ['requester', 'holder', 'operator']) await f.register(id);
  await f.rpc({ op: 'claim', agentId: 'holder', resources: ['unfinished/file.js'] });
  const requested = await f.rpc({ op: 'requestHandoff', agentId: 'requester', to: 'holder',
    resources: ['unfinished/file.js'], reason: 'Review unfinished work' });
  const id = requested.handoff.id;
  return { ...f, id, cancel: extra => f.request({ op: 'cancelOrphanHandoff', agentId: 'operator', id,
    reason: 'Work preserved and reassigned by the project owner', ...extra }) };
}

test('operator cancels an unheld orphan handoff with durable provenance, dry run and safe replay', async t => {
  const f = await orphanFixture(t);
  await f.rpc({ op: 'release', agentId: 'holder' });
  await f.restart(idle(['requester', 'holder'], 48));
  const before = (await f.readState()).rooms[0].handoffs[0];
  const dry = await f.cancel({ dryRun: true });
  assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.equal(dry.dryRun, true);
  assert.deepEqual((await f.readState()).rooms[0].handoffs[0], before);
  const result = await f.cancel();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.cancelled, true);
  const state = await f.readState(), saved = state.rooms[0].handoffs[0];
  assert.equal(saved.state, 'cancelled');
  assert.equal(saved.respondedBy, 'operator');
  assert.equal(saved.cancellationReason, 'Work preserved and reassigned by the project owner');
  for (const field of ['from', 'to', 'resources', 'generations', 'reason', 'requestedAt'])
    assert.deepEqual(saved[field], before[field], field);
  assert.deepEqual(state.rooms[0].claims, []);
  const audit = (await f.auditEntries()).filter(row => row.event === 'cancel-orphan-handoff');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, 'operator');
  assert.equal(audit[0].handoffId, f.id);
  await f.restart();
  assert.equal((await f.readState()).rooms[0].handoffs[0].state, 'cancelled');
  assert.equal((await f.cancel()).cancelled, false);
  assert.equal((await f.auditEntries()).filter(row => row.event === 'cancel-orphan-handoff').length, 1);
  const prune = await f.rpc({ op: 'prune', idleMinutes: 60 });
  assert.ok(prune.candidates.some(row => row.agentId === 'requester'));
  assert.ok(prune.candidates.some(row => row.agentId === 'holder'));
});

test('orphan cancellation refuses live parties and exact, parent or machine-held resources', async t => {
  const f = await orphanFixture(t);
  await f.rpc({ op: 'release', agentId: 'holder' });
  assert.equal((await f.cancel()).error.code, 'HANDOFF_LIVE');
  await f.restart(idle(['requester', 'holder'], 48));
  for (const resource of ['unfinished/file.js', 'unfinished']) {
    await f.rpc({ op: 'claim', agentId: 'operator', resources: [resource] });
    assert.equal((await f.cancel()).error.code, 'HANDOFF_HELD');
    await f.rpc({ op: 'release', agentId: 'operator' });
  }
  await f.rpc({ op: 'claim', agentId: 'operator', scope: 'machine', resources: ['unfinished/file.js'] });
  assert.equal((await f.cancel()).error.code, 'HANDOFF_HELD');
  await f.rpc({ op: 'release', agentId: 'operator', scope: 'machine' });
  await fs.mkdir(path.join(f.project, 'unfinished'));
  await fs.symlink(path.join(f.project, 'unfinished'), path.join(f.project, 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await f.rpc({ op: 'claim', agentId: 'operator', scope: 'machine', resources: ['alias/file.js'] });
  assert.equal((await f.cancel()).error.code, 'HANDOFF_HELD');
  await f.rpc({ op: 'release', agentId: 'operator', scope: 'machine' });
  await f.restart(state => {
    const holder = f.agentRow(state, 'holder');
    holder.transport = { adapter: 'test', state: 'connected', ts: new Date().toISOString() };
  });
  assert.equal((await f.cancel()).error.code, 'HANDOFF_LIVE');
  assert.equal((await f.readState()).rooms[0].handoffs[0].state, 'pending');
  assert.equal((await f.auditEntries()).filter(row => row.event === 'cancel-orphan-handoff').length, 0);
});

test('orphan cancellation requires actor and reason, preserves closed decisions and scopes ids to a room', async t => {
  const f = await orphanFixture(t);
  assert.equal((await f.cancel({ agentId: 'missing' })).error.code, 'UNKNOWN_AGENT');
  assert.equal((await f.cancel({ reason: '' })).error.code, 'INVALID_INPUT');
  assert.equal((await f.cancel({ dryRun: 'yes' })).error.code, 'INVALID_INPUT');
  assert.equal((await f.cancel({ id: 'missing' })).error.code, 'UNKNOWN_HANDOFF');
  await f.rpc({ op: 'respondHandoff', agentId: 'holder', id: f.id, accept: false });
  await f.restart(idle(['requester', 'holder'], 48));
  assert.equal((await f.cancel()).error.code, 'HANDOFF_CLOSED');
  const other = path.join(f.root, 'other');
  await fs.mkdir(other);
  await f.rpc({ op: 'register', agentId: 'operator', runner: 'test' }, other);
  const result = await f.request({ op: 'cancelOrphanHandoff', agentId: 'operator', id: f.id,
    reason: 'Wrong room' }, other);
  assert.equal(result.error.code, 'UNKNOWN_HANDOFF');
});

test('orphan cancellation preserves an explicitly named live successor without releasing its claims', async t => {
  const f = await orphanFixture(t);
  await f.rpc({ op: 'release', agentId: 'holder' });
  await f.restart(idle(['requester', 'holder'], 48));
  await f.register('successor');
  await f.rpc({ op: 'claim', agentId: 'successor', resources: ['unfinished'] });
  const claims = (await f.readState()).rooms[0].claims;
  assert.equal((await f.cancel()).error.code, 'HANDOFF_HELD');
  assert.equal((await f.cancel({ preserveOwner: 'operator' })).error.code, 'HANDOFF_HELD');
  assert.equal((await f.cancel({ preserveOwner: 'holder' })).error.code, 'INVALID_INPUT');
  assert.equal((await f.cancel({ preserveOwner: 'missing' })).error.code, 'INVALID_INPUT');
  const result = await f.cancel({ preserveOwner: 'successor' });
  assert.equal(result.cancelled, true, JSON.stringify(result));
  assert.equal(result.handoff.preservedOwner, 'successor');
  assert.deepEqual((await f.readState()).rooms[0].claims, claims);
  assert.equal((await f.auditEntries()).at(-1).preservedOwner, 'successor');
});

test('bulk leave never strands an obligation: the holder is kept and stays active', async t => {
  const f = await fixture(t);
  await f.register('holder');
  await f.register('claimer');
  await f.rpc({ op: 'claim', agentId: 'claimer', resources: ['build'] });
  await f.restart(idle(['claimer', 'holder'], 48));

  const dry = await f.rpc({ op: 'leave', stale: true, idleHours: 24 });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.candidates.map(row => row.agentId), ['holder']);
  assert.deepEqual(dry.kept.map(row => row.agentId), ['claimer']);
  assert.deepEqual(dry.kept[0].obligations.claims, ['build']);
  assert.deepEqual(dry.kept[0].obligations.tasks, []);

  const applied = await f.rpc({ op: 'leave', stale: true, idleHours: 24, apply: true });
  assert.equal(applied.changed, 1);
  const state = await f.readState();
  assert.equal(f.agentRow(state, 'claimer').left, undefined, 'an identity that holds work stays active');
  assert.equal(f.agentRow(state, 'holder').left, true);
  assert.deepEqual(state.rooms[0].claims.map(claim => claim.resource), ['build'], 'the claim was not dropped');
});

test('a bulk retire keeps an identity that holds an obligation', async t => {
  const f = await fixture(t);
  await f.register('worker');
  await f.rpc({ op: 'claim', agentId: 'worker', resources: ['install'] });
  await f.restart(idle(['worker'], 48));

  const dry = await f.rpc({ op: 'retire', stale: true, idleHours: 24 });
  assert.deepEqual(dry.candidates, []);
  assert.deepEqual(dry.kept.map(row => row.agentId), ['worker']);
  const applied = await f.rpc({ op: 'retire', stale: true, idleHours: 24, apply: true });
  assert.equal(applied.changed, 0);
  const state = await f.readState();
  assert.equal(f.agentRow(state, 'worker').retired, undefined, 'an identity that holds work is never retired');
});

test('a dry run changes nothing: the ledger is byte-identical afterwards', async t => {
  const f = await fixture(t);
  await f.register('a');
  await f.register('b');
  await f.restart(idle(['a', 'b'], 48));

  const before = await f.readBytes();
  const report = await f.rpc({ op: 'leave', stale: true, idleHours: 24 });
  assert.equal(report.changed, 0);
  const after = await f.readBytes();
  assert.deepEqual(after, before, 'the dry run wrote nothing');
  assert.deepEqual(await f.auditEntries(), [], 'a dry run is not a bulk action and is not audited');
});

test('--apply matches the dry run exactly', async t => {
  const f = await fixture(t);
  await f.register('a');
  await f.register('b');
  await f.restart(idle(['a', 'b'], 48));

  const dry = await f.rpc({ op: 'leave', stale: true, idleHours: 24 });
  const applied = await f.rpc({ op: 'leave', stale: true, idleHours: 24, apply: true });
  // The identity list is identical; the reported age ticks with the clock, so compare the rows.
  const rows = list => list.map(row => ({ agentId: row.agentId, runner: row.runner }));
  assert.deepEqual(rows(applied.candidates), rows(dry.candidates));
  assert.deepEqual(applied.kept, dry.kept);
  assert.deepEqual(applied.skippedLive, dry.skippedLive);
  assert.deepEqual(applied.total, dry.total);
  assert.equal(dry.changed, 0);
  assert.equal(applied.changed, dry.candidates.length);
  assert.equal(applied.dryRun, false);
  assert.ok(applied.candidates.every(row => Number.isFinite(row.lastSeenAgeMs)));
});

test('scope by id prefix and by runner', async t => {
  const f = await fixture(t);
  await f.register('claude-tmp-1', { runner: 'claude' });
  await f.register('claude-tmp-2', { runner: 'claude' });
  await f.register('codex-1', { runner: 'codex' });
  await f.restart(idle(['claude-tmp-1', 'claude-tmp-2', 'codex-1'], 48));

  const byPrefix = await f.rpc({ op: 'leave', stale: true, idleHours: 24, prefix: 'claude-tmp-' });
  assert.deepEqual(byPrefix.candidates.map(row => row.agentId).sort(), ['claude-tmp-1', 'claude-tmp-2']);
  assert.deepEqual(byPrefix.candidates.map(row => row.runner).sort(), ['claude', 'claude']);

  const byRunner = await f.rpc({ op: 'retire', stale: true, idleHours: 24, runner: 'codex' });
  assert.deepEqual(byRunner.candidates.map(row => row.agentId), ['codex-1']);

  const both = await f.rpc({ op: 'leave', stale: true, idleHours: 24, prefix: 'claude-tmp-', runner: 'codex' });
  assert.deepEqual(both.candidates, [], 'prefix and runner narrow together');
});

test('a live identity is skipped, never touched', async t => {
  const f = await fixture(t);
  await f.register('busy');
  const report = await f.rpc({ op: 'leave', stale: true, idleHours: 0 });
  assert.deepEqual(report.skippedLive, ['busy']);
  assert.deepEqual(report.candidates, []);
  const applied = await f.rpc({ op: 'leave', stale: true, idleHours: 0, apply: true });
  assert.equal(applied.changed, 0);
  const state = await f.readState();
  assert.equal(f.agentRow(state, 'busy').left, undefined);
});

test('every applied bulk action is audited: who ran it and which ids changed', async t => {
  const f = await fixture(t);
  await f.register('claude-tmp-1');
  await f.register('claude-tmp-2');
  await f.restart(idle(['claude-tmp-1', 'claude-tmp-2'], 48));

  const applied = await f.rpc({ op: 'leave', stale: true, idleHours: 24, prefix: 'claude-tmp-1', apply: true, actor: 'ops@example' });
  assert.equal(applied.changed, 1);
  const entries = await f.auditEntries();
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.event, 'bulk-leave');
  assert.equal(entry.actor, 'ops@example');
  assert.deepEqual(entry.changed, ['claude-tmp-1']);
  assert.equal(entry.changedCount, 1);
  assert.equal(entry.dryRun, false);
  assert.ok(entry.at, 'the entry is timestamped');
  assert.equal(entry.scope.prefix, 'claude-tmp-1');
  assert.equal(entry.scope.idleHours, 24);
  assert.ok(!/[a-f0-9]{64}/u.test(JSON.stringify(entry)), 'the audit log never carries a token');
  if (process.platform !== 'win32') {
    const info = await fs.stat(path.join(f.dataDir, AUDIT_FILE_NAME));
    assert.equal(info.mode & 0o777, 0o600, 'the audit log is owner-only');
  }
});

test('stale claims are surfaced with age and owner state, and appear in the blocked view', async t => {
  const f = await fixture(t);
  await f.register('live');
  await f.register('dormant');
  await f.rpc({ op: 'claim', agentId: 'live', resources: ['build'] });
  await f.rpc({ op: 'claim', agentId: 'dormant', resources: ['install'] });

  const none = await f.rpc({ op: 'staleClaims' });
  assert.deepEqual(none.claims, [], 'a claim held by a live owner is not stale');

  await f.rpc({ op: 'leave', agentId: 'dormant' });
  const listed = await f.rpc({ op: 'staleClaims' });
  assert.equal(listed.claims.length, 1);
  assert.equal(listed.claims[0].resource, 'install');
  assert.equal(listed.claims[0].agentId, 'dormant');
  assert.equal(listed.claims[0].scope, 'project');
  assert.equal(listed.claims[0].holder, 'left');
  assert.ok(listed.claims[0].ageMs >= 0);
  assert.ok(listed.claims[0].lastSeenAgeMs >= 0);

  const blocked = await f.rpc({ op: 'blocked' });
  const shape = rows => rows.map(row => ({ resource: row.resource, agentId: row.agentId, scope: row.scope, holder: row.holder }));
  assert.deepEqual(shape(blocked.staleClaims), shape(listed.claims), 'the blocked view shows the same list');

  // agents and the dashboard snapshot use the same liveness classification, so a stale
  // claim there carries its age and the owner's state, not only a boolean.
  const agents = await f.rpc({ op: 'agents' });
  const dormant = agents.claims.find(claim => claim.resource === 'install');
  const live = agents.claims.find(claim => claim.resource === 'build');
  assert.equal(dormant.stale, true);
  assert.equal(dormant.holder, 'left');
  assert.ok(dormant.ageMs >= 0);
  assert.ok(dormant.lastSeenAgeMs >= 0);
  assert.equal(live.stale, false);
  assert.equal(live.holder, 'active');
  const snapshot = await f.rpc({ op: 'snapshot' });
  const surfaced = snapshot.claims.find(claim => claim.resource === 'install');
  assert.equal(surfaced.holder, 'left');
  assert.equal(surfaced.stale, true);
  assert.equal(typeof surfaced.claimedAt, 'string', 'the dashboard ages the claim from its timestamp');
});

test('a claim held by a live owner is never released; a dormant owner is released only with the opt-in', async t => {
  const f = await fixture(t);
  await f.register('live');
  await f.register('dormant');
  await f.rpc({ op: 'claim', agentId: 'live', resources: ['build'] });
  await f.rpc({ op: 'claim', agentId: 'dormant', resources: ['install'] });
  await f.rpc({ op: 'leave', agentId: 'dormant' });
  await f.restart(ageClaims(3));

  // Without the opt-in nothing is released, even after a restart.
  const still = await f.rpc({ op: 'staleClaims' });
  assert.equal(still.claims.length, 1);
  let state = await f.readState();
  assert.deepEqual(state.rooms[0].claims.map(claim => claim.resource).sort(), ['build', 'install']);

  // With the opt-in the dormant owner's claim is released; the live owner's claim is not.
  await f.restart(null, { pruneAfterMinutes: 0, releaseStaleClaimsHours: 1 });
  const after = await f.rpc({ op: 'staleClaims' });
  assert.deepEqual(after.claims, []);
  state = await f.readState();
  assert.deepEqual(state.rooms[0].claims.map(claim => claim.resource), ['build'], 'the live owner keeps its claim');

  // The release is logged in the release log and in the audit log.
  assert.equal(state.releaseLog.length, 1);
  assert.equal(state.releaseLog[0].scope, 'project');
  assert.deepEqual(state.releaseLog[0].released, ['install']);
  assert.equal(state.releaseLog[0].as, 'daemon');
  const entries = await f.auditEntries();
  const release = entries.find(entry => entry.event === 'auto-release-stale-claims');
  assert.ok(release, 'the release is audited');
  assert.deepEqual(release.changed, ['project:install']);
  assert.deepEqual(release.owners, ['dormant']);
});

test('the room is notified when a stale claim is released', async t => {
  const f = await fixture(t);
  await f.register('dormant');
  await f.rpc({ op: 'claim', agentId: 'dormant', resources: ['build'] });
  await f.rpc({ op: 'leave', agentId: 'dormant' });
  await f.restart(ageClaims(3));
  await f.restart(null, { pruneAfterMinutes: 0, releaseStaleClaimsHours: 1 });
  const state = await f.readState();
  const notices = state.rooms[0].notices ?? [];
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'stale-claim-released');
  assert.deepEqual(notices[0].resources, ['build']);
  assert.deepEqual(notices[0].agentIds, ['dormant']);
});

test('bulk input is validated and the single identity form is untouched', async t => {
  const f = await fixture(t);
  await f.register('a');
  const bad = await f.request({ op: 'leave', stale: 'yes' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'INVALID_INPUT');
  const badHours = await f.request({ op: 'leave', stale: true, idleHours: -1 });
  assert.equal(badHours.ok, false);
  assert.equal(badHours.error.code, 'INVALID_INPUT');
  const badApply = await f.request({ op: 'leave', stale: true, apply: 'yes' });
  assert.equal(badApply.ok, false);
  assert.equal(badApply.error.code, 'INVALID_INPUT');
  // The single identity form still behaves as before.
  const left = await f.rpc({ op: 'leave', agentId: 'a' });
  assert.equal(left.left, 'a');
});
