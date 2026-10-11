import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createBroker, validateStore, MAX_AGENTS_PER_PROJECT, MAX_RETAINED_AGENTS, MAX_PROCESSES, MAX_ROOMS, noticeAllowance } from '../lib/broker.mjs';
const runNode = promisify(execFile);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-http-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  const other = path.join(root, 'other');
  await Promise.all([dataDir, project, other].map(dir => fs.mkdir(dir)));
  let broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function request(fields, room = project, options = {}) {
    const response = await fetch(broker.url + '/rpc', {
      method: 'POST', headers: { authorization: 'Bearer ' + broker.token, 'content-type': 'application/json' },
      body: JSON.stringify({ project: room, ...fields }), ...options
    });
    const result = await response.json();
    return { status: response.status, ...result };
  }
  async function rpc(fields, room = project, options) {
    const result = await request(fields, room, options);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  }
  const register = (id, room = project) => rpc({ op: 'register', agentId: id, runner: 'test', sessionId: 'session-' + id }, room);
  return { root, project, other, dataDir, request, rpc, register,
    get broker() { return broker; },
    async restart() { await broker.close(); broker = await createBroker({ dataDir }); return broker; } };
}

test('loopback health reveals no metadata; authentication and bounds reject invalid input', async t => {
  const f = await fixture(t);
  assert.match(f.broker.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.deepEqual(await (await fetch(f.broker.url + '/health')).json(), { ok: true, version: 1 });
  const unauth = await fetch(f.broker.url + '/rpc', { method: 'POST', body: '{}' });
  assert.equal(unauth.status, 401);
  assert.equal((await unauth.json()).error.code, 'UNAUTHORIZED');
  assert.equal((await f.request({ op: 'agents' }, 'relative')).error.code, 'INVALID_PROJECT');
  await f.register('a');
  assert.equal((await f.request({ op: 'status', agentId: 'a', frozen: 'yes' })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'status', agentId: 'a', task: 'x'.repeat(8193) })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'wait', agentId: 'a', timeoutMs: 30001 })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'claim', agentId: 'a', resources: ['../other'] })).error.code, 'INVALID_RESOURCE');
  assert.equal((await f.request({ op: 'status', agentId: 'a', task: 'x'.repeat(140000) })).status, 413);
  assert.equal((await f.rpc({ op: 'status', agentId: 'a', status: 'awaiting-attachment' })).agent.status, 'awaiting-attachment');
});

test('parallel bidirectional HTTP delivery preserves all messages and explicit reply/ack identity', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  const sent = await Promise.all(Array.from({ length: 24 }, (_, i) => f.rpc({
    op: 'send', from: i % 2 ? 'a' : 'b', to: i % 2 ? 'b' : 'a', body: 'parallel-' + i, messageId: 'm-' + i
  })));
  assert.equal(new Set(sent.map(s => s.cursor)).size, 24);
  const [a, b] = await Promise.all(['a', 'b'].map(agentId => f.rpc({ op: 'inbox', agentId })));
  assert.equal(a.messages.length, 12); assert.equal(b.messages.length, 12);
  assert.deepEqual(a.messages.map(m => m.body).sort(), Array.from({ length: 12 }, (_, i) => 'parallel-' + (i * 2)).sort());
  const reply = await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'reply', replyTo: 'm-0', messageId: 'reply' });
  assert.equal(reply.duplicate, false);
  assert.equal((await f.rpc({ op: 'inbox', agentId: 'b' })).messages.find(m => m.messageId === 'reply').replyTo, 'm-0');
  assert.equal((await f.request({ op: 'ack', agentId: 'a', messageId: 'reply' })).status, 404);
  assert.equal((await f.rpc({ op: 'ack', agentId: 'b', messageId: 'reply' })).duplicate, false);
  assert.equal((await f.rpc({ op: 'ack', agentId: 'b', messageId: 'reply' })).duplicate, true);
  assert.equal((await f.rpc({ op: 'inbox', agentId: 'b' })).messages.some(m => m.messageId === 'reply'), false);
  assert.equal((await f.rpc({ op: 'inbox', agentId: 'b', unacked: false })).messages.find(m => m.messageId === 'reply').acked, true);
});

test('realpath rooms isolate history and named claims; broadcast recipients remain fixed', async t => {
  const f = await fixture(t);
  const alias = path.join(f.root, 'alias');
  await fs.symlink(f.project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await f.register('a'); await f.register('b');
  await f.register('a', f.other); await f.register('b', f.other);
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['build'] });
  await f.rpc({ op: 'claim', agentId: 'b', resources: ['build'] }, f.other);
  const broadcast = { op: 'send', from: 'a', to: '*', body: 'frozen recipients', messageId: 'broadcast' };
  assert.deepEqual((await f.rpc(broadcast)).recipients, ['b']);
  await f.register('c');
  const duplicate = await f.rpc(broadcast, alias);
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.recipients, ['b']);
  assert.equal((await f.rpc({ op: 'inbox', agentId: 'c' })).messages.length, 0);
  assert.equal((await f.rpc({ op: 'inbox', agentId: 'b' }, f.other)).messages.length, 0);
  assert.equal((await f.rpc({ op: 'inbox', agentId: 'b' }, alias)).messages.length, 1);
  const conflict = await f.request({ ...broadcast, body: 'changed' });
  assert.equal(conflict.status, 409); assert.equal(conflict.error.code, 'MESSAGE_ID_CONFLICT');
  assert.equal((await f.rpc({ op: 'agents' })).cursor, 1);
  assert.equal((await f.rpc({ op: 'agents' }, f.other)).cursor, 0);
});

test('restart retains messages, acknowledgements, transport notices, claims, token and frozen status', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  const token = f.broker.token;
  const pending = { op: 'send', from: 'a', to: 'b', body: 'pending after delivery', messageId: 'pending' };
  await f.rpc(pending);
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'acknowledged', messageId: 'acked' });
  await f.rpc({ op: 'ack', agentId: 'b', messageId: 'acked' });
  const notice = await f.rpc({ op: 'notified', agentId: 'b', messageId: 'pending', adapter: 'opencode' });
  assert.equal(notice.acked, false);
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['native', 'new/future.swift'] });
  const metadata = { op: 'status', agentId: 'a', status: 'offline', frozen: true,
    resources: ['reported-only'], task: { title: 'frozen review', phase: 2 } };
  await f.rpc(metadata);
  await f.restart();
  assert.equal(f.broker.token, token);
  const inbox = await f.rpc({ op: 'inbox', agentId: 'b' });
  assert.deepEqual(inbox.messages.map(m => m.messageId), ['pending']);
  assert.equal(inbox.messages[0].notified[0].adapter, 'opencode');
  assert.equal(inbox.messages[0].acked, false);
  assert.equal((await f.rpc(pending)).duplicate, true);
  const state = await f.rpc({ op: 'agents' });
  assert.equal(state.cursor, 2); assert.equal(state.claims.length, 2);
  const a = state.agents.find(agent => agent.agentId === 'a');
  assert.equal(a.frozen, true); assert.equal(a.status, 'offline');
  assert.deepEqual(a.resources, ['reported-only']); assert.deepEqual(a.task, metadata.task);
  await f.register('a');
  assert.equal((await f.rpc({ op: 'status', agentId: 'a' })).agent.frozen, true);
  assert.equal((await f.request({ op: 'claim', agentId: 'b', resources: ['native'] })).error.code, 'CLAIM_CONFLICT');
});

test('concurrent claims are all-or-nothing; exact release cannot free another owner', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  const [a, b] = await Promise.all([
    f.request({ op: 'claim', agentId: 'a', resources: ['Sources', 'build', 'a-only'] }),
    f.request({ op: 'claim', agentId: 'b', resources: ['Sources/file.swift', 'build', 'b-only'] })
  ]);
  assert.equal([a, b].filter(result => result.ok).length, 1);
  assert.equal([a, b].find(result => !result.ok).error.code, 'CLAIM_CONFLICT');
  const winner = a.ok ? 'a' : 'b', loser = a.ok ? 'b' : 'a';
  const claims = (await f.rpc({ op: 'agents' })).claims;
  assert.equal(claims.length, 3); assert.equal(claims.every(c => c.agentId === winner), true);
  assert.deepEqual((await f.rpc({ op: 'release', agentId: loser, resources: ['build'] })).released, []);
  await f.rpc({ op: 'status', agentId: winner, status: 'offline' });
  assert.equal((await f.request({ op: 'claim', agentId: loser, resources: ['build'] })).error.code, 'CLAIM_CONFLICT');
  assert.deepEqual((await f.rpc({ op: 'release', agentId: winner, resources: ['build'] })).released, ['build']);
  await f.rpc({ op: 'claim', agentId: loser, resources: ['build', 'native', 'install'] });
  await f.rpc({ op: 'release', agentId: winner });
  assert.equal((await f.rpc({ op: 'agents' })).claims.every(c => c.agentId === loser), true);
  await f.rpc({ op: 'release', agentId: loser });
  assert.deepEqual((await f.rpc({ op: 'agents' })).claims, []);
});

test('long polling does not block writer; only message events advance cursor; timeout and close are bounded', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  let settled = false;
  const waiting = f.rpc({ op: 'wait', agentId: 'b', after: 0, timeoutMs: 2000 }).then(result => { settled = true; return result; });
  await f.rpc({ op: 'status', agentId: 'a', status: 'busy' });
  await f.register('c');
  assert.equal((await f.rpc({ op: 'agents' })).cursor, 0);
  assert.equal(settled, false);
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'wake now', messageId: 'wake' });
  const result = await waiting;
  assert.deepEqual(result.messages.map(m => m.messageId), ['wake']);
  assert.equal(result.cursor, 1);
  assert.deepEqual((await f.rpc({ op: 'wait', agentId: 'b', after: 1, timeoutMs: 15 })).messages, []);
  assert.equal((await f.rpc({ op: 'inbox', agentId: 'b' })).messages.length, 1, 'cursor never acknowledges old message');
  await f.rpc({ op: 'ack', agentId: 'b', messageId: 'wake' });
  assert.equal((await f.rpc({ op: 'agents' })).cursor, 1);
  const closing = f.rpc({ op: 'wait', agentId: 'b', after: 1, timeoutMs: 30000 });
  // A subsequent writer turn ensures the wait was admitted before closing.
  await f.rpc({ op: 'status', agentId: 'a', status: 'idle' });
  await f.broker.close();
  assert.deepEqual((await closing).messages, []);
});

