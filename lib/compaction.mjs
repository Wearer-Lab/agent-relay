// Ledger compaction: move old, fully delivered messages out of state.json into append-only
// archive files. On request it also drops dormant identities that nothing retained references
// (identity history stays resolvable by default; retired identities are always kept).
//
// A message is archivable when it is older than the cutoff, carries no attachments, and every
// delivery is finished. A delivery is finished when its recipient acknowledged it, the recipient
// is retired (it can never return), the identity is gone from the registry, or the delivery
// expired: it waited longer than its TTL and the recipient can no longer read it. Broadcasts
// expire after a week; a direct message keeps a dormant identity's inbox alive for a month, so a
// lane that comes back finds its work. One straggler no longer pins a whole message.
// A message that a retained message replies to stays too, so reply links never dangle.
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isBroadcast, isLive, liveness, hasRead, DEFAULT_LIVE_WINDOW_MINUTES, DEFAULT_TRANSPORT_STALE_MINUTES } from './registry.mjs';

export const DEFAULT_COMPACT_AFTER_DAYS = 14;
// A broadcast delivery is dropped after a week; a direct message keeps a dormant identity's
// durable inbox for a month.
export const DEFAULT_BROADCAST_TTL_DAYS = 7;
export const DEFAULT_DIRECT_TTL_DAYS = 30;
export const MAX_ARCHIVE_FILES = 256;
export const DEFAULT_BLOCKER_LIMIT = 10;

/** The TTL that applies to one message: broadcasts expire fast, direct messages stay a month. */
export function deliveryTtlDays(message, { broadcastTtlDays = DEFAULT_BROADCAST_TTL_DAYS,
  directTtlDays = DEFAULT_DIRECT_TTL_DAYS } = {}) {
  return isBroadcast(message.to) ? broadcastTtlDays : directTtlDays;
}

/** Why a delivery expired, so the archive explains itself. */
export function deliveryExpiryReason(message) {
  return isBroadcast(message.to) ? 'broadcast-ttl' : 'direct-ttl';
}

/**
 * One delivery's state.
 * 'acked'    the recipient read it
 * 'retired'  the recipient is retired and can never read it
 * 'gone'     the identity is not in the registry any more
 * 'expired'  it waited longer than its TTL and the recipient cannot read it now
 * 'pending'  still readable
 */
export function deliveryStatus(message, recipient, agent, { now = Date.now(),
  broadcastTtlDays = DEFAULT_BROADCAST_TTL_DAYS, directTtlDays = DEFAULT_DIRECT_TTL_DAYS,
  withinMinutes = DEFAULT_LIVE_WINDOW_MINUTES, transportStaleMinutes = DEFAULT_TRANSPORT_STALE_MINUTES } = {}) {
  if (hasRead(recipient, message, agent)) return 'acked';
  if (!agent) return 'gone';
  if (agent.retired) return 'retired';
  const ttlDays = deliveryTtlDays(message, { broadcastTtlDays, directTtlDays });
  if (!(ttlDays > 0)) return 'pending';
  // A delivery expires once it has waited more than its TTL in whole days: a message that is
  // exactly at the TTL still belongs to the recipient's inbox.
  if (pendingDays(message, { now }) <= ttlDays) return 'pending';
  // A live recipient can still read it; only a recipient that cannot read it expires.
  if (isLive(agent, { now, withinMinutes, transportStaleMinutes })) return 'pending';
  return 'expired';
}

/** How many whole days a delivery has been waiting. */
export function pendingDays(message, { now = Date.now() } = {}) {
  const ageMs = Math.max(0, now - Date.parse(message.createdAt));
  return Math.floor(ageMs / 864e5);
}

