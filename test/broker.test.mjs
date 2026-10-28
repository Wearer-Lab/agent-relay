import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createBroker, validateStore, verifyAttachmentReferences, offlineRestore, MAX_STORE, MAX_AGENTS_PER_PROJECT, MAX_RETAINED_AGENTS, MAX_PROCESSES, MAX_ROOMS, noticeAllowance } from '../lib/broker.mjs';
const runNode = promisify(execFile);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-http-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  const other = path.join(root, 'other');
  await Promise.all([dataDir, project, other].map(dir => fs.mkdir(dir)));
  let broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
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
  assert.equal(refused.error.recovery, 'export the ledger, then start a new data directory and re-register; pending work must be handed over explicitly');
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
  assert.equal((await f.request({ op: 'respondHandoff', agentId: 'c', id: asked.handoff.id, accept: true })).error.code, 'HANDOFF_STALE');
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
  assert.equal(outbox.done, true);
  assert.deepEqual(Object.keys(outbox.messages[0]).sort(), ['body', 'counts', 'cursor', 'followups', 'from', 'id', 'pending', 'pendingTotal', 'recipients', 'recipientsTotal', 'summary', 'to', 'ts']);
  assert.equal(outbox.messages[0].summary, 'ladder');
  assert.equal(outbox.messages[0].cursor, sent.cursor);
  assert.deepEqual(outbox.messages[0].recipients, [{ agentId: 'b', stored: true, notified: [], accepted: [], missing: [], acked: false, delivered: false, handled: false, session: 'unbound', state: 'stored', cursor: sent.cursor }]);
  assert.deepEqual(outbox.messages[0].counts, { recipients: 1, acked: 0, accepted: 0, notified: 0, pending: 1, missing: 0, delivered: 0, handled: 0 });
  const receipt = await f.rpc({ op: 'receipt', messageId: 'ladder' });
  assert.deepEqual(receipt.pending, [{ agentId: 'b', reason: 'no-transport-markers', ts: outbox.messages[0].ts }]);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  await f.rpc({ op: 'notified', agentId: 'b', messageId: 'ladder', adapter: 'codex-attempted' });
  let current = await f.rpc({ op: 'receipt', messageId: 'ladder' });
  assert.equal(current.recipients[0].state, 'attempted');
  assert.deepEqual(current.recipients[0].notified.map(n => n.adapter), ['codex-attempted']);
  assert.deepEqual(current.recipients[0].accepted, []);
  assert.deepEqual(current.recipients[0].missing, []);
  assert.deepEqual(current.counts, { recipients: 1, acked: 0, accepted: 0, notified: 1, pending: 0, missing: 0, delivered: 0, handled: 0 });
  await f.rpc({ op: 'notified', agentId: 'b', messageId: 'ladder', adapter: 'opencode-toast' });
  assert.equal((await f.rpc({ op: 'receipt', messageId: 'ladder' })).recipients[0].state, 'notified');
  await f.rpc({ op: 'notified', agentId: 'b', messageId: 'ladder', adapter: 'codex-accepted' });
  current = await f.rpc({ op: 'receipt', messageId: 'ladder' });
  assert.equal(current.recipients[0].state, 'accepted');
  assert.deepEqual(current.recipients[0].accepted.map(n => n.adapter), ['codex-accepted']);
  assert.deepEqual(current.recipients[0].notified.map(n => n.adapter), ['codex-attempted', 'opencode-toast']);
  assert.deepEqual(current.counts, { recipients: 1, acked: 0, accepted: 1, notified: 0, pending: 0, missing: 0, delivered: 0, handled: 0 });
  await f.rpc({ op: 'ack', agentId: 'b', messageId: 'ladder' });
  current = await f.rpc({ op: 'receipt', messageId: 'ladder' });
  assert.deepEqual(Object.keys(current.recipients[0]).sort(), ['accepted', 'ackTs', 'acked', 'agentId', 'cursor', 'delivered', 'handled', 'missing', 'notified', 'session', 'state', 'stored']);
  assert.equal(current.recipients[0].state, 'acked');
  assert.equal(current.recipients[0].acked, true);
  assert.equal(current.recipients[0].handled, true);
  assert.equal(current.recipients[0].delivered, false);
  assert.equal(current.recipients[0].session, 'unbound');
  assert.equal(typeof current.recipients[0].ackTs, 'string');
  assert.deepEqual(current.counts, { recipients: 1, acked: 1, accepted: 0, notified: 0, pending: 0, missing: 0, delivered: 0, handled: 1 });
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
  assert.deepEqual(fan.counts, { recipients: 2, acked: 0, accepted: 1, notified: 1, pending: 0, missing: 0, delivered: 0, handled: 0 });
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
  assert.deepEqual(fan.counts, { recipients: 2, acked: 0, accepted: 0, notified: 1, pending: 1, missing: 0, delivered: 0, handled: 0 });
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
  const acked = await f.rpc({ op: 'ackBulletin', agentId: 'b', version: 1 });
  assert.deepEqual(fields(acked), ['acks', 'current', 'duplicate', 'stale', 'version']);
  assert.deepEqual(acked.acks, ['b']);
  assert.equal(acked.duplicate, false);
  assert.equal(acked.version, 1);
  assert.equal(acked.current, 1);
  assert.equal(acked.stale, false);
  assert.equal((await f.rpc({ op: 'ackBulletin', agentId: 'b', version: 1 })).duplicate, true);
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
  await f.rpc({ op: 'ackBulletin', agentId: 'a', version: 1 });
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
  assert.equal(usage.rooms.count, 1); assert.equal(usage.rooms.limit, MAX_ROOMS);
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
  assert.equal(usage.notices.used, 1200); assert.equal(usage.notices.largest.allowance, 3600);
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
test('restore removing a waited room finishes the waiter and keeps later mutations working', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  const waiting = f.rpc({ op: 'wait', agentId: 'b', after: 0, timeoutMs: 5000 });
  await f.rpc({ op: 'agents' });
  const restored = await f.rpc({ op: 'restore', state: { version: 1, nextCursor: 1, rooms: [] } });
  assert.equal(restored.restored, true);
  assert.deepEqual(restored.missingAttachments, []);
  assert.deepEqual(restored.corruptAttachments, []);
  assert.equal(restored.rooms, 0);
  assert.equal(restored.messages, 0);
  const waited = await waiting;
  assert.deepEqual(waited.messages, []);
  await f.register('a'); await f.register('b');
  const sent = await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'after restore', messageId: 'after' });
  assert.equal(sent.duplicate, false);
  assert.equal((await f.rpc({ op: 'inbox', agentId: 'b' })).messages.length, 1);
  await f.broker.close();
  await f.restart();
  assert.equal((await f.rpc({ op: 'inbox', agentId: 'b' })).messages.length, 1);
});
test('restore removing a waited agent finishes the waiter and keeps later mutations working', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  const real = await fs.realpath(f.project);
  const waiting = f.rpc({ op: 'wait', agentId: 'b', after: 0, timeoutMs: 5000 });
  await f.rpc({ op: 'agents' });
  const exported = await f.rpc({ op: 'export' });
  const incoming = structuredClone(exported.state);
  const room = incoming.rooms.find(r => r.project === real);
  room.agents = room.agents.filter(a => a.agentId === 'a');
  const restored = await f.rpc({ op: 'restore', state: incoming });
  assert.equal(restored.restored, true);
  assert.deepEqual(restored.missingAttachments, []);
  assert.deepEqual(restored.corruptAttachments, []);
  const waited = await waiting;
  assert.deepEqual(waited.messages, []);
  await f.rpc({ op: 'status', agentId: 'a', status: 'busy' });
  await f.register('b');
  const sent = await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'after agent restore', messageId: 'after-agent' });
  assert.equal(sent.duplicate, false);
  assert.equal((await f.rpc({ op: 'inbox', agentId: 'b' })).messages.length, 1);
  await f.broker.close();
});
test('restore detects corrupt attachment bytes and requires explicit incomplete choice', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  const source = path.join(f.root, 'original');
  await fs.writeFile(source, 'original content bytes');
  await f.rpc({ op: 'send', agentId: 'a', from: 'a', to: 'b', body: 'with attachment', messageId: 'attached', attachments: [source] });
  const exported = await f.rpc({ op: 'export' });
  const clean = await f.rpc({ op: 'restore', state: exported.state, dryRun: true });
  assert.equal(clean.valid, true);
  assert.deepEqual(clean.missingAttachments, []);
  assert.deepEqual(clean.corruptAttachments, []);
  const meta = (await f.rpc({ op: 'inbox', agentId: 'b' })).messages[0].attachments[0];
  const stored = path.join(f.dataDir, 'attachments', meta.sha256);
  const original = await fs.readFile(stored);
  assert.equal(original.length, meta.size);
  const corrupt = Buffer.from(original);
  corrupt[0] ^= 1;
  await fs.writeFile(stored, corrupt);
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  const dry = await f.rpc({ op: 'restore', state: exported.state, dryRun: true });
  assert.equal(dry.valid, false);
  assert.deepEqual(dry.missingAttachments, []);
  assert.equal(dry.corruptAttachments.length, 1);
  assert.equal(dry.corruptAttachments[0].sha256, meta.sha256);
  assert.equal(dry.corruptAttachments[0].reason, 'hash-mismatch');
  assert.deepEqual(dry.corruptAttachments[0].messages, ['attached']);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  const refused = await f.request({ op: 'restore', state: exported.state });
  assert.equal(refused.error.code, 'INCOMPLETE_ATTACHMENTS');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  const allowed = await f.rpc({ op: 'restore', state: exported.state, allowIncomplete: true });
  assert.equal(allowed.restored, true);
  assert.deepEqual(allowed.missingAttachments, []);
  assert.equal(allowed.corruptAttachments.length, 1);
  assert.equal(allowed.corruptAttachments[0].reason, 'hash-mismatch');
  assert.deepEqual(allowed.corruptAttachments[0].messages, ['attached']);
});
test('restore reports missing attachments separately and refuses without explicit choice', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  const source = path.join(f.root, 'packet');
  await fs.writeFile(source, 'packet bytes');
  await f.rpc({ op: 'send', agentId: 'a', from: 'a', to: 'b', body: 'with file', messageId: 'missing-one', attachments: [source] });
  const exported = await f.rpc({ op: 'export' });
  const sha = (await f.rpc({ op: 'inbox', agentId: 'b' })).messages[0].attachments[0].sha256;
  await fs.unlink(path.join(f.dataDir, 'attachments', sha));
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  const dry = await f.rpc({ op: 'restore', state: exported.state, dryRun: true });
  assert.equal(dry.valid, false);
  assert.equal(dry.missingAttachments.length, 1);
  assert.equal(dry.missingAttachments[0].sha256, sha);
  assert.deepEqual(dry.missingAttachments[0].messages, ['missing-one']);
  assert.deepEqual(dry.corruptAttachments, []);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  const refused = await f.request({ op: 'restore', state: exported.state });
  assert.equal(refused.error.code, 'INCOMPLETE_ATTACHMENTS');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  const allowed = await f.rpc({ op: 'restore', state: exported.state, allowIncomplete: true });
  assert.equal(allowed.restored, true);
  assert.equal(allowed.missingAttachments.length, 1);
  assert.equal(allowed.missingAttachments[0].sha256, sha);
  assert.deepEqual(allowed.corruptAttachments, []);
});
test('restore attributes shared attachment hashes to every referencing message', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  const source = path.join(f.root, 'shared');
  await fs.writeFile(source, 'shared bytes for two messages');
  await f.rpc({ op: 'send', agentId: 'a', from: 'a', to: 'b', body: 'first', messageId: 'dup-one', attachments: [source] });
  await f.rpc({ op: 'send', agentId: 'a', from: 'a', to: 'b', body: 'second', messageId: 'dup-two', attachments: [source] });
  const exported = await f.rpc({ op: 'export' });
  const rows = (await f.rpc({ op: 'inbox', agentId: 'b' })).messages;
  assert.equal(rows[0].attachments[0].sha256, rows[1].attachments[0].sha256);
  const sha = rows[0].attachments[0].sha256;
  await fs.unlink(path.join(f.dataDir, 'attachments', sha));
  const dry = await f.rpc({ op: 'restore', state: exported.state, dryRun: true });
  assert.equal(dry.valid, false);
  assert.equal(dry.missingAttachments.length, 1);
  assert.equal(dry.missingAttachments[0].sha256, sha);
  assert.deepEqual(dry.missingAttachments[0].messages.sort(), ['dup-one', 'dup-two']);
  const refused = await f.request({ op: 'restore', state: exported.state });
  assert.equal(refused.error.code, 'INCOMPLETE_ATTACHMENTS');
  const allowed = await f.rpc({ op: 'restore', state: exported.state, allowIncomplete: true });
  assert.equal(allowed.restored, true);
  assert.deepEqual(allowed.missingAttachments[0].messages.sort(), ['dup-one', 'dup-two']);
  const verified = await verifyAttachmentReferences(f.dataDir, exported.state);
  assert.equal(verified.missing.length, 1);
  assert.deepEqual(verified.missing[0].messages.sort(), ['dup-one', 'dup-two']);
});
test('restore distinguishes size mismatches and unreadable attachment files', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  const source = path.join(f.root, 'sized');
  await fs.writeFile(source, 'exact size content');
  await f.rpc({ op: 'send', agentId: 'a', from: 'a', to: 'b', body: 'sized', messageId: 'sized-one', attachments: [source] });
  const exported = await f.rpc({ op: 'export' });
  const meta = (await f.rpc({ op: 'inbox', agentId: 'b' })).messages[0].attachments[0];
  const stored = path.join(f.dataDir, 'attachments', meta.sha256);
  await fs.writeFile(stored, 'short');
  const drySize = await f.rpc({ op: 'restore', state: exported.state, dryRun: true });
  assert.equal(drySize.valid, false);
  assert.deepEqual(drySize.missingAttachments, []);
  assert.equal(drySize.corruptAttachments.length, 1);
  assert.equal(drySize.corruptAttachments[0].reason, 'size-mismatch');
  assert.deepEqual(drySize.corruptAttachments[0].messages, ['sized-one']);
  assert.equal((await f.request({ op: 'restore', state: exported.state })).error.code, 'INCOMPLETE_ATTACHMENTS');
  await fs.rm(stored);
  await fs.mkdir(stored);
  const verified = await verifyAttachmentReferences(f.dataDir, exported.state);
  assert.equal(verified.missing.length, 0);
  assert.equal(verified.corrupt.length, 1);
  assert.equal(verified.corrupt[0].reason, 'unreadable');
  assert.deepEqual(verified.corrupt[0].messages, ['sized-one']);
  const dryUnreadable = await f.rpc({ op: 'restore', state: exported.state, dryRun: true });
  assert.equal(dryUnreadable.valid, false);
  assert.equal(dryUnreadable.corruptAttachments[0].reason, 'unreadable');
  assert.equal((await f.request({ op: 'restore', state: exported.state, allowIncomplete: 'yes' })).error.code, 'INVALID_INPUT');
});
test('outbox pages carry durable cursors with honest continuation', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  const one = await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'one', messageId: 'one' });
  const two = await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'two', messageId: 'two' });
  const three = await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'three', messageId: 'three' });
  const first = await f.rpc({ op: 'outbox', from: 'a', limit: 1 });
  assert.deepEqual(first.messages.map(m => m.id), ['one']);
  assert.equal(first.messages[0].cursor, one.cursor);
  assert.equal(first.messages[0].recipients[0].cursor, one.cursor);
  assert.equal(first.nextCursor, one.cursor);
  assert.equal(first.done, false);
  const second = await f.rpc({ op: 'outbox', from: 'a', since: first.nextCursor, limit: 1 });
  assert.deepEqual(second.messages.map(m => m.id), ['two']);
  assert.equal(second.messages[0].cursor, two.cursor);
  assert.equal(second.messages[0].recipients[0].cursor, two.cursor);
  assert.equal(second.nextCursor, two.cursor);
  assert.equal(second.done, false);
  const third = await f.rpc({ op: 'outbox', from: 'a', since: second.nextCursor, limit: 1 });
  assert.deepEqual(third.messages.map(m => m.id), ['three']);
  assert.equal(third.messages[0].cursor, three.cursor);
  assert.equal(third.messages[0].recipients[0].cursor, three.cursor);
  assert.equal(third.nextCursor, three.cursor);
  assert.equal(third.done, true);
  const empty = await f.rpc({ op: 'outbox', from: 'a', since: third.nextCursor, limit: 1 });
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.nextCursor, three.cursor);
  assert.equal(empty.done, true);
  const full = await f.rpc({ op: 'outbox', from: 'a' });
  assert.deepEqual(full.messages.map(m => m.id), ['one', 'two', 'three']);
  assert.equal(full.nextCursor, three.cursor);
  assert.equal(full.done, true);
});
test('receipt pages recipients while keeping full delivery counts', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b'); await f.register('c'); await f.register('d');
  const sent = await f.rpc({ op: 'send', from: 'a', to: '*', body: 'fan', messageId: 'fan' });
  await f.rpc({ op: 'notified', agentId: 'b', messageId: 'fan', adapter: 'codex-accepted' });
  await f.rpc({ op: 'notified', agentId: 'c', messageId: 'fan', adapter: 'codex-attempted' });
  const full = await f.rpc({ op: 'receipt', messageId: 'fan' });
  assert.equal(full.recipients.length, 3);
  assert.equal(full.recipientsTotal, 3);
  assert.equal(full.recipientsLimit, 3);
  assert.equal(full.recipientsOffset, 0);
  assert.deepEqual(full.counts, { recipients: 3, acked: 0, accepted: 1, notified: 1, pending: 1, missing: 0, delivered: 0, handled: 0 });
  const first = await f.rpc({ op: 'receipt', messageId: 'fan', recipientsLimit: 1, recipientsOffset: 0 });
  assert.equal(first.recipients.length, 1);
  assert.equal(first.recipients[0].agentId, full.recipients[0].agentId);
  assert.equal(first.recipients[0].cursor, sent.cursor);
  assert.equal(first.recipientsTotal, 3);
  assert.equal(first.recipientsLimit, 1);
  assert.equal(first.recipientsOffset, 0);
  assert.deepEqual(first.counts, full.counts);
  const second = await f.rpc({ op: 'receipt', messageId: 'fan', recipientsLimit: 1, recipientsOffset: 1 });
  assert.equal(second.recipients[0].agentId, full.recipients[1].agentId);
  assert.equal(second.recipientsTotal, 3);
  assert.equal(second.recipientsLimit, 1);
  assert.equal(second.recipientsOffset, 1);
  assert.deepEqual(second.counts, full.counts);
  const rest = await f.rpc({ op: 'receipt', messageId: 'fan', recipientsOffset: 2 });
  assert.equal(rest.recipients.length, 1);
  assert.equal(rest.recipients[0].agentId, full.recipients[2].agentId);
  assert.deepEqual(rest.counts, full.counts);
  assert.equal((await f.request({ op: 'receipt', messageId: 'fan', recipientsLimit: 0 })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'receipt', messageId: 'fan', recipientsOffset: -1 })).error.code, 'INVALID_INPUT');
});
test('reconciled-missing advances a negative receipt ladder without certifying delivery', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'fragile', messageId: 'fragile' });
  let receipt = await f.rpc({ op: 'receipt', messageId: 'fragile' });
  assert.equal(receipt.recipients[0].state, 'stored');
  assert.deepEqual(receipt.counts, { recipients: 1, acked: 0, accepted: 0, notified: 0, pending: 1, missing: 0, delivered: 0, handled: 0 });
  await f.rpc({ op: 'notified', agentId: 'b', messageId: 'fragile', adapter: 'codex-attempted' });
  receipt = await f.rpc({ op: 'receipt', messageId: 'fragile' });
  assert.equal(receipt.recipients[0].state, 'attempted');
  await f.rpc({ op: 'notified', agentId: 'b', messageId: 'fragile', adapter: 'codex-reconciled-missing' });
  receipt = await f.rpc({ op: 'receipt', messageId: 'fragile' });
  assert.equal(receipt.recipients[0].state, 'missing');
  assert.deepEqual(receipt.recipients[0].missing.map(n => n.adapter), ['codex-reconciled-missing']);
  assert.deepEqual(receipt.counts, { recipients: 1, acked: 0, accepted: 0, notified: 0, pending: 0, missing: 1, delivered: 0, handled: 0 });
  assert.equal(receipt.pending.length, 1);
  assert.equal(receipt.pending[0].agentId, 'b');
  assert.equal(receipt.pending[0].reason, 'operator-confirmed-missing');
  assert.equal(receipt.pending[0].ts, receipt.recipients[0].missing[0].ts);
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'failed', messageId: 'failed' });
  await f.rpc({ op: 'notified', agentId: 'b', messageId: 'failed', adapter: 'codex-delivery-failed' });
  const negative = await f.rpc({ op: 'receipt', messageId: 'failed' });
  assert.equal(negative.recipients[0].state, 'missing');
  assert.equal(negative.pending[0].reason, 'negative-reconciliation');
  assert.equal(negative.pending[0].ts, negative.recipients[0].missing[0].ts);
  assert.deepEqual(negative.counts, { recipients: 1, acked: 0, accepted: 0, notified: 0, pending: 0, missing: 1, delivered: 0, handled: 0 });
  await f.rpc({ op: 'notified', agentId: 'b', messageId: 'fragile', adapter: 'codex-accepted' });
  receipt = await f.rpc({ op: 'receipt', messageId: 'fragile' });
  assert.equal(receipt.recipients[0].state, 'accepted');
  await f.rpc({ op: 'ack', agentId: 'b', messageId: 'fragile' });
  receipt = await f.rpc({ op: 'receipt', messageId: 'fragile' });
  assert.equal(receipt.recipients[0].state, 'acked');
});
test('agents paginates with limit and offset while reporting total', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b'); await f.register('c');
  const full = await f.rpc({ op: 'agents' });
  assert.equal(full.agents.length, 3);
  assert.equal(full.total, 3);
  const first = await f.rpc({ op: 'agents', limit: 1, offset: 0 });
  assert.equal(first.agents.length, 1);
  assert.equal(first.total, 3);
  assert.equal(first.agents[0].agentId, full.agents[0].agentId);
  const second = await f.rpc({ op: 'agents', limit: 1, offset: 1 });
  assert.equal(second.agents.length, 1);
  assert.equal(second.total, 3);
  assert.equal(second.agents[0].agentId, full.agents[1].agentId);
  const empty = await f.rpc({ op: 'agents', limit: 1, offset: 3 });
  assert.deepEqual(empty.agents, []);
  assert.equal(empty.total, 3);
  assert.equal((await f.request({ op: 'agents', limit: 0 })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'agents', offset: -1 })).error.code, 'INVALID_INPUT');
});
test('512-recipient broadcast records four OpenCode stages plus reconcile without NOTICE_LIMIT', async t => {
  const f = await fixture(t);
  const at = new Date().toISOString();
  const room = await fs.realpath(f.project);
  const mk = id => ({ agentId: id, runner: 'test', registeredAt: at, updatedAt: at, status: 'idle', frozen: false, resources: [], task: null });
  const recipients = Array.from({ length: 512 }, (_, i) => 'receiver-' + i);
  const agents = ['sender', ...recipients].map(mk);
  const stages = ['opencode-toast-attempted', 'opencode-toast', 'opencode-wake-attempted', 'opencode-context'];
  const notified = recipients.flatMap(id => stages.map(adapter => ({ agentId: id, adapter, at })));
  assert.equal(notified.length, 2048);
  assert.equal(noticeAllowance(512), 3072);
  assert.equal(noticeAllowance(1), 1024);
  await f.broker.close();
  await fs.writeFile(path.join(f.dataDir, 'state.json'), JSON.stringify({ version: 1, nextCursor: 2,
    rooms: [{ project: room, agents, claims: [], cursor: 1,
      messages: [{ messageId: 'fan512', from: 'sender', to: '*', body: 'fanout', createdAt: at, cursor: 1, recipients, ackedBy: [], notified }] }] }));
  await f.restart();
  validateStore(JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8')));
  for (const id of recipients) {
    const recorded = await f.rpc({ op: 'notified', agentId: id, messageId: 'fan512', adapter: 'opencode-reconciled' });
    assert.equal(recorded.duplicate, false);
  }
  const extra = await f.rpc({ op: 'notified', agentId: recipients[0], messageId: 'fan512', adapter: 'watch-accepted' });
  assert.equal(extra.duplicate, false);
  const receipt = await f.rpc({ op: 'receipt', messageId: 'fan512' });
  assert.equal(receipt.counts.recipients, 512);
  const usage = await f.rpc({ op: 'usage' });
  assert.equal(usage.notices.used, 2561);
  assert.equal(usage.notices.largest.markers, 2561);
  assert.equal(usage.notices.largest.allowance, 3072);
  assert.equal(usage.headroom.notices, 511);
  validateStore(JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8')));
});
test('usage separates per-room and global capacity honestly', async t => {
  const f = await fixture(t);
  const at = new Date().toISOString();
  const real1 = await fs.realpath(f.project);
  const real2 = await fs.realpath(f.other);
  const mkAgent = (id, left) => ({ agentId: id, runner: 'test', registeredAt: at, updatedAt: at, status: 'idle',
    frozen: false, resources: [], task: null, ...(left ? { left: true } : {}) });
  const room1Agents = [...Array.from({ length: 2500 }, (_, i) => mkAgent('r1-a-' + i, false)),
    ...Array.from({ length: 2000 }, (_, i) => mkAgent('r1-l-' + i, true))];
  const room2Agents = [...Array.from({ length: 2500 }, (_, i) => mkAgent('r2-a-' + i, false)),
    ...Array.from({ length: 2000 }, (_, i) => mkAgent('r2-l-' + i, true))];
  const room1Claims = Array.from({ length: 5 }, (_, i) => ({ agentId: 'r1-a-0', resource: path.join(real1, 'claim-' + i), claimedAt: at }));
  const room2Claims = Array.from({ length: 8 }, (_, i) => ({ agentId: 'r2-a-0', resource: path.join(real2, 'claim-' + i), claimedAt: at }));
  const room1Handoffs = Array.from({ length: 3 }, (_, i) => ({ id: 'r1-h-' + i, from: 'r1-a-0', to: 'r1-a-1',
    resources: ['r1-h-res-' + i], reason: 'need', state: 'pending', requestedAt: at }));
  const room2Handoffs = Array.from({ length: 7 }, (_, i) => ({ id: 'r2-h-' + i, from: 'r2-a-0', to: 'r2-a-1',
    resources: ['r2-h-res-' + i], reason: 'need', state: 'pending', requestedAt: at }));
  const room1Processes = Array.from({ length: 2 }, (_, i) => ({ id: 'r1-p-' + i, agentId: 'r1-a-0', pid: 40000 + i, startedAt: at, lastVerifiedAt: at }));
  const room2Processes = Array.from({ length: 5 }, (_, i) => ({ id: 'r2-p-' + i, agentId: 'r2-a-0', pid: 50000 + i, startedAt: at, lastVerifiedAt: at }));
  const room1Tasks = Array.from({ length: 4 }, (_, i) => ({ id: 'r1-t-' + i, creator: 'r1-a-0', title: 'task ' + i, state: 'open', createdAt: at, updatedAt: at }));
  const room2Tasks = Array.from({ length: 9 }, (_, i) => ({ id: 'r2-t-' + i, creator: 'r2-a-0', title: 'task ' + i, state: 'open', createdAt: at, updatedAt: at }));
  const fanRecipients = Array.from({ length: 512 }, (_, i) => 'r1-a-' + (i + 1));
  const fanNotified = Array.from({ length: 2000 }, (_, i) => ({ agentId: fanRecipients[i % fanRecipients.length], adapter: 'opencode-toast', at }));
  const digest = createHash('sha256').update(JSON.stringify({ title: 'Policy', body: 'Body', source: 'AGENT.md' })).digest('hex');
  await f.broker.close();
  await fs.writeFile(path.join(f.dataDir, 'state.json'), JSON.stringify({ version: 1, nextCursor: 4,
    machineClaims: [{ agentId: 'r1-a-0', project: real1, resource: 'machine-res-1', claimedAt: at },
      { agentId: 'r2-a-0', project: real2, resource: 'machine-res-2', claimedAt: at }],
    releaseLog: [{ as: 'tester', at, project: real1, released: ['x'] }],
    rooms: [{ project: real1, agents: room1Agents, claims: room1Claims, handoffs: room1Handoffs, processes: room1Processes,
      tasks: room1Tasks, cursor: 2,
      bulletin: { versions: [{ version: 1, title: 'Policy', body: 'Body', source: 'AGENT.md', hash: digest, ts: at, acks: [] }] },
      messages: [{ messageId: 'm1', from: 'r1-a-0', to: 'r1-a-1', body: 'hello', createdAt: at, cursor: 1,
        recipients: ['r1-a-1'], ackedBy: [], notified: [],
        followups: [{ id: 'f1', agentId: 'r1-a-0', at }, { id: 'f2', agentId: 'r1-a-1', at }] },
        { messageId: 'fan512', from: 'r1-a-0', to: '*', body: 'fanout', createdAt: at, cursor: 2,
          recipients: fanRecipients, ackedBy: [], notified: fanNotified }] },
      { project: real2, agents: room2Agents, claims: room2Claims, handoffs: room2Handoffs, processes: room2Processes,
        tasks: room2Tasks, cursor: 3,
        messages: [{ messageId: 'm2', from: 'r2-a-0', to: 'r2-a-1', body: 'hi', createdAt: at, cursor: 3,
          recipients: ['r2-a-1'], ackedBy: [], notified: [] }] }] }));
  await f.restart();
  const usage = await f.rpc({ op: 'usage' });
  assert.equal(usage.rooms.count, 2);
  assert.equal(usage.rooms.limit, MAX_ROOMS);
  assert.equal(usage.rooms.detail.length, 2);
  const first = usage.rooms.detail.find(r => r.project === real1);
  const second = usage.rooms.detail.find(r => r.project === real2);
  assert.deepEqual(first.agents, { stored: 4500, left: 2000, active: 2500 });
  assert.deepEqual(second.agents, { stored: 4500, left: 2000, active: 2500 });
  assert.equal(first.claims, 5); assert.equal(second.claims, 8);
  assert.equal(first.handoffs, 3); assert.equal(second.handoffs, 7);
  assert.equal(first.processes, 2); assert.equal(second.processes, 5);
  assert.equal(first.messages, 2); assert.equal(second.messages, 1);
  assert.equal(first.tasks, 4); assert.equal(second.tasks, 9);
  assert.equal(usage.agents.stored, 9000); assert.equal(usage.agents.left, 4000); assert.equal(usage.agents.active, 5000);
  assert.equal(usage.claims.project, 13); assert.equal(usage.claims.machine, 2); assert.equal(usage.claims.used, 15);
  assert.equal(usage.headroom.agentsRetained, 3692);
  assert.equal(usage.headroom.agentsActive, 1596);
  assert.equal(usage.headroom.claims, 4088);
  assert.equal(usage.headroom.machineClaims, 4094);
  assert.equal(usage.headroom.handoffs, 1017);
  assert.equal(usage.headroom.processes, 251);
  assert.equal(usage.headroom.tasks, 4087);
  assert.ok(usage.headroom.agentsRetained > 0 && usage.headroom.agentsActive > 0 && usage.headroom.claims > 0);
  assert.equal(usage.notices.largest.allowance, 3072);
  assert.equal(usage.notices.largest.markers, 2000);
  assert.equal(usage.headroom.notices, 1072);
  assert.deepEqual(usage.tasks, { used: 13, limit: 4096 });
  assert.deepEqual(usage.followups, { used: 2, perMessageLimit: 32 });
  assert.deepEqual(usage.releaseLog, { used: 1, limit: 10000 });
  assert.deepEqual(usage.bulletins, { rooms: 1, versionsLimit: 16 });
  assert.equal(usage.nearLimit.includes('agents-retained'), false);
  assert.equal(usage.nearLimit.includes('agents-active'), false);
  assert.equal(usage.nearLimit.includes('claims'), false);
  assert.equal(usage.nearLimit.includes('handoffs'), false);
  assert.equal(usage.nearLimit.includes('processes'), false);
  assert.equal(usage.nearLimit.includes('tasks'), false);
  assert.deepEqual(usage.nearLimit, []);
});
test('capabilities exposes runtime package protocol and schema', async t => {
  const f = await fixture(t);
  await f.register('a');
  const caps = await f.rpc({ op: 'capabilities' });
  assert.ok(Array.isArray(caps.features));
  assert.equal(caps.runtime.protocol, 1);
  assert.equal(caps.runtime.schema, 1);
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(caps.runtime.package, pkg.version);
});
test('task listing preserves machine-claim blockers across upsert list and complete', async t => {
  const f = await fixture(t);
  await f.register('holder'); await f.register('worker');
  await f.rpc({ op: 'claim', agentId: 'holder', scope: 'machine', resources: ['build'] });
  const created = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'worker', title: 'Machine work',
    owner: 'worker', blockedBy: ['build'] });
  assert.equal(created.task.blocked, true);
  assert.deepEqual(created.task.blocking, [{ ref: 'build', kind: 'claim', scope: 'machine', holder: 'holder', state: 'held' }]);
  const listed = await f.rpc({ op: 'tasks', action: 'list' });
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.tasks[0].blocked, true);
  assert.deepEqual(listed.tasks[0].blocking, created.task.blocking);
  const filtered = await f.rpc({ op: 'tasks', action: 'list', state: 'open' });
  assert.equal(filtered.tasks.length, 1);
  assert.equal(filtered.tasks[0].blocked, true);
  assert.deepEqual(filtered.tasks[0].blocking, created.task.blocking);
  const onlyBlocked = await f.rpc({ op: 'tasks', action: 'list', blocked: true });
  assert.equal(onlyBlocked.tasks.length, 1);
  assert.deepEqual((await f.rpc({ op: 'tasks', action: 'list', blocked: false })).tasks, []);
  const done = await f.rpc({ op: 'tasks', action: 'complete', agentId: 'worker', id: created.task.id });
  assert.equal(done.task.state, 'complete');
  assert.equal(done.task.blocked, true);
  assert.deepEqual(done.task.blocking, created.task.blocking);
  const completed = await f.rpc({ op: 'tasks', action: 'list', state: 'complete' });
  assert.equal(completed.tasks.length, 1);
  assert.equal(completed.tasks[0].blocked, true);
  assert.deepEqual(completed.tasks[0].blocking, created.task.blocking);
});
test('task blockers follow parent child claim conflicts while named resources stay separate', async t => {
  const f = await fixture(t);
  const real = await fs.realpath(f.project);
  await f.register('a'); await f.register('b');
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['src'] });
  const child = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'b', title: 'Child work', blockedBy: ['src/file.mjs'] });
  assert.equal(child.task.blocked, true);
  assert.deepEqual(child.task.blocking, [{ ref: 'src/file.mjs', kind: 'claim', scope: 'project', holder: 'a', state: 'held' }]);
  const listed = await f.rpc({ op: 'tasks', action: 'list', blocked: true });
  assert.ok(listed.tasks.some(row => row.id === child.task.id && row.blocked === true));
  assert.equal((await f.request({ op: 'claim', agentId: 'b', resources: ['src/file.mjs'] })).error.code, 'CLAIM_CONFLICT');
  const deep = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'b', title: 'Deep work',
    blockedBy: ['src/nonexistent/deep/file.txt'] });
  assert.equal(deep.task.blocked, true);
  assert.equal(deep.task.blocking[0].holder, 'a');
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['build'] });
  const named = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'b', title: 'Named work', blockedBy: ['build'] });
  assert.equal(named.task.blocked, true);
  assert.deepEqual(named.task.blocking, [{ ref: 'build', kind: 'claim', scope: 'project', holder: 'a', state: 'held' }]);
  const separate = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'b', title: 'Separate work', blockedBy: ['build/file'] });
  assert.equal(separate.task.blocked, false);
  assert.deepEqual(separate.task.blocking, [{ ref: 'build/file', kind: 'unknown', holder: null, state: null }]);
  const pathRef = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'b', title: 'Path ref',
    blockedBy: [path.join(real, 'src', 'other.mjs')] });
  assert.equal(pathRef.task.blocked, true);
  assert.equal(pathRef.task.blocking[0].holder, 'a');
});
test('stale handoff acceptance never reverses direction across offer and request forms', async t => {
  const f = await fixture(t);
  const real = await fs.realpath(f.project);
  await f.register('a'); await f.register('b'); await f.register('c');
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['x'] });
  const offer = await f.rpc({ op: 'requestHandoff', agentId: 'a', to: 'b', resources: ['x'], reason: 'offer x' });
  assert.equal(offer.handoff.offeredBy, 'a');
  assert.equal(offer.handoff.offeredTo, 'b');
  await f.rpc({ op: 'release', agentId: 'a', resources: ['x'] });
  await f.rpc({ op: 'claim', agentId: 'b', resources: ['x'] });
  const stale = await f.request({ op: 'respondHandoff', agentId: 'b', id: offer.handoff.id, accept: true });
  assert.equal(stale.error.code, 'HANDOFF_STALE');
  assert.equal(stale.status, 409);
  assert.equal((await f.rpc({ op: 'agents' })).claims.find(c => c.resource === path.join(real, 'x')).agentId, 'b');
  assert.equal((await f.rpc({ op: 'handoffs' })).handoffs.find(h => h.id === offer.handoff.id).state, 'pending');
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['y'] });
  const requested = await f.rpc({ op: 'requestHandoff', agentId: 'b', to: 'a', resources: ['y'], reason: 'need y' });
  assert.equal(requested.handoff.offeredBy, 'a');
  assert.equal(requested.handoff.offeredTo, 'a');
  await f.rpc({ op: 'release', agentId: 'a', resources: ['y'] });
  await f.rpc({ op: 'claim', agentId: 'b', resources: ['y'] });
  const staleRequest = await f.request({ op: 'respondHandoff', agentId: 'a', id: requested.handoff.id, accept: true });
  assert.equal(staleRequest.error.code, 'HANDOFF_STALE');
  assert.equal((await f.rpc({ op: 'agents' })).claims.find(c => c.resource === path.join(real, 'y')).agentId, 'b');
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['z'] });
  const first = await f.rpc({ op: 'requestHandoff', agentId: 'a', to: 'b', resources: ['z'], reason: 'to b' });
  const second = await f.rpc({ op: 'requestHandoff', agentId: 'a', to: 'c', resources: ['z'], reason: 'to c' });
  const moved = await f.rpc({ op: 'respondHandoff', agentId: 'c', id: second.handoff.id, accept: true });
  assert.equal(moved.handoff.state, 'accepted');
  const intervened = await f.request({ op: 'respondHandoff', agentId: 'b', id: first.handoff.id, accept: true });
  assert.equal(intervened.error.code, 'HANDOFF_STALE');
  assert.equal((await f.rpc({ op: 'agents' })).claims.find(c => c.resource === path.join(real, 'z')).agentId, 'c');
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['w'] });
  const retiring = await f.rpc({ op: 'requestHandoff', agentId: 'a', to: 'b', resources: ['w'], reason: 'to b' });
  await f.rpc({ op: 'retire', agentId: 'a', relinquish: true });
  const retiredAccept = await f.request({ op: 'respondHandoff', agentId: 'b', id: retiring.handoff.id, accept: true });
  assert.equal(retiredAccept.error.code, 'HANDOFF_STALE');
  assert.equal((await f.rpc({ op: 'agents' })).claims.find(c => c.resource === path.join(real, 'w')).agentId, 'a');
  await f.rpc({ op: 'claim', agentId: 'b', resources: ['p', 'q'] });
  const both = await f.rpc({ op: 'requestHandoff', agentId: 'b', to: 'c', resources: ['p', 'q'], reason: 'both' });
  await f.rpc({ op: 'release', agentId: 'b', resources: ['p'] });
  await f.rpc({ op: 'claim', agentId: 'c', resources: ['p'] });
  const changedSubset = await f.request({ op: 'respondHandoff', agentId: 'c', id: both.handoff.id, accept: true, resources: ['p'] });
  assert.equal(changedSubset.error.code, 'HANDOFF_STALE');
  const keptSubset = await f.rpc({ op: 'respondHandoff', agentId: 'c', id: both.handoff.id, accept: true, resources: ['q'] });
  assert.equal(keptSubset.handoff.state, 'accepted');
  assert.deepEqual(keptSubset.handoff.transferred, [path.join(real, 'q')]);
});
test('bulletin acknowledgement binds to the retained version read', async t => {
  const f = await fixture(t);
  await f.register('a'); await f.register('b');
  const first = await f.rpc({ op: 'setBulletin', agentId: 'a', title: 'Policy', body: 'Be kind', source: 'ops' });
  assert.equal(first.version, 1);
  const read = await f.rpc({ op: 'getBulletin' });
  assert.equal(read.version, 1);
  const second = await f.rpc({ op: 'setBulletin', agentId: 'a', title: 'Policy v2', body: 'Be kinder', source: 'ops' });
  assert.equal(second.version, 2);
  assert.equal((await f.request({ op: 'ackBulletin', agentId: 'b' })).error.code, 'INVALID_INPUT');
  const acked = await f.rpc({ op: 'ackBulletin', agentId: 'b', version: 1 });
  assert.equal(acked.version, 1);
  assert.equal(acked.current, 2);
  assert.equal(acked.stale, true);
  assert.deepEqual(acked.acks, ['b']);
  assert.equal(acked.duplicate, false);
  assert.deepEqual((await f.rpc({ op: 'getBulletin', version: 1 })).acks, ['b']);
  assert.deepEqual((await f.rpc({ op: 'getBulletin' })).acks, []);
  const wrongHash = await f.request({ op: 'ackBulletin', agentId: 'a', version: 1, hash: '0'.repeat(64) });
  assert.equal(wrongHash.error.code, 'BULLETIN_MISMATCH');
  assert.equal(wrongHash.status, 409);
  assert.equal(wrongHash.error.current, 2);
  assert.equal(wrongHash.error.requested.version, 1);
  const withHash = await f.rpc({ op: 'ackBulletin', agentId: 'a', version: 2, hash: second.hash });
  assert.equal(withHash.version, 2);
  assert.equal(withHash.current, 2);
  assert.equal(withHash.stale, false);
  assert.ok(withHash.acks.includes('a'));
  assert.equal((await f.request({ op: 'ackBulletin', agentId: 'a', version: 7 })).error.code, 'UNKNOWN_BULLETIN');
  assert.equal((await f.request({ op: 'ackBulletin', agentId: 'a', version: 0 })).error.code, 'INVALID_INPUT');
  await f.restart();
  assert.deepEqual((await f.rpc({ op: 'getBulletin', version: 1 })).acks, ['b']);
  assert.ok((await f.rpc({ op: 'getBulletin' })).acks.includes('a'));
});
test('bulletin acknowledgements follow the retained identity bound without store errors', async t => {
  const f = await fixture(t);
  const at = new Date().toISOString();
  const room = await fs.realpath(f.project);
  const ackedCount = MAX_RETAINED_AGENTS - 1;
  const agents = Array.from({ length: ackedCount }, (_, i) => {
    const left = i % 3 === 0;
    const retired = !left && i % 3 === 1;
    return { agentId: 'reader-' + i, runner: 'test', registeredAt: at, updatedAt: at, status: 'idle',
      frozen: false, resources: [], task: null, ...(left ? { left: true } : {}), ...(retired ? { left: true, retired: true } : {}) };
  });
  const fresh = { agentId: 'fresh', runner: 'test', registeredAt: at, updatedAt: at, status: 'idle',
    frozen: false, resources: [], task: null };
  const acks = agents.map(a => ({ agentId: a.agentId, at }));
  const digest = (await import('node:crypto')).createHash('sha256')
    .update(JSON.stringify({ title: 'Policy', body: 'Body', source: 'AGENT.md' })).digest('hex');
  await f.broker.close();
  await fs.writeFile(path.join(f.dataDir, 'state.json'), JSON.stringify({ version: 1, nextCursor: 1,
    rooms: [{ project: room, agents: [...agents, fresh], messages: [], claims: [], cursor: 0,
      bulletin: { versions: [{ version: 1, title: 'Policy', body: 'Body', source: 'AGENT.md', hash: digest, ts: at, acks }] } }] }));
  await f.restart();
  const before = await f.rpc({ op: 'getBulletin' });
  assert.equal(before.acks.length, ackedCount);
  const admitted = await f.rpc({ op: 'ackBulletin', agentId: 'fresh', version: 1 });
  assert.equal(admitted.version, 1);
  assert.equal(admitted.current, 1);
  assert.equal(admitted.stale, false);
  assert.equal(admitted.acks.length, MAX_RETAINED_AGENTS);
  assert.equal(admitted.duplicate, false);
  await f.restart();
  assert.equal((await f.rpc({ op: 'getBulletin' })).acks.length, MAX_RETAINED_AGENTS);
  const over = { version: 1, nextCursor: 1,
    rooms: [{ project: room, agents: [...agents, fresh], messages: [], claims: [], cursor: 0,
      bulletin: { versions: [{ version: 1, title: 'Policy', body: 'Body', source: 'AGENT.md', hash: digest, ts: at,
        acks: [...acks, { agentId: 'fresh', at }] }] } }] };
  assert.doesNotThrow(() => validateStore(structuredClone(over)));
  const tooMany = structuredClone(over);
  tooMany.rooms[0].agents.push({ agentId: 'extra', runner: 'test', registeredAt: at, updatedAt: at, status: 'idle',
    frozen: false, resources: [], task: null, left: true });
  tooMany.rooms[0].bulletin.versions[0].acks.push({ agentId: 'extra', at });
  assert.throws(() => validateStore(tooMany), /corrupt or unsupported/);
});
test('retirement refuses obligations and relinquish keeps claims held with recovery', async t => {
  const f = await fixture(t);
  const real = await fs.realpath(f.project);
  await f.register('a'); await f.register('b'); await f.register('c');
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['doc.txt'] });
  await f.rpc({ op: 'claim', agentId: 'a', scope: 'machine', resources: ['build'] });
  const handoff = await f.rpc({ op: 'requestHandoff', agentId: 'a', to: 'b', resources: ['doc.txt'], reason: 'take it' });
  await f.rpc({ op: 'processes', action: 'register', agentId: 'a', pid: 61001, command: 'watcher' });
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  const refused = await f.request({ op: 'retire', agentId: 'a' });
  assert.equal(refused.error.code, 'RETIRE_BLOCKED');
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.error.claims, [path.join(real, 'doc.txt')]);
  assert.deepEqual(refused.error.machineClaims, ['build']);
  assert.deepEqual(refused.error.handoffs, [handoff.handoff.id]);
  assert.deepEqual(refused.error.processes.length, 1);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  assert.equal((await f.rpc({ op: 'agents' })).claims.find(c => c.resource === path.join(real, 'doc.txt')).agentId, 'a');
  const receipt = await f.rpc({ op: 'retire', agentId: 'a', relinquish: true });
  assert.equal(receipt.retired, 'a');
  assert.deepEqual(receipt.stranded.claims, [path.join(real, 'doc.txt')]);
  assert.deepEqual(receipt.stranded.machineClaims, ['build']);
  assert.deepEqual(receipt.stranded.handoffs, [handoff.handoff.id]);
  assert.equal(receipt.stranded.processes.length, 1);
  assert.match(receipt.recovery, /forced release/);
  const claims = (await f.rpc({ op: 'agents' })).claims;
  assert.ok(claims.some(c => c.resource === path.join(real, 'doc.txt') && c.agentId === 'a'));
  assert.equal((await f.request({ op: 'register', agentId: 'a', runner: 'test' })).error.code, 'RETIRED');
  assert.equal((await f.request({ op: 'claim', agentId: 'a', resources: ['other'] })).error.code, 'UNKNOWN_AGENT');
  assert.equal((await f.request({ op: 'retire', agentId: 'c' })).ok, true);
  assert.equal((await f.request({ op: 'retire', agentId: 'c', relinquish: 'yes' })).error.code, 'INVALID_INPUT');
});
test('test-marked registrations are durably retained and filterable', async t => {
  const f = await fixture(t);
  await f.register('real');
  await f.rpc({ op: 'register', agentId: 'smoke', runner: 'test', sessionId: 'smoke-session', test: true });
  const agents = (await f.rpc({ op: 'agents' })).agents;
  assert.equal(agents.find(a => a.agentId === 'smoke').test, true);
  assert.equal(agents.find(a => a.agentId === 'real').test, undefined);
  assert.deepEqual((await f.rpc({ op: 'agents', test: true })).agents.map(a => a.agentId), ['smoke']);
  assert.deepEqual((await f.rpc({ op: 'agents', test: false })).agents.map(a => a.agentId), ['real']);
  assert.equal((await f.request({ op: 'register', agentId: 'bad', runner: 'test', test: 'yes' })).error.code, 'INVALID_INPUT');
  await f.restart();
  assert.deepEqual((await f.rpc({ op: 'agents', test: true })).agents.map(a => a.agentId), ['smoke']);
});
test('offline restore refuses live lease without using discovery', async t => {
  const f = await fixture(t);
  await f.register('a');
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  try {
    await fs.stat(path.join(f.dataDir, 'broker.json'));
    assert.fail('discovery should be absent');
  } catch (error) {
    assert.equal(error.code, 'ENOENT');
  }
  await assert.rejects(offlineRestore(f.dataDir, { version: 1, nextCursor: 1, rooms: [] }), /live broker|Another live/u);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  assert.deepEqual((await fs.readdir(f.dataDir)).filter(name => name.startsWith('state.backup-')), []);
  assert.deepEqual((await fs.readdir(f.dataDir)).filter(name => name.endsWith('.tmp')), []);
});
test('offline restore still refuses live lease when discovery is missing or corrupt', async t => {
  const f = await fixture(t);
  await f.register('a');
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  await fs.writeFile(path.join(f.dataDir, 'broker.json'), JSON.stringify({ pid: 1, url: 'http://127.0.0.1:1', token: 'bad' }));
  await assert.rejects(offlineRestore(f.dataDir, { version: 1, nextCursor: 1, rooms: [] }), /live broker|Another live/u);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  await fs.unlink(path.join(f.dataDir, 'broker.json'));
  await assert.rejects(offlineRestore(f.dataDir, { version: 1, nextCursor: 1, rooms: [] }), /live broker|Another live/u);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  assert.deepEqual((await fs.readdir(f.dataDir)).filter(name => name.startsWith('state.backup-')), []);
});
test('offline restore refuses ambiguous recovery sentinel and corrupt lock', async t => {
  const f = await fixture(t);
  await f.register('a');
  await f.broker.close();
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  const sentinel = path.join(f.dataDir, 'writer-recovery.lock');
  await fs.writeFile(sentinel, 'ambiguous recovery owner');
  await assert.rejects(offlineRestore(f.dataDir, { version: 1, nextCursor: 1, rooms: [] }), /recovery/u);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'ambiguous recovery owner');
  await fs.unlink(sentinel);
  const lock = path.join(f.dataDir, 'writer.lock');
  await fs.unlink(lock).catch(() => {});
  await fs.writeFile(lock, 'not-json');
  await assert.rejects(offlineRestore(f.dataDir, { version: 1, nextCursor: 1, rooms: [] }), /corrupt|ownership is unknown/u);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  assert.equal(await fs.readFile(lock, 'utf8'), 'not-json');
  await fs.unlink(lock);
  const unknown = '{"version":1,"pid":"unknown","nonce":"x"}';
  await fs.writeFile(lock, unknown);
  await assert.rejects(offlineRestore(f.dataDir, { version: 1, nextCursor: 1, rooms: [] }), /ownership is unknown|corrupt/u);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  assert.deepEqual((await fs.readdir(f.dataDir)).filter(name => name.startsWith('state.backup-')), []);
});
test('offline restore holds exclusive lease so concurrent startup fails', async t => {
  const f = await fixture(t);
  await f.register('a');
  await f.broker.close();
  const incoming = { version: 1, nextCursor: 1, rooms: [] };
  const delayFs = { ...fs, readFile: async (...args) => {
    if (String(args[0]).endsWith('state.json')) await new Promise(resolve => setTimeout(resolve, 200));
    return fs.readFile(...args);
  } };
  const pending = offlineRestore(f.dataDir, incoming, { fs: delayFs });
  await new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(createBroker({ dataDir: f.dataDir }), /live broker|Another live|already owns/u);
  const result = await pending;
  assert.equal(result.restored, true);
  assert.match(result.backup, /^state\.backup-\d+\.json$/u);
  await f.restart();
  assert.equal((await f.rpc({ op: 'agents' })).cursor, 0);
});
test('offline restore accepts state just below 64 MiB', async t => {
  const f = await fixture(t);
  await f.broker.close();
  const real = await fs.realpath(f.project);
  const ts = new Date().toISOString();
  const agent = id => ({ agentId: id, runner: 'test', registeredAt: ts, updatedAt: ts, status: 'idle', frozen: false, resources: [], task: null });
  const base = { version: 1, nextCursor: 1, rooms: [{ project: real, agents: [agent('a'), agent('b')], messages: [], claims: [], cursor: 0 }] };
  const baseBytes = Buffer.byteLength(JSON.stringify(base));
  const n = (MAX_STORE - 1) - baseBytes - 9;
  const incoming = { ...base, pad: 'x'.repeat(n) };
  assert.equal(Buffer.byteLength(JSON.stringify(incoming)), MAX_STORE - 1);
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  const result = await offlineRestore(f.dataDir, incoming);
  assert.equal(result.restored, true);
  assert.equal(result.bytes, MAX_STORE - 1);
  assert.equal(result.rooms, 1);
  assert.equal(result.messages, 0);
  assert.match(result.backup, /^state\.backup-\d+\.json$/u);
  assert.equal(Buffer.byteLength(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8')), MAX_STORE - 1);
  assert.equal(await fs.readFile(path.join(f.dataDir, result.backup), 'utf8'), before);
  if(process.platform!=='win32')assert.equal((await fs.stat(path.join(f.dataDir, result.backup))).mode & 0o777, 0o600);
});
test('offline restore accepts state exactly at 64 MiB', async t => {
  const f = await fixture(t);
  await f.broker.close();
  const real = await fs.realpath(f.project);
  const ts = new Date().toISOString();
  const agent = id => ({ agentId: id, runner: 'test', registeredAt: ts, updatedAt: ts, status: 'idle', frozen: false, resources: [], task: null });
  const base = { version: 1, nextCursor: 1, rooms: [{ project: real, agents: [agent('a'), agent('b')], messages: [], claims: [], cursor: 0 }] };
  const baseBytes = Buffer.byteLength(JSON.stringify(base));
  const n = MAX_STORE - baseBytes - 9;
  const incoming = { ...base, pad: 'x'.repeat(n) };
  assert.equal(Buffer.byteLength(JSON.stringify(incoming)), MAX_STORE);
  const result = await offlineRestore(f.dataDir, incoming);
  assert.equal(result.restored, true);
  assert.equal(result.bytes, MAX_STORE);
  assert.equal(Buffer.byteLength(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8')), MAX_STORE);
});
test('offline restore refuses state just above 64 MiB without writing', async t => {
  const f = await fixture(t);
  await f.broker.close();
  const real = await fs.realpath(f.project);
  const ts = new Date().toISOString();
  const agent = id => ({ agentId: id, runner: 'test', registeredAt: ts, updatedAt: ts, status: 'idle', frozen: false, resources: [], task: null });
  const base = { version: 1, nextCursor: 1, rooms: [{ project: real, agents: [agent('a'), agent('b')], messages: [], claims: [], cursor: 0 }] };
  const baseBytes = Buffer.byteLength(JSON.stringify(base));
  const n = (MAX_STORE + 1) - baseBytes - 9;
  const incoming = { ...base, pad: 'x'.repeat(n) };
  assert.equal(Buffer.byteLength(JSON.stringify(incoming)), MAX_STORE + 1);
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  const listedBefore = await fs.readdir(f.dataDir);
  await assert.rejects(offlineRestore(f.dataDir, incoming), error => error.code === 'STORE_LIMIT' && error.details.bytes === MAX_STORE + 1 && error.details.limit === MAX_STORE);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  assert.deepEqual(await fs.readdir(f.dataDir), listedBefore);
});
test('offline restore round-trips medium state and reopens', async t => {
  const f = await fixture(t);
  await f.register('a');
  await f.register('b');
  for (let i = 0; i < 24; i++) await f.rpc({ op: 'send', from: i % 2 ? 'b' : 'a', to: i % 2 ? 'a' : 'b', body: 'medium-' + i + '-' + 'x'.repeat(8000), messageId: 'm-' + i });
  const exported = await f.rpc({ op: 'export' });
  const bytes = Buffer.byteLength(JSON.stringify(exported.state));
  assert.ok(bytes > 100000 && bytes < MAX_STORE);
  await f.broker.close();
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  const result = await offlineRestore(f.dataDir, exported.state);
  assert.equal(result.restored, true);
  assert.equal(result.rooms, 1);
  assert.equal(result.messages, 24);
  assert.equal(result.bytes, bytes);
  assert.deepEqual(result.missingAttachments, []);
  assert.deepEqual(result.corruptAttachments, []);
  assert.match(result.backup, /^state\.backup-\d+\.json$/u);
  assert.equal(await fs.readFile(path.join(f.dataDir, result.backup), 'utf8'), before);
  await f.restart();
  assert.equal((await f.rpc({ op: 'inbox', agentId: 'b' })).messages.length, 12);
  assert.equal((await f.rpc({ op: 'usage' })).messages.used, 24);
});
test('offline restore fsyncs backup state and directory', async t => {
  const f = await fixture(t);
  await f.register('a');
  await f.broker.close();
  const incoming = { version: 1, nextCursor: 1, rooms: [] };
  let syncs = 0;
  const counting = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    const original = handle.sync.bind(handle);
    handle.sync = async (...rest) => {
      syncs++;
      return original(...rest);
    };
    return handle;
  } };
  const result = await offlineRestore(f.dataDir, incoming, { fs: counting });
  assert.equal(result.restored, true);
  assert.ok(syncs >= 3);
});
test('offline restore validates input shapes without writing', async t => {
  const f = await fixture(t);
  await f.register('a');
  await f.broker.close();
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  const listedBefore = await fs.readdir(f.dataDir);
  await assert.rejects(offlineRestore(f.dataDir, null), error => error.code === 'INVALID_INPUT');
  await assert.rejects(offlineRestore(f.dataDir, []), error => error.code === 'INVALID_INPUT');
  await assert.rejects(offlineRestore(f.dataDir, 'x'), error => error.code === 'INVALID_INPUT');
  await assert.rejects(offlineRestore(f.dataDir, { version: 999, rooms: [] }), error => error.code === 'INVALID_RESTORE');
  await assert.rejects(offlineRestore(f.dataDir, { version: 1, nextCursor: 1 }), error => error.code === 'INVALID_RESTORE');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  assert.deepEqual(await fs.readdir(f.dataDir), listedBefore);
});
test('offline restore refuses missing corrupt attachments without writing unless allowed', async t => {
  const f = await fixture(t);
  await f.register('a');
  await f.register('b');
  const source = path.join(f.root, 'packet');
  await fs.writeFile(source, 'packet bytes');
  await f.rpc({ op: 'send', agentId: 'a', from: 'a', to: 'b', body: 'with file', messageId: 'att1', attachments: [source] });
  const exported = await f.rpc({ op: 'export' });
  const sha = (await f.rpc({ op: 'inbox', agentId: 'b' })).messages[0].attachments[0].sha256;
  await fs.unlink(path.join(f.dataDir, 'attachments', sha));
  await f.broker.close();
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  await assert.rejects(offlineRestore(f.dataDir, exported.state), error => error.code === 'INCOMPLETE_ATTACHMENTS' && error.details.missingAttachments.length === 1 && error.details.missingAttachments[0].sha256 === sha);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  const allowed = await offlineRestore(f.dataDir, exported.state, { allowIncomplete: true });
  assert.equal(allowed.restored, true);
  assert.equal(allowed.missingAttachments.length, 1);
  assert.deepEqual(allowed.corruptAttachments, []);
  assert.equal(allowed.missingAttachments[0].sha256, sha);
});
test('offline restore refuses corrupt attachments without writing unless allowed', async t => {
  const f = await fixture(t);
  await f.register('a');
  await f.register('b');
  const source = path.join(f.root, 'original');
  await fs.writeFile(source, 'original content bytes');
  await f.rpc({ op: 'send', agentId: 'a', from: 'a', to: 'b', body: 'with attachment', messageId: 'attached', attachments: [source] });
  const exported = await f.rpc({ op: 'export' });
  const meta = (await f.rpc({ op: 'inbox', agentId: 'b' })).messages[0].attachments[0];
  const stored = path.join(f.dataDir, 'attachments', meta.sha256);
  const original = await fs.readFile(stored);
  const corrupt = Buffer.from(original);
  corrupt[0] ^= 1;
  await fs.writeFile(stored, corrupt);
  await f.broker.close();
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  await assert.rejects(offlineRestore(f.dataDir, exported.state), error => error.code === 'INCOMPLETE_ATTACHMENTS' && error.details.corruptAttachments.length === 1 && error.details.corruptAttachments[0].reason === 'hash-mismatch');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  const allowed = await offlineRestore(f.dataDir, exported.state, { allowIncomplete: true });
  assert.equal(allowed.restored, true);
  assert.equal(allowed.corruptAttachments.length, 1);
  assert.equal(allowed.corruptAttachments[0].reason, 'hash-mismatch');
});
test('offline restore refuses symlinked state without writing', async t => {
  const f = await fixture(t);
  await f.register('a');
  await f.broker.close();
  const stateFile = path.join(f.dataDir, 'state.json');
  const before = await fs.readFile(stateFile, 'utf8');
  const target = path.join(f.dataDir, 'real-state.json');
  await fs.rename(stateFile, target);
  await fs.symlink(target, stateFile);
  const listedBefore = await fs.readdir(f.dataDir);
  await assert.rejects(offlineRestore(f.dataDir, { version: 1, nextCursor: 1, rooms: [] }), error => error.code === 'SYMLINK_STATE');
  assert.equal((await fs.lstat(stateFile)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, 'utf8'), before);
  assert.deepEqual((await fs.readdir(f.dataDir)).filter(name => name.startsWith('state.backup-')), []);
  await fs.unlink(stateFile);
  await fs.rename(target, stateFile);
});
test('offline restore backs up prior state with private mode and returns shape', async t => {
  const f = await fixture(t);
  await f.register('a');
  await f.register('b');
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'hello', messageId: 'm1' });
  await f.broker.close();
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  const incoming = { version: 1, nextCursor: 1, rooms: [] };
  const result = await offlineRestore(f.dataDir, incoming);
  assert.deepEqual(Object.keys(result).sort(), ['backup', 'bytes', 'corruptAttachments', 'messages', 'missingAttachments', 'restored', 'rooms']);
  assert.equal(result.restored, true);
  assert.equal(result.rooms, 0);
  assert.equal(result.messages, 0);
  assert.deepEqual(result.missingAttachments, []);
  assert.deepEqual(result.corruptAttachments, []);
  assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(incoming)));
  assert.match(result.backup, /^state\.backup-\d+\.json$/u);
  assert.equal(await fs.readFile(path.join(f.dataDir, result.backup), 'utf8'), before);
  if(process.platform!=='win32')assert.equal((await fs.stat(path.join(f.dataDir, result.backup))).mode & 0o777, 0o600);
  if(process.platform!=='win32')assert.equal((await fs.stat(path.join(f.dataDir, 'state.json'))).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(f.dataDir)).filter(name => name.endsWith('.tmp')), []);
  await f.restart();
  assert.deepEqual((await f.rpc({ op: 'history' })).messages, []);
});
test('offline restore with no prior state returns null backup', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-offline-fresh-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  });
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir);
  const incoming = { version: 1, nextCursor: 1, rooms: [] };
  const result = await offlineRestore(dataDir, incoming);
  assert.equal(result.restored, true);
  assert.equal(result.backup, null);
  assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(incoming)));
  assert.equal(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'), JSON.stringify(incoming));
  const broker = await createBroker({ dataDir });
  t.after(async () => {
    await broker.close();
  });
  assert.equal((await fs.readFile(path.join(dataDir, 'state.json'), 'utf8')), JSON.stringify(incoming));
  await broker.close();
});
test('offline restore leaves new state on post-rename durability failure without reverting', async t => {
  const f = await fixture(t);
  await f.broker.close();
  const real = await fs.realpath(f.project);
  const ts = new Date().toISOString();
  const incoming = { version: 1, nextCursor: 1, rooms: [{ project: real, agents: [{ agentId: 'a', runner: 'test', registeredAt: ts, updatedAt: ts, status: 'idle', frozen: false, resources: [], task: null }], messages: [], claims: [], cursor: 0 }] };
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  let dirSyncs = 0;
  const failing = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (args[1] === 'r') {
      const original = handle.sync.bind(handle);
      handle.sync = async () => {
        dirSyncs++;
        if (dirSyncs === 2) {
          const failure = new Error('injected durability failure');
          failure.code = 'EIO';
          throw failure;
        }
        return original();
      };
    }
    return handle;
  } };
  await assert.rejects(offlineRestore(f.dataDir, incoming, { fs: failing }), error => error.code === 'EIO');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), JSON.stringify(incoming));
  assert.equal((await fs.readdir(f.dataDir)).filter(name => name.startsWith('state.backup-')).length, 1);
  const backupName = (await fs.readdir(f.dataDir)).find(name => name.startsWith('state.backup-'));
  assert.equal(await fs.readFile(path.join(f.dataDir, backupName), 'utf8'), before);
});
test('receipt pages pending with limit and offset while keeping full counts', async t => {
  const f = await fixture(t);
  await f.register('a');
  for (let i = 0; i < 30; i++) await f.register('r-' + i);
  await f.rpc({ op: 'send', from: 'a', to: '*', body: 'fan', messageId: 'fan' });
  const full = await f.rpc({ op: 'receipt', messageId: 'fan' });
  assert.equal(full.recipientsTotal, 30);
  assert.equal(full.pendingTotal, 30);
  assert.equal(full.pendingLimit, 25);
  assert.equal(full.pendingOffset, 0);
  assert.equal(full.pending.length, 25);
  assert.deepEqual(full.counts, { recipients: 30, acked: 0, accepted: 0, notified: 0, pending: 30, missing: 0, delivered: 0, handled: 0 });
  const second = await f.rpc({ op: 'receipt', messageId: 'fan', pendingLimit: 10, pendingOffset: 25 });
  assert.equal(second.pending.length, 5);
  assert.equal(second.pendingTotal, 30);
  assert.equal(second.pendingLimit, 10);
  assert.equal(second.pendingOffset, 25);
  assert.deepEqual(second.counts, full.counts);
  const allPending = (await f.rpc({ op: 'receipt', messageId: 'fan', pendingLimit: 30 })).pending;
  assert.deepEqual(second.pending, allPending.slice(25));
  const empty = await f.rpc({ op: 'receipt', messageId: 'fan', pendingOffset: 30 });
  assert.deepEqual(empty.pending, []);
  assert.equal(empty.pendingTotal, 30);
  assert.deepEqual(empty.counts, full.counts);
  assert.equal((await f.request({ op: 'receipt', messageId: 'fan', pendingLimit: 0 })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'receipt', messageId: 'fan', pendingOffset: -1 })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'receipt', messageId: 'fan', pendingLimit: 1.5 })).error.code, 'INVALID_INPUT');
});
test('outbox caps recipients and pending with totals while keeping full counts', async t => {
  const f = await fixture(t);
  await f.register('a');
  for (let i = 0; i < 30; i++) await f.register('r-' + i);
  await f.rpc({ op: 'send', from: 'a', to: '*', body: 'fan', messageId: 'fan' });
  await f.rpc({ op: 'send', from: 'a', to: 'r-0', body: 'direct', messageId: 'direct' });
  const outbox = await f.rpc({ op: 'outbox', from: 'a' });
  assert.equal(outbox.messages.length, 2);
  const fan = outbox.messages.find(m => m.id === 'fan');
  assert.equal(fan.recipients.length, 25);
  assert.equal(fan.recipientsTotal, 30);
  assert.equal(fan.pending.length, 25);
  assert.equal(fan.pendingTotal, 30);
  assert.deepEqual(fan.counts, { recipients: 30, acked: 0, accepted: 0, notified: 0, pending: 30, missing: 0, delivered: 0, handled: 0 });
  const direct = outbox.messages.find(m => m.id === 'direct');
  assert.equal(direct.recipients.length, 1);
  assert.equal(direct.recipientsTotal, 1);
  assert.equal(direct.pending.length, 1);
  assert.equal(direct.pendingTotal, 1);
  assert.deepEqual(direct.counts, { recipients: 1, acked: 0, accepted: 0, notified: 0, pending: 1, missing: 0, delivered: 0, handled: 0 });
  const capped = await f.rpc({ op: 'outbox', from: 'a', recipientsLimit: 10, pendingLimit: 5 });
  const cappedFan = capped.messages.find(m => m.id === 'fan');
  assert.equal(cappedFan.recipients.length, 10);
  assert.equal(cappedFan.recipientsTotal, 30);
  assert.equal(cappedFan.pending.length, 5);
  assert.equal(cappedFan.pendingTotal, 30);
  assert.deepEqual(cappedFan.counts, fan.counts);
  const full = await f.rpc({ op: 'outbox', from: 'a', recipientsLimit: 30, pendingLimit: 30 });
  assert.equal(full.messages.find(m => m.id === 'fan').recipients.length, 30);
  assert.equal(full.messages.find(m => m.id === 'fan').pending.length, 30);
  assert.equal((await f.request({ op: 'outbox', from: 'a', recipientsLimit: 0 })).error.code, 'INVALID_INPUT');
  assert.equal((await f.request({ op: 'outbox', from: 'a', pendingLimit: 0 })).error.code, 'INVALID_INPUT');
});
test('usage tightest reflects smallest remaining allowance', async t => {
  const f = await fixture(t);
  const at = new Date().toISOString();
  const room = await fs.realpath(f.project);
  const mk = id => ({ agentId: id, runner: 'test', registeredAt: at, updatedAt: at, status: 'idle',
    frozen: false, resources: [], task: null });
  const bigRecipients = Array.from({ length: 300 }, (_, i) => 'big-' + i);
  const agents = ['sender', ...bigRecipients, 'small-0'].map(mk);
  const bigNotified = [];
  for (let i = 0; i < 1500; i++) bigNotified.push({ agentId: bigRecipients[i % bigRecipients.length], adapter: 'adapter-' + i, at });
  const smallNotified = Array.from({ length: 1024 }, (_, i) => ({ agentId: 'small-0', adapter: 'small-' + i, at }));
  await f.broker.close();
  await fs.writeFile(path.join(f.dataDir, 'state.json'), JSON.stringify({ version: 1, nextCursor: 3,
    rooms: [{ project: room, agents, claims: [], cursor: 2,
      messages: [{ messageId: 'big', from: 'sender', to: '*', body: 'big', createdAt: at, cursor: 1,
        recipients: bigRecipients, ackedBy: [], notified: bigNotified },
        { messageId: 'small', from: 'sender', to: 'small-0', body: 'small', createdAt: at, cursor: 2,
          recipients: ['small-0'], ackedBy: [], notified: smallNotified }] }] }));
  await f.restart();
  const usage = await f.rpc({ op: 'usage' });
  assert.equal(usage.notices.used, 1500);
  assert.equal(usage.notices.largest.messageId, 'big');
  assert.equal(usage.notices.largest.markers, 1500);
  assert.equal(usage.notices.largest.allowance, 1800);
  assert.deepEqual(usage.notices.tightest, { messageId: 'small', remaining: 0, allowance: 1024 });
  assert.equal(usage.headroom.notices, 0);
  assert.equal(usage.nearLimit.includes('notices'), true);
});
test('offline restore leaves state intact on tmp write and rename failures', async t => {
  const f = await fixture(t);
  await f.broker.close();
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  const incoming = { version: 1, nextCursor: 1, rooms: [] };
  const failingOpen = { ...fs, open: async (...args) => {
    if (String(args[0]).endsWith('.tmp')) {
      const failure = new Error('injected tmp failure');
      failure.code = 'EIO';
      throw failure;
    }
    return fs.open(...args);
  } };
  await assert.rejects(offlineRestore(f.dataDir, incoming, { fs: failingOpen }), error => error.code === 'EIO');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  const failingRename = { ...fs, rename: async () => {
    const failure = new Error('injected rename failure');
    failure.code = 'EIO';
    throw failure;
  } };
  await assert.rejects(offlineRestore(f.dataDir, incoming, { fs: failingRename }), error => error.code === 'EIO');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  assert.deepEqual((await fs.readdir(f.dataDir)).filter(name => name.endsWith('.tmp')), []);
});
test('task blockers resolve canonical symlink identity while preserving refs', async t => {
  const f = await fixture(t);
  const real = await fs.realpath(f.project);
  await f.register('a'); await f.register('b');
  await fs.mkdir(path.join(f.project, 'target'));
  await fs.writeFile(path.join(f.project, 'target', 'file.txt'), 'content');
  await fs.symlink(path.join(f.project, 'target'), path.join(f.project, 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['target/file.txt'] });
  const aliased = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'b', title: 'Aliased work',
    blockedBy: ['alias/file.txt'] });
  assert.equal(aliased.task.blocked, true);
  assert.deepEqual(aliased.task.blocking,
    [{ ref: 'alias/file.txt', kind: 'claim', scope: 'project', holder: 'a', state: 'held' }]);
  assert.deepEqual(aliased.task.blockedBy, ['alias/file.txt']);
  assert.equal((await f.request({ op: 'claim', agentId: 'b', resources: ['alias/file.txt'] })).error.code,
    'CLAIM_CONFLICT');
  await f.rpc({ op: 'release', agentId: 'a', resources: ['target/file.txt'] });
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['target'] });
  const missing = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'b', title: 'Missing child',
    blockedBy: ['alias/missing/deep/file.txt'] });
  assert.equal(missing.task.blocked, true);
  assert.deepEqual(missing.task.blocking,
    [{ ref: 'alias/missing/deep/file.txt', kind: 'claim', scope: 'project', holder: 'a', state: 'held' }]);
  assert.deepEqual(missing.task.blockedBy, ['alias/missing/deep/file.txt']);
  const child = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'b', title: 'Child work',
    blockedBy: ['target/file.txt'] });
  assert.equal(child.task.blocked, true);
  assert.equal(child.task.blocking[0].holder, 'a');
  assert.deepEqual(child.task.blockedBy, ['target/file.txt']);
  const dirRef = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'b', title: 'Dir work',
    blockedBy: ['alias'] });
  assert.equal(dirRef.task.blocked, true);
  assert.equal(dirRef.task.blocking[0].holder, 'a');
  assert.deepEqual(dirRef.task.blockedBy, ['alias']);
  await f.rpc({ op: 'release', agentId: 'a', resources: ['target'] });
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['alias'] });
  const opposite = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'b', title: 'Opposite work',
    blockedBy: ['target/file.txt'] });
  assert.equal(opposite.task.blocked, true);
  assert.equal(opposite.task.blocking[0].holder, 'a');
  assert.deepEqual(opposite.task.blockedBy, ['target/file.txt']);
  assert.equal((await f.rpc({ op: 'agents' })).claims.find(c => c.resource === path.join(real, 'target')).agentId, 'a');
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['build'] });
  const named = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'b', title: 'Named work',
    blockedBy: ['build'] });
  assert.equal(named.task.blocked, true);
  assert.deepEqual(named.task.blocking,
    [{ ref: 'build', kind: 'claim', scope: 'project', holder: 'a', state: 'held' }]);
  const separate = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'b', title: 'Separate',
    blockedBy: ['build/file'] });
  assert.equal(separate.task.blocked, false);
  assert.deepEqual(separate.task.blocking, [{ ref: 'build/file', kind: 'unknown', holder: null, state: null }]);
  await f.rpc({ op: 'claim', agentId: 'a', scope: 'machine', resources: ['machine-res'] });
  const machined = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'b', title: 'Machine work',
    blockedBy: ['machine-res'] });
  assert.equal(machined.task.blocked, true);
  assert.deepEqual(machined.task.blocking,
    [{ ref: 'machine-res', kind: 'claim', scope: 'machine', holder: 'a', state: 'held' }]);
  const first = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'b', title: 'First', id: 'task-one' });
  assert.equal(first.task.blocked, false);
  const dependent = await f.rpc({ op: 'tasks', action: 'upsert', agentId: 'b', title: 'Dependent',
    blockedBy: ['task-one'] });
  assert.equal(dependent.task.blocked, true);
  assert.deepEqual(dependent.task.blocking,
    [{ ref: 'task-one', kind: 'task', holder: null, state: 'open' }]);
  const listed = await f.rpc({ op: 'tasks', action: 'list', blocked: true });
  assert.ok(listed.tasks.some(row => row.id === aliased.task.id && row.blocked === true));
  assert.ok(listed.tasks.some(row => row.id === missing.task.id && row.blocked === true));
});
test('legacy handoff acceptance fails closed while decline resolves', async t => {
  const f = await fixture(t);
  const real = await fs.realpath(f.project);
  await f.register('a'); await f.register('b');
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['x'] });
  const resource = path.join(real, 'x');
  await f.broker.close();
  const file = path.join(f.dataDir, 'state.json');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  const room = state.rooms.find(r => r.project === real);
  const ts = new Date().toISOString();
  room.handoffs = [{ id: 'legacy-1', from: 'a', to: 'b', resources: [resource],
    reason: 'legacy offer', state: 'pending', requestedAt: ts }];
  await fs.writeFile(file, JSON.stringify(state));
  await f.restart();
  const listed = await f.rpc({ op: 'handoffs' });
  assert.equal(listed.handoffs.length, 1);
  assert.equal(listed.handoffs[0].id, 'legacy-1');
  assert.equal(listed.handoffs[0].state, 'pending');
  assert.equal(listed.handoffs[0].offeredBy, undefined);
  const refused = await f.request({ op: 'respondHandoff', agentId: 'b', id: 'legacy-1', accept: true });
  assert.equal(refused.error.code, 'HANDOFF_STALE');
  assert.equal(refused.status, 409);
  assert.equal(refused.error.reason, 'legacy-unverifiable-direction');
  assert.equal(refused.error.recovery, 'ask the parties to recreate the offer; the old record is preserved for audit');
  assert.equal((await f.rpc({ op: 'agents' })).claims.find(c => c.resource === resource).agentId, 'a');
  assert.equal((await f.rpc({ op: 'handoffs' })).handoffs.find(h => h.id === 'legacy-1').state, 'pending');
  const declined = await f.rpc({ op: 'respondHandoff', agentId: 'b', id: 'legacy-1', accept: false });
  assert.equal(declined.handoff.state, 'declined');
  assert.equal(declined.handoff.id, 'legacy-1');
  assert.equal((await f.rpc({ op: 'handoffs' })).handoffs.find(h => h.id === 'legacy-1').state, 'declined');
  assert.equal((await f.rpc({ op: 'agents' })).claims.find(c => c.resource === resource).agentId, 'a');
});
test('upgrade from old ledger keeps legacy offers unverifiable', async t => {
  const f = await fixture(t);
  const real = await fs.realpath(f.project);
  await f.register('a'); await f.register('b');
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['x'] });
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['y'] });
  const x = path.join(real, 'x');
  const y = path.join(real, 'y');
  await f.broker.close();
  const file = path.join(f.dataDir, 'state.json');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  const room = state.rooms.find(r => r.project === real);
  const ts = new Date().toISOString();
  room.handoffs = [
    { id: 'legacy-offer', from: 'a', to: 'b', resources: [x], reason: 'old offer', state: 'pending', requestedAt: ts },
    { id: 'legacy-request', from: 'b', to: 'a', resources: [y], reason: 'old request', state: 'pending', requestedAt: ts }
  ];
  await fs.writeFile(file, JSON.stringify(state));
  await f.restart();
  await f.rpc({ op: 'release', agentId: 'a', resources: ['x'] });
  await f.rpc({ op: 'claim', agentId: 'b', resources: ['x'] });
  const reversal = await f.request({ op: 'respondHandoff', agentId: 'b', id: 'legacy-offer', accept: true });
  assert.equal(reversal.error.code, 'HANDOFF_STALE');
  assert.equal(reversal.status, 409);
  assert.equal(reversal.error.reason, 'legacy-unverifiable-direction');
  assert.equal(reversal.error.recovery, 'ask the parties to recreate the offer; the old record is preserved for audit');
  assert.equal((await f.rpc({ op: 'agents' })).claims.find(c => c.resource === x).agentId, 'b');
  assert.equal((await f.rpc({ op: 'handoffs' })).handoffs.find(h => h.id === 'legacy-offer').state, 'pending');
  const requested = await f.request({ op: 'respondHandoff', agentId: 'a', id: 'legacy-request', accept: true });
  assert.equal(requested.error.code, 'HANDOFF_STALE');
  assert.equal(requested.status, 409);
  assert.equal(requested.error.reason, 'legacy-unverifiable-direction');
  assert.equal((await f.rpc({ op: 'agents' })).claims.find(c => c.resource === y).agentId, 'a');
  assert.equal((await f.rpc({ op: 'handoffs' })).handoffs.find(h => h.id === 'legacy-request').state, 'pending');
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['fresh'] });
  const fresh = path.join(real, 'fresh');
  const offer = await f.rpc({ op: 'requestHandoff', agentId: 'a', to: 'b', resources: ['fresh'], reason: 'fresh offer' });
  assert.equal(offer.handoff.offeredBy, 'a');
  const accepted = await f.rpc({ op: 'respondHandoff', agentId: 'b', id: offer.handoff.id, accept: true });
  assert.equal(accepted.handoff.state, 'accepted');
  assert.equal(accepted.claims.find(c => c.resource === fresh).agentId, 'b');
  await f.rpc({ op: 'claim', agentId: 'a', resources: ['need'] });
  const need = path.join(real, 'need');
  const req = await f.rpc({ op: 'requestHandoff', agentId: 'b', to: 'a', resources: ['need'], reason: 'fresh request' });
  assert.equal(req.handoff.offeredBy, 'a');
  const granted = await f.rpc({ op: 'respondHandoff', agentId: 'a', id: req.handoff.id, accept: true });
  assert.equal(granted.handoff.state, 'accepted');
  assert.equal(granted.claims.find(c => c.resource === need).agentId, 'b');
});
