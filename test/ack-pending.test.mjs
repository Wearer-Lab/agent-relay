import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createBroker } from '../lib/broker.mjs';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = ms => new Date(Date.now() - ms).toISOString();

// The house fixture: a real handler, the serial writer and the durable ledger, without a TCP
// socket. The registry sweep is switched off so the ledger only changes when a test says so.
async function fixture(t, { seed = null, brokerOptions = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-pending-'));
  const dataDir = path.join(root, 'data'), project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(p => fs.mkdir(p)));
  if (seed) await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify(seed(await fs.realpath(project))));
  let handler, broker;
  const options = { pruneAfterMinutes: 0, compactAfterDays: 0, ...brokerOptions };
  const serverFactory = callback => { handler = callback; const server = new EventEmitter(); server.listen = (port, host, ready) => queueMicrotask(ready); server.address = () => ({ port: 0 }); server.close = done => done?.(); return server; };
  const open = () => createBroker({ dataDir, serverFactory, ...options });
  broker = await open();
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  async function request(fields, room = project) {
    let status, result;
    const response = new EventEmitter(); response.writeHead = code => { status = code; }; response.end = body => { result = JSON.parse(body); };
    const incoming = { method: 'POST', url: '/rpc', headers: { authorization: 'Bearer ' + broker.token }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ project: room, ...fields })); } };
    await handler(incoming, response); return { status, ...result };
  }
  const rpc = async (fields, room) => { const result = await request(fields, room); assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  const stateFile = path.join(dataDir, 'state.json');
  return { root, dataDir, project, stateFile, request, rpc,
    register: (agentId, extra = {}) => rpc({ op: 'register', agentId, runner: 'test', ...extra }),
    readBytes: async () => fs.readFile(stateFile, 'utf8'),
    async restart(mutate) {
      await broker.close();
      if (mutate) { const state = JSON.parse(await fs.readFile(stateFile, 'utf8')); mutate(state); await fs.writeFile(stateFile, JSON.stringify(state)); }
      broker = await open();
    } };
}

const agent = (agentId, { seenMs = MIN, left = false, retired = false } = {}) => ({
  agentId, runner: 'test', registeredAt: ago(30 * DAY), updatedAt: ago(seenMs), status: 'idle', frozen: false, resources: [], task: null,
  ...(left ? { left: true } : {}), ...(retired ? { retired: true } : {}) });

const message = (cursor, { from = 'ann', to, recipients, ageMs, ackedBy = [] }) => ({
  messageId: 'm' + cursor, from, to, body: 'body ' + cursor, createdAt: ago(ageMs), cursor,
  recipients, ackedBy, notified: [] });

// ann and bob are live, cat left (dormant), dan is retired, eve is registered but unseen for days.
// The hand-computed split of this fixture:
//   live     4  (m1, m2, the broadcast row for bob and the ten-day broadcast row for bob)
//   dormant  3  (the rows for cat and eve, plus the broadcast row for eve)
//   retired  1  (the row for dan)
//   expired  1  (m9, a direct message to the dormant cat, forty days old against a thirty-day TTL)
//   total    9  (m7 is acknowledged, so it is not pending)
// A delivery expires only when its recipient cannot read it any more: bob is live, so the
// ten-day broadcast row is still his backlog, not an expired one.
const AGENTS = [agent('ann'), agent('bob'), agent('cat', { left: true }), agent('dan', { retired: true }), agent('eve', { seenMs: 5 * DAY })];
const MESSAGES = [
  message(1, { to: 'bob', recipients: ['bob'], ageMs: 90 * MIN }),
  message(2, { to: 'bob', recipients: ['bob'], ageMs: 2 * HOUR }),
  message(3, { to: 'cat', recipients: ['cat'], ageMs: 3 * HOUR }),
  message(4, { to: 'dan', recipients: ['dan'], ageMs: 4 * HOUR }),
  message(5, { to: 'eve', recipients: ['eve'], ageMs: 5 * HOUR }),
  message(6, { to: '*', recipients: ['bob', 'eve'], ageMs: 30 * MIN }),
  message(7, { to: 'bob', recipients: ['bob'], ageMs: 5 * MIN, ackedBy: ['bob'] }),
  message(8, { to: '*', recipients: ['bob'], ageMs: 10 * DAY }),
  message(9, { to: 'cat', recipients: ['cat'], ageMs: 40 * DAY }),
];
const seeded = project => ({ version: 1, nextCursor: MESSAGES.length + 1,
  rooms: [{ project, agents: AGENTS, messages: MESSAGES, claims: [], cursor: MESSAGES.length }] });

