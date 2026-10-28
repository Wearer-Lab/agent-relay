import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBroker, validateStore } from '../lib/broker.mjs';
import { planMigration, migrateState, isSchema2, hasReadMessage, readersOf, backupStateFile, writeStateFile } from '../lib/schema2.mjs';
import { backlogState } from '../scripts/bench-schema2.mjs';

const DAY = 864e5;

// A schema 1 ledger with direct messages, broadcasts, readers and a dormant identity.
function ledger(project) {
  const now = Date.now(), iso = ms => new Date(ms).toISOString();
  const agent = (agentId, extra = {}) => ({ agentId, runner: 'test', registeredAt: iso(now - DAY),
    updatedAt: iso(now), status: 'idle', frozen: false, resources: [], task: null, ...extra });
  const agents = [agent('a'), agent('b'), agent('c'), agent('d'), agent('gone', { left: true, updatedAt: iso(now - DAY) })];
  let cursor = 0;
  const message = (from, to, recipients, ackedBy, extra = {}) => ({ messageId: `m-${++cursor}`, from, to,
    body: `body ${cursor}`, createdAt: iso(now - cursor * 1000), cursor, recipients, ackedBy,
    acks: ackedBy.map(id => ({ agentId: id, at: iso(now - cursor * 1000 + 500) })), notified: [], ...extra });
  const messages = [
    message('a', 'b', ['b'], ['b']),              // m-1 direct, read by b
    message('a', 'c', ['c'], []),                  // m-2 direct, unread
    message('a', '*', ['b', 'c', 'd'], ['b']),     // m-3 broadcast, read by b
    message('a', '*', ['b', 'c', 'd'], ['b', 'c']),// m-4 broadcast, read by b and c
    message('b', 'c', ['c'], ['c']),               // m-5 direct, read by c
    message('a', 'd', ['d'], []),                  // m-6 direct, unread
  ];
  return { version: 1, nextCursor: cursor + 1, rooms: [{ project, agents, messages, claims: [], cursor }] };
}

async function root(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'relay-schema2-')));
  const project = path.join(dir, 'project');
  await fs.mkdir(project);
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  return { dir, project };
}

