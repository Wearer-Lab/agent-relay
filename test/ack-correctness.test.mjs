// Lane 01: the ack-backlog correctness fixes.
// Stale transports stop counting as live, deliveries expire per recipient, temporary identities
// are ephemeral, and a dry run says what blocks compaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createBroker } from '../lib/broker.mjs';
import { compactionBlockers, deliveryStatus, DEFAULT_BROADCAST_TTL_DAYS, DEFAULT_DIRECT_TTL_DAYS } from '../lib/compaction.mjs';

const MIN = 60000;
const DAY = 864e5;
const ago = ms => new Date(Date.now() - ms).toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Real HTTP handler, serial writer and durable ledger without binding TCP.
async function fixture(t, brokerOptions = { pruneAfterMinutes: 0, compactAfterDays: 0 }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-ack-'));
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
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  async function request(fields, room = project) {
    let status, result;
    const response = new EventEmitter();
    response.writeHead = code => { status = code; };
    response.end = body => { result = JSON.parse(body); };
    const incoming = { method: 'POST', url: '/rpc', headers: { authorization: 'Bearer ' + broker.token },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ project: room, ...fields })); } };
    await handler(incoming, response);
    return { status, ...result };
  }
  const rpc = async (fields, room) => {
    const result = await request(fields, room);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  const stateFile = path.join(dataDir, 'state.json');
  return {
    root, dataDir, project, stateFile, request, rpc,
    get handler() { return handler; },
    get broker() { return broker; },
    register: (agentId, extra = {}) => rpc({ op: 'register', agentId, runner: 'test', ...extra }),
    readState: async () => JSON.parse(await fs.readFile(stateFile, 'utf8')),
    archiveFiles: async () => (await fs.readdir(path.join(dataDir, 'archive')).catch(() => [])),
    archiveLines: async name => (await fs.readFile(path.join(dataDir, 'archive', name), 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    // A long poll whose connection closes before the poll ends: the client went away.
    async dropWait(agentId, { timeoutMs = 25000 } = {}) {
      const response = new EventEmitter();
      response.writeHead = () => {};
      response.end = () => {};
      const incoming = { method: 'POST', url: '/rpc', headers: { authorization: 'Bearer ' + broker.token },
        async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ project, op: 'wait', agentId, after: 0, timeoutMs })); } };
      const pending = handler(incoming, response);
      await sleep(20);
      response.emit('close');
      await pending;
    },
    // Close, edit the persisted ledger, reopen (optionally with new broker options).
    async restart(mutate, nextOptions) {
      await broker.close();
      if (mutate) {
        const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        mutate(state);
        await fs.writeFile(stateFile, JSON.stringify(state));
      }
      if (nextOptions) options = nextOptions;
      broker = await open();
    }
  };
}
const agentRow = (state, id) => state.rooms[0].agents.find(a => a.agentId === id);
const messageRow = (state, id) => state.rooms[0].messages.find(m => m.messageId === id);
const ageAgent = (state, id, ms, patch = {}) => {
  const agent = agentRow(state, id);
  agent.updatedAt = ago(ms);
  Object.assign(agent, patch);
};
const ageMessage = (state, id, ms) => { messageRow(state, id).createdAt = ago(ms); };