test('corrupt stores are rejected without replacement and the in-process writer is exclusive', async t => {
  const f = await fixture(t);
  await assert.rejects(createBroker({ dataDir: f.dataDir }), /already owns/u);
  await f.broker.close();
  const file = path.join(f.dataDir, 'state.json');
  const corrupt = '{"version":999,"rooms":[]}';
  await fs.writeFile(file, corrupt);
  await assert.rejects(createBroker({ dataDir: f.dataDir }), /corrupt or unsupported/u);
  assert.equal(await fs.readFile(file, 'utf8'), corrupt);
});

test('another process cannot become a second writer; proven-dead leases recover without losing history', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'durable before crash', messageId: 'crash' });
  const moduleURL = new URL('../lib/broker.mjs', import.meta.url).href;
  const program = `import {createBroker} from ${JSON.stringify(moduleURL)};
    try { const broker = await createBroker({dataDir:process.argv[1]});
      console.log('ACQUIRED'); ${'process.exit(0);'}
    } catch (error) { console.error(error.message); process.exitCode=7; }`;
  await assert.rejects(runNode(process.execPath, ['--input-type=module', '-e', program, f.dataDir]),
    error => error.code === 7 && /live broker/u.test(error.stderr));
  assert.equal((await f.rpc({ op: 'inbox', agentId: 'b' })).messages.length, 1);
  await f.broker.close();
  assert.match((await runNode(process.execPath, ['--input-type=module', '-e', program, f.dataDir])).stdout, /ACQUIRED/u);
  // The child intentionally exited without close(), leaving a dead-PID lease.
  await f.restart();
  assert.deepEqual((await f.rpc({ op: 'inbox', agentId: 'b' })).messages.map(m => m.messageId), ['crash']);
  const lock = JSON.parse(await fs.readFile(path.join(f.dataDir, 'writer.lock'), 'utf8'));
  assert.equal(lock.pid, process.pid);
});

test('unknown writer ownership and abandoned recovery sentinels fail closed without removing the lock', async t => {
  const f = await fixture(t);
  await f.broker.close();
  const lock = path.join(f.dataDir, 'writer.lock');
  const unknown = '{"version":1,"pid":"unknown"}';
  await fs.writeFile(lock, unknown);
  await assert.rejects(createBroker({ dataDir: f.dataDir }), /ownership is unknown/u);
  assert.equal(await fs.readFile(lock, 'utf8'), unknown);
  await fs.unlink(lock);
  const sentinel = path.join(f.dataDir, 'writer-recovery.lock');
  await fs.writeFile(sentinel, 'ambiguous recovery owner');
  await assert.rejects(createBroker({ dataDir: f.dataDir }), /recovery ownership is unknown/u);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'ambiguous recovery owner');
});

test('authenticated observation discovers rooms, isolates recent history and never registers or acknowledges an observer',async t=>{
 const f=await fixture(t);await f.register('a');await f.register('b');await f.register('other',f.other);
 await f.rpc({op:'send',from:'a',to:'b',body:'Ready for review?',messageId:'question'});
 const before=await fs.readFile(path.join(f.dataDir,'state.json'),'utf8');
 const rooms=await f.rpc({op:'rooms'});assert.equal(rooms.rooms.length,2);
 const current=await f.rpc({op:'snapshot',limit:1});assert.equal(current.messages[0].body,'Ready for review?');assert.equal(current.pendingDeliveries,1);
 const other=await f.rpc({op:'snapshot'},f.other);assert.equal(other.messages.length,0);
 assert.equal((await f.request({op:'snapshot',limit:201})).error.code,'INVALID_INPUT');
 assert.equal(await fs.readFile(path.join(f.dataDir,'state.json'),'utf8'),before);
 const retained=await fs.realpath(f.other);await fs.rm(f.other,{recursive:true});assert.equal((await f.rpc({op:'snapshot'},retained)).agents[0].agentId,'other');
});

test('registration admits new identities past 256 while left and retired history stays resolvable', async t => {
  const f = await fixture(t);
  const first = await f.register('hub');
  assert.deepEqual(Object.keys(first.capacity).sort(), ['limit', 'used']);
  assert.equal(first.capacity.limit, MAX_AGENTS_PER_PROJECT);
  assert.equal(first.capacity.used, 1);
  for (let i = 0; i < 258; i++) {
    const registered = await f.register('churn-' + i);
    assert.equal(registered.capacity.used, 2);
    if (i < 3) await f.rpc({ op: 'send', from: 'churn-' + i, to: 'hub', body: 'history-' + i, messageId: 'm-' + i });
    await f.rpc({ op: i % 2 ? 'leave' : 'retire', agentId: 'churn-' + i });
  }
  await f.rpc({ op: 'ack', agentId: 'hub', all: true });
  await f.restart();
  const state = await f.rpc({ op: 'agents' });
  assert.equal(state.counts.stored, 259);
  assert.equal(state.counts.left, 258);
  assert.equal(state.counts.active, 1);
  assert.equal(state.counts.recentlySeen, 1);
  assert.equal(state.counts.capacityLimit, MAX_AGENTS_PER_PROJECT);
  const snapshot = await f.rpc({ op: 'snapshot' });
  assert.equal(snapshot.totalMessages, 3);
  assert.equal(snapshot.pendingDeliveries, 0);
  assert.deepEqual(snapshot.messages.map(m => m.from).sort(), ['churn-0', 'churn-1', 'churn-2']);
  const returning = await f.register('churn-1');
  assert.equal(returning.agent.agentId, 'churn-1');
  assert.equal((await f.request({ op: 'register', agentId: 'churn-0', runner: 'test' })).error.code, 'RETIRED');
  const newcomer = await f.register('newcomer');
  assert.equal(newcomer.capacity.used, 3);
});

test('hard bounds refuse registration with recovery guidance and leave the ledger intact', async t => {
  const f = await fixture(t);
  const real = await fs.realpath(f.project);
  const file = path.join(f.dataDir, 'state.json');
  const ts = new Date().toISOString();
  const row = (id, left) => ({ agentId: id, runner: 'test', registeredAt: ts, updatedAt: ts, status: 'idle',
    frozen: false, resources: [], task: null, ...(left ? { left: true } : {}) });
  const seed = (active, left) => ({ version: 1, nextCursor: 1, rooms: [{ project: real,
    agents: [...Array.from({ length: active }, (_, i) => row('act-' + i)),
      ...Array.from({ length: left }, (_, i) => row('gone-' + i, true))],
    messages: [], claims: [], cursor: 0 }] });
  await f.broker.close();
  await fs.writeFile(file, JSON.stringify(seed(MAX_AGENTS_PER_PROJECT, MAX_RETAINED_AGENTS - MAX_AGENTS_PER_PROJECT)));
  await f.restart();
  const before = await fs.readFile(file, 'utf8');
  const refused = await f.request({ op: 'register', agentId: 'newcomer', runner: 'test' });
  assert.equal(refused.error.code, 'CAPACITY');
  assert.equal(refused.error.bound, 'retained');
  assert.equal(refused.error.limit, MAX_RETAINED_AGENTS);
  assert.equal(refused.error.used, MAX_RETAINED_AGENTS);
  assert.equal(refused.error.left, MAX_RETAINED_AGENTS - MAX_AGENTS_PER_PROJECT);
  assert.equal(refused.error.recovery, 'archive or retire identities');
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const rerun = await f.rpc({ op: 'register', agentId: 'act-0', runner: 'test' });
  assert.equal(rerun.capacity.used, MAX_AGENTS_PER_PROJECT);
  await f.broker.close();
  await fs.writeFile(file, JSON.stringify(seed(MAX_AGENTS_PER_PROJECT, 100)));
  await f.restart();
  const activeRefused = await f.request({ op: 'register', agentId: 'newcomer', runner: 'test' });
  assert.equal(activeRefused.error.code, 'CAPACITY');
  assert.equal(activeRefused.error.bound, 'active');
  assert.equal(activeRefused.error.limit, MAX_AGENTS_PER_PROJECT);
  assert.equal(activeRefused.error.used, MAX_AGENTS_PER_PROJECT);
  assert.equal(activeRefused.error.recovery, 'have agents leave or retire identities');
  assert.equal((await f.request({ op: 'register', agentId: 'gone-0', runner: 'test' })).error.bound, 'active');
  assert.equal((await f.register('act-1')).agent.agentId, 'act-1');
});