test('the pending split sums to the old total and the headline is the live-recipient count', async t => {
  const f = await fixture(t, { seed: seeded });
  const snapshot = await f.rpc({ op: 'snapshot' });
  assert.equal(snapshot.pendingDeliveries, 9, 'the old total still counts every pending delivery');
  assert.deepEqual(snapshot.pending.counts, { live: 4, dormant: 3, retired: 1, expired: 1 });
  assert.equal(snapshot.pending.total, snapshot.pendingDeliveries);
  assert.equal(snapshot.pending.counts.live + snapshot.pending.counts.dormant
    + snapshot.pending.counts.retired + snapshot.pending.counts.expired, snapshot.pending.total);
  assert.equal(snapshot.pending.headline, snapshot.pending.counts.live, 'the headline awaits live agents');
  assert.equal(snapshot.pending.headline, 4);
  // The per-agent split uses the same four groups.
  assert.deepEqual(snapshot.pending.byAgent, {
    bob: { live: 4, dormant: 0, retired: 0, expired: 0, total: 4 },
    cat: { live: 0, dormant: 1, retired: 0, expired: 1, total: 2 },
    dan: { live: 0, dormant: 0, retired: 1, expired: 0, total: 1 },
    eve: { live: 0, dormant: 2, retired: 0, expired: 0, total: 2 },
  });
  // The old numeric map keeps its shape, so existing readers keep working.
  assert.deepEqual(snapshot.pendingByAgent, { ann: 0, bob: 4, cat: 2, dan: 1, eve: 2 });
});

test('the pending breakdown matches a hand-computed table', async t => {
  const f = await fixture(t, { seed: seeded });
  const byState = await f.rpc({ op: 'pending', by: 'state' });
  assert.equal(byState.total, 9);
  assert.deepEqual(byState.counts, { live: 4, dormant: 3, retired: 1, expired: 1 });
  assert.deepEqual(byState.groups, [
    { key: 'awaiting-live', count: 4 }, { key: 'awaiting-dormant', count: 3 },
    { key: 'awaiting-retired', count: 1 }, { key: 'expired', count: 1 }]);
  assert.deepEqual(byState.rows.map(row => [row.messageId, row.recipient, row.state]), [
    ['m1', 'bob', 'awaiting-live'], ['m2', 'bob', 'awaiting-live'], ['m3', 'cat', 'awaiting-dormant'],
    ['m4', 'dan', 'awaiting-retired'], ['m5', 'eve', 'awaiting-dormant'], ['m6', 'bob', 'awaiting-live'],
    ['m6', 'eve', 'awaiting-dormant'], ['m8', 'bob', 'awaiting-live'], ['m9', 'cat', 'expired']]);
  assert.equal(byState.rows[0].from, 'ann');
  assert.equal(byState.rows[0].to, 'bob');
  assert.equal(byState.rows[0].kind, 'direct');
  assert.deepEqual(byState.rows[0].recipients, ['bob']);
  assert.ok(byState.rows[0].ageMs >= 90 * MIN);

  const byRecipient = await f.rpc({ op: 'pending', by: 'recipient' });
  assert.deepEqual(byRecipient.groups, [
    { key: 'bob', count: 4 }, { key: 'cat', count: 2 }, { key: 'eve', count: 2 }, { key: 'dan', count: 1 }]);
  const bySender = await f.rpc({ op: 'pending', by: 'sender' });
  assert.deepEqual(bySender.groups, [{ key: 'ann', count: 9 }]);
  const byKind = await f.rpc({ op: 'pending', by: 'kind' });
  assert.deepEqual(byKind.groups, [
    { key: 'broadcast', count: 3 }, { key: 'direct', count: 6 }, { key: 'task', count: 0 },
    { key: 'handoff', count: 0 }, { key: 'bulletin', count: 0 }]);
  const byAge = await f.rpc({ op: 'pending', by: 'age' });
  assert.deepEqual(byAge.groups, [
    { key: 'under-1h', count: 2 }, { key: '1h-to-1d', count: 5 }, { key: '1d-to-7d', count: 0 },
    { key: '7d-to-30d', count: 1 }, { key: 'over-30d', count: 1 }]);
  // Every grouping sees the same deliveries.
  for (const by of ['recipient', 'sender', 'kind', 'age']) {
    const grouped = await f.rpc({ op: 'pending', by });
    assert.equal(grouped.total, 9, by);
    assert.equal(grouped.groups.reduce((sum, group) => sum + group.count, 0), 9, by);
  }
});

