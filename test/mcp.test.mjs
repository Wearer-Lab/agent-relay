import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createBroker } from '../lib/broker.mjs';
import { createMcpAdapter, runMcp } from '../lib/mcp.mjs';

const channelSchema = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
});
const unpack = response => JSON.parse(response.content[0].text);

const envKeys = ['AGENT_RELAY_TEST_ROOM', 'AGENT_RELAY_DATA_DIR', 'CODEX_THREAD_ID', 'CLAUDE_SESSION_ID'];
const isolatedEnv = new WeakMap();
function isolateEnv(t, env = {}) {
  if (!isolatedEnv.has(t)) {
    const prior = new Map(envKeys.map(key => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    isolatedEnv.set(t, prior);
    t.after(() => {
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function brokerRpc(broker, project, fields) {
  const response = await fetch(broker.url + '/rpc', {
    method: 'POST', headers: { authorization: 'Bearer ' + broker.token, 'content-type': 'application/json' },
    body: JSON.stringify({ project, ...fields }),
  });
  return response.json();
}

async function fixture(t, { channel = false, rejectedOp, failFirstNotification = false, runner = 'claude', attachCodex,
  sessionId = 'test-session', expectedProject = '/fixture/project', rejectTest = false } = {}) {
  isolateEnv(t);
  const calls = [];
  const rpcOptions = [];
  let waitCount = 0;
  const waitCursors = [];
  const errors = [];
  const warnings = [];
  const waitListeners = [];
  let waiter;
  let abortObserved = false;
  let notifiedResolve;
  const notified = new Promise(resolve => { notifiedResolve = resolve; });
  const rpcImpl = async (project, fields, options) => {
    assert.equal(project, expectedProject);
    calls.push(fields);
    rpcOptions.push(options);
    if (fields.op === rejectedOp) return { ok: false, error: 'fixture conflict' };
    if (rejectTest && fields.op === 'register' && fields.test) return { ok: false, error: 'Unknown field: test' };
    if (fields.op === 'agents') return { ok: true, agents: [{ agentId: 'peer' }], claims: [], cursor: 0 };
    if (fields.op === 'inbox') return { ok: true, messages: [{ messageId: 'old-unacked' }] };
    if (fields.op === 'notified') notifiedResolve(fields);
    return { ok: true, ...fields };
  };
  const waitImpl = async (project, agentId, after, { signal }) => {
    assert.equal(project, expectedProject);
    assert.equal(agentId, adapter.agentId);
    waitCount += 1;
    waitCursors.push(after);
    return new Promise((resolve, reject) => {
      const abort = () => { abortObserved = true; reject(new Error('aborted')); };
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      waiter = payload => { signal.removeEventListener('abort', abort); resolve(payload); };
      for (const listener of waitListeners.splice(0)) listener();
    });
  };
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  if (failFirstNotification) {
    const actualSend = serverTransport.send.bind(serverTransport);
    serverTransport.send = async message => {
      if (failFirstNotification && message.method === 'notifications/claude/channel') {
        failFirstNotification = false;
        throw new Error('fixture transport refused notification');
      }
      return actualSend(message);
    };
  }
  const adapter = await createMcpAdapter({ project: '/fixture/project', runner,
    sessionId, channel, rpcImpl, waitImpl, attachCodex,
    onError: message => errors.push(message), onWarning: message => warnings.push(message) });
  const client = new Client({ name: 'fixture-client', version: '1' });
  const received = [];
  let receivedResolve;
  const firstReceived = new Promise(resolve => { receivedResolve = resolve; });
  client.setNotificationHandler(channelSchema, notification => {
    received.push(notification); receivedResolve(notification);
  });
  await adapter.start(serverTransport);
  await client.connect(clientTransport);
  // A real tool request follows initialization on the same transport, rather
  // than invoking the request handler directly or manufacturing a notification.
  const tools = await client.listTools();
  t.after(async () => { await adapter.close(); await client.close(); });
  return { adapter, client, calls, rpcOptions, tools, received, notified, firstReceived, errors, warnings, waitCursors,
    async nextWaitAfter(count) {
      if (waitCount <= count) await new Promise(resolve => waitListeners.push(resolve));
    },
    push: payload => { assert.ok(waiter, 'actual watcher entered wait'); waiter(payload); },
    get waitCount() { return waitCount; }, get abortObserved() { return abortObserved; } };
}

test('real SDK tools use pinned project/agent identity and exact broker fields', async t => {
  const f = await fixture(t);
  assert.equal(f.adapter.agentId, 'claude-test-session');
  assert.equal(f.calls[0].op, 'register');
  assert.equal(f.calls[1].status, 'awaiting-attachment');
  assert.deepEqual(f.tools.tools.map(tool => tool.name),
    ['relay_read_page', 'relay_agents', 'relay_send', 'relay_inbox', 'relay_ack', 'relay_status', 'relay_claim', 'relay_release',
      'relay_leave', 'relay_fetch', 'relay_outbox', 'relay_receipt', 'relay_history', 'relay_bulletin_get',
      'relay_bulletin_ack', 'relay_handoff_request', 'relay_handoff_respond', 'relay_handoffs', 'relay_claim_narrow',
      'relay_tasks', 'relay_roadmap', 'relay_processes_list', 'relay_group_agents', 'relay_prune', 'relay_compact',
      'relay_ownership', 'relay_branch', 'relay_pending', 'relay_retire']);
  const operations = [
    ['relay_agents', {}, { op: 'agents', limit: 100 }],
    ['relay_agents', { active: true, within: 5, transport: 'connected' },
      { op: 'agents', active: true, within: 5, transport: 'connected', limit: 100 }],
    ['relay_agents', { limit: 10, offset: 5 }, { op: 'agents', limit: 10, offset: 5 }],
    ['relay_send', { to: 'peer', body: 'File frozen', replyTo: 'message-1' },
      { op: 'send', from: f.adapter.agentId, to: 'peer', body: 'File frozen', replyTo: 'message-1' }],
    ['relay_send', { to: 'peer', body: 'Full', summary: 's', messageId: 'stable-1' },
      { op: 'send', from: f.adapter.agentId, to: 'peer', body: 'Full', summary: 's', messageId: 'stable-1' }],
    ['relay_inbox', {}, { op: 'inbox', agentId: f.adapter.agentId, limit: 50 }],
    ['relay_inbox', { unread: true, since: 7, limit: 2, from: 'peer' },
      { op: 'inbox', agentId: f.adapter.agentId, unacked: true, since: 7, limit: 2, from: 'peer' }],
    ['relay_inbox', { unread: false, since: 7, limit: 2 },
      { op: 'inbox', agentId: f.adapter.agentId, unacked: false, since: 7, limit: 2 }],
    ['relay_ack', { messageId: 'message-1' }, { op: 'ack', agentId: f.adapter.agentId, messageId: 'message-1' }],
    ['relay_ack', { through: 9 }, { op: 'ack', agentId: f.adapter.agentId, through: 9 }],
    ['relay_status', { status: 'reviewing', frozen: true, resources: ['a.swift'], task: null },
      { op: 'status', agentId: f.adapter.agentId, status: 'reviewing', frozen: true, resources: ['a.swift'], task: null }],
    ['relay_status', { transport: { adapter: 'probe', state: 'connected' } },
      { op: 'status', agentId: f.adapter.agentId, transport: { adapter: 'probe', state: 'connected' } }],
    ['relay_claim', { resources: ['a.swift', 'build'] },
      { op: 'claim', agentId: f.adapter.agentId, resources: ['a.swift', 'build'] }],
    ['relay_claim', { resources: ['native'], scope: 'machine' },
      { op: 'claim', agentId: f.adapter.agentId, resources: ['native'], scope: 'machine' }],
    ['relay_claim', { resources: ['a.swift'], meta: { baseCommit: 'abc' } },
      { op: 'claim', agentId: f.adapter.agentId, resources: ['a.swift'], meta: { baseCommit: 'abc' } }],
    ['relay_release', { resources: ['a.swift'] }, { op: 'release', agentId: f.adapter.agentId, resources: ['a.swift'] }],
    ['relay_release', {}, { op: 'release', agentId: f.adapter.agentId }],
    ['relay_leave', {}, { op: 'leave', agentId: f.adapter.agentId }],
    ['relay_fetch', { messageId: 'm', out: '/tmp/fetch-out' },
      { op: 'fetch', agentId: f.adapter.agentId, messageId: 'm', out: '/tmp/fetch-out' }],
    ['relay_receipt', { messageId: 'message-1' }, { op: 'receipt', messageId: 'message-1', recipientsLimit: 100, pendingLimit: 100 }],
    ['relay_receipt', { messageId: 'message-1', recipientsLimit: 10, recipientsOffset: 5 },
      { op: 'receipt', messageId: 'message-1', recipientsLimit: 10, recipientsOffset: 5, pendingLimit: 100 }],
    ['relay_receipt', { messageId: 'message-1', pendingLimit: 10, pendingOffset: 5 },
      { op: 'receipt', messageId: 'message-1', recipientsLimit: 100, pendingLimit: 10, pendingOffset: 5 }],
    ['relay_outbox', {}, { op: 'outbox', from: f.adapter.agentId, limit: 50, recipientsLimit: 25, pendingLimit: 25 }],
    ['relay_outbox', { recipientsLimit: 10, pendingLimit: 10 },
      { op: 'outbox', from: f.adapter.agentId, limit: 50, recipientsLimit: 10, pendingLimit: 10 }],
    ['relay_history', { acked: true, threadOf: 'message-1' },
      { op: 'history', agentId: f.adapter.agentId, limit: 50, acked: true, threadOf: 'message-1' }],
    ['relay_history', { afterTs: '2026-01-01T00:00:00.000Z', beforeTs: '2026-12-31T00:00:00.000Z', before: 9 },
      { op: 'history', agentId: f.adapter.agentId, limit: 50, afterTs: '2026-01-01T00:00:00.000Z',
        beforeTs: '2026-12-31T00:00:00.000Z', before: 9 }],
    ['relay_bulletin_get', {}, { op: 'getBulletin' }],
    ['relay_bulletin_ack', { version: 2 }, { op: 'ackBulletin', agentId: f.adapter.agentId, version: 2 }],
    ['relay_bulletin_ack', { version: 2, hash: 'abc123' },
      { op: 'ackBulletin', agentId: f.adapter.agentId, version: 2, hash: 'abc123' }],
    ['relay_handoff_request', { resources: ['a.swift'], reason: 'transfer' },
      { op: 'requestHandoff', agentId: f.adapter.agentId, resources: ['a.swift'], reason: 'transfer' }],
    ['relay_handoff_request', { to: 'peer', resources: ['a.swift'], reason: 'transfer', meta: { baseCommit: 'abc' } },
      { op: 'requestHandoff', agentId: f.adapter.agentId, to: 'peer', resources: ['a.swift'], reason: 'transfer',
        meta: { baseCommit: 'abc' } }],
    ['relay_handoff_respond', { id: 'h-1', accept: true },
      { op: 'respondHandoff', agentId: f.adapter.agentId, id: 'h-1', accept: true }],
    ['relay_handoff_respond', { id: 'h-1', accept: false, resources: ['a.swift'] },
      { op: 'respondHandoff', agentId: f.adapter.agentId, id: 'h-1', accept: false, resources: ['a.swift'] }],
    ['relay_handoffs', {}, { op: 'handoffs' }],
    ['relay_claim_narrow', { resource: 'src', resources: ['src/a.mjs'] },
      { op: 'claimNarrow', agentId: f.adapter.agentId, resource: 'src', resources: ['src/a.mjs'] }],
    ['relay_claim_narrow', { resource: 'src', resources: ['src/a.mjs'], meta: { baseCommit: 'abc' } },
      { op: 'claimNarrow', agentId: f.adapter.agentId, resource: 'src', resources: ['src/a.mjs'],
        meta: { baseCommit: 'abc' } }],
    ['relay_tasks', { action: 'upsert', title: 'Build' },
      { op: 'tasks', action: 'upsert', agentId: f.adapter.agentId, title: 'Build' }],
    ['relay_tasks', { action: 'upsert', id: 't-1', title: 'Build', owner: 'peer', blockedBy: ['a.swift'],
        resources: ['a.swift'], sourceRevision: 'rev-1', verification: 'run tests', expectedRecipient: 'peer',
        handoffId: 'h-1' },
      { op: 'tasks', action: 'upsert', agentId: f.adapter.agentId, id: 't-1', title: 'Build', owner: 'peer',
        blockedBy: ['a.swift'], resources: ['a.swift'], sourceRevision: 'rev-1', verification: 'run tests',
        expectedRecipient: 'peer', handoffId: 'h-1' }],
    ['relay_tasks', { action: 'list', state: 'open', blocked: true },
      { op: 'tasks', action: 'list', agentId: f.adapter.agentId, state: 'open', blocked: true }],
    ['relay_tasks', { action: 'complete', id: 't-1', verification: 'done' },
      { op: 'tasks', action: 'complete', agentId: f.adapter.agentId, id: 't-1', verification: 'done' }],
    ['relay_processes_list', {}, { op: 'processes', action: 'list' }],
    ['relay_processes_list', { owner: 'peer' }, { op: 'processes', action: 'list', agentId: 'peer' }],
    ['relay_group_agents', {}, { op: 'groupAgents' }],
    ['relay_group_agents', { groupId: 'g1' }, { op: 'groupAgents', groupId: 'g1' }],
  ];
  for (const [name, args, expected] of operations) {
    const response = await f.client.callTool({ name, arguments: args });
    assert.ok(!response.isError);
    assert.equal(unpack(response).ok, true);
    assert.deepEqual(f.calls.at(-1), expected);
  }
  assert.equal(f.waitCount, 0);
  assert.equal(f.client.getServerCapabilities().experimental, undefined);
  assert.deepEqual(f.errors, []);
});

test('stable runner session identity is reused across adapter instances', async t => {
  const first = await fixture(t, { sessionId: 'shared-session' });
  const second = await fixture(t, { sessionId: 'shared-session' });
  assert.equal(first.adapter.sessionId, 'shared-session');
  assert.equal(first.adapter.agentId, 'claude-shared-session');
  assert.equal(second.adapter.agentId, first.adapter.agentId);
  assert.equal(second.adapter.sessionId, 'shared-session');
  assert.deepEqual(first.warnings, []);
  assert.deepEqual(second.warnings, []);
  assert.equal(first.calls[0].sessionId, 'shared-session');
  assert.equal(second.calls[0].sessionId, 'shared-session');
  isolateEnv(t, { CODEX_THREAD_ID: 'codex-thread-7' });
  const inherited = await fixture(t, { runner: 'codex', sessionId: null });
  const inheritedAgain = await fixture(t, { runner: 'codex', sessionId: null });
  assert.equal(inherited.adapter.sessionId, 'codex-thread-7');
  assert.equal(inherited.adapter.agentId, 'codex-codex-thread-7');
  assert.equal(inheritedAgain.adapter.agentId, inherited.adapter.agentId);
  assert.deepEqual(inherited.warnings, []);
  assert.equal(inherited.calls[0].sessionId, 'codex-thread-7');
});

test('fallback identity warns with its reason and stays marked temporary', async t => {
  const first = await fixture(t, { sessionId: null });
  assert.match(first.adapter.sessionId, /^tmp-/);
  assert.equal(first.adapter.agentId, `claude-${first.adapter.sessionId}`);
  assert.equal(first.warnings.length, 1);
  assert.match(first.warnings[0], /no supplied session ID and no CLAUDE_SESSION_ID/);
  assert.match(first.warnings[0], /temporary fallback identity/);
  assert.ok(first.warnings[0].includes(first.adapter.sessionId));
  assert.equal(first.calls[0].sessionId, first.adapter.sessionId);
  const second = await fixture(t, { sessionId: null });
  assert.equal(second.adapter.sessionId, first.adapter.sessionId);
  assert.equal(second.warnings.length, 1);
  assert.deepEqual(first.errors, []);
});

test('invalid/spoofed arguments and broker conflicts cannot look successful', async t => {
  const f = await fixture(t, { rejectedOp: 'claim' });
  for (const [name, args] of [
    ['relay_send', { to: 'peer', body: 'x', from: 'another-agent' }],
    ['relay_ack', { messageId: 'm', agentId: 'another-agent' }],
    ['relay_claim', { resources: [] }], ['relay_claim', { resources: [42] }],
    ['relay_status', { frozen: 'yes' }], ['relay_status', { task: 'x'.repeat(8_193) }],
    ['relay_claim', { resources: ['native'], scope: 'galaxy' }],
    ['relay_status', { transport: { adapter: 'x', state: 'live' } }],
    ['relay_inbox', { limit: -1 }], ['relay_ack', { through: 'x' }],
    ['relay_agents', { transport: 'live' }],
    ['relay_send', { to: 'peer' }], ['relay_unknown', {}],
    ['relay_bulletin_ack', {}], ['relay_bulletin_ack', { version: 0 }],
    ['relay_bulletin_ack', { version: 1, agentId: 'spoof' }],
    ['relay_handoff_request', { reason: 'x' }], ['relay_handoff_request', { resources: [] }],
    ['relay_handoff_request', { resources: ['a'], reason: 'x', agentId: 'spoof' }],
    ['relay_handoff_respond', { id: 'h', accept: 'yes' }], ['relay_handoff_respond', { id: 'h' }],
    ['relay_claim_narrow', { resource: 'src' }], ['relay_claim_narrow', { resource: 'src', resources: [] }],
    ['relay_tasks', {}], ['relay_tasks', { action: 'bogus' }], ['relay_tasks', { action: 'list', blocked: 'yes' }],
    ['relay_tasks', { action: 'list', state: 'done' }],
    ['relay_tasks', { action: 'upsert', title: 'x', blockedBy: Array.from({ length: 65 }, (_, i) => `b-${i}`) }],
    ['relay_tasks', { action: 'upsert', title: 'x', resources: Array.from({ length: 65 }, (_, i) => `r-${i}`) }],
    ['relay_processes_list', { owner: 'x', agentId: 'spoof' }],
    ['relay_group_agents', { groupId: '' }], ['relay_group_agents', { groupId: 'g', project: '/other' }],
    ['relay_history', { beforeTs: 42 }], ['relay_history', { before: -1 }],
  ]) {
    const before = f.calls.length;
    const response = await f.client.callTool({ name, arguments: args });
    assert.equal(response.isError, true);
    assert.equal(unpack(response).ok, false);
    assert.equal(f.calls.length, before);
  }
  const conflict = await f.client.callTool({ name: 'relay_claim', arguments: { resources: ['a.swift'] } });
  assert.equal(conflict.isError, true);
  assert.match(unpack(conflict).error, /fixture conflict/);
});

test('Claude notification writes are marked notified, never acked; close aborts long poll', async t => {
  const f = await fixture(t, { channel: true });
  assert.deepEqual(f.client.getServerCapabilities().experimental, { 'claude/channel': {} });
  assert.ok(!Object.hasOwn(f.client.getServerCapabilities().experimental, 'claude/channel/permission'));
  assert.ok(f.calls.some(call => call.op === 'status' && call.status === 'channel-ready'));
  f.push({ ok: true, cursor: 4, messages: [
    { messageId: 'm-4', from: 'peer', to: f.adapter.agentId, body: 'Ready for your build', cursor: 4, acked: false },
  ] });
  const notification = await f.firstReceived;
  assert.equal(notification.params.content, 'Ready for your build');
  assert.equal(notification.params.meta.message_id, 'm-4');
  assert.equal(notification.params.meta.sender, 'peer');
  assert.equal((await f.notified).adapter, 'claude-channel');
  assert.ok(!f.calls.some(call => call.op === 'ack'));
  await f.client.callTool({ name: 'relay_inbox', arguments: {} });
  assert.equal(f.adapter.notifiedCursor, 4);
  assert.ok(f.waitCount >= 2);
  await f.client.callTool({ name: 'relay_ack', arguments: { messageId: 'm-4' } });
  assert.deepEqual(f.calls.at(-1), { op: 'ack', agentId: f.adapter.agentId, messageId: 'm-4' });
  await f.client.close();
  await f.adapter.close();
  assert.equal(f.abortObserved, true);
  assert.deepEqual(f.errors, []);
});

test('a refused transport write preserves cursor and stable ID without automatic acknowledgement', async t => {
  const f = await fixture(t, { channel: true, failFirstNotification: true });
  const payload = { ok: true, cursor: 2, messages: [
    { messageId: 'stable-2', from: 'peer', body: 'Frozen', cursor: 2, acked: false },
  ] };
  f.push(payload);
  await f.nextWaitAfter(1);
  assert.equal(f.adapter.notifiedCursor, 0);
  assert.deepEqual(f.waitCursors, [0, 0]);
  assert.equal(f.received.length, 0);
  assert.ok(!f.calls.some(call => call.op === 'notified' || call.op === 'ack'));
  f.push(payload);
  assert.equal((await f.firstReceived).params.meta.message_id, 'stable-2');
  await f.notified;
  assert.deepEqual(f.errors, ['fixture transport refused notification']);
  assert.ok(!f.calls.some(call => call.op === 'ack'));
});

test('already acknowledged wait rows are skipped while the project cursor still advances', async t => {
  const f = await fixture(t, { channel: true });
  f.push({ ok: true, cursor: 9, messages: [
    { messageId: 'done', from: 'peer', body: 'Already handled', cursor: 7, acked: true },
  ] });
  await f.nextWaitAfter(1);
  assert.equal(f.adapter.notifiedCursor, 9);
  assert.equal(f.received.length, 0);
  assert.ok(!f.calls.some(call => call.op === 'notified' || call.op === 'ack'));
  assert.deepEqual(f.errors, []);
});

test('runMcp supports injected transport and marks a fallback identity temporary', async t => {
  isolateEnv(t);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const calls = [];
  const warnings = [];
  const adapter = await runMcp({ project: '/fixture/project', runner: 'codex', transport: serverTransport,
    onWarning: message => warnings.push(message),
    rpcImpl: async (_, fields) => { calls.push(fields); return { ok: true }; },
    waitImpl: async () => assert.fail('generic MCP cannot imply wake') });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientTransport);
  t.after(async () => { await adapter.close(); await client.close(); });
  assert.match(adapter.agentId, /^codex-tmp-[0-9a-f-]{36}$/);
  assert.equal(calls[0].op, 'register');
  assert.equal(calls[0].sessionId, adapter.sessionId);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(adapter.sessionId));
  assert.match(warnings[0], /temporary fallback identity/);
  await assert.rejects(adapter.start(serverTransport), /cannot be started twice/);
});

test('AGENT_RELAY_TEST_ROOM keeps smoke-test registrations and messages out of the real room', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-mcp-smoke-'));
  const dataDir = path.join(root, 'data');
  const realRoom = path.join(root, 'real');
  const testRoom = path.join(root, 'test-room');
  await Promise.all([dataDir, realRoom, testRoom].map(dir => fs.mkdir(dir)));
  isolateEnv(t, { AGENT_RELAY_TEST_ROOM: testRoom });
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  assert.equal((await brokerRpc(broker, realRoom,
    { op: 'register', agentId: 'real-agent', runner: 'test', sessionId: 'real-session' })).ok, true);
  assert.equal((await brokerRpc(broker, testRoom,
    { op: 'register', agentId: 'test-peer', runner: 'test', sessionId: 'peer-session' })).ok, true);
  const calls = [];
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const adapter = await createMcpAdapter({ project: realRoom, runner: 'claude', sessionId: 'smoke-session',
    rpcImpl: async (project, fields) => { calls.push({ project, fields }); return brokerRpc(broker, project, fields); },
    waitImpl: async () => assert.fail('smoke test must not open a watcher') });
  const client = new Client({ name: 'smoke', version: '1' });
  await adapter.start(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await adapter.close(); await client.close(); });
  assert.equal(calls[0].fields.op, 'register');
  assert.equal(calls[0].project, testRoom);
  assert.equal(calls[0].fields.test, true);
  const send = await client.callTool({ name: 'relay_send', arguments: { to: 'test-peer', body: 'smoke-test message' } });
  assert.ok(!send.isError);
  assert.equal(unpack(send).ok, true);
  const realAgents = await brokerRpc(broker, realRoom, { op: 'agents' });
  assert.deepEqual(realAgents.agents.map(agent => agent.agentId), ['real-agent']);
  assert.equal(realAgents.counts.stored, 1);
  assert.deepEqual((await brokerRpc(broker, realRoom, { op: 'history', limit: 200 })).messages, []);
  const testAgents = await brokerRpc(broker, testRoom, { op: 'agents' });
  assert.deepEqual(testAgents.agents.map(agent => agent.agentId).sort(), ['claude-smoke-session', 'test-peer']);
  assert.deepEqual((await brokerRpc(broker, testRoom, { op: 'history', limit: 200 })).messages.map(message => message.body),
    ['smoke-test message']);
  const tools = await client.listTools();
  assert.ok(tools.tools.every(tool => tool.description.includes('AGENT_RELAY_TEST_ROOM')));
  assert.ok(tools.tools.every(tool => tool.description.includes('AGENT_RELAY_DATA_DIR')));
  assert.match(client.getInstructions(), /AGENT_RELAY_TEST_ROOM/);
});

test('test registrations fall back when the marker is rejected and AGENT_RELAY_DATA_DIR is honored', async t => {
  isolateEnv(t, { AGENT_RELAY_TEST_ROOM: '/fixture/smoke-room', AGENT_RELAY_DATA_DIR: '/fixture/smoke-data' });
  const f = await fixture(t, { expectedProject: '/fixture/smoke-room', rejectTest: true });
  const registers = f.calls.filter(call => call.op === 'register');
  assert.equal(registers.length, 2);
  assert.equal(registers[0].test, true);
  assert.equal(Object.hasOwn(registers[1], 'test'), false);
  assert.equal(f.rpcOptions[0].dataDir, '/fixture/smoke-data');
  assert.match(f.client.getInstructions(), /smoke-test room/);
});

test('MCP resource schema bound equals the broker input bound', async t => {
  const f = await fixture(t);
  const claim = f.tools.tools.find(tool => tool.name === 'relay_claim').inputSchema.properties.resources;
  const status = f.tools.tools.find(tool => tool.name === 'relay_status').inputSchema.properties.resources;
  assert.equal(status.maxItems, claim.maxItems);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-mcp-bound-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  assert.equal((await brokerRpc(broker, project,
    { op: 'register', agentId: 'bound-probe', runner: 'test', sessionId: 'bound-session' })).ok, true);
  const resources = count => Array.from({ length: count }, (_, i) => `resource-${i}`);
  assert.equal((await brokerRpc(broker, project,
    { op: 'status', agentId: 'bound-probe', resources: resources(claim.maxItems) })).ok, true);
  const refused = await brokerRpc(broker, project,
    { op: 'status', agentId: 'bound-probe', resources: resources(claim.maxItems + 1) });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'INVALID_INPUT');
  const accepted = await f.client.callTool({ name: 'relay_status', arguments: { resources: resources(claim.maxItems) } });
  assert.ok(!accepted.isError);
  const rejected = await f.client.callTool({ name: 'relay_status', arguments: { resources: resources(claim.maxItems + 1) } });
  assert.equal(rejected.isError, true);
  assert.match(unpack(rejected).error, /Invalid resources array/);
});

test('optional Codex attachment tool pins callback identity without claiming channel receipt', async t => {
  const attachments = [];
  const f = await fixture(t, { runner: 'codex', attachCodex: async input => {
    attachments.push(input);
    return { attached: true, threadId: input.threadId };
  } });
  assert.equal(f.tools.tools.length, 30);
  assert.equal(f.tools.tools.at(-1).name, 'relay_attach_codex');
  assert.deepEqual(f.tools.tools.at(-1).inputSchema.required, ['threadId']);
  assert.equal(f.tools.tools.at(-1).inputSchema.additionalProperties, false);
  assert.match(f.client.getInstructions(), /CODEX_THREAD_ID/);
  assert.match(f.client.getInstructions(), /Do not select another thread/);
  const before = f.calls.length;
  const response = await f.client.callTool({ name: 'relay_attach_codex', arguments: { threadId: 'current-thread' } });
  assert.ok(!response.isError);
  const {byteSize, maxBytes, ...attached} = unpack(response);
  assert.ok(byteSize <= maxBytes);
  assert.deepEqual(attached, { attached: true, threadId: 'current-thread' });
  assert.deepEqual(attachments, [{ threadId: 'current-thread', agentId: 'codex-test-session', project: '/fixture/project' }]);
  assert.equal(f.calls.length, before, 'attachment callback owns attachment, not an extra broker status write');
  assert.equal(f.client.getServerCapabilities().experimental, undefined);
  assert.equal(f.waitCount, 0);
  assert.ok(!f.calls.some(call => call.op === 'ack' || call.op === 'notified'));
});

test('Codex attachment rejects spoofed identity and missing/invalid thread IDs before callback', async t => {
  let invoked = 0;
  const f = await fixture(t, { runner: 'codex', attachCodex: async () => { invoked++; return { attached: true }; } });
  for (const args of [
    {}, { threadId: '' }, { threadId: 42 }, { threadId: 't', agentId: 'spoof' },
    { threadId: 't', project: '/other' }, { threadId: 't', from: 'spoof' },
  ]) {
    const response = await f.client.callTool({ name: 'relay_attach_codex', arguments: args });
    assert.equal(response.isError, true);
    assert.equal(unpack(response).ok, false);
  }
  assert.equal(invoked, 0);
});

test('Codex attachment errors and unconfirmed callback results stay failures', async t => {
  let responseKind = 'throws';
  const f = await fixture(t, { runner: 'codex', attachCodex: async () => {
    if (responseKind === 'throws') throw new Error('Existing thread does not match project');
    if (responseKind === 'unconfirmed') return { attached: false };
    return undefined;
  } });
  for (const kind of ['throws', 'unconfirmed', 'missing']) {
    responseKind = kind;
    const response = await f.client.callTool({ name: 'relay_attach_codex', arguments: { threadId: 'current-thread' } });
    assert.equal(response.isError, true);
    assert.equal(unpack(response).ok, false);
    assert.match(unpack(response).error, kind === 'throws' ? /does not match project/ : /not confirmed/);
  }
  assert.ok(!f.calls.some(call => call.op === 'ack' || call.op === 'notified'));
});
test('new tools work end to end against a real broker with bounded backlog pages', async t => {
  isolateEnv(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-mcp-wide-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  assert.equal((await brokerRpc(broker, project,
    { op: 'register', agentId: 'mcp-peer', runner: 'test', sessionId: 'peer-session' })).ok, true);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const adapter = await createMcpAdapter({ project, runner: 'claude', sessionId: 'wide-session',
    rpcImpl: async (target, fields) => brokerRpc(broker, target, fields),
    waitImpl: async () => assert.fail('this test never opens a watcher') });
  const client = new Client({ name: 'wide', version: '1' });
  await adapter.start(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await adapter.close(); await client.close(); });
  const me = adapter.agentId;
  const big = 'x'.repeat(8000);
  for (let i = 1; i <= 12; i++)
    assert.equal((await brokerRpc(broker, project, { op: 'send', agentId: 'mcp-peer', from: 'mcp-peer', to: me, body: `${big}-${i}` })).ok, true);
  const page = unpack(await client.callTool({ name: 'relay_inbox', arguments: { limit: 100 } }));
  assert.ok(page.messages.length < 12 && page.messages.length >= 1);
  assert.equal(page.messages.length + page.omitted.count, 12);
  assert.ok(page.byteSize <= 64 * 1024);
  const rest = unpack(await client.callTool({ name: 'relay_inbox', arguments: { since: page.omitted.resumeCursor, limit: 100 } }));
  assert.ok(rest.messages.length >= 1);
  assert.equal(rest.messages.length + (rest.omitted?.count ?? 0), page.omitted.count);
  const acked = unpack(await client.callTool({ name: 'relay_ack', arguments: { through: page.messages[0].cursor } }));
  assert.equal(acked.acked, 1);
  const history = unpack(await client.callTool({ name: 'relay_history', arguments: { from: 'mcp-peer', limit: 10 } }));
  assert.equal(history.scope.totalMatching, 12);
  const outbox = unpack(await client.callTool({ name: 'relay_outbox', arguments: {} }));
  assert.deepEqual(outbox.messages, []);
  const sent = unpack(await client.callTool({ name: 'relay_send', arguments: { to: 'mcp-peer', body: 'reply', messageId: 'wide-1', summary: 's' } }));
  assert.equal(sent.duplicate, false);
  const receipt = unpack(await client.callTool({ name: 'relay_receipt', arguments: { messageId: 'wide-1' } }));
  assert.equal(receipt.counts.recipients, 1);
  const machine = unpack(await client.callTool({ name: 'relay_claim', arguments: { resources: ['native'], scope: 'machine' } }));
  assert.equal(machine.owned.length, 1);
  const released = unpack(await client.callTool({ name: 'relay_release', arguments: { scope: 'machine' } }));
  assert.equal(released.released.length, 1);
  const source = path.join(root, 'packet');
  await fs.writeFile(source, 'packet bytes');
  const fileSend = unpack(await client.callTool({ name: 'relay_send', arguments: { to: 'mcp-peer', body: 'file', attachments: [source] } }));
  assert.equal(fileSend.ok, true);
  const sentId = unpack(await client.callTool({ name: 'relay_outbox', arguments: {} })).messages.at(-1).id;
  const fetched = unpack(await client.callTool({ name: 'relay_fetch', arguments: { messageId: sentId, out: path.join(root, 'fetched') } }));
  assert.equal(fetched.ok, true);
  assert.equal(fetched.files.length, 1);
  assert.equal(await fs.readFile(fetched.files[0].path, 'utf8'), 'packet bytes');
  assert.equal(unpack(await client.callTool({ name: 'relay_leave', arguments: {} })).left, me);
});

test('new coordination tools work end to end against a real broker', async t => {
  isolateEnv(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-mcp-coord-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  const forward = async (target, fields) => brokerRpc(broker, target, fields);
  const neverWatch = async () => assert.fail('this test never opens a watcher');
  const [serverA, clientA] = InMemoryTransport.createLinkedPair();
  const adapterA = await createMcpAdapter({ project, runner: 'claude', sessionId: 'coord-a',
    rpcImpl: forward, waitImpl: neverWatch });
  const mcpA = new Client({ name: 'coord-a', version: '1' });
  await adapterA.start(serverA);
  await mcpA.connect(clientA);
  const [serverB, clientB] = InMemoryTransport.createLinkedPair();
  const adapterB = await createMcpAdapter({ project, runner: 'claude', sessionId: 'coord-b',
    rpcImpl: forward, waitImpl: neverWatch });
  const mcpB = new Client({ name: 'coord-b', version: '1' });
  await adapterB.start(serverB);
  await mcpB.connect(clientB);
  t.after(async () => { await adapterA.close(); await mcpA.close(); await adapterB.close(); await mcpB.close(); });
  const meA = adapterA.agentId;
  const meB = adapterB.agentId;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  assert.equal(unpack(await mcpA.callTool({ name: 'relay_bulletin_get', arguments: {} })).version, 0);
  const set1 = await brokerRpc(broker, project,
    { op: 'setBulletin', agentId: meA, title: 'Policy', body: 'Be kind', source: 'ops' });
  assert.equal(set1.version, 1);
  const got = unpack(await mcpA.callTool({ name: 'relay_bulletin_get', arguments: {} }));
  assert.equal(got.version, 1);
  assert.equal(got.hash, set1.hash);
  const ack1 = unpack(await mcpA.callTool({ name: 'relay_bulletin_ack', arguments: { version: 1 } }));
  assert.equal(ack1.version, 1);
  assert.ok(ack1.acks.includes(meA));
  assert.equal(unpack(await mcpA.callTool({ name: 'relay_bulletin_ack', arguments: { version: 1 } })).duplicate, true);
  const set2 = await brokerRpc(broker, project,
    { op: 'setBulletin', agentId: meA, title: 'Policy v2', body: 'Be kinder', source: 'ops' });
  assert.equal(set2.version, 2);
  const stale = unpack(await mcpB.callTool({ name: 'relay_bulletin_ack', arguments: { version: 1 } }));
  assert.equal(stale.version, 1);
  assert.equal(stale.current, 2);
  assert.equal(stale.stale, true);
  assert.ok(stale.acks.includes(meB));
  const ackHash = unpack(await mcpA.callTool({ name: 'relay_bulletin_ack', arguments: { version: 2, hash: set2.hash } }));
  assert.equal(ackHash.version, 2);
  assert.ok(ackHash.acks.includes(meA));
  assert.equal((await mcpA.callTool({ name: 'relay_bulletin_ack', arguments: {} })).isError, true);
  assert.equal((await mcpA.callTool({ name: 'relay_bulletin_ack', arguments: { version: 0 } })).isError, true);
  const claimHandoff = unpack(await mcpA.callTool({ name: 'relay_claim', arguments: { resources: ['handoff.txt'] } }));
  assert.ok(claimHandoff.owned.some(row => row.agentId === meA));
  const requested = unpack(await mcpA.callTool({ name: 'relay_handoff_request',
    arguments: { to: meB, resources: ['handoff.txt'], reason: 'transfer', meta: { baseCommit: 'abc' } } }));
  assert.equal(requested.handoff.from, meA);
  assert.equal(requested.handoff.to, meB);
  assert.equal(requested.handoff.state, 'pending');
  const handoffId = requested.handoff.id;
  const listed = unpack(await mcpA.callTool({ name: 'relay_handoffs', arguments: {} }));
  assert.ok(listed.handoffs.some(row => row.id === handoffId && row.state === 'pending'));
  const accepted = unpack(await mcpB.callTool({ name: 'relay_handoff_respond',
    arguments: { id: handoffId, accept: true } }));
  assert.equal(accepted.handoff.state, 'accepted');
  const listedAgain = unpack(await mcpA.callTool({ name: 'relay_handoffs', arguments: {} }));
  assert.ok(listedAgain.handoffs.some(row => row.id === handoffId && row.state === 'accepted'));
  assert.equal((await mcpA.callTool({ name: 'relay_handoff_request', arguments: { resources: ['handoff.txt'] } })).isError, true);
  assert.equal((await mcpB.callTool({ name: 'relay_handoff_respond', arguments: { id: handoffId } })).isError, true);
  const claimDecline = unpack(await mcpA.callTool({ name: 'relay_claim', arguments: { resources: ['decline.txt'] } }));
  assert.ok(claimDecline.owned.some(row => row.agentId === meA));
  const openOffer = unpack(await mcpA.callTool({ name: 'relay_handoff_request',
    arguments: { resources: ['decline.txt'], reason: 'open offer' } }));
  assert.equal(openOffer.handoff.to, null);
  const declined = unpack(await mcpB.callTool({ name: 'relay_handoff_respond',
    arguments: { id: openOffer.handoff.id, accept: false } }));
  assert.equal(declined.handoff.state, 'declined');
  const claimSrc = unpack(await mcpA.callTool({ name: 'relay_claim', arguments: { resources: ['src'] } }));
  assert.ok(claimSrc.owned.some(row => row.agentId === meA));
  const narrowed = unpack(await mcpA.callTool({ name: 'relay_claim_narrow',
    arguments: { resource: 'src', resources: ['src/a.mjs', 'src/b.mjs'] } }));
  assert.equal(narrowed.released.length, 1);
  assert.equal(narrowed.claimed.length, 2);
  assert.equal((await mcpA.callTool({ name: 'relay_claim_narrow', arguments: { resource: 'src' } })).isError, true);
  const claimBlocked = unpack(await mcpB.callTool({ name: 'relay_claim', arguments: { resources: ['blocked.txt'] } }));
  assert.ok(claimBlocked.owned.some(row => row.agentId === meB));
  const upserted = unpack(await mcpA.callTool({ name: 'relay_tasks',
    arguments: { action: 'upsert', title: 'Needs blocked', blockedBy: ['blocked.txt'], resources: ['blocked.txt'] } }));
  assert.equal(upserted.task.state, 'open');
  assert.equal(upserted.task.blocked, true);
  const taskId = upserted.task.id;
  const listAll = unpack(await mcpA.callTool({ name: 'relay_tasks', arguments: { action: 'list' } }));
  assert.ok(listAll.tasks.some(row => row.id === taskId && row.blocked === true));
  const listBlocked = unpack(await mcpA.callTool({ name: 'relay_tasks', arguments: { action: 'list', blocked: true } }));
  assert.ok(listBlocked.tasks.some(row => row.id === taskId));
  assert.ok(listBlocked.tasks.every(row => row.blocked === true));
  const listUnblocked = unpack(await mcpA.callTool({ name: 'relay_tasks', arguments: { action: 'list', blocked: false } }));
  assert.ok(!listUnblocked.tasks.some(row => row.id === taskId));
  const completed = unpack(await mcpA.callTool({ name: 'relay_tasks',
    arguments: { action: 'complete', id: taskId, verification: 'ran checks' } }));
  assert.equal(completed.task.state, 'complete');
  const listComplete = unpack(await mcpA.callTool({ name: 'relay_tasks',
    arguments: { action: 'list', state: 'complete' } }));
  assert.ok(listComplete.tasks.some(row => row.id === taskId));
  assert.equal((await mcpA.callTool({ name: 'relay_tasks', arguments: { action: 'remove' } })).isError, true);
  const registered = await brokerRpc(broker, project,
    { op: 'processes', action: 'register', agentId: meA, pid: process.pid, command: 'coord-probe' });
  assert.equal(registered.process.pid, process.pid);
  const processes = unpack(await mcpA.callTool({ name: 'relay_processes_list', arguments: {} }));
  assert.ok(processes.processes.some(row => row.pid === process.pid && row.agentId === meA));
  const owned = unpack(await mcpA.callTool({ name: 'relay_processes_list', arguments: { owner: meA } }));
  assert.ok(owned.processes.some(row => row.pid === process.pid));
  const foreign = unpack(await mcpA.callTool({ name: 'relay_processes_list', arguments: { owner: meB } }));
  assert.ok(!foreign.processes.some(row => row.pid === process.pid));
  assert.equal((await brokerRpc(broker, project,
    { op: 'register', agentId: meA, runner: 'test', sessionId: 'coord-a', groupId: 'g-coord' })).group.id, 'g-coord');
  const project2 = path.join(root, 'project2');
  await fs.mkdir(project2);
  assert.equal((await brokerRpc(broker, project2,
    { op: 'register', agentId: 'group-peer', runner: 'test', sessionId: 'peer', groupId: 'g-coord' })).group.id, 'g-coord');
  const group = unpack(await mcpA.callTool({ name: 'relay_group_agents', arguments: {} }));
  assert.equal(group.groupId, 'g-coord');
  assert.ok(group.rooms.length >= 2);
  assert.ok(group.agents.some(row => row.agentId === meA));
  const explicit = unpack(await mcpA.callTool({ name: 'relay_group_agents', arguments: { groupId: 'g-coord' } }));
  assert.equal(explicit.groupId, 'g-coord');
  assert.equal(explicit.rooms.length, group.rooms.length);
  const sent1 = unpack(await mcpA.callTool({ name: 'relay_send', arguments: { to: meB, body: 'history-one' } }));
  await delay(10);
  const sent2 = unpack(await mcpA.callTool({ name: 'relay_send',
    arguments: { to: meB, body: 'history-two', replyTo: sent1.messageId } }));
  await delay(10);
  const sent3 = unpack(await mcpA.callTool({ name: 'relay_send', arguments: { to: meB, body: 'history-three' } }));
  assert.ok(sent1.messageId && sent2.messageId && sent3.messageId);
  const full = unpack(await mcpA.callTool({ name: 'relay_history', arguments: { limit: 50 } }));
  assert.equal(full.scope.totalMatching, 3);
  const [first, , last] = full.messages;
  const thread = unpack(await mcpA.callTool({ name: 'relay_history',
    arguments: { threadOf: sent1.messageId, limit: 50 } }));
  assert.ok(thread.messages.some(row => row.messageId === sent2.messageId));
  assert.ok(!thread.messages.some(row => row.messageId === sent1.messageId));
  const afterFirst = unpack(await mcpA.callTool({ name: 'relay_history',
    arguments: { afterTs: first.createdAt, limit: 50 } }));
  assert.ok(!afterFirst.messages.some(row => row.messageId === first.messageId));
  assert.ok(afterFirst.scope.totalMatching < 3);
  const beforeLast = unpack(await mcpA.callTool({ name: 'relay_history',
    arguments: { beforeTs: last.createdAt, limit: 50 } }));
  assert.ok(!beforeLast.messages.some(row => row.messageId === last.messageId));
  assert.ok(beforeLast.scope.totalMatching < 3);
  const beforeCursor = unpack(await mcpA.callTool({ name: 'relay_history',
    arguments: { before: last.cursor, limit: 50 } }));
  assert.ok(beforeCursor.messages.length >= 1);
  assert.ok(beforeCursor.messages.every(row => row.cursor < last.cursor));
  assert.equal((await mcpA.callTool({ name: 'relay_history', arguments: { afterTs: 'not-a-time' } })).isError, true);
});

test('count-limited inbox/history/outbox pages resume to every row exactly once', async t => {
  isolateEnv(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-mcp-count-pages-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  assert.equal((await brokerRpc(broker, project,
    { op: 'register', agentId: 'count-peer', runner: 'test', sessionId: 'peer' })).ok, true);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const adapter = await createMcpAdapter({ project, runner: 'claude', sessionId: 'count-me',
    rpcImpl: async (target, fields) => brokerRpc(broker, target, fields),
    waitImpl: async () => assert.fail('no watcher') });
  const client = new Client({ name: 'count', version: '1' });
  await adapter.start(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await adapter.close(); await client.close(); });
  const me = adapter.agentId;
  for (let i = 1; i <= 12; i++)
    assert.equal((await brokerRpc(broker, project,
      { op: 'send', agentId: 'count-peer', from: 'count-peer', to: me, body: `in-${i}` })).ok, true);
  for (let i = 1; i <= 12; i++)
    assert.equal(unpack(await client.callTool({ name: 'relay_send', arguments: { to: 'count-peer', body: `out-${i}` } })).ok, true);
  const inboxSeen = [];
  let since = 0;
  for (let guard = 0; guard < 10; guard++) {
    const page = unpack(await client.callTool({ name: 'relay_inbox', arguments: { since, limit: 5 } }));
    assert.ok(page.messages.length <= 5);
    assert.equal(page.omitted, null);
    assert.ok(page.byteSize <= 64 * 1024);
    for (const m of page.messages) inboxSeen.push(m.messageId);
    if (page.messages.length === 0) break;
    since = page.cursor;
    if (inboxSeen.length === 12) {
      const tail = unpack(await client.callTool({ name: 'relay_inbox', arguments: { since, limit: 5 } }));
      assert.deepEqual(tail.messages, []);
      break;
    }
  }
  assert.equal(inboxSeen.length, 12);
  assert.equal(new Set(inboxSeen).size, 12);
  const historySeen = [];
  since = 0;
  for (let guard = 0; guard < 10; guard++) {
    const page = unpack(await client.callTool({ name: 'relay_history', arguments: { since, limit: 5, from: 'count-peer' } }));
    assert.ok(page.messages.length <= 5);
    assert.equal(page.omitted, null);
    if (page.omitted !== null) assert.equal(page.done, false);
    for (const m of page.messages) historySeen.push(m.messageId);
    if (page.done) break;
    assert.equal(page.nextCursor, page.messages.at(-1).cursor);
    since = page.nextCursor;
  }
  assert.equal(historySeen.length, 12);
  assert.equal(new Set(historySeen).size, 12);
  assert.deepEqual([...historySeen].sort(), [...inboxSeen].sort());
  const outboxSeen = [];
  since = 0;
  for (let guard = 0; guard < 10; guard++) {
    const page = unpack(await client.callTool({ name: 'relay_outbox', arguments: { since, limit: 5 } }));
    assert.ok(page.messages.length <= 5);
    assert.equal(page.omitted, null);
    if (page.omitted !== null) assert.equal(page.done, false);
    for (const m of page.messages) outboxSeen.push(m.id);
    if (page.done) break;
    assert.equal(page.nextCursor, page.messages.at(-1).cursor);
    since = page.nextCursor;
  }
  assert.equal(outboxSeen.length, 12);
  assert.equal(new Set(outboxSeen).size, 12);
});

test('byte-limited inbox/history/outbox pages keep consistent continuation', async t => {
  isolateEnv(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-mcp-byte-pages-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  assert.equal((await brokerRpc(broker, project,
    { op: 'register', agentId: 'byte-peer', runner: 'test', sessionId: 'peer' })).ok, true);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const adapter = await createMcpAdapter({ project, runner: 'claude', sessionId: 'byte-me',
    rpcImpl: async (target, fields) => brokerRpc(broker, target, fields),
    waitImpl: async () => assert.fail('no watcher') });
  const client = new Client({ name: 'byte', version: '1' });
  await adapter.start(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await adapter.close(); await client.close(); });
  const me = adapter.agentId;
  const big = 'x'.repeat(8000);
  for (let i = 1; i <= 12; i++)
    assert.equal((await brokerRpc(broker, project,
      { op: 'send', agentId: 'byte-peer', from: 'byte-peer', to: me, body: `${big}-${i}` })).ok, true);
  const inboxSeen = [];
  let since = 0;
  let truncated = false;
  for (let guard = 0; guard < 10; guard++) {
    const page = unpack(await client.callTool({ name: 'relay_inbox', arguments: { since, limit: 100 } }));
    assert.ok(page.byteSize <= 64 * 1024);
    assert.ok(page.messages.length >= 1);
    if (page.omitted) {
      truncated = true;
      assert.equal(page.cursor, page.messages.at(-1).cursor);
      assert.equal(page.omitted.resumeCursor, page.messages.at(-1).cursor);
      if (Object.hasOwn(page, 'done')) assert.equal(page.done, false);
      assert.equal(page.done !== true || page.omitted === null, true);
    }
    for (const m of page.messages) inboxSeen.push(m.messageId);
    if (!page.omitted) break;
    since = page.omitted.resumeCursor;
  }
  assert.ok(truncated);
  assert.equal(inboxSeen.length, 12);
  assert.equal(new Set(inboxSeen).size, 12);
  const historySeen = [];
  since = 0;
  truncated = false;
  for (let guard = 0; guard < 10; guard++) {
    const page = unpack(await client.callTool({ name: 'relay_history', arguments: { since, limit: 100, from: 'byte-peer' } }));
    assert.ok(page.byteSize <= 64 * 1024);
    if (page.omitted) {
      truncated = true;
      assert.equal(page.nextCursor, page.messages.at(-1).cursor);
      assert.equal(page.omitted.resumeCursor, page.messages.at(-1).cursor);
      assert.equal(page.done, false);
    } else if (!page.done) {
      assert.equal(page.nextCursor, page.messages.at(-1).cursor);
    }
    assert.equal(page.done === true && page.omitted !== null, false);
    for (const m of page.messages) historySeen.push(m.messageId);
    if (page.done && !page.omitted) break;
    since = page.omitted ? page.omitted.resumeCursor : page.nextCursor;
  }
  assert.ok(truncated);
  assert.equal(historySeen.length, 12);
  assert.equal(new Set(historySeen).size, 12);
  for (let i = 1; i <= 12; i++)
    assert.equal(unpack(await client.callTool({ name: 'relay_send', arguments: { to: 'byte-peer', body: `${big}-out-${i}` } })).ok, true);
  const outboxSeen = [];
  since = 0;
  truncated = false;
  for (let guard = 0; guard < 10; guard++) {
    const page = unpack(await client.callTool({ name: 'relay_outbox', arguments: { since, limit: 100 } }));
    assert.ok(page.byteSize <= 64 * 1024);
    if (page.omitted) {
      truncated = true;
      assert.equal(page.nextCursor, page.messages.at(-1).cursor);
      assert.equal(page.omitted.resumeCursor, page.messages.at(-1).cursor);
      assert.equal(page.done, false);
    } else if (!page.done) {
      assert.equal(page.nextCursor, page.messages.at(-1).cursor);
    }
    assert.equal(page.done === true && page.omitted !== null, false);
    for (const m of page.messages) {
      assert.ok(Number.isSafeInteger(m.cursor));
      outboxSeen.push(m.id);
    }
    if (page.done && !page.omitted) break;
    since = page.omitted ? page.omitted.resumeCursor : page.nextCursor;
  }
  assert.ok(truncated);
  assert.equal(outboxSeen.length, 12);
  assert.equal(new Set(outboxSeen).size, 12);
});

test('unread forwards directly and matches broker acknowledgement state', async t => {
  isolateEnv(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-mcp-unread-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  assert.equal((await brokerRpc(broker, project,
    { op: 'register', agentId: 'unread-peer', runner: 'test', sessionId: 'peer' })).ok, true);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const adapter = await createMcpAdapter({ project, runner: 'claude', sessionId: 'unread-me',
    rpcImpl: async (target, fields) => brokerRpc(broker, target, fields),
    waitImpl: async () => assert.fail('no watcher') });
  const client = new Client({ name: 'unread', version: '1' });
  await adapter.start(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await adapter.close(); await client.close(); });
  const me = adapter.agentId;
  const first = await brokerRpc(broker, project,
    { op: 'send', agentId: 'unread-peer', from: 'unread-peer', to: me, body: 'first' });
  const second = await brokerRpc(broker, project,
    { op: 'send', agentId: 'unread-peer', from: 'unread-peer', to: me, body: 'second' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(unpack(await client.callTool({ name: 'relay_ack', arguments: { messageId: first.messageId } })).ok, true);
  const onlyUnread = unpack(await client.callTool({ name: 'relay_inbox', arguments: { unread: true, limit: 50 } }));
  assert.deepEqual(onlyUnread.messages.map(m => m.messageId), [second.messageId]);
  const withRead = unpack(await client.callTool({ name: 'relay_inbox', arguments: { unread: false, limit: 50 } }));
  assert.equal(withRead.messages.length, 2);
  assert.ok(withRead.messages.some(m => m.messageId === first.messageId));
  assert.ok(withRead.messages.some(m => m.messageId === second.messageId));
  const omitted = unpack(await client.callTool({ name: 'relay_inbox', arguments: { limit: 50 } }));
  assert.deepEqual(omitted.messages.map(m => m.messageId), [second.messageId]);
});

test('800-recipient broadcast receipt stays bounded with full counts and resumable offsets', async t => {
  isolateEnv(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-mcp-receipt-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const adapter = await createMcpAdapter({ project, runner: 'claude', sessionId: 'receipt-me',
    rpcImpl: async (target, fields) => brokerRpc(broker, target, fields),
    waitImpl: async () => assert.fail('no watcher') });
  const client = new Client({ name: 'receipt', version: '1' });
  await adapter.start(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await adapter.close(); await client.close(); });
  const me = adapter.agentId;
  for (let i = 0; i < 800; i++)
    assert.equal((await brokerRpc(broker, project,
      { op: 'register', agentId: `fanout-${i}`, runner: 'test', sessionId: `s-${i}` })).ok, true);
  const sent = unpack(await client.callTool({ name: 'relay_send', arguments: { to: '*', body: 'broadcast', messageId: 'fanout-1' } }));
  assert.equal(sent.ok, true);
  const first = unpack(await client.callTool({ name: 'relay_receipt', arguments: { messageId: 'fanout-1' } }));
  assert.equal(first.counts.recipients, 800);
  assert.equal(first.recipientsTotal, 800);
  assert.equal(first.recipients.length, 100);
  assert.equal(first.recipientsOffset, 0);
  assert.equal(first.nextRecipientsOffset, 100);
  assert.equal(first.hasMoreRecipients, true);
  assert.equal(first.pendingTotal, 800);
  assert.equal(first.pending.length, 100);
  assert.equal(first.pendingOffset, 0);
  assert.equal(first.nextPendingOffset, 100);
  assert.equal(first.hasMorePending, true);
  assert.equal(first.counts.pending + first.counts.missing + first.counts.acked + first.counts.accepted + first.counts.notified <= 800, true);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 64 * 1024);
  const explicit = unpack(await client.callTool({ name: 'relay_receipt', arguments: { messageId: 'fanout-1', recipientsLimit: 10, recipientsOffset: 5 } }));
  assert.equal(explicit.recipients.length, 10);
  assert.equal(explicit.recipientsOffset, 5);
  assert.equal(explicit.recipientsTotal, 800);
  assert.equal(explicit.counts.recipients, 800);
  assert.equal(explicit.pendingTotal, 800);
  assert.ok(Buffer.byteLength(JSON.stringify(explicit)) <= 64 * 1024);
  const pendingExplicit = unpack(await client.callTool({ name: 'relay_receipt', arguments: { messageId: 'fanout-1', pendingLimit: 10, pendingOffset: 5 } }));
  assert.equal(pendingExplicit.pending.length, 10);
  assert.equal(pendingExplicit.pendingOffset, 5);
  assert.equal(pendingExplicit.pendingTotal, 800);
  assert.equal(pendingExplicit.nextPendingOffset, 15);
  assert.equal(pendingExplicit.hasMorePending, true);
  assert.ok(Buffer.byteLength(JSON.stringify(pendingExplicit)) <= 64 * 1024);
  const second = unpack(await client.callTool({ name: 'relay_receipt', arguments: { messageId: 'fanout-1', recipientsLimit: 100, recipientsOffset: 100, pendingLimit: 100, pendingOffset: 100 } }));
  assert.equal(second.recipients.length, 100);
  assert.equal(second.recipientsOffset, 100);
  assert.equal(second.recipientsTotal, 800);
  assert.equal(second.nextRecipientsOffset, 200);
  assert.equal(second.hasMoreRecipients, true);
  assert.equal(second.pending.length, 100);
  assert.equal(second.pendingOffset, 100);
  assert.equal(second.pendingTotal, 800);
  assert.equal(second.nextPendingOffset, 200);
  assert.equal(second.hasMorePending, true);
  assert.ok(Buffer.byteLength(JSON.stringify(second)) <= 64 * 1024);
  assert.notDeepEqual(second.recipients.map(r => r.agentId).sort(), first.recipients.map(r => r.agentId).sort());
  const seen = [];
  let offset = 0;
  for (let guard = 0; guard < 12; guard++) {
    const page = unpack(await client.callTool({ name: 'relay_receipt', arguments: { messageId: 'fanout-1', recipientsLimit: 100, recipientsOffset: offset } }));
    assert.equal(page.counts.recipients, 800);
    assert.equal(page.recipientsTotal, 800);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 64 * 1024);
    for (const r of page.recipients) seen.push(r.agentId);
    if (!page.hasMoreRecipients) break;
    offset = page.nextRecipientsOffset;
  }
  assert.equal(seen.length, 800);
  assert.equal(new Set(seen).size, 800);
  const pendingSeen = [];
  let pendingOffset = 0;
  for (let guard = 0; guard < 12; guard++) {
    const page = unpack(await client.callTool({ name: 'relay_receipt', arguments: { messageId: 'fanout-1', pendingLimit: 100, pendingOffset } }));
    assert.equal(page.pendingTotal, 800);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 64 * 1024);
    for (const r of page.pending) pendingSeen.push(r.agentId);
    if (!page.hasMorePending) break;
    pendingOffset = page.nextPendingOffset;
  }
  assert.equal(pendingSeen.length, 800);
  assert.equal(new Set(pendingSeen).size, 800);
  const outbox = unpack(await client.callTool({ name: 'relay_outbox', arguments: {} }));
  assert.equal(outbox.messages.length, 1);
  assert.equal(outbox.messages[0].recipients.length, 25);
  assert.equal(outbox.messages[0].recipientsTotal, 800);
  assert.equal(outbox.messages[0].pending.length, 25);
  assert.equal(outbox.messages[0].pendingTotal, 800);
  assert.equal(outbox.messages[0].counts.recipients, 800);
  assert.ok(Buffer.byteLength(JSON.stringify(outbox)) <= 64 * 1024);
  const outboxExplicit = unpack(await client.callTool({ name: 'relay_outbox', arguments: { recipientsLimit: 10, pendingLimit: 10 } }));
  assert.equal(outboxExplicit.messages.length, 1);
  assert.equal(outboxExplicit.messages[0].recipients.length, 10);
  assert.equal(outboxExplicit.messages[0].recipientsTotal, 800);
  assert.equal(outboxExplicit.messages[0].pending.length, 10);
  assert.equal(outboxExplicit.messages[0].pendingTotal, 800);
  assert.ok(Buffer.byteLength(JSON.stringify(outboxExplicit)) <= 64 * 1024);
});

test('large agent listing is bounded with continuation', async t => {
  isolateEnv(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-mcp-agents-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const adapter = await createMcpAdapter({ project, runner: 'claude', sessionId: 'agents-me',
    rpcImpl: async (target, fields) => brokerRpc(broker, target, fields),
    waitImpl: async () => assert.fail('no watcher') });
  const client = new Client({ name: 'agents', version: '1' });
  await adapter.start(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await adapter.close(); await client.close(); });
  for (let i = 0; i < 150; i++)
    assert.equal((await brokerRpc(broker, project,
      { op: 'register', agentId: `listed-${i}`, runner: 'test', sessionId: `s-${i}` })).ok, true);
  const first = unpack(await client.callTool({ name: 'relay_agents', arguments: {} }));
  assert.equal(first.total, 151);
  assert.equal(first.agents.length, 100);
  assert.equal(first.nextOffset, 100);
  assert.equal(first.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 64 * 1024);
  const rest = unpack(await client.callTool({ name: 'relay_agents', arguments: { offset: 100 } }));
  assert.equal(rest.total, 151);
  assert.equal(rest.agents.length, 51);
  assert.ok(Buffer.byteLength(JSON.stringify(rest)) <= 64 * 1024);
  const explicit = unpack(await client.callTool({ name: 'relay_agents', arguments: { limit: 10 } }));
  assert.equal(explicit.agents.length, 10);
  assert.equal(explicit.total, 151);
  assert.ok(Buffer.byteLength(JSON.stringify(explicit)) <= 64 * 1024);
});

test('max-size task metadata stays bounded', async t => {
  isolateEnv(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-mcp-task-bound-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const adapter = await createMcpAdapter({ project, runner: 'claude', sessionId: 'task-bound-me',
    rpcImpl: async (target, fields) => brokerRpc(broker, target, fields),
    waitImpl: async () => assert.fail('no watcher') });
  const client = new Client({ name: 'task-bound', version: '1' });
  await adapter.start(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await adapter.close(); await client.close(); });
  const bigVerification = 'v'.repeat(4096);
  const bigResources = Array.from({ length: 10 }, (_, i) => `resource-${i}-` + 'r'.repeat(100));
  const bigBlockedBy = Array.from({ length: 10 }, (_, i) => `blocker-${i}-` + 'b'.repeat(100));
  const created = unpack(await client.callTool({ name: 'relay_tasks',
    arguments: { action: 'upsert', title: 'Max metadata', verification: bigVerification, resources: bigResources, blockedBy: bigBlockedBy } }));
  assert.equal(created.task.verification, bigVerification);
  assert.ok(Buffer.byteLength(JSON.stringify(created)) <= 64 * 1024);
  const listed = unpack(await client.callTool({ name: 'relay_tasks', arguments: { action: 'list' } }));
  assert.ok(listed.tasks.some(row => row.id === created.task.id));
  assert.ok(Buffer.byteLength(JSON.stringify(listed)) <= 64 * 1024);
  const bulletin = unpack(await client.callTool({ name: 'relay_bulletin_get', arguments: {} }));
  assert.ok(Buffer.byteLength(JSON.stringify(bulletin)) <= 64 * 1024);
  const handoffs = unpack(await client.callTool({ name: 'relay_handoffs', arguments: {} }));
  assert.ok(Buffer.byteLength(JSON.stringify(handoffs)) <= 64 * 1024);
  const group = unpack(await client.callTool({ name: 'relay_group_agents', arguments: { groupId: 'g-task-bound' } }));
  assert.ok(Buffer.byteLength(JSON.stringify(group)) <= 64 * 1024);
});

test('channel close reports disconnected transport', async t => {
  isolateEnv(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-mcp-close-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const adapter = await createMcpAdapter({ project, runner: 'claude', sessionId: 'close-me', channel: true,
    rpcImpl: async (target, fields) => brokerRpc(broker, target, fields),
    waitImpl: async (target, agentId, after, { signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'));
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) });
  const client = new Client({ name: 'close', version: '1' });
  await adapter.start(serverTransport);
  await client.connect(clientTransport);
  const me = adapter.agentId;
  let connected = null;
  for (let i = 0; i < 50; i++) {
    const agents = await brokerRpc(broker, project, { op: 'agents', transport: 'connected' });
    if (agents.agents.some(a => a.agentId === me)) { connected = agents; break; }
    await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(connected);
  await adapter.close();
  await client.close();
  const disconnected = await brokerRpc(broker, project, { op: 'agents', transport: 'disconnected' });
  assert.ok(disconnected.agents.some(a => a.agentId === me));
  const stillConnected = await brokerRpc(broker, project, { op: 'agents', transport: 'connected' });
  assert.ok(!stillConnected.agents.some(a => a.agentId === me));
});

test('transient transport report failure does not disable later reports', async t => {
  isolateEnv(t);
  const calls = [];
  let transportCalls = 0;
  const rpcImpl = async (project, fields) => {
    calls.push(fields);
    if (fields.op === 'register' || fields.op === 'agents') return { ok: true, agents: [], counts: {} };
    if (fields.op === 'status' && fields.transport) {
      transportCalls++;
      if (transportCalls === 1) {
        const error = new Error('ECONNREFUSED');
        error.code = 'ECONNREFUSED';
        throw error;
      }
      return { ok: true, agent: { agentId: 'x' }, claims: [] };
    }
    return { ok: true, ...fields };
  };
  let waits = 0;
  const waitImpl = async () => {
    waits++;
    if (waits === 1) throw new Error('ECONNREFUSED');
    return { ok: true, cursor: 0, messages: [] };
  };
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const errors = [];
  const adapter = await createMcpAdapter({ project: '/fixture/project', runner: 'claude', sessionId: 'transient-me',
    channel: true, rpcImpl, waitImpl, onError: m => errors.push(m) });
  const client = new Client({ name: 'transient', version: '1' });
  await adapter.start(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await adapter.close(); await client.close(); });
  for (let i = 0; i < 50; i++) {
    if (calls.filter(c => c.op === 'status' && c.transport?.state === 'connected').length >= 2) break;
    await new Promise(r => setTimeout(r, 20));
  }
  const connectedReports = calls.filter(c => c.op === 'status' && c.transport?.state === 'connected');
  const disconnectedReports = calls.filter(c => c.op === 'status' && c.transport?.state === 'disconnected');
  assert.ok(disconnectedReports.length >= 1);
  assert.ok(connectedReports.length >= 2);
  assert.ok(calls.some(c => c.op === 'status' && c.transport?.state === 'disconnected'));
});

test('task blocker and resource lists clear end to end against a real broker', async t => {
  isolateEnv(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-mcp-clear-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const adapter = await createMcpAdapter({ project, runner: 'claude', sessionId: 'clear-me',
    rpcImpl: async (target, fields) => brokerRpc(broker, target, fields),
    waitImpl: async () => assert.fail('no watcher') });
  const client = new Client({ name: 'clear', version: '1' });
  await adapter.start(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { try { await adapter.close(); } catch {} try { await client.close(); } catch {} });
  const claimed = unpack(await client.callTool({ name: 'relay_claim', arguments: { resources: ['clear-block.txt'] } }));
  assert.ok(claimed.owned.some(row => row.agentId === adapter.agentId));
  const created = unpack(await client.callTool({ name: 'relay_tasks',
    arguments: { action: 'upsert', title: 'Clearable', blockedBy: ['clear-block.txt'], resources: ['clear-res.txt'] } }));
  assert.deepEqual(created.task.blockedBy, ['clear-block.txt']);
  assert.deepEqual(created.task.resources, ['clear-res.txt']);
  assert.equal(created.task.blocked, true);
  const cleared = unpack(await client.callTool({ name: 'relay_tasks',
    arguments: { action: 'upsert', id: created.task.id, blockedBy: [], resources: [] } }));
  assert.deepEqual(cleared.task.blockedBy, []);
  assert.deepEqual(cleared.task.resources, []);
  assert.equal(cleared.task.blocked, false);
  const listed = unpack(await client.callTool({ name: 'relay_tasks', arguments: { action: 'list' } }));
  const row = listed.tasks.find(entry => entry.id === created.task.id);
  assert.deepEqual(row.blockedBy, []);
  assert.deepEqual(row.resources, []);
  assert.equal(row.blocked, false);
  const badClaim = await client.callTool({ name: 'relay_claim', arguments: { resources: [] } });
  assert.equal(badClaim.isError, true);
  assert.match(unpack(badClaim).error, /Invalid resources array/);
});

test('peer transport close reports disconnected transport once', async t => {
  isolateEnv(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-mcp-peer-close-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  let disconnects = 0;
  const forward = async (target, fields) => {
    if (fields.op === 'status' && fields.transport?.state === 'disconnected') disconnects += 1;
    return brokerRpc(broker, target, fields);
  };
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const adapter = await createMcpAdapter({ project, runner: 'claude', sessionId: 'peer-close-me', channel: true,
    rpcImpl: forward,
    waitImpl: async (target, agentId, after, { signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'));
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) });
  const client = new Client({ name: 'peer-close', version: '1' });
  await adapter.start(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { try { await adapter.close(); } catch {} try { await client.close(); } catch {} });
  const me = adapter.agentId;
  let connected = false;
  for (let i = 0; i < 50; i++) {
    const agents = await brokerRpc(broker, project, { op: 'agents', transport: 'connected' });
    if (agents.agents.some(entry => entry.agentId === me)) { connected = true; break; }
    await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(connected);
  await client.close();
  let disconnected = false;
  for (let i = 0; i < 50; i++) {
    const agents = await brokerRpc(broker, project, { op: 'agents', transport: 'disconnected' });
    if (agents.agents.some(entry => entry.agentId === me)) { disconnected = true; break; }
    await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(disconnected);
  assert.ok(!(await brokerRpc(broker, project, { op: 'agents', transport: 'connected' })).agents.some(entry => entry.agentId === me));
  await adapter.close();
  assert.ok((await brokerRpc(broker, project, { op: 'agents', transport: 'disconnected' })).agents.some(entry => entry.agentId === me));
  assert.equal(disconnects, 1);
});

test('explicit close reports disconnected transport once', async t => {
  isolateEnv(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-mcp-explicit-close-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); });
  let disconnects = 0;
  const forward = async (target, fields) => {
    if (fields.op === 'status' && fields.transport?.state === 'disconnected') disconnects += 1;
    return brokerRpc(broker, target, fields);
  };
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const adapter = await createMcpAdapter({ project, runner: 'claude', sessionId: 'explicit-close-me', channel: true,
    rpcImpl: forward,
    waitImpl: async (target, agentId, after, { signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'));
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) });
  const client = new Client({ name: 'explicit-close', version: '1' });
  await adapter.start(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { try { await adapter.close(); } catch {} try { await client.close(); } catch {} });
  const me = adapter.agentId;
  let connected = false;
  for (let i = 0; i < 50; i++) {
    const agents = await brokerRpc(broker, project, { op: 'agents', transport: 'connected' });
    if (agents.agents.some(entry => entry.agentId === me)) { connected = true; break; }
    await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(connected);
  await adapter.close();
  await client.close();
  assert.ok((await brokerRpc(broker, project, { op: 'agents', transport: 'disconnected' })).agents.some(entry => entry.agentId === me));
  assert.ok(!(await brokerRpc(broker, project, { op: 'agents', transport: 'connected' })).agents.some(entry => entry.agentId === me));
  assert.equal(disconnects, 1);
});