async function broker(t, dataDir, project, seed) {
  await fs.mkdir(dataDir, { recursive: true });
  if (seed) await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify(seed));
  let broker = await createBroker({ dataDir, pruneAfterMinutes: 0, compactAfterDays: 0 });
  const call = async fields => {
    const response = await fetch(`${broker.url}/rpc`, { method: 'POST',
      headers: { authorization: `Bearer ${broker.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ project, ...fields }) });
    const result = await response.json();
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, status: response.status });
    return result;
  };
  const disk = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  const close = () => broker.close().catch(() => {});
  t.after(close);
  return { call, disk, close, get broker() { return broker; } };
}

// The read-through cursor has no per-message stamp, so a cursor read reports the moment the
// cursor was set. Everything else must answer the same before and after the migration.
const withoutAckTimes = value => JSON.parse(JSON.stringify(value, (key, value) =>
  key === 'ackTs' || key === 'at' || key === 'deliveredAt' ? undefined : value));

test('planMigration reports the counts and changes nothing', () => {
  const state = ledger('/work/p');
  const before = JSON.stringify(state);
  const plan = planMigration(state, { now: Date.parse('2026-10-26T09:00:00.000Z') });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.from, 1);
  assert.equal(plan.to, 2);
  assert.equal(plan.counts.rooms, 1);
  assert.equal(plan.counts.agents, 5);
  assert.equal(plan.counts.messages, 6);
  assert.equal(plan.counts.broadcasts, 2);
  assert.equal(plan.counts.directMessages, 4);
  assert.equal(plan.counts.deliveryRows, 10, 'every recipient of every message is one delivery row');
  assert.equal(plan.counts.ackedDeliveryRows, 5);
  assert.equal(plan.changes.messages, 6);
  assert.equal(plan.changes.broadcasts, 2);
  assert.equal(plan.changes.readAcksFolded, 2, 'the two reads b made of the broadcasts become one cursor');
  assert.equal(plan.changes.readRowsRemoved, 4, 'each folded read took an ack entry and a stamp with it');
  assert.equal(plan.changes.recipientRowsRemoved, 3, 'four read rows go, one cursor takes their place');
  assert.equal(plan.changes.cursors.length, 1);
  assert.deepEqual(plan.changes.cursors.map(row => row.agentId), ['b']);
  assert.equal(plan.changes.cursors[0].readThrough, 4);
  assert.ok(plan.changes.bytesBefore > 0 && plan.changes.bytesAfter > 0);
  assert.ok(plan.warnings.some(warning => /audience rule/.test(warning)), 'the rule a schema 1 broadcast never stored is reported');
  assert.equal(JSON.stringify(state), before, 'the plan changes nothing');
});

test('migrateState keeps every message and is idempotent', () => {
  const state = ledger('/work/p');
  const { state: migrated, report } = migrateState(state, { now: Date.parse('2026-10-26T09:00:00.000Z') });
  assert.equal(report.dryRun, false);
  assert.equal(report.from, 1);
  assert.equal(report.to, 2);
  assert.equal(migrated.version, 2);
  assert.equal(isSchema2(migrated), true);
  assert.equal(migrated.rooms[0].messages.length, state.rooms[0].messages.length, 'no message is deleted');
  assert.deepEqual(migrated.rooms[0].messages.map(m => m.messageId), state.rooms[0].messages.map(m => m.messageId));
  assert.deepEqual(migrated.rooms[0].messages.map(m => m.body), state.rooms[0].messages.map(m => m.body));
  assert.deepEqual(migrated.rooms[0].messages.map(m => m.recipients), state.rooms[0].messages.map(m => m.recipients),
    'the audience snapshot a broadcast was sent to is kept');
  for (const message of migrated.rooms[0].messages) {
    assert.ok(message.kind === 'direct' || message.kind === 'broadcast', 'every message is marked');
    if (message.kind === 'broadcast') assert.equal(message.audience.mode, 'live');
  }
  validateStore(migrated);
  // Migrating again changes nothing. The comparison is between two distinct
  // objects: comparing a value with itself cannot fail.
  const snapshot = structuredClone(migrated);
  const again = migrateState(migrated);
  assert.deepEqual(again.state, snapshot, 'the migration is idempotent');
  assert.deepEqual(migrated, snapshot, 'the migration did not touch the ledger');
  assert.equal(again.report.from, 2);
  assert.ok(again.report.warnings.some(warning => /already at schema 2/.test(warning)));
  assert.equal(again.report.changes.messages, 0);
});

test('the migration preserves who read what', () => {
  const state = ledger('/work/p');
  const { state: migrated } = migrateState(state);
  const before = state.rooms[0], after = migrated.rooms[0];
  const read = (room, agentId) => new Set(room.messages.filter(m => m.ackedBy.includes(agentId)).map(m => m.messageId));
  for (const agent of before.agents) {
    const original = read(before, agent.agentId), migrated = read(after, agent.agentId);
    const cursor = after.agents.find(a => a.agentId === agent.agentId)?.readThrough ?? 0;
    for (const message of after.messages) {
      const wasRead = original.has(message.messageId);
      const isRead = hasReadMessage(agent.agentId, message, after.agents.find(a => a.agentId === agent.agentId));
      assert.equal(isRead, wasRead, `${agent.agentId} read ${message.messageId}: ${wasRead} -> ${isRead} (cursor ${cursor})`);
    }
  }
  // b read both broadcasts in order, so one cursor covers them.
  const b = after.agents.find(a => a.agentId === 'b');
  assert.equal(b.readThrough, 4);
  assert.deepEqual(after.messages.find(m => m.messageId === 'm-3').ackedBy, []);
  // c read the second broadcast only: the first one is still unread, so c keeps an explicit ack.
  const c = after.agents.find(a => a.agentId === 'c');
  assert.equal(c.readThrough, undefined);
  assert.deepEqual(after.messages.find(m => m.messageId === 'm-4').ackedBy, ['c']);
  assert.deepEqual(after.messages.find(m => m.messageId === 'm-4').acks.map(row => row.agentId), ['c']);
});

test('the broker refuses a mixed state and names the fix', async t => {
  const { dir, project } = await root(t);
  const state = ledger(project);
  const mixed = { ...state, version: 2 };
  await fs.mkdir(path.join(dir, 'data'), { recursive: true });
  await fs.writeFile(path.join(dir, 'data', 'state.json'), JSON.stringify(mixed));
  await assert.rejects(() => createBroker({ dataDir: path.join(dir, 'data'), pruneAfterMinutes: 0, compactAfterDays: 0 }),
    /migrate --to 2/, 'the broker says how to fix it');
  // The ledger on disk was left alone.
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'data', 'state.json'), 'utf8')), mixed);
});

test('a schema 1 state still validates and still works', async t => {
  const { dir, project } = await root(t);
  const state = ledger(project);
  assert.doesNotThrow(() => validateStore(state));
  const relay = await broker(t, path.join(dir, 'data1'), project, state);
  const capabilities = await relay.call({ op: 'capabilities' });
  assert.equal(capabilities.runtime.schema, 1, 'an untouched ledger still reports schema 1');
  const inbox = await relay.call({ op: 'inbox', agentId: 'c' });
  assert.deepEqual(inbox.messages.map(m => m.messageId), ['m-2', 'm-3']);
  await relay.close();
});

test('inbox, ack, receipt, history and outbox answer the same before and after the migration', async t => {
  const { dir, project } = await root(t);
  const base = ledger(project);
  const before = await broker(t, path.join(dir, 'data1'), project, base);
  const { state: migrated } = migrateState(base);
  const after = await broker(t, path.join(dir, 'data2'), project, migrated);

  const ask = async relay => ({
    inboxC: await relay.call({ op: 'inbox', agentId: 'c' }),
    inboxB: await relay.call({ op: 'inbox', agentId: 'b' }),
    inboxAllD: await relay.call({ op: 'inbox', agentId: 'd', unacked: false }),
    receipt3: await relay.call({ op: 'receipt', messageId: 'm-3' }),
    receipt4: await relay.call({ op: 'receipt', messageId: 'm-4' }),
    history: await relay.call({ op: 'history' }),
    historyAcked: await relay.call({ op: 'history', acked: true }),
    outbox: await relay.call({ op: 'outbox', from: 'a' }),
  });
  const one = await ask(before);
  const two = await ask(after);
  assert.deepEqual(withoutAckTimes(two), withoutAckTimes(one), 'the same questions get the same answers');

  // The same acknowledgement changes the same things.
  const ackBefore = await before.call({ op: 'ack', agentId: 'c', messageId: 'm-3' });
  const ackAfter = await after.call({ op: 'ack', agentId: 'c', messageId: 'm-3' });
  assert.deepEqual(ackAfter, ackBefore);
  const afterAckBefore = await ask(before);
  const afterAckAfter = await ask(after);
  assert.deepEqual(withoutAckTimes(afterAckAfter), withoutAckTimes(afterAckBefore));
  assert.deepEqual((await before.call({ op: 'inbox', agentId: 'c' })).messages.map(m => m.messageId), ['m-2']);
  assert.deepEqual((await after.call({ op: 'inbox', agentId: 'c' })).messages.map(m => m.messageId), ['m-2']);

  await before.close();
  await after.close();
});

test('a migrated ledger reports schema 2 and keeps the old inbox and ack shapes', async t => {
  const { dir, project } = await root(t);
  const { state: migrated } = migrateState(ledger(project));
  const relay = await broker(t, path.join(dir, 'data2'), project, migrated);
  const capabilities = await relay.call({ op: 'capabilities' });
  assert.equal(capabilities.runtime.schema, 2);
  assert.ok(capabilities.features.includes('bulk-ack'), 'the feature list is unchanged');
  const inbox = await relay.call({ op: 'inbox', agentId: 'c' });
  assert.deepEqual(Object.keys(inbox.messages[0]).sort(),
    ['acked', 'body', 'createdAt', 'cursor', 'from', 'messageId', 'notified', 'recipients', 'to'].sort(),
    'the inbox row keeps the schema 1 shape');
  const ack = await relay.call({ op: 'ack', agentId: 'c', messageId: 'm-2' });
  assert.deepEqual(Object.keys(ack).sort(), ['acked', 'duplicate', 'messageId', 'ok']);
  await relay.close();
});

test('the cursor replaces the per-broadcast read rows', async t => {
  const { dir, project } = await root(t);
  const { state: migrated } = migrateState(ledger(project));
  const relay = await broker(t, path.join(dir, 'data2'), project, migrated);
  // b already read both broadcasts: the ledger holds one number for the agent, not two rows.
  const stored = await relay.disk();
  const b = stored.rooms[0].agents.find(a => a.agentId === 'b');
  assert.equal(b.readThrough, 4);
  assert.deepEqual(stored.rooms[0].messages.find(m => m.messageId === 'm-3').ackedBy, []);
  assert.equal(stored.rooms[0].messages.find(m => m.messageId === 'm-3').acks, undefined);
  // Reading the last broadcast moves the cursor; the ledger does not grow a row per broadcast.
  await relay.call({ op: 'ack', agentId: 'c', messageId: 'm-4' });
  const after = await relay.disk();
  assert.equal(after.rooms[0].agents.find(a => a.agentId === 'c').readThrough, undefined,
    'c has not read the earlier broadcast, so it keeps an explicit ack');
  assert.deepEqual(after.rooms[0].messages.find(m => m.messageId === 'm-4').ackedBy, ['c']);
  await relay.call({ op: 'ack', agentId: 'c', messageId: 'm-3' });
  const folded = await relay.disk();
  const c = folded.rooms[0].agents.find(a => a.agentId === 'c');
  assert.equal(c.readThrough, 4, 'reading the earlier broadcast lets one cursor cover both');
  assert.deepEqual(folded.rooms[0].messages.find(m => m.messageId === 'm-3').ackedBy, []);
  assert.deepEqual(folded.rooms[0].messages.find(m => m.messageId === 'm-4').ackedBy, []);
  await relay.close();
});

test('a migrated ledger keeps writing schema 2', async t => {
  const { dir, project } = await root(t);
  const { state: migrated } = migrateState(ledger(project));
  const relay = await broker(t, path.join(dir, 'data2'), project, migrated);
  const sent = await relay.call({ op: 'send', from: 'a', to: 'c', body: 'after the migration', messageId: 'm-7' });
  assert.equal(sent.duplicate, false);
  const broadcast = await relay.call({ op: 'send', from: 'a', to: '*', body: 'bulletin', messageId: 'm-8' });
  assert.equal(broadcast.duplicate, false);
  const stored = await relay.disk();
  const direct = stored.rooms[0].messages.find(m => m.messageId === 'm-7');
  const bull = stored.rooms[0].messages.find(m => m.messageId === 'm-8');
  assert.equal(direct.kind, 'direct');
  assert.equal(bull.kind, 'broadcast');
  assert.deepEqual(bull.audience, { mode: 'live', within: 120, excluded: 0 }, 'the broadcast keeps the rule it was sent with');
  assert.doesNotThrow(() => validateStore(stored), 'the broker wrote a valid schema 2 ledger');
  assert.deepEqual(bull.recipients, ['b', 'c', 'd'], 'the audience snapshot is the audience it was sent to');
});

test('a bulk acknowledgement moves the cursor instead of writing a row per broadcast', async t => {
  const { dir, project } = await root(t);
  const { state: migrated } = migrateState(ledger(project));
  const relay = await broker(t, path.join(dir, 'data2'), project, migrated);
  const acked = await relay.call({ op: 'ack', agentId: 'd', all: true });
  assert.equal(acked.acked, 3, 'the two unread broadcasts and the unread direct message');
  const stored = await relay.disk();
  const d = stored.rooms[0].agents.find(a => a.agentId === 'd');
  assert.equal(d.readThrough, 4, 'one cursor covers both broadcasts');
  assert.deepEqual(stored.rooms[0].messages.find(m => m.messageId === 'm-3').ackedBy, []);
  assert.deepEqual(stored.rooms[0].messages.find(m => m.messageId === 'm-4').ackedBy, ['c'],
    'c read the second broadcast before the first one, so it keeps an explicit ack');
  // The direct messages keep their explicit acks: they have one recipient each.
  assert.deepEqual(stored.rooms[0].messages.find(m => m.messageId === 'm-6').ackedBy, ['d']);
  assert.deepEqual((await relay.call({ op: 'inbox', agentId: 'd' })).messages, []);
});

test('the export of a migrated ledger carries schema 2 and restores', async t => {
  const { dir, project } = await root(t);
  const { state: migrated } = migrateState(ledger(project));
  const relay = await broker(t, path.join(dir, 'data2'), project, migrated);
  const exported = await relay.call({ op: 'export' });
  assert.equal(exported.schemaVersion, 2);
  assert.equal(exported.state.version, 2);
  const dry = await relay.call({ op: 'restore', state: exported.state, schemaVersion: 2, dryRun: true });
  assert.equal(dry.dryRun, true);
  const restored = await relay.call({ op: 'restore', state: exported.state, schemaVersion: 2 });
  assert.equal(restored.restored, true);
  assert.equal((await relay.call({ op: 'capabilities' })).runtime.schema, 2);
  const restoredState = await relay.disk();
  assert.doesNotThrow(() => validateStore(restoredState));
  await assert.rejects(() => relay.call({ op: 'restore', state: exported.state, schemaVersion: 3 }), /not supported/);});

test('a cursor does not invent a read for an agent the broadcast was not addressed to',()=>{
 const room={project:'/w',agents:[{agentId:'x',readThrough:5},{agentId:'y',readThrough:5}],messages:[
  {messageId:'m3',to:'*',kind:'broadcast',cursor:3,recipients:['y'],ackedBy:['y'],acks:[]}]};
 assert.equal(hasReadMessage('x',room.messages[0],room.agents[0]),false,'x was never addressed to m3');
 assert.equal(hasReadMessage('y',room.messages[0],room.agents[1]),true,'y was addressed and read it');
 assert.deepEqual([...readersOf(room.messages[0],room)],['y'],'only the reader is reported');
});

test('the backup keeps the old rows recoverable', async t => {
  const { dir } = await root(t);
  const file = path.join(dir, 'state.json');
  const state = ledger('/work/p');
  await fs.writeFile(file, JSON.stringify(state));
  const backup = await backupStateFile(file, { now: new Date(Date.parse('2026-10-26T09:00:00.000Z')) });
  assert.equal(backup.bytes, (await fs.stat(file)).size);
  assert.equal(path.dirname(backup.path), dir, 'the backup sits next to the ledger');
  assert.equal((await fs.stat(backup.path)).mode & 0o777, 0o600, 'the backup is private');
  assert.deepEqual(JSON.parse(await fs.readFile(backup.path, 'utf8')), state);
  // The write-back is atomic and leaves no temp file behind.
  const { state: migrated } = migrateState(state);
  const written = await writeStateFile(file, migrated);
  assert.equal(written.bytes, Buffer.byteLength(JSON.stringify(migrated)));
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), migrated);
  assert.equal((await fs.readdir(dir)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('the schema 2 win is real at the size the redesign was built for', () => {
  // The whole point of the redesign: a broadcast is stored once, and the read
  // state is one cursor per agent instead of one row per reader.
  const state = backlogState('/work/p', {agents: 300, live: 300, messages: 1, broadcasts: 1, acked: 1});
  const before = JSON.stringify(state).length;
  const {state: migrated} = migrateState(state);
  const broadcast = migrated.rooms[0].messages[0];
  assert.deepEqual(broadcast.ackedBy, [], 'no per-reader rows survive');
  assert.equal(broadcast.acks, undefined);
  assert.ok(migrated.rooms[0].agents.some(agent => agent.readThrough === 1), 'the reader has a cursor');
  assert.ok(migrated.rooms[0].agents.every(agent => agent.ackedBy === undefined), 'no per-agent read rows survive');
  assert.ok(JSON.stringify(migrated).length < before, 'the ledger shrank');
  validateStore(migrated);
});

test('a migration of a ledger the broker itself wrote keeps the truth', async () => {
  // The hand-written fixtures are shaped to satisfy the validator. This runs
  // the broker, takes the ledger it wrote, and migrates that.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-ack-real-'));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir);
  const broker = await createBroker({dataDir, pruneAfterMinutes: 0, compactAfterDays: 0});
  const call = async fields => {
    const response = await fetch(`${broker.url}/rpc`, {method: 'POST',
      headers: {authorization: `Bearer ${broker.token}`, 'content-type': 'application/json'},
      body: JSON.stringify({project, ...fields})});
    const result = await response.json();
    if (!result.ok) throw Object.assign(new Error(result.error.message), {code: result.error.code});
    return result;
  };
  try {
    await call({op: 'register', agentId: 'a', runner: 'codex'});
    await call({op: 'register', agentId: 'b', runner: 'claude'});
    await call({op: 'register', agentId: 'c', runner: 'codex'});
    const broadcast = await call({op: 'send', from: 'a', to: '*', body: 'to everybody'});
    const direct = await call({op: 'send', from: 'a', to: 'b', body: 'just for you'});
    const reply = await call({op: 'send', from: 'b', to: 'a', body: 'and back', replyTo: direct.messageId, summary: 'a summary'});
    await call({op: 'ack', agentId: 'b', messageId: broadcast.messageId});
    await call({op: 'notified', agentId: 'b', messageId: direct.messageId, adapter: 'codex'});
    const raw = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
    assert.equal(raw.version, 1, 'the broker writes schema 1');
    const {state: migrated} = migrateState(raw);
    const messages = migrated.rooms[0].messages;
    const all = messages.find(m => m.messageId === broadcast.messageId);
    const d = messages.find(m => m.messageId === direct.messageId);
    const r = messages.find(m => m.messageId === reply.messageId);
    assert.ok(all && d && r, 'every message survived');
    assert.equal(all.kind, 'broadcast');
    assert.equal(r.replyTo, direct.messageId, 'the reply target survives');
    assert.equal(r.summary, 'a summary', 'the summary survives');
    assert.ok((d.notified ?? []).length >= 1, 'the transport marker survives');
    assert.ok(migrated.rooms[0].agents.some(a => a.agentId === 'b' && a.readThrough > 0),
      'the reader has a cursor');
    validateStore(migrated);
  } finally {
    await broker.close();
    await fs.rm(root, {recursive: true, force: true});
  }
});