test('a stale transport report is prunable, and a watcher that keeps reporting stays live', async t => {
  const f = await fixture(t);
  await f.register('watcher');
  await f.register('sleepy');
  await f.rpc({ op: 'status', agentId: 'watcher', transport: { adapter: 'test', state: 'connected' } });
  await f.rpc({ op: 'status', agentId: 'sleepy', transport: { adapter: 'test', state: 'connected' } });
  await f.restart(state => {
    ageAgent(state, 'sleepy', 2 * DAY, { transport: { adapter: 'test', state: 'connected', ts: ago(2 * DAY), source: 'adapter-report' } });
  });
  const rows = (await f.rpc({ op: 'agents' })).agents;
  const watcher = rows.find(row => row.agentId === 'watcher');
  const sleepy = rows.find(row => row.agentId === 'sleepy');
  assert.equal(watcher.transportStale, false, 'a fresh report is not stale');
  assert.equal(typeof watcher.transportAgeMs, 'number');
  assert.equal(sleepy.transportStale, true, 'an old connected report is a claim, not a fact');
  assert.ok(sleepy.transportAgeMs >= 2 * DAY);
  const dry = await f.rpc({ op: 'prune' });
  assert.deepEqual(dry.candidates.map(c => c.agentId), ['sleepy'], 'a connected agent unseen for days is prunable');
  assert.equal(dry.candidates[0].ephemeral, false);
  // The watcher stays: its report is fresh.
  await f.rpc({ op: 'prune', dryRun: false });
  assert.equal(agentRow(await f.readState(), 'watcher').left, undefined);
  assert.equal(agentRow(await f.readState(), 'sleepy').left, true);
});

test('the agents and snapshot rows show the transport age and the stale flag', async t => {
  const f = await fixture(t);
  await f.register('watcher');
  await f.rpc({ op: 'status', agentId: 'watcher', transport: { adapter: 'test', state: 'connected' } });
  const row = (await f.rpc({ op: 'agents' })).agents.find(r => r.agentId === 'watcher');
  assert.equal(typeof row.transportAgeMs, 'number');
  assert.equal(row.transportStale, false);
  assert.equal(row.readiness.transportAgeMs, row.transportAgeMs, 'the age sits next to the transport');
  assert.equal(row.readiness.transportStale, false);
  const snapshot = (await f.rpc({ op: 'snapshot' })).agents.find(r => r.agentId === 'watcher');
  assert.equal(typeof snapshot.transportAgeMs, 'number');
  assert.equal(snapshot.transportStale, false);
  await f.restart(state => {
    ageAgent(state, 'watcher', 30 * MIN, { transport: { adapter: 'test', state: 'connected', ts: ago(30 * MIN), source: 'adapter-report' } });
  });
  const stale = (await f.rpc({ op: 'agents' })).agents.find(r => r.agentId === 'watcher');
  assert.equal(stale.transportStale, true);
  assert.ok(stale.transportAgeMs >= 30 * MIN);
  const staleSnapshot = (await f.rpc({ op: 'snapshot' })).agents.find(r => r.agentId === 'watcher');
  assert.equal(staleSnapshot.transportStale, true, 'the snapshot view passes the same fields through');
  assert.ok(staleSnapshot.transportAgeMs >= 30 * MIN);
});

test('the sweep rewrites a stale connected transport to unknown with source expired', async t => {
  const f = await fixture(t, { pruneAfterMinutes: 60, compactAfterDays: 0 });
  await f.register('ghost');
  await f.rpc({ op: 'status', agentId: 'ghost', transport: { adapter: 'mcp-watch', state: 'connected' } });
  const reported = ago(2 * DAY);
  await f.restart(state => {
    ageAgent(state, 'ghost', 2 * DAY, { transport: { adapter: 'mcp-watch', state: 'connected', ts: reported, source: 'adapter-report' } });
  }, { pruneAfterMinutes: 60, compactAfterDays: 0 });
  const ghost = agentRow(await f.readState(), 'ghost');
  assert.equal(ghost.transport.state, 'unknown', 'a stale connected claim is rewritten to the truth');
  assert.equal(ghost.transport.source, 'expired');
  assert.equal(ghost.transport.adapter, 'mcp-watch', 'the adapter that made the claim is kept');
  assert.equal(ghost.transport.ts, reported, 'the report that went stale is kept, so its age stays visible');
  const counts = (await f.rpc({ op: 'agents' })).counts;
  assert.equal(counts.staleTransports, 0, 'no stale connected claim is left in the room');
});