test('validateStore accepts old and new ledgers under one capacity contract and rejects corrupt shapes', () => {
  const ts = new Date().toISOString();
  const agent = (id, extra) => ({ agentId: id, runner: 'test', registeredAt: ts, updatedAt: ts, status: 'idle',
    frozen: false, resources: [], task: null, ...(extra ?? {}) });
  const state = agents => ({ version: 1, nextCursor: 1,
    rooms: [{ project: '/abs/project', agents, messages: [], claims: [], cursor: 0 }] });
  assert.doesNotThrow(() => validateStore(state([agent('a')])));
  assert.doesNotThrow(() => validateStore({ version: 1, nextCursor: 1, rooms: [{ project: '/abs/project',
    group: { id: 'grp', commonDir: '/abs/.git' },
    handoffs: [{ id: 'h1', from: 'a', to: 'b', resources: ['/abs/project/x'], reason: 'done', state: 'pending', requestedAt: ts }],
    agents: [agent('a'), agent('b', { left: true, retired: true }), agent('c', { sessionId: 's' })],
    messages: [], claims: [{ agentId: 'a', resource: '/abs/project/x', claimedAt: ts,
      meta: { baseCommit: 'abc', patchHash: 'p', resultingCommit: 'def', verification: 'green' },
      transferredFrom: 'b', transferredAt: ts }], cursor: 0 }] }));
  assert.throws(() => validateStore(state(Array.from({ length: MAX_AGENTS_PER_PROJECT + 1 }, (_, i) => agent('a' + i)))), /corrupt or unsupported/);
  assert.doesNotThrow(() => validateStore(state(Array.from({ length: MAX_RETAINED_AGENTS }, (_, i) =>
    agent('a' + i, i >= MAX_AGENTS_PER_PROJECT ? { left: true } : {})))));
  assert.throws(() => validateStore(state(Array.from({ length: MAX_RETAINED_AGENTS + 1 }, (_, i) =>
    agent('a' + i, i >= MAX_AGENTS_PER_PROJECT ? { left: true } : {})))), /corrupt or unsupported/);
  assert.throws(() => validateStore({ version: 1, nextCursor: 1, rooms: [{ project: '/abs/project',
    handoffs: [{ id: 'h', from: 'a', to: null, resources: ['r'], reason: 'x', state: 'stale', requestedAt: ts }],
    agents: [agent('a')], messages: [], claims: [], cursor: 0 }] }), /corrupt or unsupported/);
  assert.throws(() => validateStore({ version: 1, nextCursor: 1, rooms: [{ project: '/abs/project',
    agents: [agent('a')], messages: [], claims: [{ agentId: 'a', resource: 'build', claimedAt: ts, meta: { sha: 'x' } }],
    cursor: 0 }] }), /corrupt or unsupported/);
  const message = extra => ({ messageId: 'm1', cursor: 1, from: 'a', to: 'b', body: 'body', createdAt: ts,
    recipients: ['b'], ackedBy: [], notified: [], ...extra });
  const withMessages = rows => ({ version: 1, nextCursor: 2,
    rooms: [{ project: '/abs/project', agents: [agent('a'), agent('b'), agent('c')],
      messages: rows, claims: [], cursor: 1 }] });
  assert.doesNotThrow(() => validateStore(withMessages([message({})])));
  assert.doesNotThrow(() => validateStore(withMessages([message({ ackedBy: ['b'],
    notified: [{ agentId: 'b', adapter: 'codex-accepted', at: ts }] })])));
  assert.doesNotThrow(() => validateStore(withMessages([message({ ackedBy: ['b'], acks: [{ agentId: 'b', at: ts }],
    followups: [{ id: 'f1', agentId: 'a', note: 'escalate', at: ts }, { id: 'f2', agentId: 'b', at: ts }] })])));
  assert.throws(() => validateStore(withMessages([message({ acks: [{ agentId: 'b', at: ts }] })])), /corrupt or unsupported/);
  assert.throws(() => validateStore(withMessages([message({ ackedBy: ['b'], acks: [{ agentId: 'a', at: ts }] })])), /corrupt or unsupported/);
  assert.throws(() => validateStore(withMessages([message({ followups: [{ id: 'f1', agentId: 'c', at: ts }] })])), /corrupt or unsupported/);
  assert.throws(() => validateStore(withMessages([message({ followups: [{ id: 'f1', agentId: 'a', at: ts }, { id: 'f1', agentId: 'b', at: ts }] })])), /corrupt or unsupported/);
  assert.throws(() => validateStore(withMessages([message({ followups: Array.from({ length: 33 }, (_, i) => ({ id: 'f' + i, agentId: 'a', at: ts })) })])), /corrupt or unsupported/);
  const digest = (title, body, source) => createHash('sha256').update(JSON.stringify({ title, body, source })).digest('hex');
  const bulletin = (version, title, acks) => ({ version, title, body: 'body-' + version, source: 'AGENT.md',
    hash: digest(title, 'body-' + version, 'AGENT.md'), ts, acks });
  const ledger = extra => ({ version: 1, nextCursor: 1,
    rooms: [{ project: '/abs/project', agents: [agent('a')], messages: [], claims: [], cursor: 0, ...extra }] });
  assert.doesNotThrow(() => validateStore(ledger({ bulletin: { versions: [bulletin(2, 'second', []),
    bulletin(1, 'first', [{ agentId: 'a', at: ts }])] } })));
  assert.doesNotThrow(() => validateStore(ledger({ processes: [{ id: 'pr-1', agentId: 'a', pid: 5150,
    command: 'node watch.mjs', cwd: '/abs/project', port: 5173, deployment: 'staging',
    note: 'publishes on save', startedAt: ts, lastVerifiedAt: ts }] })));
  assert.throws(() => validateStore(ledger({ bulletin: { versions: [bulletin(3, 'gap', []), bulletin(1, 'first', [])] } })),
    /corrupt or unsupported/);
  assert.throws(() => validateStore(ledger({ bulletin: { versions: [{ ...bulletin(1, 'first', []), hash: 'f'.repeat(64) }] } })),
    /corrupt or unsupported/);
  assert.throws(() => validateStore(ledger({ bulletin: { versions: [bulletin(1, 'first', [{ agentId: 'zzz', at: ts }])] } })),
    /corrupt or unsupported/);
  assert.throws(() => validateStore(ledger({ processes: [{ id: 'pr-1', agentId: 'a', pid: 0, startedAt: ts, lastVerifiedAt: ts }] })),
    /corrupt or unsupported/);
  assert.throws(() => validateStore(ledger({ processes: [{ id: 'pr-1', agentId: 'zzz', pid: 5150, startedAt: ts, lastVerifiedAt: ts }] })),
    /corrupt or unsupported/);
  assert.throws(() => validateStore(ledger({ processes: Array.from({ length: MAX_PROCESSES + 1 }, (_, i) =>
    ({ id: 'pr-' + i, agentId: 'a', pid: 5150 + i, startedAt: ts, lastVerifiedAt: ts })) })), /corrupt or unsupported/);
});

test('coordination groups associate explicit rooms and expose discovery with project paths', async t => {
  const f = await fixture(t);
  const third = path.join(f.root, 'third');
  await fs.mkdir(third);
  const [realProject, realOther, realThird] = await Promise.all([f.project, f.other, third].map(dir => fs.realpath(dir)));
  const group = 'group-one';
  const first = await f.rpc({ op: 'register', agentId: 'a', runner: 'test', groupId: group });
  assert.deepEqual(first.group, { id: group, commonDir: null, verified: false, members: [realProject] });
  await f.rpc({ op: 'register', agentId: 'b', runner: 'test', groupId: group }, f.other);
  await f.register('solo', third);
  const rooms = await f.rpc({ op: 'rooms' });
  const byProject = Object.fromEntries(rooms.rooms.map(room => [room.project, room.groupId]));
  assert.equal(byProject[realProject], group);
  assert.equal(byProject[realOther], group);
  assert.equal(byProject[realThird], null);
  const own = await f.rpc({ op: 'groupAgents', agentId: 'a' });
  assert.equal(own.groupId, group);
  assert.deepEqual(own.rooms.map(room => room.project).sort(), [realProject, realOther].sort());
  assert.deepEqual(own.agents.map(agent => [agent.agentId, agent.project]).sort(),
    [['a', realProject], ['b', realOther]].sort());
  const explicit = await f.rpc({ op: 'groupAgents', groupId: group }, third);
  assert.equal(explicit.agents.length, 2);
  assert.equal((await f.request({ op: 'groupAgents' }, third)).error.code, 'UNKNOWN_GROUP');
  assert.equal((await f.rpc({ op: 'agents' })).groupId, group);
  assert.equal((await f.rpc({ op: 'agents' }, third)).groupId, null);
  await f.restart();
  assert.equal((await f.rpc({ op: 'agents' })).groupId, group);
});

test('detectGroup verifies linked worktrees through the git common directory and never merges independent clones', async t => {
  try { await runNode('git', ['--version']); } catch { t.skip('git is unavailable'); return; }
  const f = await fixture(t);
  const repo = path.join(f.root, 'repo'), wt = path.join(f.root, 'wt'), clone = path.join(f.root, 'clone');
  await Promise.all([repo, clone].map(dir => fs.mkdir(dir)));
  await runNode('git', ['init'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'file.txt'), 'x');
  await runNode('git', ['add', 'file.txt'], { cwd: repo });
  await runNode('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'], { cwd: repo });
  await runNode('git', ['worktree', 'add', wt, '-b', 'feature'], { cwd: repo });
  await runNode('git', ['init'], { cwd: clone });
  const primary = await f.rpc({ op: 'detectGroup' }, repo);
  const linked = await f.rpc({ op: 'detectGroup' }, wt);
  assert.equal(primary.git, true);
  assert.equal(linked.git, true);
  assert.equal(primary.commonDir, linked.commonDir);
  assert.deepEqual(primary.suggestion, { groupId: primary.commonDir });
  assert.deepEqual(linked.matches, []);
  const registered = await f.rpc({ op: 'register', agentId: 'p', runner: 'test', groupId: primary.suggestion.groupId }, repo);
  assert.equal(registered.group.verified, true);
  const discovery = await f.rpc({ op: 'detectGroup' }, wt);
  assert.deepEqual(discovery.matches, [{ project: await fs.realpath(repo), groupId: primary.suggestion.groupId,
    commonDir: primary.commonDir }]);
  const joined = await f.rpc({ op: 'register', agentId: 'w', runner: 'test', groupId: primary.suggestion.groupId }, wt);
  assert.equal(joined.group.verified, true);
  const members = await f.rpc({ op: 'groupAgents', groupId: primary.suggestion.groupId }, repo);
  assert.deepEqual(members.rooms.map(room => room.project).sort(),
    [(await fs.realpath(repo)), (await fs.realpath(wt))].sort());
  assert.deepEqual(members.agents.map(agent => [agent.agentId, agent.project]).sort(),
    [['p', await fs.realpath(repo)], ['w', await fs.realpath(wt)]].sort());
  const separate = await f.rpc({ op: 'register', agentId: 'c', runner: 'test', groupId: primary.suggestion.groupId }, clone);
  assert.equal(separate.group.verified, false);
  assert.equal(separate.group.members.length, 3);
  const alone = await f.rpc({ op: 'detectGroup' }, f.other);
  assert.equal(alone.git, false);
  assert.equal(alone.commonDir, null);
  assert.equal(alone.suggestion, null);
  assert.deepEqual(alone.matches, []);
  assert.equal(alone.room, null);
});

