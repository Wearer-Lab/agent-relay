import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createBroker, validateStore } from '../lib/broker.mjs';
import { mutate, encodeState, stateBytes, createMessageCache } from '../lib/ledger.mjs';
import { planCompaction } from '../lib/compaction.mjs';
import { largeState } from '../scripts/bench-broker.mjs';

const cli = fileURLToPath(new URL('../bin/agent-relay.mjs', import.meta.url));
const DAY = 864e5;

async function fixture(t, options = {}, seed) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'relay-write-')));
  const dataDir = path.join(root, 'data'), project = path.join(root, 'project');
  await fs.mkdir(dataDir); await fs.mkdir(project);
  if (seed) await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify(seed(project)));
  let broker = await createBroker({ dataDir, pruneAfterMinutes: 0, compactAfterDays: 0, ...options });
  t.after(async () => {
    await broker?.close();
    // Stop a CLI-started daemon before deleting its data dir (after hooks run in registration order).
    try {
      const { pid } = JSON.parse(await fs.readFile(path.join(dataDir, 'broker.json'), 'utf8'));
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 100)); } catch { break; } }
    } catch { /* no CLI daemon */ }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  });
  const raw = async (fields, room = project) => {
    const response = await fetch(`${broker.url}/rpc`, { method: 'POST',
      headers: { authorization: `Bearer ${broker.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ project: room, ...fields }) });
    return { status: response.status, ...(await response.json()) };
  };
  const call = async (fields, room) => {
    const result = await raw(fields, room);
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, status: result.status });
    return result;
  };
  const disk = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  const restart = async (next = {}) => { await broker.close(); broker = await createBroker({ dataDir, pruneAfterMinutes: 0, compactAfterDays: 0, ...next }); };
  return { root, dataDir, project, call, raw, disk, restart, get broker() { return broker; } };
}

// Count atomic replacements of state.json (the broker's durable writes).
function countStateWrites(t) {
  const real = fs.rename, rows = [];
  fs.rename = async (from, to, ...rest) => { if (String(to).endsWith('state.json')) rows.push(to); return real.call(fs, from, to, ...rest); };
  t.after(() => { fs.rename = real; });
  return rows;
}

test('the cached serializer is byte-identical to JSON.stringify and reports exact UTF-8 size', () => {
  const state = largeState('/work/p', { agents: 60, live: 5, messages: 300, broadcasts: 10 });
  state.rooms[0].agents[0].task = { note: 'naïve 😀', skip: undefined };
  state.rooms[0].messages[3].body = 'emoji 😀 and escapes "\n\\';
  state.extra = { list: [1, undefined, 'x'] };
  const row = createMessageCache();
  for (let pass = 0; pass < 2; pass++) {
    const [chunks, bytes] = encodeState(state, row), text = chunks.join('');
    assert.equal(text, JSON.stringify(state));
    assert.equal(bytes, Buffer.byteLength(text));
    assert.equal(stateBytes(state, row), bytes);
  }
});

test('mutations are atomic, share unchanged messages and return plain results', () => {
  const base = largeState('/work/p', { agents: 20, live: 4, messages: 50, broadcasts: 5 });
  const before = JSON.stringify(base);
  assert.throws(() => mutate(base, draft => { draft.rooms[0].messages[0].body = 'changed'; throw new Error('late failure'); }), /late failure/);
  assert.equal(JSON.stringify(base), before, 'a throwing mutator leaves the base untouched');
  const { next, result } = mutate(base, draft => {
    const message = draft.rooms[0].messages.find(m => m.messageId === 'm-10');
    message.ackedBy = [...new Set([...message.ackedBy, message.recipients[0]])];
    return { message };
  });
  assert.notEqual(next.rooms[0].messages[9], base.rooms[0].messages[9]);
  assert.equal(next.rooms[0].messages[8], base.rooms[0].messages[8], 'unchanged messages keep their identity');
  assert.equal(JSON.stringify(result.message), JSON.stringify(next.rooms[0].messages[9]), 'results are plain data, usable after the draft is gone');
  assert.equal(mutate(base, () => {}).next, base, 'a mutator that changes nothing returns the same ledger');
  assert.throws(() => mutate(base, async () => {}), /synchronous/);
});

test('incremental validation skips known-good messages but still rejects new corruption and disorder', () => {
  const state = largeState('/work/p', { agents: 20, live: 4, messages: 40, broadcasts: 4 });
  const validated = new WeakSet();
  validateStore(state, { validated });
  const bad = structuredClone(state.rooms[0].messages.at(-1));
  bad.messageId = 'bad'; bad.cursor = 41; bad.recipients = ['ghost']; bad.ackedBy = []; bad.acks = []; bad.notified = [];
  const corrupt = { ...state, nextCursor: 42, rooms: [{ ...state.rooms[0], cursor: 41, messages: [...state.rooms[0].messages, bad] }] };
  assert.throws(() => validateStore(corrupt, { validated }), /corrupt/);
  const swapped = state.rooms[0].messages.slice(); [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  assert.throws(() => validateStore({ ...state, rooms: [{ ...state.rooms[0], messages: swapped }] }, { validated }), /corrupt/, 'messages must stay in cursor order');
});

test('concurrent writes share batched durable writes, and every response is already on disk', async t => {
  const f = await fixture(t);
  for (const id of ['a', 'b']) await f.call({ op: 'register', agentId: id, runner: 'test' });
  const writes = countStateWrites(t);
  const sends = Array.from({ length: 40 }, (_, i) => f.call({ op: 'send', from: 'a', to: 'b', body: `m${i}`, messageId: `id-${i}` })
    .then(async result => ({ result, disk: await f.disk() })));
  const done = await Promise.all(sends);
  for (const { result, disk } of done) {
    assert.ok(disk.rooms[0].messages.some(m => m.messageId === result.messageId), `response for ${result.messageId} waited for its write`);
  }
  assert.ok(writes.length < 40, `40 sends used ${writes.length} durable writes`);
  assert.deepEqual(done.map(row => row.result.cursor).sort((x, y) => x - y), Array.from({ length: 40 }, (_, i) => i + 1));
});

test('a failed write rolls back what it carried; later operations succeed on the durable ledger', async t => {
  const f = await fixture(t);
  for (const id of ['a', 'b']) await f.call({ op: 'register', agentId: id, runner: 'test' });
  const real = fs.rename;
  let fail = true;
  fs.rename = async (from, to, ...rest) => {
    if (fail && String(to).endsWith('state.json')) { fail = false; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
    return real.call(fs, from, to, ...rest);
  };
  t.after(() => { fs.rename = real; });
  const lost = await f.raw({ op: 'send', from: 'a', to: 'b', body: 'lost', messageId: 'lost' });
  assert.equal(lost.ok, false); assert.equal(lost.error.code, 'STORE_IO');
  const kept = await f.call({ op: 'send', from: 'a', to: 'b', body: 'kept', messageId: 'kept' });
  assert.equal(kept.cursor, 1, 'the rolled-back cursor is reused, never skipped or duplicated');
  const inbox = await f.call({ op: 'inbox', agentId: 'b' });
  assert.deepEqual(inbox.messages.map(m => m.messageId), ['kept']);
  assert.deepEqual((await f.disk()).rooms[0].messages.map(m => m.messageId), ['kept']);
});

test('presence refreshes stay in memory, then ride along with the next write or the presence flush', async t => {
  const f = await fixture(t, { presenceFlushMs: 60000 });
  await f.call({ op: 'register', agentId: 'a', runner: 'test' });
  const registered = (await f.disk()).rooms[0].agents[0].updatedAt;
  await new Promise(r => setTimeout(r, 1100));
  const writes = countStateWrites(t);
  await f.call({ op: 'wait', agentId: 'a', after: 0, timeoutMs: 0 });
  await f.call({ op: 'inbox', agentId: 'a' });
  assert.equal(writes.length, 0, 'presence alone never rewrites the ledger');
  const live = (await f.call({ op: 'agents' })).agents[0];
  assert.ok(Date.parse(live.updatedAt) > Date.parse(registered), 'readers see the refreshed presence');
  assert.equal((await f.disk()).rooms[0].agents[0].updatedAt, registered);
  await f.call({ op: 'status', agentId: 'a', status: 'busy' });
  assert.ok(Date.parse((await f.disk()).rooms[0].agents[0].updatedAt) >= Date.parse(live.updatedAt), 'the next real write carries presence');
  // A quiet broker flushes presence on its own timer, and on close.
  await f.restart({ presenceFlushMs: 40 });
  await new Promise(r => setTimeout(r, 1100));
  await f.call({ op: 'inbox', agentId: 'a' });
  const refreshed = (await f.call({ op: 'agents' })).agents[0].updatedAt;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (await f.disk()).rooms[0].agents[0].updatedAt !== refreshed) await new Promise(r => setTimeout(r, 20));
  assert.equal((await f.disk()).rooms[0].agents[0].updatedAt, refreshed);
});

test('a failed write does not lose presence: the next flush carries it again', async t => {
  const f = await fixture(t, { presenceFlushMs: 40 });
  await f.call({ op: 'register', agentId: 'a', runner: 'test' });
  await new Promise(r => setTimeout(r, 1100));
  const real = fs.rename;
  let failures = 0;
  fs.rename = async (from, to, ...rest) => {
    if (failures < 1 && String(to).endsWith('state.json')) { failures++; throw Object.assign(new Error('busy'), { code: 'EIO' }); }
    return real.call(fs, from, to, ...rest);
  };
  t.after(() => { fs.rename = real; });
  await f.call({ op: 'inbox', agentId: 'a' });
  const refreshed = (await f.call({ op: 'agents' })).agents[0].updatedAt;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (await f.disk()).rooms[0].agents[0].updatedAt !== refreshed) await new Promise(r => setTimeout(r, 25));
  assert.equal(failures, 1, 'the first presence flush failed');
  assert.equal((await f.disk()).rooms[0].agents[0].updatedAt, refreshed, 'a later flush wrote the presence');
});

test('long-poll wakes see only durable messages and only the tail past their cursor', async t => {
  const f = await fixture(t);
  for (const id of ['a', 'b']) await f.call({ op: 'register', agentId: id, runner: 'test' });
  await f.call({ op: 'send', from: 'a', to: 'b', body: 'one', messageId: 'one' });
  const waiting = f.call({ op: 'wait', agentId: 'b', after: 1, timeoutMs: 5000 });
  await new Promise(r => setTimeout(r, 50));
  await f.call({ op: 'send', from: 'a', to: 'b', body: 'two', messageId: 'two' });
  const woke = await waiting;
  assert.deepEqual(woke.messages.map(m => m.messageId), ['two']);
  assert.ok((await f.disk()).rooms[0].messages.some(m => m.messageId === 'two'));
});

// A room whose old history is finished, plus the cases compaction must keep.
function historyLedger(project) {
  const old = Date.now() - 30 * DAY, iso = ms => new Date(ms).toISOString();
  const agent = (agentId, extra = {}) => ({ agentId, runner: 'test', registeredAt: iso(old), updatedAt: iso(Date.now()), status: 'idle', frozen: false, resources: [], task: null, ...extra });
  const agents = [agent('a'), agent('b'), agent('gone', { left: true, updatedAt: iso(old) }), agent('away', { left: true, updatedAt: iso(old) }),
    agent('retired', { left: true, retired: true, updatedAt: iso(old) }), agent('idle', { left: true, updatedAt: iso(old) })];
  let cursor = 0;
  const message = (from, to, recipients, ackedBy, extra = {}, at = old) => ({ messageId: `m${++cursor}`, from, to, body: `body ${cursor} ${'x'.repeat(200)}`,
    createdAt: iso(at + cursor), cursor, recipients, ackedBy, acks: ackedBy.map(id => ({ agentId: id, at: iso(at) })), notified: [], ...extra });
  const messages = [
    message('a', 'b', ['b'], ['b']),                                   // m1 acked direct: archive
    message('a', '*', ['b', 'gone', 'retired'], ['b']),                // m2 broadcast, rest dormant/retired: archive
    message('a', 'away', ['away'], []),                                 // m3 direct to dormant, unacked: keep
    message('a', 'b', ['b'], ['b']),                                   // m4 acked but replied to by m6: keep
    message('a', 'b', ['b'], ['b'], { attachments: [{ name: 'f.txt', sha256: 'a'.repeat(64), size: 1 }] }), // m5 attachment: keep
    message('b', 'a', ['a'], ['a'], { replyTo: 'm4' }, Date.now()),     // m6 recent reply: keep
    message('a', 'b', ['b'], ['b'], {}, Date.now()),                    // m7 recent: keep
  ];
  return { version: 1, nextCursor: cursor + 1, rooms: [{ project, agents, messages, claims: [], cursor }] };
}

test('compaction archives only finished old history, keeps reply targets, and shrinks the ledger', async t => {
  const f = await fixture(t, {}, historyLedger);
  const sizeBefore = (await fs.stat(path.join(f.dataDir, 'state.json'))).size;
  const dry = await f.call({ op: 'compact', olderThanDays: 14 });
  assert.equal(dry.dryRun, true); assert.equal(dry.archivedMessages, 2); assert.equal(dry.removedIdentities, 0);
  assert.equal((await f.disk()).rooms[0].messages.length, 7, 'dry run changes nothing');
  const applied = await f.call({ op: 'compact', olderThanDays: 14, dryRun: false });
  assert.equal(applied.archivedMessages, 2); assert.ok(applied.bytesAfter < applied.bytesBefore);
  const disk = await f.disk();
  assert.deepEqual(disk.rooms[0].messages.map(m => m.messageId), ['m3', 'm4', 'm5', 'm6', 'm7']);
  assert.deepEqual({ messages: disk.rooms[0].archived.messages, through: disk.rooms[0].archived.through }, { messages: 2, through: 2 });
  assert.ok((await fs.stat(path.join(f.dataDir, 'state.json'))).size < sizeBefore);
  const lines = (await fs.readFile(path.join(f.dataDir, 'archive', applied.archive.name), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(row => row.message.messageId), ['m1', 'm2']);
  assert.equal(lines[0].project, f.project);
  assert.deepEqual((await f.call({ op: 'history' })).scope.archived, { messages: 2, through: 2, files: 1 });
  // Cursors keep moving forward and the archived room still validates after a restart.
  const next = await f.call({ op: 'send', from: 'a', to: 'b', body: 'after', messageId: 'after' });
  assert.equal(next.cursor, 8);
  await f.restart();
  assert.equal((await f.call({ op: 'inbox', agentId: 'b', unacked: false })).messages.at(-1).messageId, 'after');
});

test('dropping identities is opt-in and removes only unreferenced dormant ones', async t => {
  const f = await fixture(t, {}, historyLedger);
  await f.call({ op: 'compact', olderThanDays: 14, dryRun: false });
  assert.equal((await f.disk()).rooms[0].agents.length, 6, 'identity history stays resolvable by default');
  const dropped = await f.call({ op: 'compact', olderThanDays: 14, dryRun: false, dropIdentities: true });
  assert.equal(dropped.removedIdentities, 2);
  assert.deepEqual((await f.disk()).rooms[0].agents.map(a => a.agentId), ['a', 'b', 'away', 'retired'],
    'referenced (away) and retired identities stay; unreferenced dormant ones (gone, idle) go');
  const plan = planCompaction(await f.disk(), (await f.disk()).rooms[0], { olderThanDays: 14, dropIdentities: true });
  assert.deepEqual(plan.identities, []);
});

test('the maintenance sweep compacts on startup when enabled, and the CLI drives compaction', async t => {
  const f = await fixture(t, { compactAfterDays: 14 }, historyLedger);
  assert.deepEqual((await f.disk()).rooms[0].messages.map(m => m.messageId), ['m3', 'm4', 'm5', 'm6', 'm7'], 'startup sweep archived finished history');
  await f.broker.close();
  const g = await fixture(t, {}, historyLedger);
  await g.broker.close();
  const env = { ...process.env, AGENT_RELAY_COMPACT_AFTER_DAYS: '0', AGENT_RELAY_PRUNE_AFTER_MINUTES: '0' };
  const run = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, [cli, ...args, '--project', g.project, '--data-dir', g.dataDir], { env, timeout: 20000 })).stdout);
  const dry = await run('compact', '--older-than-days', '14');
  assert.equal(dry.dryRun, true); assert.equal(dry.archivedMessages, 2);
  const applied = await run('compact', '--older-than-days', '14', '--apply', '--drop-identities');
  assert.equal(applied.archivedMessages, 2); assert.equal(applied.removedIdentities, 2);
});