test('the pending operation is read-only: no agent, no ledger change, the same numbers twice', async t => {
  const f = await fixture(t, { seed: seeded });
  const agentsBefore = await f.rpc({ op: 'agents' });
  // Fetching the inbox records delivery. That write belongs to inbox, so the
  // snapshot is taken after it: pending itself must leave the ledger alone.
  const inboxBefore = await f.rpc({ op: 'inbox', agentId: 'bob' });
  const before = await f.readBytes();
  const first = await f.rpc({ op: 'pending' });
  const second = await f.rpc({ op: 'pending' });
  assert.equal(await f.readBytes(), before, 'the ledger file is untouched');
  const agentsAfter = await f.rpc({ op: 'agents' });
  assert.equal(agentsAfter.agents.length, agentsBefore.agents.length, 'no observer was registered');
  assert.deepEqual(agentsAfter.counts, agentsBefore.counts);
  const inboxAfter = await f.rpc({ op: 'inbox', agentId: 'bob' });
  assert.deepEqual(inboxAfter.messages.map(row => row.messageId), inboxBefore.messages.map(row => row.messageId));
  assert.deepEqual(first.total, second.total);
  assert.deepEqual(first.counts, second.counts);
  assert.deepEqual(first.groups, second.groups);
  assert.deepEqual(first.rows.map(row => ({ ...row, ageMs: 0 })), second.rows.map(row => ({ ...row, ageMs: 0 })));
  // It is a broker operation, not a file read: an unknown project is refused the same way.
  const unknown = await f.request({ op: 'pending' }, 'relative');
  assert.equal(unknown.error.code, 'INVALID_PROJECT');
});

test('the pending rows are paged and bounded', async t => {
  const f = await fixture(t, { seed: seeded });
  const page = await f.rpc({ op: 'pending', limit: 3 });
  assert.equal(page.limit, 3);
  assert.equal(page.offset, 0);
  assert.equal(page.rows.length, 3);
  assert.deepEqual(page.rows.map(row => row.messageId), ['m1', 'm2', 'm3']);
  const next = await f.rpc({ op: 'pending', limit: 3, offset: 3 });
  assert.deepEqual(next.rows.map(row => row.messageId), ['m4', 'm5', 'm6']);
  assert.equal((await f.rpc({ op: 'pending' })).limit, 50, 'the default page holds fifty rows');
  assert.equal((await f.request({ op: 'pending', limit: 0 })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'pending', limit: 501 })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'pending', offset: -1 })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'pending', by: 'colour' })).error.code, 'INVALID_INPUT');
});

test('the four groups are right for a live, a dormant and a retired recipient', async t => {
  const f = await fixture(t);
  for (const id of ['ann', 'bob', 'cat', 'dan']) await f.register(id);
  await f.rpc({ op: 'send', from: 'ann', to: 'bob', body: 'live', messageId: 'live' });
  await f.rpc({ op: 'send', from: 'ann', to: 'cat', body: 'dormant', messageId: 'dormant' });
  await f.rpc({ op: 'send', from: 'ann', to: 'dan', body: 'retired', messageId: 'retired' });
  await f.rpc({ op: 'leave', agentId: 'cat' });
  await f.rpc({ op: 'retire', agentId: 'dan' });
  const rows = (await f.rpc({ op: 'pending', by: 'recipient' })).rows;
  const stateOf = id => rows.find(row => row.recipient === id)?.state;
  assert.equal(stateOf('bob'), 'awaiting-live');
  assert.equal(stateOf('cat'), 'awaiting-dormant');
  assert.equal(stateOf('dan'), 'awaiting-retired');
  const counts = (await f.rpc({ op: 'pending' })).counts;
  assert.deepEqual(counts, { live: 1, dormant: 1, retired: 1, expired: 0 });
  // An acknowledgement takes the delivery out of the backlog entirely.
  await f.rpc({ op: 'ack', agentId: 'bob', messageId: 'live' });
  const after = (await f.rpc({ op: 'pending' })).counts;
  assert.deepEqual(after, { live: 0, dormant: 1, retired: 1, expired: 0 });
});

