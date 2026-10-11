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
    ['relay_agents', 'relay_send', 'relay_inbox', 'relay_ack', 'relay_status', 'relay_claim', 'relay_release',
      'relay_leave', 'relay_fetch', 'relay_outbox', 'relay_receipt', 'relay_history']);
  const operations = [
    ['relay_agents', {}, { op: 'agents' }],
    ['relay_agents', { active: true, within: 5, transport: 'connected' },
      { op: 'agents', active: true, within: 5, transport: 'connected' }],
    ['relay_send', { to: 'peer', body: 'File frozen', replyTo: 'message-1' },
      { op: 'send', from: f.adapter.agentId, to: 'peer', body: 'File frozen', replyTo: 'message-1' }],
    ['relay_send', { to: 'peer', body: 'Full', summary: 's', messageId: 'stable-1' },
      { op: 'send', from: f.adapter.agentId, to: 'peer', body: 'Full', summary: 's', messageId: 'stable-1' }],
    ['relay_inbox', {}, { op: 'inbox', agentId: f.adapter.agentId, limit: 50 }],
    ['relay_inbox', { unread: true, since: 7, limit: 2, from: 'peer' },
      { op: 'inbox', agentId: f.adapter.agentId, unacked: false, since: 7, limit: 2, from: 'peer' }],
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
    ['relay_receipt', { messageId: 'message-1' }, { op: 'receipt', messageId: 'message-1' }],
    ['relay_outbox', {}, { op: 'outbox', from: f.adapter.agentId, limit: 50 }],
    ['relay_history', { acked: true, threadOf: 'message-1' },
      { op: 'history', agentId: f.adapter.agentId, limit: 50, acked: true, threadOf: 'message-1' }],
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
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true }); });
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
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true }); });
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
  assert.equal(f.tools.tools.length, 13);
  assert.equal(f.tools.tools.at(-1).name, 'relay_attach_codex');
  assert.deepEqual(f.tools.tools.at(-1).inputSchema.required, ['threadId']);
  assert.equal(f.tools.tools.at(-1).inputSchema.additionalProperties, false);
  assert.match(f.client.getInstructions(), /CODEX_THREAD_ID/);
  assert.match(f.client.getInstructions(), /Do not select another thread/);
  const before = f.calls.length;
  const response = await f.client.callTool({ name: 'relay_attach_codex', arguments: { threadId: 'current-thread' } });
  assert.ok(!response.isError);
  assert.deepEqual(unpack(response), { attached: true, threadId: 'current-thread' });
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
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true }); });
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
