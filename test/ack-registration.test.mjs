// Lane 05: fewer identities. Lazy registration, one identity per runner session id,
// and the two broadcast guards (a fresh probe never joins a '*' broadcast, '*all' is
// rate limited per sender).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBroker } from '../lib/broker.mjs';
import { createMcpAdapter } from '../lib/mcp.mjs';
import { AgentRelayPlugin } from '../lib/opencode-plugin.mjs';
import { sessionIdentity, resolveIdentity, fallbackSession, broadcastAllLimitMessage,
  BROADCAST_ALL_LIMIT, BROADCAST_ALL_WINDOW_MS } from '../lib/registration.mjs';

const runNode = promisify(execFile);
const registrationModule = new URL('../lib/registration.mjs', import.meta.url).href;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function flush() { for (let i = 0; i < 5; i++) await tick(); }

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-registration-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  let broker = await createBroker({ dataDir });
  t.after(async () => {
    await broker.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  });
  async function request(fields, room = project) {
    const response = await fetch(broker.url + '/rpc', {
      method: 'POST', headers: { authorization: 'Bearer ' + broker.token, 'content-type': 'application/json' },
      body: JSON.stringify({ project: room, ...fields }),
    });
    return { status: response.status, ...(await response.json()) };
  }
  async function rpc(fields, room = project) {
    const result = await request(fields, room);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  }
  const stateFile = path.join(dataDir, 'state.json');
  return { root, dataDir, project, request, rpc, stateFile,
    get broker() { return broker; },
    // Close, edit the persisted ledger, reopen.
    async restart(mutate) {
      await broker.close();
      if (mutate) {
        const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        mutate(state);
        await fs.writeFile(stateFile, JSON.stringify(state));
      }
      broker = await createBroker({ dataDir });
      return broker;
    } };
}