/** Plan one room's compaction against the current ledger. Never mutates. */
export function planCompaction(state, room, { olderThanDays = DEFAULT_COMPACT_AFTER_DAYS, now = Date.now(), dropIdentities = false,
  broadcastTtlDays = DEFAULT_BROADCAST_TTL_DAYS, directTtlDays = DEFAULT_DIRECT_TTL_DAYS,
  withinMinutes = DEFAULT_LIVE_WINDOW_MINUTES, transportStaleMinutes = DEFAULT_TRANSPORT_STALE_MINUTES } = {}) {
  const cutoff = now - olderThanDays * 864e5;
  const agents = new Map(room.agents.map(agent => [agent.agentId, agent]));
  const archive = new Set();
  const expired = [];
  for (const message of room.messages) {
    if (Date.parse(message.createdAt) >= cutoff || message.attachments?.length) continue;
    let finished = true;
    const rows = [];
    for (const recipient of message.recipients) {
      const status = deliveryStatus(message, recipient, agents.get(recipient),
        { now, broadcastTtlDays, directTtlDays, withinMinutes, transportStaleMinutes });
      if (status === 'expired') {
        rows.push({ recipient, reason: deliveryExpiryReason(message),
          ttlDays: deliveryTtlDays(message, { broadcastTtlDays, directTtlDays }),
          pendingDays: pendingDays(message, { now }) });
      } else if (status === 'pending') { finished = false; break; }
    }
    if (!finished) continue;
    archive.add(message.messageId);
    for (const row of rows) expired.push({ messageId: message.messageId, ...row });
  }
  // Keep every message a retained message replies to (reply chains only point backwards).
  for (let changed = true; changed;) {
    changed = false;
    for (const message of room.messages) {
      if (!archive.has(message.messageId) && message.replyTo !== undefined && archive.has(message.replyTo)) {
        archive.delete(message.replyTo); changed = true;
      }
    }
  }
  const archived = room.messages.filter(message => archive.has(message.messageId));
  const retained = room.messages.filter(message => !archive.has(message.messageId));
  const identities = dropIdentities ? unreferencedDormant(state, room, retained) : [];
  return { project: room.project, archived, retainedCount: retained.length, identities,
    through: archived.reduce((max, message) => Math.max(max, message.cursor), 0),
    expired, expiredDeliveries: expired.length };
}

/**
 * The identities that hold compaction back: for each one, how many messages it pins and how many
 * delivery rows it holds, plus how long ago it was seen and how old its transport report is.
 * `state` is accepted so every caller passes the same arguments as `planCompaction`.
 */
export function compactionBlockers(state, room, { now = Date.now(), olderThanDays = DEFAULT_COMPACT_AFTER_DAYS,
  limit = DEFAULT_BLOCKER_LIMIT, broadcastTtlDays = DEFAULT_BROADCAST_TTL_DAYS, directTtlDays = DEFAULT_DIRECT_TTL_DAYS,
  withinMinutes = DEFAULT_LIVE_WINDOW_MINUTES, transportStaleMinutes = DEFAULT_TRANSPORT_STALE_MINUTES } = {}) {
  const cutoff = now - olderThanDays * 864e5;
  const agents = new Map((room?.agents ?? []).map(agent => [agent.agentId, agent]));
  const rows = new Map();
  const pinned = new Set();
  const note = (recipient, messageId, pins) => {
    let row = rows.get(recipient);
    if (!row) rows.set(recipient, row = { agentId: recipient, messages: 0, deliveries: 0 });
    row.deliveries++;
    if (pins) { row.messages++; pinned.add(messageId); }
  };
  for (const message of room?.messages ?? []) {
    const archivable = Date.parse(message.createdAt) < cutoff && !(message.attachments?.length);
    for (const recipient of message.recipients) {
      const status = deliveryStatus(message, recipient, agents.get(recipient),
        { now, broadcastTtlDays, directTtlDays, withinMinutes, transportStaleMinutes });
      if (status === 'acked' || status === 'retired' || status === 'gone') continue;
      note(recipient, message.messageId, archivable);
    }
  }
  const blockers = [...rows.values()].map(row => {
    const life = liveness(agents.get(row.agentId), { now, withinMinutes, transportStaleMinutes });
    return { agentId: row.agentId, messages: row.messages, deliveries: row.deliveries,
      holder: life.holder, live: life.live, lastSeenAgeMs: life.lastSeenAgeMs,
      transportAgeMs: life.transportAgeMs, transportStale: life.transportStale };
  }).sort((a, b) => b.messages - a.messages || b.deliveries - a.deliveries || a.agentId.localeCompare(b.agentId));
  return { blockers: blockers.slice(0, Math.max(0, limit)), total: blockers.length,
    blockedMessages: pinned.size,
    blockedDeliveries: blockers.reduce((total, row) => total + row.deliveries, 0) };
}

