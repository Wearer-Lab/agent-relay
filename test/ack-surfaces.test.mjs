import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createBroker} from '../lib/broker.mjs';
import {createMcpAdapter} from '../lib/mcp.mjs';
import {AgentRelayPlugin} from '../lib/opencode-plugin.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/agent-relay.mjs', import.meta.url));

// A broker over a temporary data directory, plus the CLI that talks to it.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-surfaces-'));
  const dataDir = path.join(root, 'data'), project = path.join(root, 'project');
  await fs.mkdir(dataDir); await fs.mkdir(project);
  let broker = await createBroker({dataDir, port: 0, pruneAfterMinutes: 0, compactAfterDays: 0});
  // The discovery file is how the CLI finds a running broker.
  await fs.writeFile(path.join(dataDir, 'broker.json'),
    JSON.stringify({pid: process.pid, url: broker.url, token: broker.token, api: '/api/v1/rpc'}), {mode: 0o600});
  t.after(async () => {
    await broker.close();
    await fs.rm(root, {recursive: true, force: true, maxRetries: 15, retryDelay: 200});
  });
  const run = async (...args) => {
    const {stdout} = await exec(process.execPath, [cli, ...args, '--project', project, '--data-dir', dataDir],
      {timeout: 30000, env: {...process.env, AGENT_RELAY_PRUNE_AFTER_MINUTES: '0'}});
    return stdout.trim() ? JSON.parse(stdout) : null;
  };
  const raw = async (...args) => (await exec(process.execPath, [cli, ...args, '--project', project, '--data-dir', dataDir],
    {timeout: 30000, env: {...process.env, AGENT_RELAY_PRUNE_AFTER_MINUTES: '0'}})).stdout;
  // Close the broker, age the identities, reopen: a live agent is never swept.
  const age = async (agentIds, minutes) => {
    await broker.close();
    const file = path.join(dataDir, 'state.json');
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    const when = new Date(Date.now() - minutes * 60000).toISOString();
    for (const room of state.rooms) for (const agent of room.agents) {
      if (agentIds.includes(agent.agentId)) agent.updatedAt = when;
    }
    await fs.writeFile(file, JSON.stringify(state));
    broker = await createBroker({dataDir, port: 0, pruneAfterMinutes: 0, compactAfterDays: 0});
    await fs.writeFile(path.join(dataDir, 'broker.json'),
      JSON.stringify({pid: process.pid, url: broker.url, token: broker.token, api: '/api/v1/rpc'}), {mode: 0o600});
  };
  const rpc = async fields => {
    const response = await fetch(`${broker.url}/api/v1/rpc`, {
      method: 'POST', headers: {authorization: `Bearer ${broker.token}`, 'content-type': 'application/json'},
      body: JSON.stringify({project, ...fields}),
    });
    const body = await response.json();
    if (!body.ok) { const error = new Error(body.error?.message); error.code = body.error?.code; throw error; }
    return body;
  };
  return {root, dataDir, project, broker, run, raw, rpc, age};
}

test('the CLI parses the new flags: a boolean never swallows the next argument', async t => {
  const f = await fixture(t);
  await f.run('join', '--as', 'a', '--runner', 'codex');
  await f.run('join', '--as', 'b', '--runner', 'codex');
  // --stale is a boolean; the value after it belongs to the next flag.
  const bulk = await f.run('leave', '--stale', '--idle-hours', '24', '--apply', '--json');
  assert.equal(bulk.dryRun, false);
  assert.equal(typeof bulk.total.candidates, 'number');
  // --apply alone is not a sweep: it never turns one identity into many.
  const single = await f.run('leave', '--as', 'b', '--if-idle');
  assert.equal(single.left, 'b');
});

test('agent-relay pending prints the breakdown and changes nothing', async t => {
  const f = await fixture(t);
  await f.run('join', '--as', 'a', '--runner', 'codex');
  await f.run('join', '--as', 'b', '--runner', 'codex');
  await f.run('send', '--as', 'a', '--to', 'b', '--message', 'hello', '--id', 'm1');
  const before = (await f.rpc({op: 'usage'})).messages.used;
  const pending = await f.run('pending', '--json');
  assert.equal(pending.total, 1);
  assert.equal(pending.counts.live, 1);
  assert.equal(pending.groups.find(group => group.key === 'awaiting-live').count, 1);
  assert.equal((await f.rpc({op: 'usage'})).messages.used, before, 'the ledger did not change');
  // The human output says the same thing.
  const text = await f.raw('pending');
  assert.match(text, /awaiting live agents: 1/);
  // --json prints the broker's own report.
  const json = await f.run('pending', '--json');
  assert.equal(json.total, 1);
});

