// Schema 2: store a broadcast once.
//
// Schema 1 keeps one delivery row per recipient. A broadcast to 900 agents carries 900 ids in
// `recipients`, plus an `ackedBy` entry and an `acks` timestamp for every reader. Schema 2 keeps
// the audience snapshot on the message (the audience stays exact, so nothing about who received
// what changes) but moves the *read state* out of the message and into one cursor per agent:
//
//   agent.readThrough     the broadcast cursor the agent has read through (0 = nothing read)
//   agent.readThroughAt   when that cursor was set
//
// A broadcast is read by an agent when the agent's cursor is at or past the broadcast's cursor.
// A broadcast an agent read out of order keeps an explicit exception ack on the message, so no
// read is ever lost and no read is ever invented.
//
// Direct messages keep their explicit acks: they have exactly one recipient, so there is nothing
// to collapse.
//
// The migration is offline and idempotent. `planMigration` never changes anything;
// `migrateState` returns a new state plus a report that says what changed. Migrating an
// already-migrated ledger changes nothing.
import fs from 'node:fs/promises';
import path from 'node:path';
import { isBroadcast } from './registry.mjs';

export const SCHEMA_1 = 1;
export const SCHEMA_2 = 2;
export const SUPPORTED_SCHEMA_VERSIONS = [SCHEMA_1, SCHEMA_2];

/** True for a ledger already converted to schema 2. */
export const isSchema2 = state => state?.version === SCHEMA_2;
export const isSchema1 = state => state?.version === SCHEMA_1;

/** A broadcast in either schema: schema 2 marks it, schema 1 shows it in the `to` field. */
export const isBroadcastMessage = message => message?.kind === 'broadcast' || isBroadcast(message?.to);

/** The audience snapshot a message was sent to (schema 1 and schema 2 both keep it on the message). */
export const audienceOf = message => (Array.isArray(message?.recipients) ? message.recipients : []);

/** The broadcast cursor an agent has read through (0 when it has read nothing). */
export const readThroughOf = agent => (Number.isSafeInteger(agent?.readThrough) && agent.readThrough > 0 ? agent.readThrough : 0);

/**
 * Has this agent read this message?
 * Schema 1: the explicit ack on the message.
 * Schema 2: the explicit ack (an out-of-order read) or the agent's read cursor.
 */
export function hasReadMessage(agentId, message, agent) {
  if (!message) return false;
  if (agentId !== undefined && Array.isArray(message.ackedBy) && message.ackedBy.includes(agentId)) return true;
  if (!isBroadcastMessage(message) || !agent) return false;
  // A cursor only counts as a read for an agent the broadcast was addressed to.
  // The cursor runs past the broadcasts an agent was not in, so without this the
  // cursor would invent a read that never happened.
  const audience = audienceOf(message);
  if (audience.length && !audience.includes(agent.agentId)) return false;
  const cursor = readThroughOf(agent);
  return cursor > 0 && cursor >= message.cursor;
}

/**
 * When the agent read the message. A cursor read has no per-message stamp, so it reports the
 * moment the cursor was set; an explicit ack keeps its own stamp.
 */
export function ackTimeOf(agentId, message, agent) {
  const row = Array.isArray(message?.acks) ? message.acks.find(a => a?.agentId === agentId) : undefined;
  if (row) return row.at;
  if (isBroadcastMessage(message) && agent && readThroughOf(agent) >= message.cursor)
    return agent.readThroughAt ?? undefined;
  return undefined;
}

/** The readers of a message under the cursor model: the explicit acks plus everyone the cursor covers. */
export function readersOf(message, room) {
  const explicit = new Set(Array.isArray(message?.ackedBy) ? message.ackedBy : []);
  if (!isBroadcastMessage(message)) return explicit;
  const audience = audienceOf(message);
  for (const agent of room?.agents ?? []) {
    if (audience.length && !audience.includes(agent.agentId)) continue;
    const cursor = readThroughOf(agent);
    if (cursor > 0 && cursor >= message.cursor) explicit.add(agent.agentId);
  }
  return explicit;
}

/** True when every recipient of the message has read it (the cursor model, both schemas). */
export function fullyRead(message, room) {
  const readers = readersOf(message, room);
  return audienceOf(message).every(id => readers.has(id));
}

/**
 * Advance an agent's read cursor over the broadcasts it has read, dropping the exception acks
 * the cursor now covers. The cursor only ever moves forward and only over a contiguous run of
 * broadcasts the agent was addressed to, so a read is never invented.
 */
