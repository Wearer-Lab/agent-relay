import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureBroker, recordOwnerRefusal, resolveNodeRuntime } from '../lib/client.mjs';
import { probeNode, recordNodeRuntime, renameWithRetry } from '../lib/runtime.mjs';
import { createLogWriter } from '../lib/logwriter.mjs';
import { createBroker } from '../lib/broker.mjs';

const temp = prefix => fs.mkdtemp(path.join(os.tmpdir(), prefix));
const ISO_LINE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /mu;

test('the broker spawn command is a real Node runtime, never the host binary', async () => {
  const host = '/opt/homebrew/bin/opencode';
  const resolved = await resolveNodeRuntime({ execPath: host, versions: { bun: '1.2.0' }, env: { PATH: process.env.PATH } });
  assert.notEqual(resolved.command, host, 'the host binary is never spawned');
  assert.match(path.basename(resolved.command), /node/u);
  const probe = await probeNode(resolved.command);
  assert.equal(probe.ok, true, probe.reason);
});

test('the recorded runtime is read back and preferred over the host binary', async () => {
  const root = await temp('relay-ack-record-');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir);
  await recordNodeRuntime(dataDir, { command: process.execPath, source: 'exec-path', version: process.versions.node });
  const resolved = await resolveNodeRuntime({ dataDir, execPath: '/opt/homebrew/bin/opencode', versions: { bun: '1.2.0' } });
  assert.equal(resolved.command, process.execPath);
  assert.equal(resolved.source, 'data-dir');
  await fs.rm(root, { recursive: true, force: true });
});

test('the runtime the setup step recorded in the project is read back', async () => {
  const root = await temp('relay-ack-project-');
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'agent-relay': { command: process.execPath, args: ['cli'] } } }));
  const fromMcp = await resolveNodeRuntime({ project, execPath: '/opt/homebrew/bin/opencode', versions: { bun: '1.2.0' } });
  assert.equal(fromMcp.command, process.execPath);
  assert.equal(fromMcp.source, 'project');
  await fs.writeFile(path.join(project, '.mcp.json'), '{}');
  await fs.mkdir(path.join(project, '.codex'));
  await fs.writeFile(path.join(project, '.codex', 'config.toml'),
    `[mcp_servers.agent-relay]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["cli"]\n`);
  const fromCodex = await resolveNodeRuntime({ project, execPath: '/opt/homebrew/bin/opencode', versions: { bun: '1.2.0' } });
  assert.equal(fromCodex.command, process.execPath);
  assert.equal(fromCodex.source, 'project');
  await fs.rm(root, { recursive: true, force: true });
});

test('a missing Node gives one clear error that names the fix', async () => {
  await assert.rejects(resolveNodeRuntime({
    env: {}, execPath: '/opt/homebrew/bin/opencode', versions: { bun: '1.2.0' },
    lookup: async () => null, probe: async () => ({ ok: false, reason: 'not found' }),
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  }), error => {
    assert.match(error.message, /Node 20 or newer/u);
    assert.match(error.message, /OpenCode/u);
    assert.match(error.message, /agent-relay setup --refresh/u);
    assert.match(error.message, /AGENT_RELAY_NODE/u);
    return true;
  });
});

test('a client without Node refuses to spawn and names the fix', async t => {
  const root = await temp('relay-ack-nonode-');
  const previous = process.env.AGENT_RELAY_NODE;
  process.env.AGENT_RELAY_NODE = path.join(root, 'no-such-node');
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENT_RELAY_NODE;
    else process.env.AGENT_RELAY_NODE = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  await assert.rejects(ensureBroker({ dataDir: path.join(root, 'data') }), /AGENT_RELAY_NODE/u);
  await assert.rejects(ensureBroker({ dataDir: path.join(root, 'data') }), /not a usable Node runtime/u);
});

test('the discovery rename retries the Windows sharing failures', async () => {
  let calls = 0;
  const rename = async () => {
    calls++;
    if (calls <= 2) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    return 'renamed';
  };
  assert.equal(await renameWithRetry('a', 'b', { platform: 'win32', rename }), 'renamed');
  assert.equal(calls, 3, 'two failures, then one success');
  // A permission error that is not a Windows sharing failure is not retried.
  await assert.rejects(renameWithRetry('a', 'b', {
    platform: 'linux',
    rename: async () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); },
  }), /busy/u);
});

