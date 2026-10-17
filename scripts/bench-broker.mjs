// Broker write-cost benchmark on a large, realistic ledger.
//   node scripts/bench-broker.mjs [--seconds N] [--pollers N] [--json]
// Builds a large ledger (about 1,400 identities with 25 live, 9,000 messages including broadcasts
// to about 1,000 recipients), then measures the write path in isolation, a mixed load (live agents
// long-polling while peers send, acknowledge, report status and claim), compaction, and the same
// load on the compacted ledger.
// Everything lives in a temporary data directory that is removed on exit.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createBroker, validateStore } from '../lib/broker.mjs';
import { mutate, encodeState, stateBytes, createMessageCache } from '../lib/ledger.mjs';

const argv = process.argv.slice(2), flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`); return i >= 0 ? Number(argv[i + 1]) : fallback;
};
const SECONDS = flag('seconds', 15), POLLERS = flag('pollers', 25), AS_JSON = argv.includes('--json');

export function largeState(project, { agents = 1400, live = 25, messages = 9000, broadcasts = 200 } = {}) {
  const now = Date.now(), iso = ms => new Date(ms).toISOString();
  const ids = Array.from({ length: agents }, (_, i) => `codex-019a${String(i).padStart(4, '0')}-5b1c-7e42-9d3f-${String(i).padStart(12, '0')}`);
  const rows = ids.map((agentId, i) => ({ agentId, runner: 'codex', registeredAt: iso(now - 864e5 * 3), updatedAt: iso(i < live ? now : now - 864e5 * 2),
    status: i < live ? 'working' : 'idle', frozen: false, resources: [], task: i < live ? `Task ${i}` : null,
    ...(i >= live && i % 3 === 0 ? { left: true } : {}) }));
  const active = rows.filter(a => !a.left).map(a => a.agentId);
  const msgs = [];
  for (let c = 1; c <= messages; c++) {
    const from = ids[c % live], broadcast = c % Math.floor(messages / broadcasts) === 0;
    const recipients = broadcast ? active.filter(id => id !== from) : [ids[(c + 1) % live]];
    const acked = broadcast ? recipients.slice(0, live) : c % 4 ? recipients : [];
    msgs.push({ messageId: `m-${c}`, from, to: broadcast ? '*' : recipients[0],
      body: broadcast ? `Bulletin ${c}: please re-read the coordination notes before touching shared files.`
        : `Status ${c}: finished step ${c % 17} of the migration; next is the validator. ${'x'.repeat(240)}`,
      createdAt: iso(now - (messages - c) * 6e4), cursor: c, recipients, ackedBy: acked,
      acks: acked.map(agentId => ({ agentId, at: iso(now - (messages - c) * 6e4 + 1000) })),
      notified: recipients.slice(0, broadcast ? live : 1).map(agentId => ({ agentId, adapter: 'mcp-watch', at: iso(now - (messages - c) * 6e4) })) });
  }
  return { version: 1, nextCursor: messages + 1,
    rooms: [{ project, agents: rows, messages: msgs, claims: [], cursor: messages }] };
}

const pct = (values, p) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(1); };
const timed = async fn => { const t = performance.now(); await fn(); return performance.now() - t; };

async function load(broker, project, state, seconds) {
  const call = async fields => {
    const response = await fetch(`${broker.url}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${broker.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ project, ...fields }) });
    const result = await response.json(); if (!result.ok) throw Object.assign(new Error(result.error?.message), { code: result.error?.code }); return result;
  };
  const live = state.rooms[0].agents.slice(0, POLLERS).map(a => a.agentId);
  const lat = { wait: [], send: [], ack: [], status: [], claim: [], inbox: [] }, errors = {};
  const record = (op, ms) => lat[op].push(ms);
  const end = Date.now() + seconds * 1000; let stop = false;
  const cursors = new Map(live.map(id => [id, state.nextCursor - 1]));
  // Pollers: long-poll like the MCP/Codex watchers (wait refreshes presence on every call).
  const pollers = live.map(async id => {
    while (!stop) {
      try {
        const t = performance.now(); const r = await call({ op: 'wait', agentId: id, after: cursors.get(id), timeoutMs: 2000 });
        record('wait', performance.now() - t); cursors.set(id, Math.max(cursors.get(id), r.cursor ?? 0));
        for (const m of r.messages ?? []) { const t2 = performance.now(); await call({ op: 'ack', agentId: id, messageId: m.messageId }); record('ack', performance.now() - t2); }
      } catch (e) { errors[e.code ?? e.message] = (errors[e.code ?? e.message] ?? 0) + 1; }
    }
  });
  // Workers: sends, status reports, inbox reads and claims at a steady mixed rate.
  let n = 0;
  const workers = Array.from({ length: 5 }, async (_, w) => {
    while (!stop) {
      const from = live[(n++) % live.length], to = live[(n + 7) % live.length];
      try {
        const op = ['send', 'status', 'inbox', 'claim', 'send'][n % 5];
        const t = performance.now();
        if (op === 'send') await call({ op: 'send', from, to: to === from ? live[0] : to, body: `bench ${n}` });
        else if (op === 'status') await call({ op: 'status', agentId: from, status: 'working', task: `bench ${n}` });
        else if (op === 'inbox') await call({ op: 'inbox', agentId: from, limit: 20 });
        else await call({ op: 'claim', agentId: from, resources: [`bench/${w}/${n}.txt`] });
        record(op, performance.now() - t);
      } catch (e) { errors[e.code ?? e.message] = (errors[e.code ?? e.message] ?? 0) + 1; }
      await new Promise(r => setTimeout(r, 20));
    }
  });
  while (Date.now() < end) await new Promise(r => setTimeout(r, 200));
  stop = true; await Promise.all(workers);
  const result = { ops: {} };
  for (const [op, values] of Object.entries(lat)) result.ops[op] = { count: values.length, p50Ms: pct(values, 50), p99Ms: pct(values, 99) };
  result.throughputOpsPerSec = +(Object.values(lat).reduce((t, v) => t + v.length, 0) / seconds).toFixed(1);
  result.errors = errors;
  return { result, call, settle: () => Promise.allSettled(pollers) };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-bench-'));
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir); await fs.mkdir(path.join(root, 'project'));
  const project = await fs.realpath(path.join(root, 'project'));
  const state = largeState(project);
  const serialized = JSON.stringify(state);
  const stateFile = path.join(dataDir, 'state.json');
  await fs.writeFile(stateFile, serialized, { mode: 0o600 });
  const report = { stateBytes: Buffer.byteLength(serialized), agents: state.rooms[0].agents.length,
    messages: state.rooms[0].messages.length, previousWrite: {}, currentWrite: {} };
  // Isolated costs. Previous write path: every mutation cloned, validated, serialized and wrote
  // the whole ledger. Current: one mutation is a draft + incremental validation + size check; a
  // batch of mutations shares one cached encode and one write.
  const before = { clone: [], validate: [], stringify: [], write: [] }, now = { mutate: [], validate: [], size: [], encode: [] };
  const validated = new WeakSet(), row = createMessageCache();
  validateStore(state, { validated }); encodeState(state, row);
  for (let i = 0; i < 5; i++) {
    before.clone.push(await timed(() => structuredClone(state)));
    before.validate.push(await timed(() => validateStore(state)));
    before.stringify.push(await timed(() => JSON.stringify(state)));
    before.write.push(await timed(async () => { const f = await fs.open(path.join(root, `w${i}.tmp`), 'w'); await f.writeFile(serialized); await f.sync(); await f.close(); }));
    let next;
    now.mutate.push(await timed(() => { next = mutate(state, d => { d.rooms[0].messages[100 + i].ackedBy.push(d.rooms[0].messages[100 + i].recipients[0]); }).next; }));
    now.validate.push(await timed(() => { try { validateStore(next, { validated }); } catch {} }));
    now.size.push(await timed(() => stateBytes(next, row)));
    now.encode.push(await timed(() => encodeState(next, row)[0].join('')));
  }
  for (const [k, v] of Object.entries(before)) report.previousWrite[k + 'Ms'] = pct(v, 50);
  for (const [k, v] of Object.entries(now)) report.currentWrite[k + 'Ms'] = pct(v, 50);

  let broker = await createBroker({ dataDir, pruneAfterMinutes: 0, compactAfterDays: 0 });
  const first = await load(broker, project, state, SECONDS);
  report.load = first.result;
  // Maintenance as the daily sweep does it: idle identities become dormant (prune), then finished
  // history older than one day is archived (compaction). Measure the smaller ledger after.
  const pruned = await first.call({ op: 'prune', dryRun: false });
  const compact = await first.call({ op: 'compact', olderThanDays: 1, dryRun: false });
  await broker.close(); await first.settle();
  report.compaction = { prunedIdentities: pruned.pruned, archivedMessages: compact.archivedMessages, bytesBefore: compact.bytesBefore, bytesAfter: compact.bytesAfter };
  broker = await createBroker({ dataDir, pruneAfterMinutes: 0, compactAfterDays: 0 });
  const second = await load(broker, project, JSON.parse(await fs.readFile(stateFile, 'utf8')), SECONDS);
  await broker.close(); await second.settle();
  report.loadAfterCompaction = second.result;
  report.finalStateBytes = (await fs.stat(stateFile)).size;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (AS_JSON) { console.log(JSON.stringify(report)); return; }
  const mib = bytes => (bytes / 1048576).toFixed(1) + ' MiB';
  const show = (label, run) => {
    console.log(`${label}: ${run.throughputOpsPerSec} ops/s`);
    for (const [op, row] of Object.entries(run.ops)) console.log(`  ${op.padEnd(6)} n=${String(row.count).padStart(5)}  p50 ${row.p50Ms} ms  p99 ${row.p99Ms} ms`);
    if (Object.keys(run.errors).length) console.log('  errors', run.errors);
  };
  console.log(`Ledger: ${mib(report.stateBytes)}, ${report.agents} identities, ${report.messages} messages`);
  const b = report.previousWrite, c = report.currentWrite;
  console.log(`Previous per-write cost (p50): clone ${b.cloneMs} + validate ${b.validateMs} + stringify ${b.stringifyMs} + write/fsync ${b.writeMs} ms`);
  console.log(`Current per-mutation cost (p50): draft ${c.mutateMs} + incremental validate ${c.validateMs} + size ${c.sizeMs} ms; per batch: cached encode ${c.encodeMs} ms + one write/fsync`);
  show(`Mixed load, ${SECONDS}s, ${POLLERS} long-polling agents`, report.load);
  console.log(`Maintenance: pruned ${report.compaction.prunedIdentities} idle identities, archived ${report.compaction.archivedMessages} finished messages older than 1 day, ${mib(report.compaction.bytesBefore)} -> ${mib(report.compaction.bytesAfter)}`);
  show('Mixed load after compaction', report.loadAfterCompaction);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
