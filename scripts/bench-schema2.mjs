// Schema 2 benchmark: the same room, before and after the migration.
//
//   node scripts/bench-schema2.mjs [--agents N] [--messages N] [--broadcasts N] [--acked 0..1] [--json]
//
// Builds a room shaped like the one from the 2026-10-25 investigation (about 2,000 identities,
// 6,800 messages, 160 broadcasts that reached every non-left identity), migrates it to schema 2
// and prints what changed: the rows the ledger stores for delivery state, the bytes on disk, and
// how much a bulk acknowledgement writes.
//
// Schema 2 keeps the audience snapshot of a broadcast (so who received what never changes) and
// moves the read state into one cursor per agent. The rows it removes are the per-reader rows:
// one `ackedBy` entry and one timestamp for every agent that read a broadcast.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { planMigration, migrateState, hasReadMessage } from '../lib/schema2.mjs';
import { createBroker } from '../lib/broker.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? Number(argv[i + 1]) : fallback; };
const AGENTS = flag('agents', 1971), MESSAGES = flag('messages', 6824), BROADCASTS = flag('broadcasts', 160);
const ACKED = flag('acked', 0.02), AS_JSON = argv.includes('--json');

const iso = ms => new Date(ms).toISOString();
const isBroadcastTo = to => to === '*' || to === '*all';

/** A room shaped like the reported one: many identities, many broadcasts, a big backlog. */
export function backlogState(project, { agents = AGENTS, live = 29, messages = MESSAGES, broadcasts = BROADCASTS,
  acked = ACKED } = {}) {
  const now = Date.now();
  const ids = Array.from({ length: agents }, (_, i) => `codex-019a${String(i).padStart(4, '0')}-5b1c-7e42-9d3f-${String(i).padStart(12, '0')}`);
  const rows = ids.map((agentId, i) => ({ agentId, runner: 'codex', registeredAt: iso(now - 864e5 * 30),
    updatedAt: iso(i < live ? now : now - 864e5 * 8), status: 'idle', frozen: false, resources: [], task: null,
    ...(i >= live && i % 3 === 0 ? { left: true } : {}) }));
  const active = rows.filter(agent => !agent.left).map(agent => agent.agentId);
  const msgs = [];
  for (let c = 1; c <= messages; c++) {
    const from = ids[c % live];
    const broadcast = c % Math.max(1, Math.floor(messages / broadcasts)) === 0;
    const recipients = broadcast ? active.filter(id => id !== from) : [ids[(c + 1) % live]];
    const read = broadcast ? recipients.slice(0, Math.max(1, Math.round(recipients.length * acked))) : (c % 4 ? recipients : []);
    msgs.push({ messageId: `m-${c}`, from, to: broadcast ? '*' : recipients[0],
      body: broadcast ? `Bulletin ${c}: re-read the coordination notes before touching shared files.`
        : `Status ${c}: finished step ${c % 17}; next is the validator. ${'x'.repeat(240)}`,
      createdAt: iso(now - (messages - c) * 6e4), cursor: c, recipients, ackedBy: read,
      acks: read.map(agentId => ({ agentId, at: iso(now - (messages - c) * 6e4 + 1000) })),
      notified: recipients.slice(0, broadcast ? 29 : 1).map(agentId => ({ agentId, adapter: 'mcp-watch', at: iso(now - (messages - c) * 6e4) })) });
  }
  return { version: 1, nextCursor: messages + 1, rooms: [{ project, agents: rows, messages: msgs, claims: [], cursor: messages }] };
}

/** The rows the ledger stores: the audience snapshot, the read rows and the transport notices. */
function storedRows(state) {
  let recipients = 0, broadcastReads = 0, directReads = 0, notices = 0, cursors = 0;
  for (const room of state.rooms ?? []) {
    cursors += room.agents.filter(agent => agent.readThrough).length;
    for (const message of room.messages ?? []) {
      recipients += message.recipients.length;
      const reads = (message.ackedBy?.length ?? 0) + (message.acks?.length ?? 0);
      if (isBroadcastTo(message.to)) broadcastReads += reads; else directReads += reads;
      notices += message.notified?.length ?? 0;
    }
  }
  return { recipients, broadcastReads, directReads, notices, cursors,
    total: recipients + broadcastReads + directReads + notices + cursors };
}

/** The deliveries a client still has to read: the same number in both schemas, computed not stored. */
function pendingDeliveries(state) {
  let pending = 0;
  for (const room of state.rooms ?? []) {
    const agents = new Map(room.agents.map(agent => [agent.agentId, agent]));
    for (const message of room.messages ?? []) {
      for (const agentId of message.recipients) {
        if (!hasReadMessage(agentId, message, agents.get(agentId))) pending++;
      }
    }
  }
  return pending;
}

const bytes = state => Buffer.byteLength(JSON.stringify(state));
const mib = value => (value / 1048576).toFixed(2) + ' MiB';
const percent = (before, after) => `${((1 - after / before) * 100).toFixed(1)}%`;