test('startup cleanup removes stale temp files and old backups, and leaves the live files alone', async t => {
  const root = await temp('relay-ack-cleanup-');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir);
  let broker = await createBroker({ dataDir, pruneAfterMinutes: 0, compactAfterDays: 0 });
  await broker.close();
  // What a crashed run leaves behind.
  await fs.writeFile(path.join(dataDir, 'broker.json.4242.tmp'), '{}');
  await fs.writeFile(path.join(dataDir, '.state-1111.tmp'), '{}');
  const backups = [];
  for (let index = 0; index < 3; index++) {
    const name = `state.backup-${1700000000000 + index * 1000}.json`;
    const file = path.join(dataDir, name);
    await fs.writeFile(file, '{}');
    await fs.utimes(file, new Date(1700000000000 + index * 1000), new Date(1700000000000 + index * 1000));
    backups.push(name);
  }
  broker = await createBroker({ dataDir, pruneAfterMinutes: 0, compactAfterDays: 0, keepBackups: 2 });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true }); });
  const names = await fs.readdir(dataDir);
  assert.ok(!names.includes('broker.json.4242.tmp'), 'the stale discovery temp file is gone');
  assert.ok(!names.includes('.state-1111.tmp'), 'the stale state temp file is gone');
  assert.ok(!names.includes(backups[0]), 'the oldest state backup is gone');
  assert.ok(names.includes(backups[1]) && names.includes(backups[2]), 'the newest backups are kept');
  for (const live of ['state.json', 'token']) assert.ok(names.includes(live), `${live} is untouched`);
  assert.ok(broker.cleanup.removed.includes('broker.json.4242.tmp'));
  assert.ok(broker.cleanup.removed.includes('.state-1111.tmp'));
  assert.deepEqual(broker.cleanup.kept.sort(), [backups[1], backups[2]].sort());
});

test('the broker log rotates by size and keeps the bound', async () => {
  const root = await temp('relay-ack-log-');
  const file = path.join(root, 'broker.log');
  const writer = createLogWriter({ file, maxBytes: 2048, keep: 2 });
  for (let index = 0; index < 200; index++) writer.write(`line ${index} ${'x'.repeat(60)}\n`);
  await writer.close();
  const size = (await fs.stat(file)).size;
  assert.ok(size <= 2048, `the log grew to ${size} bytes`);
  const rotated = (await fs.readdir(root)).filter(name => name.startsWith('broker.log.'));
  assert.ok(rotated.length <= 2, `kept ${rotated.length} rotated files`);
  const text = await fs.readFile(file, 'utf8');
  assert.match(text, ISO_LINE);
  assert.match(text, /line \d+ /u);
});

test('another live broker owns this directory is recorded once per owning pid', async () => {
  const root = await temp('relay-ack-refusal-');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir);
  assert.equal((await recordOwnerRefusal(dataDir, 4242)).recorded, true);
  assert.equal((await recordOwnerRefusal(dataDir, 4242)).recorded, false);
  assert.equal((await recordOwnerRefusal(dataDir, 4343)).recorded, true);
  const lines = (await fs.readFile(path.join(dataDir, 'owner-refusal.log'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /pid=4242 /u);
  assert.match(lines[1], /pid=4343 /u);
  await fs.rm(root, { recursive: true, force: true });
});

test('a live owner of the data directory is refused once, not on every client start', async t => {
  const root = await temp('relay-ack-owner-');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(dataDir, 'writer.lock'), JSON.stringify({ version: 1, pid: process.pid, nonce: 'live' }));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await assert.rejects(ensureBroker({ dataDir, startupTimeoutMs: 300 }),
    /Another live broker owns this data directory \(pid \d+\)/u);
  await assert.rejects(ensureBroker({ dataDir, startupTimeoutMs: 300 }),
    /Another live broker owns this data directory/u);
  const lines = (await fs.readFile(path.join(dataDir, 'owner-refusal.log'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1, 'the refusal is written once per owning pid');
  assert.match(lines[0], new RegExp(`pid=${process.pid} `, 'u'));
});

test('ensureBroker starts the daemon on Node, records the runtime and writes a timestamped log', async t => {
  const root = await temp('relay-ack-spawn-');
  const dataDir = path.join(root, 'data');
  t.after(async () => {
    try {
      const { pid } = JSON.parse(await fs.readFile(path.join(dataDir, 'broker.json'), 'utf8'));
      process.kill(pid, 'SIGTERM');
      for (let index = 0; index < 50; index++) {
        try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); } catch { break; }
      }
    } catch { /* no daemon */ }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  });
  const info = await ensureBroker({ dataDir });
  assert.ok(info.pid > 0);
  const record = JSON.parse(await fs.readFile(path.join(dataDir, 'node-runtime.json'), 'utf8'));
  const probe = await probeNode(record.command);
  assert.equal(probe.ok, true, `the daemon runs ${record.command}: ${probe.reason}`);
  // The daemon writes its own output: one timestamped line per message.
  const deadline = Date.now() + 5000;
  let text = '';
  while (Date.now() < deadline) {
    text = await fs.readFile(path.join(dataDir, 'broker.log'), 'utf8').catch(() => '');
    if (ISO_LINE.test(text)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.match(text, ISO_LINE);
  assert.match(text, /broker listening on http:\/\/127\.0\.0\.1:\d+/u);
});