test('a dropped wait connection marks the transport disconnected after the grace period, and not before', async t => {
  const f = await fixture(t, { pruneAfterMinutes: 0, watcherGraceMs: 300 });
  await f.register('watcher');
  await f.rpc({ op: 'status', agentId: 'watcher', transport: { adapter: 'mcp-watch', state: 'connected' } });
  await f.dropWait('watcher');
  await sleep(80);
  assert.equal(agentRow(await f.readState(), 'watcher').transport.state, 'connected', 'the grace period has not passed yet');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (agentRow(await f.readState(), 'watcher').transport.state === 'disconnected') break;
    await sleep(20);
  }
  const transport = agentRow(await f.readState(), 'watcher').transport;
  assert.equal(transport.state, 'disconnected', 'the broker notices the dropped watcher itself');
  assert.equal(transport.source, 'broker');
});

test('a watcher that polls again inside the grace period keeps its transport', async t => {
  const f = await fixture(t, { pruneAfterMinutes: 0, watcherGraceMs: 300 });
  await f.register('watcher');
  await f.rpc({ op: 'status', agentId: 'watcher', transport: { adapter: 'mcp-watch', state: 'connected' } });
  await f.dropWait('watcher');
  await f.rpc({ op: 'wait', agentId: 'watcher', after: 0, timeoutMs: 0 });
  await sleep(500);
  assert.equal(agentRow(await f.readState(), 'watcher').transport.state, 'connected', 'the watcher came back');
});

test('one idle non-left recipient no longer blocks a broadcast', async t => {
  const f = await fixture(t);
  await f.register('sender');
  await f.register('idle');
  const sent = await f.rpc({ op: 'send', from: 'sender', to: '*', body: 'hello', messageId: 'bc' });
  assert.deepEqual(sent.recipients, ['idle']);
  // Inside the broadcast TTL the delivery still waits.
  await f.restart(state => { ageMessage(state, 'bc', 3 * DAY); ageAgent(state, 'idle', 3 * DAY); });
  const inside = await f.rpc({ op: 'compact', olderThanDays: 2, dryRun: true });
  assert.equal(inside.archivedMessages, 0, 'the broadcast is still inside its seven day TTL');
  assert.deepEqual(inside.blockers.map(b => b.agentId), ['idle']);
  // Past the TTL the idle recipient no longer pins it.
  await f.restart(state => { ageMessage(state, 'bc', 9 * DAY); ageAgent(state, 'idle', 9 * DAY); });
  const outside = await f.rpc({ op: 'compact', olderThanDays: 2, dryRun: true });
  assert.equal(outside.archivedMessages, 1, 'one idle recipient no longer blocks the broadcast');
  assert.equal(outside.expiredDeliveries, 1);
});

test('a direct message to a dormant identity survives a week and archives after a month', async t => {
  const f = await fixture(t);
  await f.register('a');
  await f.register('b');
  await f.rpc({ op: 'leave', agentId: 'b' });
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'for later', messageId: 'dm' });
  await f.restart(state => { ageMessage(state, 'dm', 8 * DAY); ageAgent(state, 'b', 8 * DAY); });
  const week = await f.rpc({ op: 'compact', olderThanDays: 7, dryRun: true });
  assert.equal(week.archivedMessages, 0, 'a dormant identity keeps its inbox for a month');
  assert.deepEqual(week.blockers.map(b => b.agentId), ['b']);
  await f.restart(state => { ageMessage(state, 'dm', 31 * DAY); ageAgent(state, 'b', 31 * DAY); });
  const month = await f.rpc({ op: 'compact', olderThanDays: 7, dryRun: true });
  assert.equal(month.archivedMessages, 1, 'after thirty days the durable inbox is over');
  assert.equal(month.expiredDeliveries, 1);
});

test('expired deliveries land in the archive with the recipient and the reason', async t => {
  const f = await fixture(t);
  await f.register('sender');
  await f.register('idle');
  await f.rpc({ op: 'send', from: 'sender', to: '*', body: 'hello', messageId: 'bc' });
  await f.restart(state => { ageMessage(state, 'bc', 9 * DAY); ageAgent(state, 'idle', 9 * DAY); });
  const applied = await f.rpc({ op: 'compact', olderThanDays: 2, dryRun: false });
  assert.equal(applied.archivedMessages, 1);
  const lines = await f.archiveLines(applied.archive.name);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].project, await fs.realpath(f.project));
  assert.equal(lines[0].message.messageId, 'bc');
  assert.deepEqual(lines[0].expired, [{ recipient: 'idle', reason: 'broadcast-ttl', ttlDays: DEFAULT_BROADCAST_TTL_DAYS, pendingDays: 9 }]);
  const state = await f.readState();
  assert.equal(state.rooms[0].messages.length, 0, 'the archived message left the ledger');
  assert.equal(state.rooms[0].archived.expiredDeliveries, 1);
});