export function advanceReadCursor(agent, room, { at } = {}) {
  const cursor = readThroughOf(agent);
  let next = cursor, stamp = agent.readThroughAt ?? null;
  for (const message of room?.messages ?? []) {
    if (!isBroadcastMessage(message) || message.cursor <= next) continue;
    if (!audienceOf(message).includes(agent.agentId)) continue;
    if (!Array.isArray(message.ackedBy) || !message.ackedBy.includes(agent.agentId)) break;
    next = message.cursor;
    const row = Array.isArray(message.acks) ? message.acks.find(a => a?.agentId === agent.agentId) : undefined;
    if (row?.at && (stamp === null || row.at > stamp)) stamp = row.at;
    message.ackedBy = message.ackedBy.filter(id => id !== agent.agentId);
    if (Array.isArray(message.acks)) message.acks = message.acks.filter(a => a?.agentId !== agent.agentId);
    if (message.acks.length === 0) delete message.acks;
  }
  if (next > cursor) {
    agent.readThrough = next;
    agent.readThroughAt = stamp ?? at ?? new Date().toISOString();
  }
  return next;
}

const countState = state => {
  const counts = { rooms: 0, agents: 0, messages: 0, broadcasts: 0, directMessages: 0,
    deliveryRows: 0, ackedDeliveryRows: 0 };
  for (const room of state?.rooms ?? []) {
    counts.rooms++;
    counts.agents += room.agents?.length ?? 0;
    for (const message of room.messages ?? []) {
      counts.messages++;
      if (isBroadcastMessage(message)) counts.broadcasts++; else counts.directMessages++;
      counts.deliveryRows += audienceOf(message).length;
      counts.ackedDeliveryRows += Array.isArray(message.ackedBy) ? message.ackedBy.length : 0;
    }
  }
  return counts;
};

/** The audience rule of a schema 1 broadcast, recovered as far as the ledger allows. */
function recoverAudience(message) {
  if (message.audience && typeof message.audience === 'object') return { audience: message.audience, known: true };
  const mode = message.to === '*all' ? 'all' : 'live';
  return { audience: { mode, within: null, excluded: null }, known: false };
}

function migrateRoom(room, { changes, warnings }) {
  const broadcasts = room.messages.filter(isBroadcastMessage);
  const ordered = [...broadcasts].sort((a, b) => a.cursor - b.cursor);
  // The audience of every broadcast, as a set: the walk below runs once per identity.
  const audiences = new Map(ordered.map(message => [message, new Set(audienceOf(message))]));
  const readers = new Map(ordered.map(message => [message, new Set(Array.isArray(message.ackedBy) ? message.ackedBy : [])]));
  // 1. One cursor per agent: the longest run of broadcasts it has read, counting from the start.
  for (const agent of room.agents ?? []) {
    let cursor = 0, stamp = null;
    for (const message of ordered) {
      if (message.cursor <= cursor) continue;
      if (!audiences.get(message).has(agent.agentId)) continue; // not addressed to it: it does not break the run
      if (!readers.get(message).has(agent.agentId)) break; // the first unread one stops it
      cursor = message.cursor;
      const row = Array.isArray(message.acks) ? message.acks.find(a => a?.agentId === agent.agentId) : undefined;
      if (row?.at && (stamp === null || row.at > stamp)) stamp = row.at;
    }
    if (cursor > 0) {
      agent.readThrough = cursor;
      if (stamp) agent.readThroughAt = stamp;
      changes.cursors.push({ agentId: agent.agentId, readThrough: cursor, readThroughAt: stamp ?? null });
    }
  }
  const cursors = new Map((room.agents ?? []).map(agent => [agent.agentId, readThroughOf(agent)]));
  // 2. The messages keep only the acks their reader's cursor does not cover.
  for (const message of broadcasts) {
    const kept = [], stamps = [];
    const stampsByAgent = new Map((Array.isArray(message.acks) ? message.acks : []).map(row => [row?.agentId, row?.at]));
    for (const agentId of Array.isArray(message.ackedBy) ? message.ackedBy : []) {
      if ((cursors.get(agentId) ?? 0) >= message.cursor) {
        changes.readAcksFolded++;
        changes.readRowsRemoved++;
        if (stampsByAgent.has(agentId)) changes.readRowsRemoved++;
        continue;
      }
      kept.push(agentId);
      const at = stampsByAgent.get(agentId);
      if (at) stamps.push({ agentId, at });
    }
    message.ackedBy = kept;
    if (stamps.length) message.acks = stamps; else delete message.acks;
  }
  // 3. The schema 2 message shape: the kind marker and, for a broadcast, the audience rule.
  let unknownRules = 0;
  for (const message of room.messages ?? []) {
    if (!isBroadcastMessage(message)) { message.kind = 'direct'; continue; }
    message.kind = 'broadcast';
    const recovered = recoverAudience(message);
    message.audience = recovered.audience;
    if (!recovered.known) unknownRules++;
  }
  if (unknownRules) warnings.push(`${room.project}: ${unknownRules} broadcast(s) carried no audience rule; the rule was read from the "to" field (mode only). The audience snapshot is kept, so the audience did not change, but "within" and "excluded" are unknown.`);
  return unknownRules;
}

