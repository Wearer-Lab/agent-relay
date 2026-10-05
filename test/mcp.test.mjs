import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createMcpAdapter, runMcp } from '../lib/mcp.mjs';

const channelSchema = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
});
const unpack = response => JSON.parse(response.content[0].text);

async function fixture(t, { channel = false, rejectedOp, failFirstNotification = false, runner = 'claude', attachCodex } = {}) {
  const calls = [];
  let waitCount = 0;
  const waitCursors = [];
  const errors = [];
  const waitListeners = [];
  let waiter;
  let abortObserved = false;
  let notifiedResolve;
  const notified = new Promise(resolve => { notifiedResolve = resolve; });
  const rpcImpl = async (project, fields) => {
    assert.equal(project, '/fixture/project');
    calls.push(fields);
    if (fields.op === rejectedOp) return { ok: false, error: 'fixture conflict' };
    if (fields.op === 'agents') return { ok: true, agents: [{ agentId: 'peer' }], claims: [], cursor: 0 };
    if (fields.op === 'inbox') return { ok: true, messages: [{ messageId: 'old-unacked' }] };
    if (fields.op === 'notified') notifiedResolve(fields);
    return { ok: true, ...fields };
  };
  const waitImpl = async (project, agentId, after, { signal }) => {
    assert.equal(project, '/fixture/project');
    assert.equal(agentId, 'claude-test-session');
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
    sessionId: 'test-session', channel, rpcImpl, waitImpl, attachCodex, onError: message => errors.push(message) });
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
  return { adapter, client, calls, tools, received, notified, firstReceived, errors, waitCursors,
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
    ['relay_agents', 'relay_send', 'relay_inbox', 'relay_ack', 'relay_status', 'relay_claim', 'relay_release']);
  const operations = [
    ['relay_agents', {}, { op: 'agents' }],
    ['relay_send', { to: 'peer', body: 'File frozen', replyTo: 'message-1' },
      { op: 'send', from: f.adapter.agentId, to: 'peer', body: 'File frozen', replyTo: 'message-1' }],
    ['relay_inbox', {}, { op: 'inbox', agentId: f.adapter.agentId }],
    ['relay_ack', { messageId: 'message-1' }, { op: 'ack', agentId: f.adapter.agentId, messageId: 'message-1' }],
    ['relay_status', { status: 'reviewing', frozen: true, resources: ['a.swift'], task: null },
      { op: 'status', agentId: f.adapter.agentId, status: 'reviewing', frozen: true, resources: ['a.swift'], task: null }],
    ['relay_claim', { resources: ['a.swift', 'build'] },
      { op: 'claim', agentId: f.adapter.agentId, resources: ['a.swift', 'build'] }],
    ['relay_release', { resources: ['a.swift'] }, { op: 'release', agentId: f.adapter.agentId, resources: ['a.swift'] }],
    ['relay_release', {}, { op: 'release', agentId: f.adapter.agentId }],
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

test('invalid/spoofed arguments and broker conflicts cannot look successful', async t => {
  const f = await fixture(t, { rejectedOp: 'claim' });
  for (const [name, args] of [
    ['relay_send', { to: 'peer', body: 'x', from: 'another-agent' }],
    ['relay_ack', { messageId: 'm', agentId: 'another-agent' }],
    ['relay_claim', { resources: [] }], ['relay_claim', { resources: [42] }],
    ['relay_status', { frozen: 'yes' }], ['relay_status', { task: 'x'.repeat(8_193) }],
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

test('runMcp supports injected transport and generates unique fresh registration', async t => {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const calls = [];
  const adapter = await runMcp({ project: '/fixture/project', runner: 'codex', transport: serverTransport,
    rpcImpl: async (_, fields) => { calls.push(fields); return { ok: true }; },
    waitImpl: async () => assert.fail('generic MCP cannot imply wake') });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientTransport);
  t.after(async () => { await adapter.close(); await client.close(); });
  assert.match(adapter.agentId, /^codex-[0-9a-f-]{36}$/);
  assert.equal(calls[0].sessionId, adapter.sessionId);
  await assert.rejects(adapter.start(serverTransport), /cannot be started twice/);
});

test('optional Codex attachment tool pins callback identity without claiming channel receipt', async t => {
  const attachments = [];
  const f = await fixture(t, { runner: 'codex', attachCodex: async input => {
    attachments.push(input);
    return { attached: true, threadId: input.threadId };
  } });
  assert.equal(f.tools.tools.length, 8);
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