test('usage reports the same split, warns at 80% of the message cap and names the blockers', async t => {
  const filler = count => Array.from({ length: count }, (_, index) => message(index + 1,
    { from: 'ann', to: 'bob', recipients: ['bob'], ageMs: 5 * MIN, ackedBy: ['bob'] }));
  const blocker = message(9000, { from: 'ann', to: 'cat', recipients: ['cat'], ageMs: 20 * DAY });
  const agents = [agent('ann'), agent('bob'), agent('cat', { left: true })];
  const seed = count => project => ({ version: 1, nextCursor: 9001,
    rooms: [{ project, agents, messages: [...filler(count), blocker], claims: [], cursor: 9000 }] });
  const f = await fixture(t, { seed: seed(7999) });
  const usage = await f.rpc({ op: 'usage' });
  assert.equal(usage.messages.used, 8000, 'the ledger holds eight thousand messages');
  assert.equal(usage.messages.limit, 10000);
  assert.ok(usage.nearLimit.includes('messages'), '80% of the cap warns');
  assert.equal(usage.pending.total, 1, 'only the blocker is pending');
  assert.deepEqual(usage.pending.counts, { live: 0, dormant: 1, retired: 0, expired: 0 });
  assert.equal(usage.blockers.length, 1);
  assert.equal(usage.blockers[0].agentId, 'cat');
  assert.equal(usage.blockers[0].messages, 1);
  const warning = usage.warnings.find(row => row.code === 'messages');
  assert.ok(warning, 'the warning exists');
  assert.match(warning.message, /cat/, 'the warning names the compaction blocker');
  assert.deepEqual(warning.blockers.map(row => row.agentId), ['cat']);
  // One message fewer is below the threshold.
  await f.restart(state => { state.rooms[0].messages = state.rooms[0].messages.filter(row => row.messageId !== 'm1'); });
  const below = await f.rpc({ op: 'usage' });
  assert.equal(below.messages.used, 7999);
  assert.equal(below.nearLimit.includes('messages'), false, 'below 80% nothing warns');
});

test('the kind of a delivery names the work it carries', async t => {
  const f = await fixture(t);
  for (const id of ['ann', 'bob', 'cid', 'dee', 'eve']) await f.register(id);
  await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'ann', title: 'Build it', owner: 'bob' });
  await f.rpc({ op: 'claim', agentId: 'ann', resources: ['build'] });
  await f.rpc({ op: 'requestHandoff', agentId: 'ann', to: 'cid', resources: ['build'], reason: 'context' });
  await f.rpc({ op: 'setBulletin', agentId: 'ann', title: 'House rules', body: 'Be kind', source: 'ann' });
  await f.rpc({ op: 'send', from: 'ann', to: 'bob', body: 'task', messageId: 'task-msg' });
  await f.rpc({ op: 'send', from: 'ann', to: 'cid', body: 'handoff', messageId: 'handoff-msg' });
  await f.rpc({ op: 'send', from: 'ann', to: 'dee', body: 'Be kind', summary: 'House rules', messageId: 'bulletin-msg' });
  await f.rpc({ op: 'send', from: 'ann', to: 'eve', body: 'plain', messageId: 'plain-msg' });
  const rows = (await f.rpc({ op: 'pending', by: 'kind' })).rows;
  assert.deepEqual(rows.map(row => [row.messageId, row.kind]), [
    ['task-msg', 'task'], ['handoff-msg', 'handoff'], ['bulletin-msg', 'bulletin'], ['plain-msg', 'direct']]);
  const groups = (await f.rpc({ op: 'pending', by: 'kind' })).groups;
  assert.deepEqual(groups.filter(group => group.count), [
    { key: 'direct', count: 1 }, { key: 'task', count: 1 }, { key: 'handoff', count: 1 }, { key: 'bulletin', count: 1 }]);
});

test('usage reports the pending split of every room', async t => {
  const f = await fixture(t, { seed: seeded });
  const usage = await f.rpc({ op: 'usage' });
  assert.equal(usage.pending.total, 9);
  assert.deepEqual(usage.pending.counts, { live: 4, dormant: 3, retired: 1, expired: 1 });
  assert.deepEqual(usage.warnings, [], 'a quiet room warns about nothing');
});