test('claimNarrow atomically replaces an owned claim with narrower children and never opens a reclaim gap', async t => {
  const f = await fixture(t);
  const real = await fs.realpath(f.project);
  await f.register('a'); await f.register('b');
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['Sources', 'build', 'a-only'] });
  await f.rpc({ op: 'claim', agentId: 'b', resources: ['b-only'] });
  const narrow = await f.rpc({ op: 'claimNarrow', agentId: 'a', resource: 'Sources',
    resources: ['Sources/file.swift', 'Sources/nested/deep'], meta: { baseCommit: 'sha-0' } });
  assert.deepEqual(narrow.released, [path.join(real, 'Sources')]);
  assert.deepEqual(narrow.claimed.sort(),
    [path.join(real, 'Sources/file.swift'), path.join(real, 'Sources/nested/deep')].sort());
  const claims = (await f.rpc({ op: 'agents' })).claims;
  assert.equal(claims.find(c => c.resource === 'build').agentId, 'a');
  assert.equal(claims.find(c => c.resource === path.join(real, 'a-only')).agentId, 'a');
  assert.equal(claims.find(c => c.resource === path.join(real, 'b-only')).agentId, 'b');
  assert.equal(claims.find(c => c.resource === path.join(real, 'Sources')), undefined);
  assert.equal(claims.find(c => c.resource === path.join(real, 'Sources/file.swift')).meta.baseCommit, 'sha-0');
  const before = claims.map(c => c.resource).sort();
  assert.equal((await f.request({ op: 'claimNarrow', agentId: 'b', resource: 'a-only', resources: ['a-only/x'] })).error.code, 'NOT_HOLDER');
  assert.equal((await f.request({ op: 'claimNarrow', agentId: 'a', resource: 'build', resources: ['build/x'] })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'claimNarrow', agentId: 'a', resource: 'Sources/file.swift', resources: ['outside'] })).error.code, 'INVALID_INPUT');
  assert.deepEqual((await f.rpc({ op: 'agents' })).claims.map(c => c.resource).sort(), before);
  const [narrowed, stolen] = await Promise.all([
    f.request({ op: 'claimNarrow', agentId: 'a', resource: 'Sources/file.swift', resources: ['Sources/file.swift/kept'] }),
    f.request({ op: 'claim', agentId: 'b', resources: ['Sources/file.swift'] })
  ]);
  assert.equal(stolen.error.code, 'CLAIM_CONFLICT');
  assert.equal(narrowed.ok, true);
  const after = (await f.rpc({ op: 'agents' })).claims;
  assert.equal(after.some(c => c.resource === path.join(real, 'Sources/file.swift')), false);
  assert.equal(after.some(c => c.resource === path.join(real, 'Sources/file.swift/kept')), true);
  await f.restart();
  assert.equal((await f.rpc({ op: 'agents' })).claims.some(c => c.resource === path.join(real, 'Sources/file.swift/kept')), true);
});

test('handoffs transfer claims only with both parties consent and expose blocking and warnings', async t => {
  const f = await fixture(t);
  const real = await fs.realpath(f.project);
  await f.register('a'); await f.register('b'); await f.register('c');
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['roadmap', 'done/file'],
    meta: { baseCommit: 'sha-1', patchHash: 'p-1', resultingCommit: 'sha-2', verification: '68 tests green' } });
  const asked = await f.rpc({ op: 'requestHandoff', agentId: 'b', to: 'a', resources: ['roadmap'], reason: 'need it for route fixes' });
  assert.equal(asked.handoff.state, 'pending');
  assert.equal(asked.handoff.from, 'b');
  assert.equal(asked.handoff.to, 'a');
  assert.deepEqual((await f.rpc({ op: 'handoffs' })).handoffs.find(h => h.id === asked.handoff.id).held, [path.join(real, 'roadmap')]);
  const blocked = await f.rpc({ op: 'blocked' });
  assert.equal(blocked.blocked[0].holder, 'a');
  assert.deepEqual(blocked.blocked[0].resources, [path.join(real, 'roadmap')]);
  assert.deepEqual(blocked.blocked[0].requestIds, [asked.handoff.id]);
  assert.equal(blocked.warnings[0].code, 'HANDOFF_PENDING');
  const flagged = await f.rpc({ op: 'agents' });
  assert.deepEqual(flagged.claims.find(c => c.resource === path.join(real, 'roadmap')).handoffPending, [asked.handoff.id]);
  assert.equal(flagged.warnings[0].code, 'HANDOFF_PENDING');
  assert.equal((await f.request({ op: 'respondHandoff', agentId: 'c', id: asked.handoff.id, accept: true })).error.code, 'NOT_RECIPIENT');
  const offer = await f.rpc({ op: 'requestHandoff', agentId: 'a', to: 'c', resources: ['done/file'], reason: 'completed' });
  assert.equal((await f.rpc({ op: 'respondHandoff', agentId: 'c', id: offer.handoff.id, accept: false })).handoff.state, 'declined');
  const again = await f.rpc({ op: 'requestHandoff', agentId: 'a', to: 'b', resources: ['done/file'], reason: 'completed' });
  const accepted = await f.rpc({ op: 'respondHandoff', agentId: 'b', id: again.handoff.id, accept: true });
  assert.equal(accepted.handoff.state, 'accepted');
  assert.deepEqual(accepted.handoff.transferred, [path.join(real, 'done/file')]);
  const claim = accepted.claims.find(c => c.resource === path.join(real, 'done/file'));
  assert.equal(claim.agentId, 'b');
  assert.equal(claim.transferredFrom, 'a');
  assert.deepEqual(claim.meta, { baseCommit: 'sha-1', patchHash: 'p-1', resultingCommit: 'sha-2', verification: '68 tests green' });
  assert.equal((await f.request({ op: 'respondHandoff', agentId: 'b', id: again.handoff.id, accept: true })).error.code, 'HANDOFF_CLOSED');
  assert.equal((await f.request({ op: 'respondHandoff', agentId: 'a', id: 'missing', accept: true })).error.code, 'UNKNOWN_HANDOFF');
  const granted = await f.rpc({ op: 'respondHandoff', agentId: 'a', id: asked.handoff.id, accept: true });
  assert.equal(granted.handoff.state, 'accepted');
  assert.equal(granted.claims.find(c => c.resource === path.join(real, 'roadmap')).agentId, 'b');
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['p', 'q'] });
  const split = await f.rpc({ op: 'requestHandoff', agentId: 'a', to: 'c', resources: ['p', 'q'], reason: 'partial' });
  const partial = await f.rpc({ op: 'respondHandoff', agentId: 'c', id: split.handoff.id, accept: true, resources: ['p'] });
  assert.deepEqual(partial.handoff.transferred, [path.join(real, 'p')]);
  assert.equal(partial.claims.find(c => c.resource === path.join(real, 'q')).agentId, 'a');
  const open = await f.rpc({ op: 'requestHandoff', agentId: 'a', resources: ['q'], reason: 'open offer' });
  assert.equal(open.handoff.to, null);
  assert.equal((await f.request({ op: 'respondHandoff', agentId: 'a', id: open.handoff.id, accept: true })).error.code, 'INVALID_INPUT');
  const taken = await f.rpc({ op: 'respondHandoff', agentId: 'b', id: open.handoff.id, accept: true });
  assert.equal(taken.claims.find(c => c.resource === path.join(real, 'q')).agentId, 'b');
  assert.equal((await f.request({ op: 'requestHandoff', agentId: 'c', to: 'a', resources: ['nobody'], reason: 'x' })).error.code, 'NOT_HOLDER');
  assert.equal((await f.request({ op: 'requestHandoff', agentId: 'a', to: 'a', resources: ['q'], reason: 'x' })).error.code, 'INVALID_INPUT');
  const list = await f.rpc({ op: 'handoffs' });
  assert.deepEqual(list.handoffs.map(h => h.state).sort(),
    ['accepted', 'accepted', 'accepted', 'accepted', 'declined']);
  await f.restart();
  assert.equal((await f.rpc({ op: 'handoffs' })).handoffs.length, 5);
  assert.deepEqual((await f.rpc({ op: 'blocked' })).blocked, []);
  assert.equal((await f.rpc({ op: 'agents' })).claims.find(c => c.resource === path.join(real, 'roadmap')).agentId, 'b');
});

test('claim provenance meta round-trips through listings and restart; forced release returns an audit receipt', async t => {
  const f = await fixture(t);
  const real = await fs.realpath(f.project);
  await f.register('a');
  const meta = { baseCommit: 'abc123', patchHash: 'def456', resultingCommit: '789abc', verification: '68 tests green' };
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['native', 'Sources/file'], meta });
  const claims = (await f.rpc({ op: 'agents' })).claims;
  assert.deepEqual(claims.find(c => c.resource === 'native').meta, meta);
  assert.deepEqual(claims.find(c => c.resource === path.join(real, 'Sources/file')).meta, meta);
  await f.restart();
  const again = (await f.rpc({ op: 'agents' })).claims;
  assert.deepEqual(again.find(c => c.resource === 'native').meta, meta);
  const force = await f.rpc({ op: 'release', agentId: 'operator', force: true, resources: ['native', 'Sources/file'] });
  assert.equal(force.receipt.as, 'operator');
  assert.equal(force.receipt.scope, 'project');
  assert.deepEqual(force.receipt.released.map(c => c.resource).sort(),
    ['native', path.join(real, 'Sources/file')].sort());
  assert.deepEqual(force.receipt.released.find(c => c.resource === 'native').meta, meta);
  assert.equal(force.released.length, 2);
  const machine = await f.rpc({ op: 'claim', agentId: 'a', scope: 'machine', resources: ['native'], meta: { verification: 'probed' } });
  assert.deepEqual(machine.owned[0].meta, { verification: 'probed' });
  const plain = await f.rpc({ op: 'claim', agentId: 'a', resources: ['plain'] });
  assert.equal(plain.owned.find(c => c.resource === path.join(real, 'plain')).meta, undefined);
  assert.equal((await f.request({ op: 'claim', agentId: 'a', resources: ['x'], meta: { sha: 'nope' } })).error.code, 'INVALID_INPUT');
});

test('outbox and receipt derive per-recipient delivery ladder states from transport and ack markers', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  const sent = await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'ladder body', summary: 'ladder', messageId: 'ladder' });
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  const outbox = await f.rpc({ op: 'outbox', from: 'a' });
  assert.equal(outbox.nextCursor, sent.cursor);
  assert.deepEqual(Object.keys(outbox.messages[0]).sort(), ['body', 'counts', 'followups', 'from', 'id', 'recipients', 'summary', 'to', 'ts']);
  assert.equal(outbox.messages[0].summary, 'ladder');
  assert.deepEqual(outbox.messages[0].recipients, [{ agentId: 'b', stored: true, notified: [], accepted: [], acked: false, state: 'stored' }]);
  assert.deepEqual(outbox.messages[0].counts, { recipients: 1, acked: 0, accepted: 0, notified: 0, pending: 1 });
  const receipt = await f.rpc({ op: 'receipt', messageId: 'ladder' });
  assert.deepEqual(receipt.pending, [{ agentId: 'b', reason: 'no-transport-markers', ts: outbox.messages[0].ts }]);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  await f.rpc({ op: 'notified', agentId: 'b', messageId: 'ladder', adapter: 'codex-attempted' });
  let current = await f.rpc({ op: 'receipt', messageId: 'ladder' });
  assert.equal(current.recipients[0].state, 'attempted');
  assert.deepEqual(current.recipients[0].notified.map(n => n.adapter), ['codex-attempted']);
  assert.deepEqual(current.recipients[0].accepted, []);
  assert.deepEqual(current.counts, { recipients: 1, acked: 0, accepted: 0, notified: 1, pending: 0 });
  await f.rpc({ op: 'notified', agentId: 'b', messageId: 'ladder', adapter: 'opencode-toast' });
  assert.equal((await f.rpc({ op: 'receipt', messageId: 'ladder' })).recipients[0].state, 'notified');
  await f.rpc({ op: 'notified', agentId: 'b', messageId: 'ladder', adapter: 'codex-accepted' });
  current = await f.rpc({ op: 'receipt', messageId: 'ladder' });
  assert.equal(current.recipients[0].state, 'accepted');
  assert.deepEqual(current.recipients[0].accepted.map(n => n.adapter), ['codex-accepted']);
  assert.deepEqual(current.recipients[0].notified.map(n => n.adapter), ['codex-attempted', 'opencode-toast']);
  assert.deepEqual(current.counts, { recipients: 1, acked: 0, accepted: 1, notified: 0, pending: 0 });
  await f.rpc({ op: 'ack', agentId: 'b', messageId: 'ladder' });
  current = await f.rpc({ op: 'receipt', messageId: 'ladder' });
  assert.deepEqual(Object.keys(current.recipients[0]).sort(), ['accepted', 'ackTs', 'acked', 'agentId', 'notified', 'state', 'stored']);
  assert.equal(current.recipients[0].state, 'acked');
  assert.equal(current.recipients[0].acked, true);
  assert.equal(typeof current.recipients[0].ackTs, 'string');
  assert.deepEqual(current.counts, { recipients: 1, acked: 1, accepted: 0, notified: 0, pending: 0 });
  assert.deepEqual(current.pending, []);
});