test('legacy tmp identities are ephemeral: swept, retired, and reported when they hold a claim', async t => {
  const f = await fixture(t, { pruneAfterMinutes: 60, compactAfterDays: 0 });
  await f.register('claude-tmp-1712abcd');
  await f.register('codex-tmp-9911ff');
  await f.rpc({ op: 'claim', agentId: 'codex-tmp-9911ff', resources: ['build'] });
  await f.restart(state => {
    ageAgent(state, 'claude-tmp-1712abcd', 2 * 60 * MIN);
    ageAgent(state, 'codex-tmp-9911ff', 2 * 60 * MIN);
  }, { pruneAfterMinutes: 60, compactAfterDays: 0 });
  const state = await f.readState();
  const free = agentRow(state, 'claude-tmp-1712abcd');
  assert.equal(free.left, true, 'a tmp identity that holds nothing is swept');
  assert.equal(free.retired, true, 'and retired, so it counts as a finished recipient at once');
  assert.equal(free.ephemeral, undefined, 'the stored flag did not exist when it registered');
  const busy = agentRow(state, 'codex-tmp-9911ff');
  assert.equal(busy.left, undefined, 'a tmp identity that holds a claim is kept');
  assert.equal(busy.retired, undefined, 'and never retired');
  const dry = await f.rpc({ op: 'prune' });
  assert.deepEqual(dry.keptEphemeral.map(row => row.agentId), ['codex-tmp-9911ff'], 'the held tmp identity is reported');
  assert.deepEqual(dry.keptEphemeral[0].obligations.claims, ['build']);
});

test('a compact dry run names the identity that blocks compaction', async t => {
  const f = await fixture(t);
  await f.register('sender');
  await f.register('keeper');
  await f.rpc({ op: 'send', from: 'sender', to: '*', body: 'hello', messageId: 'bc' });
  await f.restart(state => { ageMessage(state, 'bc', 3 * DAY); ageAgent(state, 'keeper', 3 * DAY); });
  const dry = await f.rpc({ op: 'compact', olderThanDays: 2, dryRun: true });
  assert.equal(dry.archivedMessages, 0);
  assert.equal(dry.blockers.length, 1);
  const blocker = dry.blockers[0];
  assert.equal(blocker.agentId, 'keeper');
  assert.equal(blocker.messages, 1, 'it pins one message');
  assert.equal(blocker.deliveries, 1, 'and holds one delivery row');
  assert.equal(blocker.holder, 'stale');
  assert.equal(blocker.live, false);
  assert.ok(blocker.lastSeenAgeMs >= 3 * DAY);
  assert.equal(blocker.transportAgeMs, null, 'it never reported a transport');
  assert.equal(blocker.transportStale, false);
});

test('the prune report splits kept identities: live ones and stale transport claims', async t => {
  const f = await fixture(t);
  await f.register('live');
  await f.register('claimed');
  await f.rpc({ op: 'status', agentId: 'live', transport: { adapter: 'test', state: 'connected' } });
  await f.rpc({ op: 'status', agentId: 'claimed', transport: { adapter: 'test', state: 'connected' } });
  await f.restart(state => {
    ageAgent(state, 'claimed', 3 * 60 * MIN, { transport: { adapter: 'test', state: 'connected', ts: ago(3 * 60 * MIN), source: 'adapter-report' } });
  });
  const dry = await f.rpc({ op: 'prune' });
  assert.deepEqual(dry.kept, { withObligations: 0, live: 2 }, 'the existing counters keep their shape');
  assert.deepEqual(dry.keptBreakdown, { live: 1, connectedNotSeen: 1, notSeen: 0, withObligations: 0 },
    'a connected transport nobody refreshed is reported apart from the truly live ones');
});