/** One MCP adapter on the in-memory transport, against the real broker. */
async function mcpAdapter(t, f, { sessionId = 'session-1', runner = 'claude', connect = true } = {}) {
  const calls = [];
  let announce;
  const registered = new Promise(resolve => { announce = resolve; });
  const rpcImpl = async (project, fields) => {
    calls.push(fields);
    if (fields.op === 'register') announce();
    const response = await fetch(f.broker.url + '/rpc', {
      method: 'POST', headers: { authorization: 'Bearer ' + f.broker.token, 'content-type': 'application/json' },
      body: JSON.stringify({ project, ...fields }),
    });
    const body = await response.json();
    if (!response.ok || body.ok === false) {
      throw Object.assign(new Error(body.error?.message ?? 'Relay broker rejected the request'), { code: body.error?.code });
    }
    return body;
  };
  const adapter = await createMcpAdapter({ project: f.project, runner, sessionId, dataDir: f.dataDir, rpcImpl,
    waitImpl: async () => assert.fail('this fixture opens no watcher'),
    onError() {}, onWarning() {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await adapter.start(serverTransport);
  let client;
  if (connect) {
    client = new Client({ name: 'registration-fixture', version: '1' });
    await client.connect(clientTransport);
    await registered;
  }
  t.after(async () => { await adapter.close(); await client?.close(); });
  return { adapter, client, calls, registered };
}

/** One OpenCode plugin on a recording transport. */
async function plugin(f) {
  const calls = [];
  const transport = {
    async rpc(project, fields) { calls.push({ project, ...fields }); return { ok: true, ...fields }; },
    wait(project, agentId, after, { signal }) {
      return new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    },
  };
  const client = {
    tui: { async showToast() { return { data: true }; } },
    session: { async status() { return { data: {} }; } },
  };
  const hooks = await AgentRelayPlugin({ client, directory: f.project, worktree: f.project }, { transport, dataDir: f.dataDir });
  return { hooks, calls, client };
}

test('the identity rule is one identity per runner session id, and the broker agrees', async t => {
  assert.equal(sessionIdentity('claude', 'abc'), 'claude-abc');
  assert.equal(sessionIdentity('codex', 'abc'), 'codex-abc');
  assert.equal(sessionIdentity('opencode', 'ses_abc'), 'opencode:ses_abc');
  const f = await fixture(t);
  // A client that only knows its session gets the session's identity.
  const derived = await f.rpc({ op: 'register', runner: 'codex', sessionId: 'derived' });
  assert.equal(derived.agent.agentId, 'codex-derived');
  // A pinned name is the owner's choice and is kept.
  const pinned = await f.rpc({ op: 'register', agentId: 'worker-3', runner: 'codex', sessionId: 'derived-2' });
  assert.equal(pinned.agent.agentId, 'worker-3');
});

test('an MCP adapter that starts and exits without a tool call leaves no record', async t => {
  const f = await fixture(t);
  const { adapter, calls } = await mcpAdapter(t, f, { connect: false });
  await adapter.close();
  assert.deepEqual(calls, [], 'nothing reached the broker before the client spoke');
  const room = await f.rpc({ op: 'agents' });
  assert.deepEqual(room.agents, [], 'no identity at all');
});

test('the OpenCode plugin starts and exits without a tool call leaves no record', async t => {
  const f = await fixture(t);
  const { hooks, calls } = await plugin(f);
  await hooks.dispose();
  assert.deepEqual(calls, [], 'nothing reached the broker before a session used the relay');
  const room = await f.rpc({ op: 'agents' });
  assert.deepEqual(room.agents, [], 'no identity at all');
});

test('the OpenCode plugin identity follows the shared session rule', async t => {
  const f = await fixture(t);
  const { hooks, calls } = await plugin(f);
  t.after(() => hooks.dispose());
  await hooks['chat.message']({ sessionID: 'ses_abc' }, { message: { info: { id: 'm1', sessionID: 'ses_abc', role: 'user' } } });
  await flush();
  const registration = calls.find(call => call.op === 'register');
  assert.equal(registration.agentId, sessionIdentity('opencode', 'ses_abc'));
  assert.equal(registration.agentId, 'opencode:ses_abc');
  assert.equal(registration.sessionId, 'ses_abc');
});

test('two MCP processes of one session share one identity', async t => {
  const f = await fixture(t);
  const first = await mcpAdapter(t, f, { sessionId: 'shared-session' });
  const second = await mcpAdapter(t, f, { sessionId: 'shared-session' });
  assert.equal(first.adapter.agentId, 'claude-shared-session');
  assert.equal(second.adapter.agentId, first.adapter.agentId);
  assert.equal(first.calls.find(call => call.op === 'register').agentId, first.adapter.agentId);
  const room = await f.rpc({ op: 'agents' });
  assert.deepEqual(room.agents.map(agent => agent.agentId), ['claude-shared-session'],
    'the second process attached to the identity the session already owns');
});

test('a restart inside the session reuses the temporary identity', async t => {
  const f = await fixture(t);
  const first = resolveIdentity({ runner: 'codex', dataDir: f.dataDir, treeKey: '4242' });
  assert.match(first.sessionId, /^tmp-/);
  assert.equal(first.fallback, true);
  assert.equal(first.agentId, `codex-${first.sessionId}`);
  // A new process has no memory of the id: it reads it back from the data dir.
  const script = `import(${JSON.stringify(registrationModule)}).then(m => process.stdout.write(`
    + `m.fallbackSession({ runner: 'codex', dataDir: ${JSON.stringify(f.dataDir)}, treeKey: '4242' }).sessionId));`;
  const { stdout } = await runNode(process.execPath, ['-e', script]);
  assert.equal(stdout, first.sessionId, 'the restart reused the remembered identity');
  // The broker stores that identity, not a second one.
  const registered = await f.rpc({ op: 'register', agentId: first.agentId, runner: 'codex', sessionId: first.sessionId });
  assert.equal(registered.agent.agentId, first.agentId);
  const room = await f.rpc({ op: 'agents' });
  assert.deepEqual(room.agents.map(agent => agent.agentId), [first.agentId]);
});

test('a restart inside the session reuses the identity the MCP adapter computes', async t => {
  const f = await fixture(t);
  const first = await mcpAdapter(t, f, { sessionId: 'restart-session' });
  assert.equal(first.adapter.agentId, 'claude-restart-session');
  // The same session after a restart: the same identity, one row in the room.
  const again = await mcpAdapter(t, f, { sessionId: 'restart-session' });
  assert.equal(again.adapter.agentId, first.adapter.agentId);
  const room = await f.rpc({ op: 'agents' });
  assert.deepEqual(room.agents.map(agent => agent.agentId), ['claude-restart-session']);
});

test('a fresh probe identity is excluded from a `*` broadcast', async t => {
  const f = await fixture(t);
  await f.rpc({ op: 'register', agentId: 'sender', runner: 'codex', sessionId: 'sender-session' });
  await f.rpc({ op: 'register', agentId: 'codex-tmp-probe', runner: 'codex', sessionId: 'tmp-probe' });
  await f.rpc({ op: 'register', agentId: 'peer', runner: 'codex', sessionId: 'peer-session' });
  const sent = await f.rpc({ op: 'send', from: 'sender', to: '*', body: 'hello', messageId: 'm1' });
  assert.deepEqual(sent.recipients, ['peer'], 'a probe that just registered has not proved it is there');
  assert.equal(sent.audience.excluded, 1);
  const inbox = await f.rpc({ op: 'inbox', agentId: 'codex-tmp-probe' });
  assert.deepEqual(inbox.messages, [], 'the probe received nothing');
  // A probe that reported a transport has proved it is there and joins the audience.
  await f.rpc({ op: 'status', agentId: 'codex-tmp-probe', transport: { adapter: 'mcp-watch', state: 'connected' } });
  const proven = await f.rpc({ op: 'send', from: 'sender', to: '*', body: 'again', messageId: 'm2' });
  assert.deepEqual(proven.recipients.sort(), ['codex-tmp-probe', 'peer']);
});

test('the `*all` limit triggers for a sender and comes back on its own', async t => {
  const f = await fixture(t);
  await f.rpc({ op: 'register', agentId: 'sender', runner: 'codex', sessionId: 'sender-session' });
  await f.rpc({ op: 'register', agentId: 'peer', runner: 'codex', sessionId: 'peer-session' });
  for (let i = 0; i < BROADCAST_ALL_LIMIT; i++) {
    await f.rpc({ op: 'send', from: 'sender', to: '*all', body: 'everyone', messageId: `m-${i}` });
  }
  const refused = await f.request({ op: 'send', from: 'sender', to: '*all', body: 'everyone', messageId: 'm-refused' });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 429);
  assert.equal(refused.error.code, 'BROADCAST_ALL_RATE_LIMIT');
  assert.equal(refused.error.message, broadcastAllLimitMessage());
  assert.equal(refused.error.limit, BROADCAST_ALL_LIMIT);
  // Another sender has its own budget.
  await f.rpc({ op: 'register', agentId: 'other', runner: 'codex', sessionId: 'other-session' });
  const other = await f.rpc({ op: 'send', from: 'other', to: '*all', body: 'everyone', messageId: 'm-other' });
  assert.deepEqual(other.recipients.sort(), ['peer', 'sender']);
  // An hour later the budget is back, without any operator step.
  const aged = new Date(Date.now() - BROADCAST_ALL_WINDOW_MS - 60_000).toISOString();
  await f.restart(state => { for (const message of state.rooms[0].messages) message.createdAt = aged; });
  const recovered = await f.rpc({ op: 'send', from: 'sender', to: '*all', body: 'everyone', messageId: 'm-recovered' });
  assert.deepEqual(recovered.recipients.sort(), ['other', 'peer']);
});

test('the `*all` error message suggests a bulletin and stays stable', () => {
  const message = broadcastAllLimitMessage();
  assert.match(message, /bulletin/i);
  assert.equal(message, broadcastAllLimitMessage());
  assert.match(message, new RegExp(String(BROADCAST_ALL_LIMIT)));
});

test('the remembered temporary identity is per process tree and per runner', async t => {
  const f = await fixture(t);
  const one = fallbackSession({ runner: 'claude', dataDir: f.dataDir, treeKey: '11' });
  const same = fallbackSession({ runner: 'claude', dataDir: f.dataDir, treeKey: '11' });
  const other = fallbackSession({ runner: 'codex', dataDir: f.dataDir, treeKey: '11' });
  const tree = fallbackSession({ runner: 'claude', dataDir: f.dataDir, treeKey: '12' });
  assert.equal(same.sessionId, one.sessionId, 'the same process tree keeps the same identity');
  assert.notEqual(other.sessionId, one.sessionId, 'every runner has its own identity');
  assert.notEqual(tree.sessionId, one.sessionId, 'every process tree has its own identity');
  for (const session of [one, other, tree]) assert.match(session.sessionId, /^tmp-/);
});