test('outbox filters by message ID and cursor window while receipts explain pending recipients', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b'); await f.register('c');
  const one = await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'one', messageId: 'one' });
  await f.rpc({ op: 'send', from: 'a', to: '*', body: 'fan', messageId: 'fan' });
  await f.rpc({ op: 'send', from: 'b', to: 'a', body: 'two', messageId: 'two' });
  assert.deepEqual((await f.rpc({ op: 'outbox', from: 'a', messageId: 'fan' })).messages.map(m => m.id), ['fan']);
  assert.deepEqual((await f.rpc({ op: 'outbox', from: 'a', messageId: 'two' })).messages, []);
  assert.deepEqual((await f.rpc({ op: 'outbox', from: 'b' })).messages.map(m => m.id), ['two']);
  assert.deepEqual((await f.rpc({ op: 'outbox', from: 'nobody' })).messages, []);
  const paged = await f.rpc({ op: 'outbox', from: 'a', limit: 1 });
  assert.deepEqual(paged.messages.map(m => m.id), ['one']);
  assert.equal(paged.nextCursor, one.cursor);
  assert.deepEqual((await f.rpc({ op: 'outbox', from: 'a', since: one.cursor })).messages.map(m => m.id), ['fan']);
  assert.equal((await f.rpc({ op: 'outbox', from: 'a' })).messages[0].summary, null);
  await f.rpc({ op: 'notified', agentId: 'b', messageId: 'fan', adapter: 'codex-attempted' });
  await f.rpc({ op: 'notified', agentId: 'b', messageId: 'fan', adapter: 'codex-accepted' });
  await f.rpc({ op: 'notified', agentId: 'c', messageId: 'fan', adapter: 'opencode-wake-attempted' });
  const fan = await f.rpc({ op: 'receipt', messageId: 'fan' });
  assert.deepEqual(fan.recipients.map(row => [row.agentId, row.state]), [['b', 'accepted'], ['c', 'attempted']]);
  assert.deepEqual(fan.counts, { recipients: 2, acked: 0, accepted: 1, notified: 1, pending: 0 });
  assert.deepEqual(fan.pending, []);
  await f.rpc({ op: 'leave', agentId: 'b' });
  const pending = await f.rpc({ op: 'receipt', messageId: 'one' });
  assert.deepEqual(pending.pending, [{ agentId: 'b', reason: 'recipient-left', ts: pending.ts }]);
  await f.rpc({ op: 'send', from: 'a', to: 'c', body: 'three', messageId: 'three' });
  await f.rpc({ op: 'retire', agentId: 'c' });
  const three = await f.rpc({ op: 'receipt', messageId: 'three' });
  assert.deepEqual(three.pending, [{ agentId: 'c', reason: 'recipient-retired', ts: three.ts }]);
  assert.equal((await f.request({ op: 'outbox', from: 'a', since: -1 })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'outbox', from: 'a', limit: 0 })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'receipt', messageId: 'missing' })).error.code, 'UNKNOWN_MESSAGE');
  assert.equal((await f.request({ op: 'receipt' })).error.code, 'INVALID_INPUT');
});

test('follow-up requests are inert bounded records that round-trip through receipt and outbox', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b'); await f.register('c');
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'needs reply', messageId: 'follow' });
  const asked = await f.rpc({ op: 'requestFollowup', agentId: 'a', messageId: 'follow', note: 'please confirm receipt' });
  assert.deepEqual(Object.keys(asked.followup).sort(), ['agentId', 'at', 'id', 'note']);
  assert.equal(asked.followup.agentId, 'a');
  assert.equal(asked.followup.note, 'please confirm receipt');
  const receipt = await f.rpc({ op: 'receipt', messageId: 'follow' });
  assert.deepEqual(receipt.followups, [asked.followup]);
  assert.deepEqual((await f.rpc({ op: 'outbox', from: 'a', messageId: 'follow' })).messages[0].followups, [asked.followup]);
  const bare = await f.rpc({ op: 'requestFollowup', agentId: 'b', messageId: 'follow' });
  assert.deepEqual(Object.keys(bare.followup).sort(), ['agentId', 'at', 'id']);
  assert.deepEqual((await f.rpc({ op: 'receipt', messageId: 'follow' })).followups.map(row => row.id), [asked.followup.id, bare.followup.id]);
  assert.equal((await f.request({ op: 'requestFollowup', agentId: 'c', messageId: 'follow' })).error.code, 'UNKNOWN_MESSAGE');
  assert.equal((await f.request({ op: 'requestFollowup', agentId: 'a', messageId: 'missing' })).error.code, 'UNKNOWN_MESSAGE');
  assert.equal((await f.request({ op: 'requestFollowup', agentId: 'a', messageId: 'follow', note: '' })).error.code, 'INVALID_INPUT');
  const inbox = await f.rpc({ op: 'inbox', agentId: 'b', unacked: false });
  assert.deepEqual(inbox.messages.map(m => m.messageId), ['follow']);
  assert.equal(inbox.messages[0].acked, false);
  assert.equal((await f.rpc({ op: 'agents' })).cursor, 1);
  for (let i = 0; i < 30; i++) await f.rpc({ op: 'requestFollowup', agentId: 'a', messageId: 'follow', note: 'n' + i });
  assert.equal((await f.request({ op: 'requestFollowup', agentId: 'a', messageId: 'follow', note: 'overflow' })).error.code, 'FOLLOWUP_LIMIT');
  assert.equal((await f.rpc({ op: 'receipt', messageId: 'follow' })).followups.length, 32);
});

test('restart preserves delivery ladder markers, acknowledgement times and follow-up records', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b'); await f.register('c');
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'one', summary: 'first', messageId: 'one' });
  await f.rpc({ op: 'send', from: 'a', to: '*', body: 'fan', messageId: 'fan' });
  await f.rpc({ op: 'notified', agentId: 'b', messageId: 'one', adapter: 'codex-attempted' });
  await f.rpc({ op: 'notified', agentId: 'b', messageId: 'one', adapter: 'codex-accepted' });
  await f.rpc({ op: 'ack', agentId: 'b', messageId: 'one' });
  await f.rpc({ op: 'notified', agentId: 'c', messageId: 'fan', adapter: 'opencode-wake-attempted' });
  await f.rpc({ op: 'requestFollowup', agentId: 'a', messageId: 'one', note: 'escalate' });
  const outboxBefore = await f.rpc({ op: 'outbox', from: 'a' });
  const receiptBefore = await f.rpc({ op: 'receipt', messageId: 'one' });
  await f.restart();
  assert.deepEqual(await f.rpc({ op: 'outbox', from: 'a' }), outboxBefore);
  assert.deepEqual(await f.rpc({ op: 'receipt', messageId: 'one' }), receiptBefore);
  assert.deepEqual(receiptBefore.recipients.map(row => row.state), ['acked']);
  assert.equal(receiptBefore.recipients[0].ackTs !== undefined, true);
  assert.deepEqual(receiptBefore.followups.map(row => row.note), ['escalate']);
  const fan = await f.rpc({ op: 'receipt', messageId: 'fan' });
  assert.deepEqual(fan.recipients.map(row => [row.agentId, row.state]), [['b', 'stored'], ['c', 'attempted']]);
  assert.deepEqual(fan.counts, { recipients: 2, acked: 0, accepted: 0, notified: 1, pending: 1 });
  assert.deepEqual(fan.pending.map(row => row.agentId), ['b']);
});

test('history paginates the full retained ledger past the snapshot cap and reaches an early message', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  for (let i = 0; i < 210; i++)
    await f.rpc({ op: 'send', from: i % 2 ? 'b' : 'a', to: i % 2 ? 'a' : 'b', body: 'flow-' + i, messageId: 'm-' + i });
  await f.rpc({ op: 'ack', agentId: 'a', messageId: 'm-1' });
  await f.rpc({ op: 'ack', agentId: 'b', messageId: 'm-0' });
  const snapshot = await f.rpc({ op: 'snapshot', limit: 200 });
  assert.equal(snapshot.totalMessages, 210);
  assert.equal(snapshot.messages.some(m => m.messageId === 'm-2'), false);
  const seen = [];
  let since = 0, pages = 0, done = false;
  while (!done) {
    const page = await f.rpc({ op: 'history', since, limit: 100 });
    pages++;
    assert.equal(page.messages[0].cursor > since, true);
    if (!page.done) assert.equal(page.nextCursor, page.messages.at(-1).cursor);
    seen.push(...page.messages.map(m => m.messageId));
    done = page.done;
    since = page.nextCursor;
  }
  assert.equal(pages, 3);
  assert.equal(seen.length, 210);
  assert.equal(new Set(seen).size, 210);
  assert.equal(seen[2], 'm-2');
  const older = [];
  let before = Number.MAX_SAFE_INTEGER, backPages = 0, more = true;
  while (more) {
    const page = await f.rpc({ op: 'history', before, limit: 100 });
    backPages++;
    older.push(...page.messages.map(m => m.messageId));
    more = !page.done;
    before = page.nextCursor;
  }
  assert.equal(backPages, 3);
  assert.deepEqual(older, [...seen].reverse());
  assert.equal(older.includes('m-2'), true);
  assert.deepEqual((await f.rpc({ op: 'history', before: 4, limit: 10 })).messages.map(m => m.messageId),
    ['m-2', 'm-1', 'm-0']);
});