test('the compact op takes the delivery TTLs and reports them', async t => {
  const f = await fixture(t);
  const dry = await f.rpc({ op: 'compact', dryRun: true, broadcastTtlDays: 3, directTtlDays: 9 });
  assert.equal(dry.broadcastTtlDays, 3);
  assert.equal(dry.directTtlDays, 9);
  const defaults = await f.rpc({ op: 'compact', dryRun: true });
  assert.equal(defaults.broadcastTtlDays, DEFAULT_BROADCAST_TTL_DAYS);
  assert.equal(defaults.directTtlDays, DEFAULT_DIRECT_TTL_DAYS);
  assert.equal((await f.request({ op: 'compact', dryRun: true, broadcastTtlDays: -1 })).ok, false);
  assert.equal((await f.request({ op: 'compact', dryRun: true, directTtlDays: 'soon' })).ok, false);
});

test('the delivery TTLs are configurable per broker and from the environment', async t => {
  const prior = process.env.AGENT_RELAY_BROADCAST_TTL_DAYS;
  process.env.AGENT_RELAY_BROADCAST_TTL_DAYS = '2';
  t.after(() => { if (prior === undefined) delete process.env.AGENT_RELAY_BROADCAST_TTL_DAYS; else process.env.AGENT_RELAY_BROADCAST_TTL_DAYS = prior; });
  const f = await fixture(t, { pruneAfterMinutes: 0, compactAfterDays: 0 });
  const dry = await f.rpc({ op: 'compact', dryRun: true });
  assert.equal(dry.broadcastTtlDays, 2, 'the daemon environment sets the broadcast TTL');
  assert.equal(dry.directTtlDays, DEFAULT_DIRECT_TTL_DAYS);
  const explicit = await fixture(t, { pruneAfterMinutes: 0, compactAfterDays: 0, broadcastTtlDays: 5, directTtlDays: 11 });
  const other = await explicit.rpc({ op: 'compact', dryRun: true });
  assert.equal(other.broadcastTtlDays, 5, 'the daemon option wins over the environment');
  assert.equal(other.directTtlDays, 11);
});

test('the delivery TTLs are per recipient kind and the blocker view is exported for the usage op', async t => {
  const now = Date.now();
  const at = days => new Date(now - days * DAY).toISOString();
  const message = (to, days) => ({ messageId: 'm', from: 'a', to, body: 'x', createdAt: at(days), cursor: 1,
    recipients: to === '*' ? ['b'] : ['b'], ackedBy: [], notified: [] });
  const dormant = { agentId: 'b', updatedAt: at(9), left: true };
  assert.equal(deliveryStatus(message('*', 3), 'b', dormant, { now }), 'pending', 'a broadcast waits inside its TTL');
  assert.equal(deliveryStatus(message('*', 9), 'b', dormant, { now }), 'expired', 'a broadcast expires after a week');
  assert.equal(deliveryStatus(message('b', 9), 'b', dormant, { now }), 'pending', 'a direct message waits a month');
  assert.equal(deliveryStatus(message('b', 31), 'b', dormant, { now }), 'expired');
  assert.equal(deliveryStatus(message('b', 31), 'b', { ...dormant, retired: true }, { now }), 'retired');
  assert.equal(deliveryStatus(message('b', 31), 'b', null, { now }), 'gone');
  // A live recipient still gets its message, however old it is.
  assert.equal(deliveryStatus(message('b', 31), 'b', { agentId: 'b', updatedAt: at(0) }, { now }), 'pending');
  const room = { project: '/p', agents: [dormant], messages: [message('*', 9)], claims: [] };
  const view = compactionBlockers({}, room, { now, olderThanDays: 2 });
  assert.equal(view.blockers.length, 1);
  assert.equal(view.blockers[0].agentId, 'b');
  assert.equal(view.blockedMessages, 1);
});
