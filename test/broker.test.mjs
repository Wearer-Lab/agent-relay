import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createBroker } from '../lib/broker.mjs';
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