async function bulkAckCost() {
  // How much a backlog acknowledgement writes, in both schemas, on a smaller room.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-schema2-bench-'));
  const results = {};
  try {
    for (const schema of [1, 2]) {
      const dataDir = path.join(root, `data-${schema}`);
      await fs.mkdir(dataDir);
      const project = path.join(root, `project-${schema}`);
      await fs.mkdir(project);
      const realProject = await fs.realpath(project);
      const state = backlogState(realProject, { agents: 300, live: 10, messages: 400, broadcasts: 40, acked: 0 });
      const ready = schema === 2 ? migrateState(state).state : state;
      await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify(ready));
      const broker = await createBroker({ dataDir, pruneAfterMinutes: 0, compactAfterDays: 0 });
      const call = async fields => {
        const response = await fetch(`${broker.url}/rpc`, { method: 'POST',
          headers: { authorization: `Bearer ${broker.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ project: realProject, ...fields }) });
        const result = await response.json();
        if (!result.ok) throw new Error(result.error.message);
        return result;
      };
      const file = path.join(dataDir, 'state.json');
      const before = (await fs.stat(file)).size;
      // An identity that received every broadcast and has read none of them yet.
      const reader = ready.rooms[0].agents.find(agent => !agent.left && !ready.rooms[0].agents.slice(0, 10).includes(agent));
      const started = performance.now();
      const acked = await call({ op: 'ack', agentId: reader.agentId, all: true });
      const elapsed = performance.now() - started;
      const after = (await fs.stat(file)).size;
      results[schema] = { acked: acked.acked, bytesBefore: before, bytesAfter: after, growth: after - before, ms: +elapsed.toFixed(1) };
      await broker.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return results;
}

function scenario(state, label) {
  const plan = planMigration(state);
  const started = performance.now();
  const { state: migrated, report } = migrateState(state);
  const migrateMs = performance.now() - started;
  const before = { rows: storedRows(state), bytes: report.changes.bytesBefore };
  const after = { rows: storedRows(migrated), bytes: report.changes.bytesAfter };
  return {
    label, plan,
    fixture: { agents: state.rooms[0].agents.length, messages: state.rooms[0].messages.length,
      broadcasts: plan.counts.broadcasts, deliveries: plan.counts.deliveryRows,
      pendingBefore: pendingDeliveries(state), pendingAfter: pendingDeliveries(migrated) },
    rows: { before: before.rows.total, after: after.rows.total, saved: percent(before.rows.total, after.rows.total),
      detail: { before: before.rows, after: after.rows } },
    bytes: { before: before.bytes, after: after.bytes, saved: percent(before.bytes, after.bytes) },
    changes: { ...report.changes, cursors: report.changes.cursors.length },
    warnings: report.warnings,
    migrateMs: +migrateMs.toFixed(1)
  };
}

async function main() {
  const backlog = scenario(backlogState('/work/project'), 'as reported (the backlog was never read)');
  const read = scenario(backlogState('/work/project', { acked: 1 }), 'after the readers acked their backlog');
  const ack = await bulkAckCost();
  const report = { backlog, read, bulkAck: ack };
  if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); return; }
  for (const part of [backlog, read]) {
    const f = part.fixture;
    console.log(`Room: ${f.agents} identities, ${f.messages} messages (${f.broadcasts} broadcasts), ${f.deliveries} deliveries - ${part.label}`);
    console.log(`Pending deliveries: ${f.pendingBefore} before, ${f.pendingAfter} after (the same backlog, computed from the cursors instead of stored)`);
    console.log(`Rows stored: ${part.rows.before} -> ${part.rows.after} (-${part.rows.saved})`);
    console.log(`  audience snapshots ${part.rows.detail.before.recipients} -> ${part.rows.detail.after.recipients},` +
      ` broadcast read rows ${part.rows.detail.before.broadcastReads} -> ${part.rows.detail.after.broadcastReads},` +
      ` read cursors 0 -> ${part.rows.detail.after.cursors},` +
      ` direct read rows ${part.rows.detail.before.directReads} -> ${part.rows.detail.after.directReads},` +
      ` notices ${part.rows.detail.before.notices} -> ${part.rows.detail.after.notices}`);
    console.log(`Bytes on disk: ${mib(part.bytes.before)} -> ${mib(part.bytes.after)} (-${part.bytes.saved})`);
    console.log(`Migration: ${part.migrateMs} ms, ${part.changes.cursors} read cursors, ${part.changes.readAcksFolded} read rows folded`);
    for (const warning of part.warnings) console.log(`  warning: ${warning}`);
    console.log('');
  }
  console.log(`Bulk acknowledgement of a whole backlog (${ack[1].acked} deliveries):`);
  console.log(`  schema 1: ledger ${ack[1].bytesBefore} -> ${ack[1].bytesAfter} bytes (+${ack[1].growth}), ${ack[1].ms} ms`);
  console.log(`  schema 2: ledger ${ack[2].bytesBefore} -> ${ack[2].bytesAfter} bytes (+${ack[2].growth}), ${ack[2].ms} ms`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