test('history acked filter separates acknowledged exchanges from pending ones', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b'); await f.register('c');
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'settled', messageId: 'settled' });
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'pending', messageId: 'pending' });
  await f.rpc({ op: 'send', from: 'b', to: 'a', body: 'return', messageId: 'return' });
  await f.rpc({ op: 'send', from: 'a', to: '*', body: 'fan', messageId: 'fan' });
  await f.rpc({ op: 'ack', agentId: 'b', messageId: 'settled' });
  await f.rpc({ op: 'ack', agentId: 'c', messageId: 'fan' });
  const ids = async fields => (await f.rpc({ op: 'history', ...fields })).messages.map(m => m.messageId);
  assert.deepEqual(await ids({ acked: true }), ['settled']);
  assert.deepEqual(await ids({ acked: false }), ['pending', 'return', 'fan']);
  assert.deepEqual(await ids({}), ['settled', 'pending', 'return', 'fan']);
  assert.deepEqual(await ids({ agentId: 'b', acked: true }), ['settled']);
  assert.deepEqual(await ids({ agentId: 'c', acked: true }), []);
  assert.deepEqual(await ids({ agentId: 'c', acked: false }), ['fan']);
  assert.equal((await f.request({ op: 'history', acked: 'yes' })).error.code, 'INVALID_INPUT');
});

test('history sender, recipient and involvement filters cover broadcasts and combine', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b'); await f.register('c');
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'one', messageId: 'ab' });
  await f.rpc({ op: 'send', from: 'b', to: 'a', body: 'two', messageId: 'ba' });
  await f.rpc({ op: 'send', from: 'a', to: '*', body: 'fan', messageId: 'fan' });
  await f.rpc({ op: 'send', from: 'b', to: '*', body: 'wide', messageId: 'wide' });
  await f.rpc({ op: 'send', from: 'c', to: 'a', body: 'three', messageId: 'ca' });
  const ids = async fields => (await f.rpc({ op: 'history', ...fields })).messages.map(m => m.messageId);
  assert.deepEqual(await ids({ from: 'a' }), ['ab', 'fan']);
  assert.deepEqual(await ids({ to: 'b' }), ['ab', 'fan']);
  assert.deepEqual(await ids({ to: 'a' }), ['ba', 'wide', 'ca']);
  assert.deepEqual(await ids({ to: '*' }), ['fan', 'wide']);
  assert.deepEqual(await ids({ agentId: 'c' }), ['fan', 'wide', 'ca']);
  assert.deepEqual(await ids({ from: 'a', to: 'b' }), ['ab', 'fan']);
  assert.deepEqual(await ids({ from: 'nobody' }), []);
});

test('history time ranges bound messages on exclusive ISO timestamp edges', async t => {
  const f = await fixture(t);
  const real = await fs.realpath(f.project);
  const at = n => `2026-10-09T00:00:0${n}.000Z`;
  const row = (messageId, cursor, createdAt) => ({ messageId, cursor, from: 'a', to: 'b', body: messageId,
    createdAt, recipients: ['b'], ackedBy: [], notified: [] });
  const agent = id => ({ agentId: id, runner: 'test', registeredAt: at(0), updatedAt: at(0), status: 'idle',
    frozen: false, resources: [], task: null });
  await f.broker.close();
  await fs.writeFile(path.join(f.dataDir, 'state.json'), JSON.stringify({ version: 1, nextCursor: 4,
    rooms: [{ project: real, agents: [agent('a'), agent('b')],
      messages: [row('early', 1, at(1)), row('mid', 2, at(2)), row('late', 3, at(3))], claims: [], cursor: 3 }] }));
  await f.restart();
  const ids = async fields => (await f.rpc({ op: 'history', ...fields })).messages.map(m => m.messageId);
  assert.deepEqual(await ids({}), ['early', 'mid', 'late']);
  assert.deepEqual(await ids({ afterTs: at(1) }), ['mid', 'late']);
  assert.deepEqual(await ids({ afterTs: '2026-10-09T00:00:00.999Z' }), ['early', 'mid', 'late']);
  assert.deepEqual(await ids({ beforeTs: at(3) }), ['early', 'mid']);
  assert.deepEqual(await ids({ afterTs: at(1), beforeTs: at(3) }), ['mid']);
  assert.deepEqual(await ids({ beforeTs: at(1) }), []);
  assert.equal((await f.rpc({ op: 'history', afterTs: at(1) })).scope.windowLabel, `after ${at(1)}`);
  assert.equal((await f.request({ op: 'history', afterTs: 'not-a-time' })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'history', beforeTs: 5 })).error.code, 'INVALID_INPUT');
});

test('history threadOf returns direct replies and descendants along reply chains', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'root', messageId: 'root' });
  await f.rpc({ op: 'send', from: 'b', to: 'a', body: 'reply', messageId: 'r1', replyTo: 'root' });
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'deep', messageId: 'r2', replyTo: 'r1' });
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'side', messageId: 'r3', replyTo: 'root' });
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'other', messageId: 'other' });
  const ids = async fields => (await f.rpc({ op: 'history', ...fields })).messages.map(m => m.messageId);
  assert.deepEqual(await ids({ threadOf: 'root' }), ['r1', 'r2', 'r3']);
  assert.deepEqual(await ids({ threadOf: 'r1' }), ['r2']);
  assert.deepEqual(await ids({ threadOf: 'r2' }), []);
  assert.deepEqual(await ids({ threadOf: 'root', from: 'b' }), ['r1']);
  assert.equal((await f.rpc({ op: 'history', threadOf: 'root' })).scope.totalMatching, 3);
  assert.equal((await f.request({ op: 'history', threadOf: 'missing' })).error.code, 'UNKNOWN_MESSAGE');
});

test('history scope reports matched totals, search origin and window label honestly', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  for (let i = 0; i < 25; i++)
    await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'n-' + i, messageId: 'm-' + i });
  const first = await f.rpc({ op: 'history', limit: 10 });
  assert.deepEqual(Object.keys(first).filter(key => !['ok', 'status'].includes(key)).sort(),
    ['done', 'messages', 'nextCursor', 'scope']);
  assert.equal(first.messages.length, 10);
  assert.equal(first.nextCursor, 10);
  assert.equal(first.done, false);
  assert.deepEqual(first.scope, { totalMatching: 25, searchedFrom: 1, windowLabel: 'full retained history' });
  const middle = await f.rpc({ op: 'history', since: 10, limit: 10 });
  assert.equal(middle.nextCursor, 20);
  assert.equal(middle.done, false);
  assert.deepEqual(middle.scope, { totalMatching: 15, searchedFrom: 10, windowLabel: 'cursors after 10' });
  const last = await f.rpc({ op: 'history', since: 20 });
  assert.equal(last.messages.length, 5);
  assert.equal(last.done, true);
  assert.deepEqual(last.scope, { totalMatching: 5, searchedFrom: 20, windowLabel: 'cursors after 20' });
  const old = await f.rpc({ op: 'history', before: 5, limit: 3 });
  assert.deepEqual(old.messages.map(m => m.messageId), ['m-3', 'm-2', 'm-1']);
  assert.equal(old.nextCursor, 2);
  assert.equal(old.done, false);
  assert.deepEqual(old.scope, { totalMatching: 4, searchedFrom: 1, windowLabel: 'cursors before 5' });
  const oldest = await f.rpc({ op: 'history', before: old.nextCursor, limit: 3 });
  assert.deepEqual(oldest.messages.map(m => m.messageId), ['m-0']);
  assert.equal(oldest.done, true);
  assert.deepEqual(oldest.scope, { totalMatching: 1, searchedFrom: 1, windowLabel: 'cursors before 2' });
  assert.deepEqual((await f.rpc({ op: 'history', since: 2, before: 4 })).scope.windowLabel, 'cursors 2-4');
  assert.equal((await f.request({ op: 'history', limit: 0 })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'history', limit: 10001 })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'history', since: -1 })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'history', before: 'x' })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'history', before: 1.5 })).error.code, 'INVALID_INPUT');
});

test('snapshot window reports limit, offset and total over all retained messages', async t => {
  const f = await fixture(t);
  const real = await fs.realpath(f.project);
  const ts = '2026-10-09T00:00:00.000Z';
  const agent = id => ({ agentId: id, runner: 'test', registeredAt: ts, updatedAt: ts, status: 'idle',
    frozen: false, resources: [], task: null });
  const rows = Array.from({ length: 250 }, (_, i) => ({ messageId: 'm-' + i, cursor: i + 1, from: 'a', to: 'b',
    body: 'seed-' + i, createdAt: ts, recipients: ['b'], ackedBy: [], notified: [] }));
  await f.broker.close();
  await fs.writeFile(path.join(f.dataDir, 'state.json'), JSON.stringify({ version: 1, nextCursor: 251,
    rooms: [{ project: real, agents: [agent('a'), agent('b')], messages: rows, claims: [], cursor: 250 }] }));
  await f.restart();
  const wide = await f.rpc({ op: 'snapshot', limit: 200 });
  assert.deepEqual(wide.window, { limit: 200, offset: 50, total: 250 });
  assert.equal(wide.messages.length, 200);
  assert.equal(wide.messages[0].messageId, 'm-249');
  assert.deepEqual((await f.rpc({ op: 'snapshot', limit: 1 })).window, { limit: 1, offset: 249, total: 250 });
  assert.deepEqual((await f.rpc({ op: 'snapshot' })).window, { limit: 100, offset: 150, total: 250 });
  assert.deepEqual((await f.rpc({ op: 'snapshot' }, f.other)).window, { limit: 100, offset: 0, total: 0 });
});

