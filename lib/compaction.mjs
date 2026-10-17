// Ledger compaction: move old, fully delivered messages out of state.json into append-only
// archive files. On request it also drops dormant identities that nothing retained references
// (identity history stays resolvable by default; retired identities are always kept).
//
// A message is archivable when it is older than the cutoff, carries no attachments, and its
// delivery is finished: every recipient acknowledged it, the unacknowledged recipient is retired
// (it can never return), or it was a broadcast whose unacknowledged recipients are all dormant or
// retired. Direct messages to a dormant identity stay, because dormant identities keep durable
// inboxes. A message that a retained message replies to stays too, so reply links never dangle.
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isBroadcast } from './registry.mjs';

export const DEFAULT_COMPACT_AFTER_DAYS = 14;
export const MAX_ARCHIVE_FILES = 256;

function deliveryFinished(message, agents) {
  return message.recipients.every(id => {
    if (message.ackedBy.includes(id)) return true;
    const agent = agents.get(id);
    if (!agent || agent.retired) return true;
    return isBroadcast(message.to) && agent.left === true;
  });
}

/** Plan one room's compaction against the current ledger. Never mutates. */
export function planCompaction(state, room, { olderThanDays = DEFAULT_COMPACT_AFTER_DAYS, now = Date.now(), dropIdentities = false } = {}) {
  const cutoff = now - olderThanDays * 864e5;
  const agents = new Map(room.agents.map(agent => [agent.agentId, agent]));
  let archive = new Set(room.messages.filter(message => Date.parse(message.createdAt) < cutoff
    && !(message.attachments?.length) && deliveryFinished(message, agents)).map(message => message.messageId));
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
    through: archived.reduce((max, message) => Math.max(max, message.cursor), 0) };
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
  const text = plan.archived.map(message => JSON.stringify({ project: plan.project, message })).join('\n') + '\n';
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
      files: [...prior.files, archive.name].slice(-MAX_ARCHIVE_FILES), at };
  }
  return { archivedMessages: archived, removedIdentities: agentsBefore - room.agents.length };
}

export function validArchived(value, isText) {
  return value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value)
    && Number.isSafeInteger(value.messages) && value.messages >= 0
    && Number.isSafeInteger(value.through) && value.through >= 0
    && Array.isArray(value.files) && value.files.length <= MAX_ARCHIVE_FILES && value.files.every(name => isText(name, 256))
    && isText(value.at));
}