/** Dormant (left, not retired) identities with no reference anywhere in the retained ledger. */
export function unreferencedDormant(state, room, retained = room.messages) {
  const used = new Set();
  const add = id => { if (typeof id === 'string') used.add(id); };
  for (const message of retained) { add(message.from); message.recipients.forEach(add); }
  for (const claim of room.claims) { add(claim.agentId); add(claim.transferredFrom); }
  for (const task of room.tasks ?? []) { add(task.creator); add(task.owner); add(task.expectedRecipient); }
  for (const handoff of room.handoffs ?? []) {
    add(handoff.from); add(handoff.to); add(handoff.offeredBy); add(handoff.offeredTo);
    (handoff.generations ?? []).forEach(row => add(row.agentId));
  }
  for (const record of room.bulletin?.versions ?? []) record.acks.forEach(row => add(row.agentId));
  for (const row of room.processes ?? []) add(row.agentId);
  for (const claim of [...(state.machineClaims ?? []), ...(state.branchClaims ?? [])]) {
    if (claim.project === room.project) add(claim.agentId);
  }
  return room.agents.filter(agent => agent.left === true && !agent.retired && !used.has(agent.agentId)).map(agent => agent.agentId);
}

/** Append the archived messages to a new, fsynced archive file before the ledger drops them. */
export async function writeArchive(directory, plan, { now = new Date() } = {}) {
  if (!plan.archived.length) return null;
  const folder = path.join(directory, 'archive');
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const room = createHash('sha256').update(plan.project).digest('hex').slice(0, 12);
  const name = `${room}-${now.toISOString().replace(/[-:.]/gu, '')}-${randomUUID().slice(0, 8)}.jsonl`;
  // Expired deliveries travel with the message they belonged to, so the history stays explainable.
  const expired = new Map();
  for (const row of plan.expired ?? []) {
    const rows = expired.get(row.messageId) ?? [];
    rows.push({ recipient: row.recipient, reason: row.reason, ttlDays: row.ttlDays, pendingDays: row.pendingDays });
    expired.set(row.messageId, rows);
  }
  const text = plan.archived.map(message => {
    const rows = expired.get(message.messageId);
    return JSON.stringify(rows?.length
      ? { project: plan.project, message, expired: rows }
      : { project: plan.project, message });
  }).join('\n') + '\n';
  const file = await fs.open(path.join(folder, name), 'wx', 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  let dir;
  try { dir = await fs.open(folder, 'r'); await dir.sync(); }
  catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)
        && !(process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code))) throw error;
  } finally { await dir?.close(); }
  return { name, bytes: Buffer.byteLength(text) };
}

/** Apply a plan to a draft room. Returns counts for the report. */
export function applyCompaction(room, plan, archive, { at = new Date().toISOString() } = {}) {
  const drop = new Set(plan.archived.map(message => message.messageId));
  const before = room.messages.length;
  room.messages = room.messages.filter(message => !drop.has(message.messageId));
  const gone = new Set(plan.identities);
  const agentsBefore = room.agents.length;
  if (gone.size) room.agents = room.agents.filter(agent => !gone.has(agent.agentId));
  const archived = before - room.messages.length;
  if (archived) {
    const prior = room.archived ?? { messages: 0, through: 0, files: [] };
    room.archived = { messages: prior.messages + archived, through: Math.max(prior.through, plan.through),
      files: [...prior.files, archive.name].slice(-MAX_ARCHIVE_FILES), at,
      expiredDeliveries: (prior.expiredDeliveries ?? 0) + (plan.expiredDeliveries ?? 0) };
  }
  return { archivedMessages: archived, removedIdentities: agentsBefore - room.agents.length,
    expiredDeliveries: plan.expiredDeliveries ?? 0 };
}

export function validArchived(value, isText) {
  return value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value)
    && Number.isSafeInteger(value.messages) && value.messages >= 0
    && Number.isSafeInteger(value.through) && value.through >= 0
    && Array.isArray(value.files) && value.files.length <= MAX_ARCHIVE_FILES && value.files.every(name => isText(name, 256))
    && isText(value.at)
    && (value.expiredDeliveries === undefined
      || (Number.isSafeInteger(value.expiredDeliveries) && value.expiredDeliveries >= 0)));
}