/**
 * Plan the migration. Never changes the ledger: it reports the counts, the changes and anything
 * the migration could not decide.
 */
export function planMigration(state, { to = SCHEMA_2, now = Date.now() } = {}) {
  const { report } = runMigration(state, { to, now });
  return { ...report, dryRun: true };
}

/**
 * Migrate a ledger to schema 2. Returns the new state and the report. Migrating a ledger that is
 * already at schema 2 changes nothing.
 */
export function migrateState(state, { to = SCHEMA_2, now = Date.now() } = {}) {
  const { state: next, report } = runMigration(state, { to, now });
  return { state: next, report: { ...report, dryRun: false } };
}

/** The rows the ledger stores for delivery state: the audience, the reads and the notices. */
function deliveryRows(state) {
  let rows = 0;
  for (const room of state?.rooms ?? []) {
    for (const message of room.messages ?? []) {
      rows += audienceOf(message).length;
      rows += (Array.isArray(message.ackedBy) ? message.ackedBy.length : 0) + (Array.isArray(message.acks) ? message.acks.length : 0);
      rows += Array.isArray(message.notified) ? message.notified.length : 0;
    }
    rows += (room.agents ?? []).filter(agent => readThroughOf(agent) > 0).length;
  }
  return rows;
}

function runMigration(state, { to = SCHEMA_2, now = Date.now() } = {}) {
  if (to !== SCHEMA_2) throw new Error(`This migration only produces schema ${SCHEMA_2}.`);
  const from = Number.isSafeInteger(state?.version) ? state.version : SCHEMA_1;
  const counts = countState(state);
  const changes = { messages: 0, broadcasts: 0, readAcksFolded: 0, readRowsRemoved: 0, exceptionAcksKept: 0,
    recipientRowsRemoved: 0, deliveryRowsBefore: deliveryRows(state), deliveryRowsAfter: 0, cursors: [],
    bytesBefore: 0, bytesAfter: 0, audienceRulesUnknown: 0 };
  const warnings = [];
  if (from === SCHEMA_2) {
    warnings.push('The ledger is already at schema 2; the migration changed nothing.');
    changes.bytesBefore = changes.bytesAfter = byteLength(state);
    changes.deliveryRowsAfter = changes.deliveryRowsBefore;
    return { state, report: { from, to, counts, changes, warnings, migratedAt: new Date(now).toISOString() } };
  }
  if (from !== SCHEMA_1) throw new Error(`Relay state schema ${from} is not supported; nothing was changed.`);
  const next = structuredClone(state);
  next.version = SCHEMA_2;
  for (const room of next.rooms ?? []) {
    changes.messages += room.messages?.length ?? 0;
    changes.broadcasts += room.messages?.filter(isBroadcastMessage).length ?? 0;
    changes.audienceRulesUnknown += migrateRoom(room, { changes, warnings });
  }
  changes.exceptionAcksKept = (next.rooms ?? []).reduce((total, room) =>
    total + room.messages.reduce((sum, message) => sum + (Array.isArray(message.ackedBy) ? message.ackedBy.length : 0), 0), 0);
  changes.deliveryRowsAfter = deliveryRows(next);
  changes.recipientRowsRemoved = Math.max(0, changes.deliveryRowsBefore - changes.deliveryRowsAfter);
  changes.bytesBefore = byteLength(state);
  changes.bytesAfter = byteLength(next);
  return { state: next, report: { from, to, counts, changes, warnings, migratedAt: new Date(now).toISOString() } };
}

const byteLength = state => Buffer.byteLength(JSON.stringify(state));

/**
 * Copy the state file next to itself before it is rewritten. The copy is mode 600, like the
 * ledger it protects, and the old rows stay recoverable from it.
 */
export async function backupStateFile(file, { now = new Date() } = {}) {
  const target = path.join(path.dirname(file), `state.backup-${now.getTime()}.json`);
  const bytes = await fs.readFile(file);
  await fs.writeFile(target, bytes, { mode: 0o600 });
  return { path: target, bytes: bytes.length };
}

/** Write a ledger back atomically (temp file, fsync, rename), mode 600. */
export async function writeStateFile(file, state, { mode = 0o600 } = {}) {
  const target = path.resolve(file);
  const temporary = `${target}.${process.pid}.tmp`;
  const handle = await fs.open(temporary, 'w', mode);
  try {
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, target);
  return { path: target, bytes: Buffer.byteLength(JSON.stringify(state)) };
}