test('the bulk sweep is a dry run, and --apply matches it', async t => {
  const f = await fixture(t);
  await f.run('join', '--as', 'a', '--runner', 'codex');
  await f.run('join', '--as', 'b', '--runner', 'codex');
  await f.rpc({op: 'claim', agentId: 'a', resources: ['build']});
  // A live identity is never swept, so age the two identities first.
  await f.age(['a', 'b'], 200);
  const dry = await f.run('leave', '--stale', '--idle-hours', '0', '--json');
  assert.equal(dry.dryRun, true);
  assert.equal(dry.changed, 0);
  assert.deepEqual(dry.candidates.map(row => row.agentId), ['b'], 'the identity that holds a claim is kept');
  assert.equal(dry.kept.find(row => row.agentId === 'a').obligations.claims.length, 1);
  const applied = await f.run('leave', '--stale', '--idle-hours', '0', '--apply', '--json');
  assert.equal(applied.dryRun, false);
  assert.deepEqual(applied.candidates.map(row => row.agentId), ['b']);
  assert.equal(applied.changed, 1);
  // The identity that held the claim is still active.
  const agents = await f.run('agents');
  assert.ok(agents.agents.some(row => row.agentId === 'a'));
});

test('the migration refuses to run while a broker owns the data directory', async t => {
  const f = await fixture(t);
  await f.run('join', '--as', 'a', '--runner', 'codex');
  await assert.rejects(() => f.run('migrate', '--to', '2'), /live broker owns this data directory/);
  // The dry run of the plan needs no broker: it only reads the ledger.
  await f.broker.close();
  const plan = await f.run('migrate', '--to', '2', '--dry-run');
  assert.equal(plan.dryRun, true);
  assert.equal(plan.to, 2);
});

test('the MCP tools forward the new operations exactly', async t => {
  const calls = [];
  const rpcImpl = async (project, fields) => { calls.push(fields); return {ok: true, ...fields}; };
  const waitImpl = async () => new Promise(() => {});
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const adapter = await createMcpAdapter({project: '/fixture/project', runner: 'codex', rpcImpl, waitImpl, onError() {}, onWarning() {}});
  const client = new Client({name: 'c', version: '1'});
  await adapter.start(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await adapter.close(); await client.close(); });

  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('relay_pending'));
  assert.ok(names.includes('relay_retire'));
  assert.ok(names.includes('relay_compact'));

  await client.callTool({name: 'relay_pending', arguments: {by: 'state', limit: 10}});
  assert.deepEqual(calls.findLast(call => call.op === 'pending'), {op: 'pending', by: 'state', limit: 10});

  await client.callTool({name: 'relay_compact', arguments: {broadcastTtlDays: 7, directTtlDays: 30}});
  assert.deepEqual(calls.findLast(call => call.op === 'compact'), {op: 'compact', broadcastTtlDays: 7, directTtlDays: 30, dryRun: true});

  await client.callTool({name: 'relay_leave', arguments: {stale: true, idleHours: 24}});
  assert.deepEqual(calls.findLast(call => call.op === 'leave'), {op: 'leave', stale: true, idleHours: 24});

  await client.callTool({name: 'relay_retire', arguments: {stale: true, apply: true}});
  assert.deepEqual(calls.findLast(call => call.op === 'retire'), {op: 'retire', stale: true, apply: true});

  // A plain leave still leaves the caller's own identity.
  await client.callTool({name: 'relay_leave', arguments: {}});
  assert.equal(calls.findLast(call => call.op === 'leave').agentId, adapter.agentId);
});

test('the OpenCode tools mirror the MCP surface', async t => {
  const calls = [];
  const transport = {
    async rpc(project, fields) { calls.push(fields); return {ok: true, ...fields}; },
    // The wait ends when the session is disposed, so the plugin can shut down.
    wait(project, agentId, after, {signal}) { return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true})); },
  };
  const directory = '/tmp/relay-surfaces-project', sessionID = 'ses_surfaces';
  const hooks = await AgentRelayPlugin({client: {tui: {async showToast() { return {data: true}; }}, session: {async status() { return {data: {}}; }}}, directory, worktree: directory}, {transport, dataDir: '/tmp/relay-surfaces-isolated'});
  t.after(() => hooks.dispose());
  const ctx = {sessionID, directory, worktree: directory, agent: 'build', abort: new AbortController().signal};
  const id = 'opencode:' + sessionID;
  await hooks.tool.relay_pending.execute({by: 'recipient', limit: 5}, ctx);
  assert.deepEqual(calls.findLast(call => call.op === 'pending'), {op: 'pending', by: 'recipient', limit: 5, agentId: id});
  await hooks.tool.relay_retire.execute({stale: true, idleHours: 12}, ctx);
  assert.deepEqual(calls.findLast(call => call.op === 'retire'), {op: 'retire', stale: true, idleHours: 12, agentId: id});
  await hooks.tool.relay_compact.execute({directTtlDays: 30}, ctx);
  assert.deepEqual(calls.findLast(call => call.op === 'compact'), {op: 'compact', directTtlDays: 30, dryRun: true, agentId: id});
});