test('policy bulletin pins versioned policy with hashes and per-agent acknowledgement evidence', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  const digest = (title, body, source) => createHash('sha256').update(JSON.stringify({ title, body, source })).digest('hex');
  const fields = result => Object.keys(result).filter(key => !['ok', 'status'].includes(key)).sort();
  const empty = await f.rpc({ op: 'getBulletin' });
  assert.deepEqual(fields(empty), ['acks', 'body', 'hash', 'source', 'title', 'ts', 'version', 'versions']);
  assert.equal(empty.version, 0); assert.deepEqual(empty.acks, []); assert.deepEqual(empty.versions, []);
  const first = await f.rpc({ op: 'setBulletin', agentId: 'a', title: 'Worktree policy',
    body: 'One agent per worktree.\nStop watchers by verified identity.', source: 'AGENT_BEST_PRACTICES.md' });
  assert.deepEqual(fields(first), ['acks', 'body', 'hash', 'source', 'title', 'ts', 'version']);
  assert.equal(first.version, 1);
  assert.equal(first.hash, digest(first.title, first.body, first.source));
  assert.deepEqual(first.acks, []);
  const conflict = await f.request({ op: 'setBulletin', agentId: 'a', title: 'x', body: 'y', source: 'z', version: 5 });
  assert.equal(conflict.error.code, 'VERSION_CONFLICT');
  assert.equal(conflict.error.current, 1);
  const acked = await f.rpc({ op: 'ackBulletin', agentId: 'b' });
  assert.deepEqual(fields(acked), ['acks', 'duplicate', 'version']);
  assert.deepEqual(acked.acks, ['b']);
  assert.equal(acked.duplicate, false);
  assert.equal((await f.rpc({ op: 'ackBulletin', agentId: 'b' })).duplicate, true);
  const second = await f.rpc({ op: 'setBulletin', agentId: 'b', title: 'Restart policy',
    body: 'Restart only owned process trees.', source: 'AGENT_BEST_PRACTICES.md', version: 1 });
  assert.equal(second.version, 2);
  assert.deepEqual(second.acks, []);
  assert.equal((await f.request({ op: 'setBulletin', agentId: 'a', title: 'x', body: 'y', source: 'z', version: 1 })).error.code, 'VERSION_CONFLICT');
  await f.register('c');
  const current = await f.rpc({ op: 'getBulletin' });
  assert.equal(current.version, 2);
  assert.equal(current.source, 'AGENT_BEST_PRACTICES.md');
  assert.deepEqual(current.acks, []);
  assert.deepEqual(current.versions.map(row => row.version), [2, 1]);
  assert.deepEqual(current.versions.map(row => row.hash), [second.hash, first.hash]);
  const prior = await f.rpc({ op: 'getBulletin', version: 1 });
  assert.equal(prior.title, 'Worktree policy');
  assert.deepEqual(prior.acks, ['b']);
  assert.equal(prior.hash, first.hash);
  assert.equal((await f.request({ op: 'getBulletin', version: 7 })).error.code, 'UNKNOWN_BULLETIN');
  assert.equal((await f.request({ op: 'getBulletin', version: 0 })).error.code, 'INVALID_INPUT');
  for (let i = 3; i <= 17; i++)
    await f.rpc({ op: 'setBulletin', agentId: 'a', title: 'Policy ' + i, body: 'body ' + i, source: 'AGENT_BEST_PRACTICES.md' });
  const retained = await f.rpc({ op: 'getBulletin' });
  assert.equal(retained.version, 17);
  assert.equal(retained.versions.length, 16);
  assert.equal(retained.versions.at(-1).version, 2);
  assert.equal(retained.versions.every(row => /^[a-f0-9]{64}$/u.test(row.hash)), true);
  assert.equal((await f.request({ op: 'getBulletin', version: 1 })).error.code, 'UNKNOWN_BULLETIN');
  const broadcast = await f.rpc({ op: 'send', from: 'a', to: '*', body: 'one-off notice', messageId: 'notice' });
  assert.deepEqual(broadcast.recipients, ['b', 'c']);
  assert.equal((await f.rpc({ op: 'inbox', agentId: 'c' })).messages.length, 1);
});

test('bulletin and process ownership records survive restart with hashes and owners intact', async t => {
  const f = await fixture(t);
  await f.register('a');
  await f.rpc({ op: 'setBulletin', agentId: 'a', title: 'Policy', body: 'Durable policy body.', source: 'AGENT.md' });
  await f.rpc({ op: 'ackBulletin', agentId: 'a' });
  await f.rpc({ op: 'processes', action: 'register', agentId: 'a', pid: 5150, command: 'node watch.mjs',
    cwd: f.project, port: 5173, deployment: 'staging', note: 'publishes on save' });
  const bulletinBefore = await f.rpc({ op: 'getBulletin' });
  const processesBefore = await f.rpc({ op: 'processes', action: 'list' });
  await f.restart();
  assert.deepEqual(await f.rpc({ op: 'getBulletin' }), bulletinBefore);
  const after = await f.rpc({ op: 'processes', action: 'list' });
  const stable = rows => rows.map(({ alive, lastVerifiedAt, ...row }) => row);
  assert.deepEqual(stable(after.processes), stable(processesBefore.processes));
  assert.equal(after.processes[0].agentId, 'a');
  assert.equal(after.processes[0].startedAt, processesBefore.processes[0].startedAt);
  assert.match(after.processes[0].lastVerifiedAt, /^\d{4}-\d{2}-\d{2}T/u);
});

test('process records expose owners and liveness and removal never stops the process', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => { child.kill(); });
  await new Promise(resolve => child.once('spawn', resolve));
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise(resolve => dead.once('exit', resolve));
  const owned = await f.rpc({ op: 'processes', action: 'register', agentId: 'a', pid: child.pid,
    command: 'node -e watcher', cwd: f.project, port: 5173, deployment: 'preview', note: 'publishes schema on save' });
  assert.deepEqual(Object.keys(owned.process).sort(),
    ['agentId', 'alive', 'command', 'cwd', 'deployment', 'id', 'lastVerifiedAt', 'note', 'pid', 'port', 'startedAt']);
  assert.equal(owned.process.agentId, 'a');
  assert.equal(owned.process.alive, true);
  assert.match(owned.process.startedAt, /^\d{4}-\d{2}-\d{2}T/u);
  await f.rpc({ op: 'processes', action: 'register', agentId: 'b', pid: dead.pid, command: 'node -e done' });
  const listed = await f.rpc({ op: 'processes', action: 'list' });
  assert.equal(listed.processes.length, 2);
  assert.deepEqual(Object.keys(listed.liveness).sort(), ['limit', 'method', 'pidReuse']);
  assert.equal(listed.liveness.method, 'process.kill(pid,0)');
  assert.equal(listed.liveness.pidReuse, 'best-effort');
  assert.match(listed.liveness.limit, /startedAt/u);
  const live = listed.processes.find(row => row.pid === child.pid);
  assert.equal(live.alive, true);
  assert.equal(live.agentId, 'a');
  assert.equal(live.port, 5173);
  assert.equal(live.deployment, 'preview');
  assert.equal(listed.processes.find(row => row.pid === dead.pid).alive, false);
  const owned2 = await f.rpc({ op: 'processes', action: 'list', agentId: 'b' });
  assert.deepEqual(owned2.processes.map(row => [row.pid, row.agentId]), [[dead.pid, 'b']]);
  assert.equal((await f.request({ op: 'processes', action: 'register', agentId: 'a', pid: child.pid })).error.code, 'PROCESS_EXISTS');
  assert.equal((await f.request({ op: 'processes', action: 'register', agentId: 'a' })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'processes', action: 'register', agentId: 'nobody', pid: 1 })).error.code, 'UNKNOWN_AGENT');
  assert.equal((await f.request({ op: 'processes', action: 'register', agentId: 'a', pid: 1, port: 70000 })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'processes', action: 'retire' })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'processes', action: 'remove', agentId: 'a' })).error.code, 'INVALID_INPUT');
  const calls = [];
  const realKill = process.kill;
  process.kill = (pid, signal) => { calls.push({ pid, signal }); return realKill(pid, signal); };
  let removed;
  try {
    removed = await f.rpc({ op: 'processes', action: 'remove', id: owned.process.id });
  } finally { process.kill = realKill; }
  assert.deepEqual(removed.removed.map(row => row.id), [owned.process.id]);
  assert.deepEqual(removed.processes.map(row => row.pid), [dead.pid]);
  assert.equal(calls.length > 0, true);
  assert.equal(calls.every(call => call.signal === 0), true);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  assert.equal((await f.rpc({ op: 'processes', action: 'list' })).processes.some(row => row.pid === child.pid), false);
  assert.deepEqual((await f.rpc({ op: 'processes', action: 'remove', pid: dead.pid, agentId: 'a' })).removed, []);
  assert.deepEqual((await f.rpc({ op: 'processes', action: 'remove', pid: dead.pid })).removed.map(row => row.pid), [dead.pid]);
});

