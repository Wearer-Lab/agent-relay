import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createToolPages, MAX_TOOL_BYTES} from '../lib/tool-pages.mjs';

test('all eight third-review reproductions are corrected through real CLI, broker, SDK and dashboard paths', async () => {
  const harness = fileURLToPath(new URL('../docs/reviews/2026-10-12-fix-probes.mjs', import.meta.url));
  const {stdout} = await promisify(execFile)(process.execPath, [harness], {timeout: 60000, maxBuffer: 1024 * 1024});
  const records = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 13);
  assert.ok(records.every(row => row.outcome === 'resolved'), stdout);
});

async function recover(pages, value, owner) {
  const first = pages.bound(value, {owner});
  assert.ok(first.continuation);
  assert.equal(first.byteSize, Buffer.byteLength(JSON.stringify(first)));
  assert.ok(first.byteSize <= MAX_TOOL_BYTES);
  let text = '', offset = 0;
  for (;;) {
    const chunk = pages.read(first.continuation.token, offset, owner);
    assert.equal(chunk.byteSize, Buffer.byteLength(JSON.stringify(chunk)));
    assert.ok(chunk.byteSize <= MAX_TOOL_BYTES);
    assert.equal(chunk.offset, offset);
    text += chunk.text;
    if (chunk.done) break;
    assert.ok(chunk.nextOffset > offset);
    offset = chunk.nextOffset;
  }
  assert.equal(createHash('sha256').update(text).digest('hex'), first.continuation.sha256);
  assert.deepEqual(JSON.parse(text), value);
  return first;
}

test('collection, nested marker and escaped text continuations recover complete immutable snapshots', async () => {
  const pages = createToolPages();
  const rows = Array.from({length: 64}, (_, i) => ({id: 'row-' + i, detail: '漢😀\u0000"\\'.repeat(900)}));
  for (const key of ['tasks', 'handoffs', 'processes', 'claims', 'agents', 'acks']) {
    await recover(pages, {ok: true, [key]: rows});
  }
  await recover(pages, {ok: true, rooms: rows, agents: rows});
  await recover(pages, {ok: true, messages: [{messageId: 'large', cursor: 1,
    body: '\u0000'.repeat(16384), recipients: [{agentId: 'reader', notified: rows}], notified: rows}]});
  const original = {ok: true, tasks: structuredClone(rows)};
  const first = await recover(pages, original);
  original.tasks.length = 0;
  let text = '', offset = 0;
  for (;;) {
    const chunk = pages.read(first.continuation.token, offset);
    text += chunk.text;
    if (chunk.done) break;
    offset = chunk.nextOffset;
  }
  assert.equal(JSON.parse(text).tasks.length, 64, 'mutation of the source cannot change retained pages');
});

test('page retries are stable, tokens are owner scoped, and cache expiry/eviction fail explicitly', () => {
  let now = 1000;
  const pages = createToolPages({maxSnapshots: 1, ttlMs: 100, now: () => now});
  const first = pages.bound({ok: true, body: 'x'.repeat(90000)}, {owner: 'a'});
  assert.deepEqual(pages.read(first.continuation.token, 0, 'a'), pages.read(first.continuation.token, 0, 'a'));
  assert.throws(() => pages.read(first.continuation.token, 0, 'b'), /Unknown or expired/);
  assert.throws(() => pages.read(first.continuation.token, -1, 'a'), /offset/);
  assert.throws(() => pages.read(first.continuation.token, 1e9, 'a'), /offset/);
  const second = pages.bound({ok: true, body: 'y'.repeat(90000)}, {owner: 'a'});
  assert.throws(() => pages.read(first.continuation.token, 0, 'a'), /Unknown or expired/);
  assert.ok(pages.read(second.continuation.token, 0, 'a').text);
  now = 1101;
  assert.throws(() => pages.read(second.continuation.token, 0, 'a'), /Unknown or expired/);
  const third = pages.bound({ok: true, body: 'z'.repeat(90000)}, {owner: 'a'});
  pages.clear('a');
  assert.throws(() => pages.read(third.continuation.token, 0, 'a'), /Unknown or expired/);
  const tinyCache = createToolPages({maxStoredBytes: 70000});
  assert.throws(() => tinyCache.bound({ok: true, body: 'x'.repeat(90000)}), /storage budget/);
});

test('complete envelopes remain bounded around the 64 KiB boundary', async () => {
  const pages = createToolPages();
  for (const size of [63000, 63500, 65500, 65536, 65537]) {
    const value = {ok: true, messages: [{messageId: 'boundary', cursor: 1, body: 'x'.repeat(size)}], cursor: 1};
    const page = pages.bound(value);
    assert.equal(page.byteSize, Buffer.byteLength(JSON.stringify(page)));
    assert.ok(page.byteSize <= MAX_TOOL_BYTES);
    if (page.continuation) await recover(pages, value);
    else assert.equal(page.messages[0].body.length, size);
  }
});