test('process records refuse past MAX_PROCESSES with recovery guidance and leave the ledger intact', async t => {
  const f = await fixture(t);
  await f.register('a');
  for (let i = 0; i < MAX_PROCESSES; i++)
    await f.rpc({ op: 'processes', action: 'register', agentId: 'a', pid: 60000 + i, command: 'watcher-' + i });
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  const refused = await f.request({ op: 'processes', action: 'register', agentId: 'a', pid: 59999, command: 'overflow' });
  assert.equal(refused.error.code, 'PROCESS_LIMIT');
  assert.equal(refused.error.used, MAX_PROCESSES);
  assert.equal(refused.error.limit, MAX_PROCESSES);
  assert.equal(refused.error.recovery, 'remove finished process records');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  assert.equal((await f.rpc({ op: 'processes', action: 'list' })).processes.length, MAX_PROCESSES);
  await f.rpc({ op: 'processes', action: 'remove', pid: 60000 });
  assert.equal((await f.request({ op: 'processes', action: 'register', agentId: 'a', pid: 59999, command: 'fits' })).ok, true);
  assert.equal((await f.rpc({ op: 'processes', action: 'list' })).processes.length, MAX_PROCESSES);
});
test('usage reports utilization and headroom for every bound', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  await f.rpc({ op: 'send', agentId: 'a', from: 'a', to: 'b', body: 'hello' });
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['doc.txt'] });
  const usage = await f.rpc({ op: 'usage' });
  assert.deepEqual(usage.messages, { used: 1, limit: 10000 });
  assert.deepEqual(usage.rooms, { count: 1, limit: MAX_ROOMS });
  assert.equal(usage.agents.stored, 2); assert.equal(usage.agents.active, 2); assert.equal(usage.agents.left, 0);
  assert.equal(usage.claims.used, 1); assert.equal(usage.claims.project, 1); assert.equal(usage.claims.machine, 0);
  assert.equal(usage.handoffs.used, 0); assert.equal(usage.processes.used, 0);
  assert.equal(usage.attachments.count, 0);
  assert.ok(usage.store.usedBytes > 0 && usage.store.limitBytes === 64 * 1024 * 1024);
  assert.equal(usage.headroom.messages, 9999); assert.deepEqual(usage.nearLimit, []);
});
test('export and restore round-trip preserves history with dry-run safety', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  await f.rpc({ op: 'send', agentId: 'a', from: 'a', to: '*', body: 'policy' });
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['doc.txt'] });
  const exported = await f.rpc({ op: 'export' });
  assert.equal(exported.schemaVersion, 1); assert.ok(exported.exportedAt);
  assert.equal(exported.state.rooms.length, 1); assert.deepEqual(exported.attachmentHashes, []);
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  const dry = await f.rpc({ op: 'restore', state: exported.state, dryRun: true });
  assert.equal(dry.valid, true); assert.equal(dry.dryRun, true); assert.deepEqual(dry.missingAttachments, []);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  const tampered = structuredClone(exported.state); delete tampered.rooms;
  assert.equal((await f.request({ op: 'restore', state: tampered })).error.code, 'INVALID_RESTORE');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  assert.equal((await f.request({ op: 'restore', state: exported.state, schemaVersion: 999 })).error.code, 'SCHEMA_MISMATCH');
  const done = await f.rpc({ op: 'restore', state: exported.state });
  assert.equal(done.restored, true); assert.equal(done.rooms, 1); assert.equal(done.messages, 1);
  assert.equal((await f.rpc({ op: 'usage' })).messages.used, 1);
  assert.equal((await f.rpc({ op: 'history', threadOf: (await f.rpc({ op: 'outbox', from: 'a' })).messages[0].id })).scope.totalMatching, 0);
});
test('attachment audit lists only unreferenced content and refuses without dryRun', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  const source = path.join(f.root, 'packet'); await fs.writeFile(source, 'packet bytes');
  await f.rpc({ op: 'send', agentId: 'a', from: 'a', to: 'b', body: 'with file', attachments: [source] });
  const stray = 'ab'.repeat(32);
  await fs.writeFile(path.join(f.dataDir, 'attachments', stray), 'orphan');
  assert.equal((await f.request({ op: 'auditAttachments' })).error.code, 'ATTACHMENT_AUDIT_DRY_RUN_REQUIRED');
  const audit = await f.rpc({ op: 'auditAttachments', dryRun: true });
  assert.equal(audit.stored, 2); assert.equal(audit.referenced, 1);
  assert.deepEqual(audit.unreferenced.map(r => r.sha256), [stray]);
  assert.equal(audit.unreferenced[0].size, 6);
});
test('broadcast beyond 1024 markers records every delivery transition', async t => {
  const f = await fixture(t);
  const at = new Date().toISOString();
  const room = await fs.realpath(f.project);
  const agents = Array.from({ length: 601 }, (_, i) => ({ agentId: 'agent-' + i, runner: 'test',
    registeredAt: at, updatedAt: at, status: 'idle', frozen: false, resources: [], task: null }));
  const recipients = agents.slice(1).map(a => a.agentId);
  const notified = recipients.flatMap(id => [{ agentId: id, adapter: 'codex-attempted', at }, { agentId: id, adapter: 'codex-accepted', at }]);
  await fs.writeFile(path.join(f.dataDir, 'state.json'), JSON.stringify({ version: 1, nextCursor: 2,
    rooms: [{ project: room, agents, claims: [], cursor: 1,
      messages: [{ messageId: 'big', from: 'agent-0', to: '*', body: 'fanout', createdAt: at, cursor: 1, recipients, ackedBy: [], notified }] }] }));
  await f.restart();
  assert.equal(notified.length, 1200);
  const receipt = await f.rpc({ op: 'receipt', messageId: 'big' });
  assert.equal(receipt.counts.accepted, 600); assert.equal(receipt.counts.pending, 0);
  const usage = await f.rpc({ op: 'usage' });
  assert.equal(usage.notices.used, 1200); assert.equal(usage.notices.largest.allowance, 1800);
  await f.rpc({ op: 'notified', agentId: 'agent-1', messageId: 'big', adapter: 'watch-accepted' });
  assert.equal((await f.rpc({ op: 'receipt', messageId: 'big' })).recipients.find(r => r.agentId === 'agent-1').accepted.length, 2);
});
test('near-full store pauses sends while ack and status keep working', async t => {
  const f = await fixture(t);
  const at = new Date().toISOString();
  const room = await fs.realpath(f.project);
  const mkAgent = id => ({ agentId: id, runner: 'test', registeredAt: at, updatedAt: at, status: 'idle', frozen: false, resources: [], task: null });
  const sample = { messageId: 'm-1', from: 'a', to: 'b', body: 'x'.repeat(16384), createdAt: at, cursor: 1, recipients: ['b'], ackedBy: [], notified: [] };
  const perMessage = Buffer.byteLength(JSON.stringify(sample)) + 1;
  const count = Math.floor((63.4 * 1024 * 1024) / perMessage);
  const messages = [];
  for (let cursor = 1; cursor <= count; cursor++)
    messages.push({ messageId: 'm-' + cursor, from: 'a', to: 'b', body: 'x'.repeat(16384), createdAt: at, cursor, recipients: ['b'], ackedBy: [], notified: [] });
  const snapshot = { version: 1, nextCursor: count + 1,
    rooms: [{ project: room, agents: [mkAgent('a'), mkAgent('b')], claims: [], cursor: count, messages }] };
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  assert.ok(bytes > 63 * 1024 * 1024 && bytes <= 64 * 1024 * 1024, `fixture is ${bytes} bytes`);
  await fs.writeFile(path.join(f.dataDir, 'state.json'), JSON.stringify(snapshot));
  await f.restart();
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  const refused = await f.request({ op: 'send', agentId: 'a', from: 'a', to: 'b', body: 'one more' });
  assert.equal(refused.error.code, 'STORE_LOW_HEADROOM');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  await f.rpc({ op: 'ack', agentId: 'b', messageId: 'm-1' });
  assert.equal((await f.rpc({ op: 'receipt', messageId: 'm-1' })).recipients[0].state, 'acked');
  assert.equal((await f.rpc({ op: 'status', agentId: 'b', status: 'busy' })).agent.status, 'busy');
  assert.ok((await f.rpc({ op: 'usage' })).nearLimit.includes('store'));
});
test('readiness separates declared task, activity, transport and push observations', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  await f.rpc({ op: 'status', agentId: 'a', status: 'busy', task: 'working' });
  let agents = (await f.rpc({ op: 'agents' })).agents;
  const fresh = agents.find(a => a.agentId === 'a');
  assert.equal(fresh.readiness.transport.state, 'unknown');
  assert.equal(fresh.readiness.push.ready, null);
  assert.equal(fresh.readiness.declared.task, 'working');
  assert.ok(fresh.readiness.declared.statusAt);
  assert.equal(fresh.readiness.lastSeenAt, fresh.updatedAt);
  const statusAt = fresh.readiness.declared.statusAt;
  await f.rpc({ op: 'status', agentId: 'a', transport: { adapter: 'codex-bridge', state: 'connected', push: true } });
  agents = (await f.rpc({ op: 'agents' })).agents;
  const attached = agents.find(a => a.agentId === 'a');
  assert.equal(attached.readiness.transport.state, 'connected');
  assert.equal(attached.readiness.transport.adapter, 'codex-bridge');
  assert.ok(attached.readiness.transport.ts);
  assert.equal(attached.readiness.push.ready, true);
  assert.equal(attached.readiness.declared.task, 'working');
  assert.equal(attached.readiness.declared.statusAt, statusAt);
  await f.rpc({ op: 'status', agentId: 'a', transport: { adapter: 'codex-bridge', state: 'disconnected' } });
  agents = (await f.rpc({ op: 'agents' })).agents;
  const dropped = agents.find(a => a.agentId === 'a');
  assert.equal(dropped.readiness.transport.state, 'disconnected');
  assert.equal(dropped.readiness.declared.status, 'busy');
  assert.equal(dropped.readiness.declared.task, 'working');
  const connected = await f.rpc({ op: 'agents', transport: 'connected' });
  assert.deepEqual(connected.agents.map(a => a.agentId), []);
  const unknown = await f.rpc({ op: 'agents', transport: 'unknown' });
  assert.deepEqual(unknown.agents.map(a => a.agentId), ['b']);
  assert.equal((await f.request({ op: 'status', agentId: 'a', transport: { adapter: 'x', state: 'live' } })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'agents', transport: 'live' })).error.code, 'INVALID_INPUT');
  await f.restart();
  assert.equal((await f.rpc({ op: 'agents' })).agents.find(a => a.agentId === 'a').readiness.transport.state, 'disconnected');
});
test('structured tasks expose blocking claims, handoff acceptance and completion gates', async t => {
  const f = await fixture(t);
  await f.register('holder'); await f.register('worker');
  await f.rpc({ op: 'claim', agentId: 'holder', resources: ['shared.txt'] });
  const created = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'worker', title: 'Fix route',
    owner: 'worker', blockedBy: ['shared.txt'], resources: ['shared.txt'], sourceRevision: 'abc123',
    expectedRecipient: 'holder' });
  assert.equal(created.task.state, 'open'); assert.equal(created.task.blocked, true);
  assert.deepEqual(created.task.blocking, [{ ref: 'shared.txt', kind: 'claim', scope: 'project', holder: 'holder', state: 'held' }]);
  assert.equal(created.task.handoff, null);
  const handoff = await f.rpc({ op: 'requestHandoff', agentId: 'holder', to: 'worker', resources: ['shared.txt'], reason: 'take it' });
  const linked = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'worker', id: created.task.id, handoffId: handoff.handoff.id });
  assert.equal(linked.task.handoff.accepted, false);
  await f.rpc({ op: 'respondHandoff', agentId: 'worker', id: handoff.handoff.id, accept: true });
  const after = await f.rpc({ op: 'tasks', action: 'list', agentId: 'worker', blocked: true });
  assert.equal(after.tasks.length, 1); assert.equal(after.tasks[0].handoff.accepted, true);
  assert.deepEqual(after.tasks[0].blocking, [{ ref: 'shared.txt', kind: 'claim', scope: 'project', holder: 'worker', state: 'held' }]);
  const done = await f.rpc({ op: 'tasks', action: 'complete', agentId: 'worker', id: created.task.id, verification: 'tests pass' });
  assert.equal(done.task.state, 'complete'); assert.equal(done.task.verification, 'tests pass');
  assert.equal((await f.rpc({ op: 'agents' })).claims.length, 1);
  const open = await f.rpc({ op: 'tasks', action: 'list', agentId: 'worker', state: 'open' });
  assert.deepEqual(open.tasks, []);
  assert.equal((await f.request({ op: 'tasks', action: 'upsert', agentId: 'worker' })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'tasks', action: 'complete', agentId: 'worker', id: 'missing' })).error.code, 'UNKNOWN_TASK');
  await f.restart();
  assert.equal((await f.rpc({ op: 'tasks', action: 'list', agentId: 'worker' })).tasks[0].state, 'complete');
});
