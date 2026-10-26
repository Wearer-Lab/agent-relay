import {storeAttachments,fetchAttachments,validAttachment,ATTACHMENT_TOTAL_LIMIT,ATTACHMENT_FILE_LIMIT} from './attachments.mjs';
import http from 'node:http';
import {projectSummaries,roomSnapshot,machineClaims,presence,projectClaims,transportState} from './observability.mjs';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { gitCommonDir } from './gitworktree.mjs';
import { mutate, snapshot, createMessageCache, encodeState, stateBytes } from './ledger.mjs';
import { planCompaction, writeArchive, applyCompaction, validArchived, DEFAULT_COMPACT_AFTER_DAYS } from './compaction.mjs';
import { isBroadcast, isDormant, broadcastAudience, obligationIndex, hasObligations, emptyObligations, planPrune, markDormant, pruneReport, registryCounts, minutes,
  DEFAULT_LIVE_WINDOW_MINUTES, DEFAULT_PRUNE_IDLE_MINUTES, DEFAULT_EPHEMERAL_IDLE_MINUTES, DEFAULT_SWEEP_INTERVAL_MS } from './registry.mjs';
import { ownershipView, branchClaimView, validBranchClaims, validAgentGit } from './ownership.mjs';
import { createWork, validWorkLedger, workView, setStatus, derivedStatuses, reportedStatus, kindOf, WORK_ACTIONS, KINDS, STATUSES } from './workitems.mjs';
import { SCHEMA_2, SUPPORTED_SCHEMA_VERSIONS, isSchema2, isBroadcastMessage, hasReadMessage,
  ackTimeOf, fullyRead, advanceReadCursor } from './schema2.mjs';
let brokerPackage = 'unknown';
try {
  const parsed = JSON.parse(syncFs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (typeof parsed.version === 'string' && parsed.version) brokerPackage = parsed.version;
} catch {
  brokerPackage = 'unknown';
}

const MAX_REQUEST = 128 * 1024;
// Schema 1 is the default on-disk shape: one delivery row per recipient. Schema 2 stores a
// broadcast once and keeps the read state in one cursor per agent; it is opt-in and only a
// migrated ledger runs on it.
export const SCHEMA_VERSION = 1;
export const LATEST_SCHEMA_VERSION = SCHEMA_2;
export const MAX_STORE = 64 * 1024 * 1024;
const STORE_RESERVE = 1024 * 1024;
const MAX_MESSAGES = 10000;
const MAX_CLAIMS = 4096;
const MAX_NOTICES = 1024;
const NOTICES_PER_RECIPIENT = 6;
const MAX_FOLLOWUPS = 32;
export const MAX_ROOMS = 256;
export function noticeAllowance(recipientCount) {
  return Math.max(MAX_NOTICES, recipientCount * NOTICES_PER_RECIPIENT);
}
export const MAX_AGENTS_PER_PROJECT = 4096;
export const MAX_RETAINED_AGENTS = 8192;
export const MAX_HANDOFFS = 1024;
export const MAX_PROCESSES = 256;
export const MAX_TASKS = 4096;
const MAX_BULLETIN_VERSIONS = 16;
const claimMetaKeys = ['baseCommit', 'patchHash', 'resultingCommit', 'verification'];
const activeStores = new Set();
const namedResources = new Set(['build', 'install', 'native']);

const work = createWork((code, message, status, details) => fail(code, message, status, details));
class RpcError extends Error {
  constructor(code, message, httpStatus = 400, details) {
    super(message);
    Object.assign(this, { code, httpStatus, details });
  }
}
function fail(code, message, status = 400, details) {
  throw new RpcError(code, message, status, details);
}
function text(value, field, max = 128, trim = true) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max
      || (field !== 'body' && /[\u0000-\u001f]/u.test(value))) {
    fail('INVALID_INPUT', `${field} must be a nonempty bounded string.`);
  }
  return trim ? value.trim() : value;
}
function strings(value, field, allowEmpty = false) {
  if (!Array.isArray(value) || value.length > 64 || (!allowEmpty && value.length === 0)) {
    fail('INVALID_INPUT', `${field} must contain ${allowEmpty ? 'up to' : '1 to'} 64 strings.`);
  }
  return [...new Set(value.map(item => text(item, field, 4096)))];
}
function timestamp(value, field) {
  if (value === undefined) return undefined;
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) fail('INVALID_INPUT', `${field} must be an ISO timestamp.`);
  return ms;
}
function within(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}
async function canonicalProject(value) {
  const input = text(value, 'project', 4096);
  if (!path.isAbsolute(input)) fail('INVALID_PROJECT', 'project must be an absolute existing directory.');
  try {
    const canonical = await fs.realpath(input);
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch { fail('INVALID_PROJECT', 'project must be an absolute existing directory.'); }
}
async function canonicalResource(project, resource) {
  if (namedResources.has(resource)) return resource;
  const candidate = path.resolve(project, resource);
  const suffix = [];
  let ancestor = candidate;
  let canonical;
  for (;;) {
    try { canonical = path.resolve(await fs.realpath(ancestor), ...suffix); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  if (!within(project, canonical)) fail('INVALID_RESOURCE', 'Path resources must stay inside the project.');
  return canonical;
}
function resourceConflict(a, b) {
  if (namedResources.has(a) || namedResources.has(b)) return a === b;
  if (process.platform === 'win32') { a = a.toLowerCase(); b = b.toLowerCase(); }
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
    || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}
function validClaimMeta(value) {
  return value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => claimMetaKeys.includes(key))
    && Object.values(value).every(item => typeof item === 'string' && item.length > 0 && Buffer.byteLength(item) <= 4096)
    && Buffer.byteLength(JSON.stringify(value)) <= 8192);
}
function claimMeta(value, field = 'meta') {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${field} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!claimMetaKeys.includes(key))
      fail('INVALID_INPUT', `${field} may contain only baseCommit, patchHash, resultingCommit, and verification.`);
  }
  const meta = {};
  for (const key of claimMetaKeys) if (value[key] !== undefined) meta[key] = text(value[key], `${field}.${key}`, 4096);
  if (!validClaimMeta(meta)) fail('INVALID_INPUT', `${field} exceeds its bounds.`);
  return meta;
}
function branchName(value, field = 'branch') {
  const name = text(value, field, 256);
  const bare = (name.startsWith('refs/heads/') ? name.slice(11) : name).trim();
  if (!bare) fail('INVALID_INPUT', `${field} must be a nonempty bounded string.`);
  return bare;
}
function groupView(state, room) {
  if (!room?.group) return null;
  const commonDir = room.group.commonDir ?? null;
  const members = state.rooms.filter(candidate => candidate.group?.id === room.group.id);
  const verified = commonDir !== null
    && members.every(candidate => (candidate.group.commonDir ?? null) === null || candidate.group.commonDir === commonDir);
  return { id: room.group.id, commonDir, verified, members: members.map(candidate => candidate.project) };
}
function pendingHandoffs(room) {
  return (room?.handoffs ?? []).filter(handoff => handoff.state === 'pending');
}
function annotateClaims(claims, room) {
  const pending = pendingHandoffs(room);
  return claims.map(claim => {
    if (claim.scope !== 'project') return claim;
    const ids = pending.filter(handoff => handoff.resources.includes(claim.resource)).map(handoff => handoff.id);
    return ids.length ? { ...claim, handoffPending: ids } : claim;
  });
}
function handoffWarnings(room) {
  return pendingHandoffs(room).map(handoff => {
    const held = handoff.resources.filter(resource => (room?.claims ?? []).some(claim => claim.resource === resource));
    if (!held.length) return null;
    return { code: 'HANDOFF_PENDING', holder: room.claims.find(claim => claim.resource === held[0])?.agentId ?? null,
      resources: held, requestIds: [handoff.id],
      message: 'Holder retains claimed resources while a handoff request is pending.' };
  }).filter(Boolean);
}
function taskView(room, task, state, derived) {
  const claims = room?.claims ?? [];
  const blocking = (task.blockedBy ?? []).map(ref => {
    const other = (room?.tasks ?? []).find(candidate => candidate.id === ref);
    if (other) return { ref, kind: 'task', holder: other.owner ?? null, state: other.state };
    const machine = (state?.machineClaims ?? []).find(c => c.resource === ref);
    if (machine) return { ref, kind: 'claim', scope: 'machine', holder: machine.agentId, state: 'held' };
    let resolved = ref;
    if (room?.project !== undefined && !namedResources.has(ref)) {
      const candidate = path.resolve(room.project, ref);
      try {
        let ancestor = candidate;
        const suffix = [];
        for (;;) {
          try {
            resolved = path.resolve(syncFs.realpathSync.native(ancestor), ...suffix);
            break;
          } catch (error) {
            if (error?.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
            suffix.unshift(path.basename(ancestor));
            ancestor = path.dirname(ancestor);
          }
        }
      } catch {
        resolved = candidate;
      }
    }
    const claim = claims.find(c => c.resource === ref || resourceConflict(c.resource, resolved));
    if (claim) return { ref, kind: 'claim', scope: 'project', holder: claim.agentId, state: 'held' };
    return { ref, kind: 'unknown', holder: null, state: null };
  });
  const handoff = task.handoffId == null ? undefined
    : (room?.handoffs ?? []).find(candidate => candidate.id === task.handoffId);
  return workView(task, { ...snapshot(task), blocking,
    blocked: blocking.some(row => (row.kind === 'claim' && row.state === 'held')
      || (row.kind === 'task' && row.state === 'open')),
    handoff: task.handoffId == null ? null : handoff === undefined ? { id: task.handoffId, state: 'missing' }
      : { id: handoff.id, state: handoff.state, from: handoff.from, to: handoff.to, accepted: handoff.state === 'accepted' } }, derived);
}
// One rolled-up status pass per response; the derived status is display-only and never written to state.
function taskViewer(room, state) {
  const derived = derivedStatuses(room?.tasks ?? []);
  return task => taskView(room, task, state, derived.get(task.id));
}
function blockedView(room) {
  const holders = new Map();
  for (const handoff of pendingHandoffs(room)) {
    const claims = (room?.claims ?? []).filter(claim => handoff.resources.includes(claim.resource));
    if (!claims.length) continue;
    const holder = claims[0].agentId;
    if (!holders.has(holder)) holders.set(holder, { holder, resources: [], claims: [], requestIds: [], requests: [] });
    const row = holders.get(holder);
    for (const claim of claims) {
      if (!row.resources.includes(claim.resource)) { row.resources.push(claim.resource); row.claims.push({ ...claim }); }
      if (!row.requestIds.includes(handoff.id)) row.requestIds.push(handoff.id);
    }
    row.requests.push({ id: handoff.id, from: handoff.from, to: handoff.to, resources: [...handoff.resources],
      reason: handoff.reason, requestedAt: handoff.requestedAt });
  }
  const blocked = [...holders.values()].map(row => {
    const holder = room?.agents.find(agent => agent.agentId === row.holder);
    return { ...row, stale: !holder || holder.left === true };
  });
  return { blocked, warnings: handoffWarnings(room) };
}
function markerStage(marker) {
  if (marker.adapter.endsWith('-accepted')) return 'accepted';
  if (marker.adapter.endsWith('-attempted')) return 'attempted';
  if (marker.adapter.endsWith('-missing') || marker.adapter.endsWith('-failed')) return 'missing';
  return 'notified';
}
function recipientReceipt(message, agentId, agent) {
  const markers = message.notified.filter(marker => marker.agentId === agentId);
  const accepted = markers.filter(marker => markerStage(marker) === 'accepted');
  const missing = markers.filter(marker => markerStage(marker) === 'missing');
  const notified = markers.filter(marker => {
    const stage = markerStage(marker);
    return stage === 'notified' || stage === 'attempted';
  });
  // Schema 1 reads the explicit ack off the message; schema 2 also reads the agent's cursor.
  const acked = hasReadMessage(agentId, message, agent);
  const ackTs = ackTimeOf(agentId, message, agent);
  const state = acked ? 'acked' : accepted.length ? 'accepted'
    : missing.length ? 'missing'
    : notified.some(marker => markerStage(marker) === 'notified') ? 'notified' : notified.length ? 'attempted' : 'stored';
  return { agentId, stored: true, notified: notified.map(marker => ({ adapter: marker.adapter, ts: marker.at })),
    accepted: accepted.map(marker => ({ adapter: marker.adapter, ts: marker.at })),
    missing: missing.map(marker => ({ adapter: marker.adapter, ts: marker.at })),
    acked, ...(ackTs !== undefined ? { ackTs } : {}), state, cursor: message.cursor };
}
function messageReceipt(message, room) {
  const agents = room ? new Map(room.agents.map(agent => [agent.agentId, agent])) : new Map();
  const recipients = message.recipients.map(agentId => recipientReceipt(message, agentId, agents.get(agentId)));
  return { id: message.messageId, ts: message.createdAt, from: message.from, to: message.to,
    summary: message.summary ?? null, body: message.body, cursor: message.cursor, recipients,
    counts: { recipients: recipients.length,
      acked: recipients.filter(row => row.state === 'acked').length,
      accepted: recipients.filter(row => row.state === 'accepted').length,
      notified: recipients.filter(row => row.state === 'notified' || row.state === 'attempted').length,
      pending: recipients.filter(row => row.state === 'stored').length,
      missing: recipients.filter(row => row.state === 'missing').length },
    followups: (message.followups ?? []).map(row => ({ ...row })) };
}
function pendingReceipts(message, room) {
  const agents = room ? new Map(room.agents.map(agent => [agent.agentId, agent])) : new Map();
  return message.recipients.map(agentId => recipientReceipt(message, agentId, agents.get(agentId))).filter(row => row.state === 'stored' || row.state === 'missing')
    .map(row => {
      if (row.state === 'missing') {
        const markers = message.notified.filter(marker => marker.agentId === row.agentId && markerStage(marker) === 'missing');
        const reconciled = markers.find(marker => marker.adapter === 'codex-reconciled-missing');
        const chosen = reconciled ?? markers[0];
        return { agentId: row.agentId,
          reason: reconciled ? 'operator-confirmed-missing' : 'negative-reconciliation',
          ts: chosen.at };
      }
      const agent = agents.get(row.agentId);
      return { agentId: row.agentId,
        reason: agent?.retired ? 'recipient-retired' : agent?.left ? 'recipient-left' : 'no-transport-markers',
        ts: message.createdAt };
    });
}
/**
 * The reader list of a message as a schema 1 client expects it. Schema 2 keeps the read state in
 * the agents' cursors, so a broadcast's stored `ackedBy` only holds the out-of-order reads; the
 * history view rebuilds the full list so an old client keeps seeing who read what. The schema 2
 * markers stay inside the ledger: a client sees the same message shape it always saw.
 */
function messageView(message, room) {
  if (message?.kind === undefined) return message;
  const { kind, audience, ...rest } = message;
  if (kind !== 'broadcast') return rest;
  const agents = room ? new Map(room.agents.map(agent => [agent.agentId, agent])) : new Map();
  const readers = [], acks = [];
  for (const agentId of message.recipients) {
    const agent = agents.get(agentId);
    if (!hasReadMessage(agentId, message, agent)) continue;
    readers.push(agentId);
    const row = Array.isArray(message.acks) ? message.acks.find(a => a?.agentId === agentId) : undefined;
    const at = row?.at ?? agent?.readThroughAt;
    if (at) acks.push({ agentId, at });
  }
  return { ...rest, ackedBy: readers, ...(acks.length ? { acks } : {}) };
}
function bulletinHash(title, body, source) {
  return createHash('sha256').update(JSON.stringify({ title, body, source })).digest('hex');
}
function bulletinView(record) {
  return { version: record.version, title: record.title, body: record.body, source: record.source,
    hash: record.hash, ts: record.ts, acks: record.acks.map(row => row.agentId) };
}
function probeAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
function processView(row, alive) {
  return { id: row.id, agentId: row.agentId, pid: row.pid,
    command: row.command ?? null, cwd: row.cwd ?? null, port: row.port ?? null,
    deployment: row.deployment ?? null, note: row.note ?? null,
    startedAt: row.startedAt, lastVerifiedAt: row.lastVerifiedAt ?? null, alive };
}
const livenessView = { method: 'process.kill(pid,0)', pidReuse: 'best-effort',
  limit: 'startedAt records registration time, not the kernel process start; a recycled PID can appear alive' };

/**
 * Validate a whole ledger. Pass the broker's `validated` WeakSet to skip the per-message checks
 * for message objects that already passed them; agents are only ever removed by full-validation
 * paths (load, restore, compaction), so an unchanged message stays valid. Messages within a room
 * must be in ascending cursor order, which every broker-written ledger satisfies.
 */
export function validateStore(state, { validated } = {}) {
  const corrupt = () => { throw new Error('Relay state is corrupt or unsupported; retained without modification.'); };
  // A schema 2 ledger that still holds schema 1 messages is half migrated. Say so plainly and
  // name the fix instead of reading half of it.
  const mixed = () => { throw new Error('Relay state mixes schema 1 messages with a schema 2 ledger; run `agent-relay migrate --to 2` to convert it.'); };
  const isText = (v, limit = 4096) => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= limit;
  if (!state || !SUPPORTED_SCHEMA_VERSIONS.includes(state.version) || !Number.isSafeInteger(state.nextCursor)
      || state.nextCursor < 1 || !Array.isArray(state.rooms) || state.rooms.length > MAX_ROOMS) corrupt();
  const schema2 = state.version === SCHEMA_2;
  const projects = new Set();
  const cursors = new Set();
  let largest = 0, messageCount = 0, roomCursorMax = 0;
  for (const room of state.rooms) {
    if (!room || !isText(room.project) || !path.isAbsolute(room.project) || projects.has(room.project)
        || !Array.isArray(room.agents) || room.agents.length > MAX_RETAINED_AGENTS || !Array.isArray(room.messages)
        || !Array.isArray(room.claims) || room.claims.length > MAX_CLAIMS
        || !Number.isSafeInteger(room.cursor) || room.cursor < 0) corrupt();
    if (room.group !== undefined && (!room.group || typeof room.group !== 'object' || Array.isArray(room.group)
        || !isText(room.group.id, 128) || (room.group.commonDir !== undefined && room.group.commonDir !== null
          && !isText(room.group.commonDir, 4096)))) corrupt();
    projects.add(room.project);
    const agents = new Set();
    for (const agent of room.agents) {
      if (!agent || !isText(agent.agentId, 128) || agents.has(agent.agentId)
          || !isText(agent.runner, 80) || !isText(agent.registeredAt) || !isText(agent.updatedAt)
          || !isText(agent.status, 80) || typeof agent.frozen !== 'boolean'
          || !Array.isArray(agent.resources) || agent.resources.length > 64
          || agent.resources.some(r => !isText(r))) corrupt();
      if (agent.left!==undefined&&typeof agent.left!=='boolean') corrupt();
      if (agent.retired!==undefined&&typeof agent.retired!=='boolean') corrupt();
      if (agent.sessionId !== undefined && !isText(agent.sessionId, 256)) corrupt();
      if (agent.test !== undefined && typeof agent.test !== 'boolean') corrupt();
      if (agent.ephemeral !== undefined && typeof agent.ephemeral !== 'boolean') corrupt();
      if (agent.task !== null && typeof agent.task !== 'string'
          && (!agent.task || typeof agent.task !== 'object' || Array.isArray(agent.task))) corrupt();
      if (Buffer.byteLength(JSON.stringify(agent.task)) > 8192) corrupt();
      if (agent.statusAt !== undefined && !isText(agent.statusAt)) corrupt();
      if (agent.readThrough !== undefined && (!Number.isSafeInteger(agent.readThrough) || agent.readThrough < 0)) corrupt();
      if (agent.readThroughAt !== undefined && !isText(agent.readThroughAt)) corrupt();
      if (agent.git !== undefined && !validAgentGit(agent.git)) corrupt();
      if (agent.transport !== undefined && (!agent.transport || typeof agent.transport !== 'object'
          || Array.isArray(agent.transport) || !isText(agent.transport.adapter, 80)
          || !['connected', 'disconnected', 'unknown'].includes(agent.transport.state)
          || !isText(agent.transport.ts)
          || (agent.transport.push !== undefined && typeof agent.transport.push !== 'boolean')
          || (agent.transport.source !== undefined && !isText(agent.transport.source, 80)))) corrupt();
      agents.add(agent.agentId);
    }
    if (room.agents.filter(agent => !agent.left).length > MAX_AGENTS_PER_PROJECT) corrupt();
    const ids = new Set();
    let roomLargest = 0;
    for (const message of room.messages) {
      if (!message || ids.has(message.messageId) || cursors.has(message.cursor) || !(message.cursor > roomLargest)) corrupt();
      if (schema2) {
        // Schema 2 marks every message; a message without the marker is a schema 1 leftover.
        if (message.kind !== 'direct' && message.kind !== 'broadcast') mixed();
        if ((message.kind === 'broadcast') !== isBroadcast(message.to)) corrupt();
        if (message.kind === 'broadcast') {
          const audience = message.audience;
          if (!audience || typeof audience !== 'object' || Array.isArray(audience)
              || !['live', 'all'].includes(audience.mode)
              || (audience.within !== null && audience.within !== undefined
                && (!Number.isFinite(audience.within) || audience.within < 0))
              || (audience.excluded !== null && audience.excluded !== undefined
                && (!Number.isSafeInteger(audience.excluded) || audience.excluded < 0))) corrupt();
        }
      }
      if (validated?.has(message)) {
        ids.add(message.messageId); cursors.add(message.cursor);
        largest = Math.max(largest, message.cursor); roomLargest = message.cursor;
        messageCount++;
        continue;
      }
      if (!isText(message.messageId, 128)
          || !agents.has(message.from) || !isText(message.to, 128) || !isText(message.body, 16384)
          || !isText(message.createdAt) || !Number.isSafeInteger(message.cursor) || message.cursor < 1
          || cursors.has(message.cursor) || !Array.isArray(message.recipients) || message.recipients.length === 0
          || new Set(message.recipients).size !== message.recipients.length
          || message.recipients.some(id => !agents.has(id)) || !Array.isArray(message.ackedBy)
          || new Set(message.ackedBy).size !== message.ackedBy.length
           || message.ackedBy.some(id => !message.recipients.includes(id)) || !Array.isArray(message.notified)
           || message.notified.length > noticeAllowance(message.recipients.length)) corrupt();
      if (!isBroadcast(message.to) && (message.recipients.length !== 1 || message.recipients[0] !== message.to)) corrupt();
      if (isBroadcast(message.to) && message.recipients.includes(message.from)) corrupt();
      if (message.summary!==undefined&&(!isText(message.summary,480)||Array.from(message.summary).length>120)) corrupt();
      if (message.attachments !== undefined && (!Array.isArray(message.attachments)||message.attachments.length>64||message.attachments.some(a=>!validAttachment(a)))) corrupt();
      if (message.replyTo !== undefined && !isText(message.replyTo, 128)) corrupt();
      if (message.notified.some(n => !n || !message.recipients.includes(n.agentId)
          || !isText(n.adapter, 80) || !isText(n.at))) corrupt();
      if (message.acks !== undefined && (!Array.isArray(message.acks)
          || new Set(message.acks.map(a => a?.agentId)).size !== message.acks.length
          || message.acks.some(a => !a || !message.ackedBy.includes(a.agentId) || !isText(a.at)))) corrupt();
      if (message.followups !== undefined) {
        if (!Array.isArray(message.followups) || message.followups.length > MAX_FOLLOWUPS) corrupt();
        const followupIds = new Set();
        for (const followup of message.followups) {
          if (!followup || !isText(followup.id, 128) || followupIds.has(followup.id)
              || (followup.agentId !== message.from && !message.recipients.includes(followup.agentId))
              || !isText(followup.at) || (followup.note !== undefined && !isText(followup.note, 1024))) corrupt();
          followupIds.add(followup.id);
        }
      }
      ids.add(message.messageId); cursors.add(message.cursor);
      largest = Math.max(largest, message.cursor); roomLargest = Math.max(roomLargest, message.cursor);
      messageCount++;
    }
    // Compaction can archive a room's newest messages, so its cursor may run ahead of the
    // retained ones (never behind them, and never behind what was archived).
    if (!validArchived(room.archived, isText)) corrupt();
    if (room.archived === undefined ? room.cursor !== roomLargest
      : room.cursor < roomLargest || room.cursor < room.archived.through) corrupt();
    roomCursorMax = Math.max(roomCursorMax, room.cursor);
    if (room.messages.some(m => m.replyTo !== undefined && !ids.has(m.replyTo))) corrupt();
    const resources = new Set();
    for (const claim of room.claims) {
      if (!claim || !agents.has(claim.agentId) || !isText(claim.resource) || resources.has(claim.resource)
          || !isText(claim.claimedAt) || !validClaimMeta(claim.meta)
          || (claim.transferredFrom !== undefined && !agents.has(claim.transferredFrom))
          || (claim.transferredAt !== undefined && !isText(claim.transferredAt))
          || (!namedResources.has(claim.resource)
            && (!path.isAbsolute(claim.resource) || !within(room.project, claim.resource)))) corrupt();
      resources.add(claim.resource);
    }
    for (let i = 0; i < room.claims.length; i++) {
      for (let j = i + 1; j < room.claims.length; j++) {
        if (room.claims[i].agentId !== room.claims[j].agentId
            && resourceConflict(room.claims[i].resource, room.claims[j].resource)) corrupt();
      }
    }
    if (room.tasks !== undefined) {
      if (!Array.isArray(room.tasks) || room.tasks.length > MAX_TASKS) corrupt();
      const taskIds = new Set();
      for (const task of room.tasks) {
        if (!task || !isText(task.id, 128) || taskIds.has(task.id) || !agents.has(task.creator)
            || !isText(task.title, 480) || (task.owner !== undefined && task.owner !== null && !agents.has(task.owner))
            || !['open', 'complete'].includes(task.state) || !isText(task.createdAt) || !isText(task.updatedAt)
            || (task.blockedBy !== undefined && (!Array.isArray(task.blockedBy) || task.blockedBy.length > 64
              || task.blockedBy.some(r => !isText(r, 4096))))
            || (task.resources !== undefined && (!Array.isArray(task.resources) || task.resources.length > 64
              || task.resources.some(r => !isText(r, 4096))))
            || (task.sourceRevision !== undefined && !isText(task.sourceRevision, 256))
            || (task.verification !== undefined && !isText(task.verification, 4096))
            || (task.expectedRecipient !== undefined && task.expectedRecipient !== null && !agents.has(task.expectedRecipient))
            || (task.handoffId !== undefined && task.handoffId !== null && !isText(task.handoffId, 128))
            || (task.completionAck !== undefined && task.completionAck !== null
              && (typeof task.completionAck !== 'boolean'))) corrupt();
        taskIds.add(task.id);
      }
      if (!validWorkLedger(room.tasks)) corrupt();
    }
    if (room.handoffs !== undefined) {
      if (!Array.isArray(room.handoffs) || room.handoffs.length > MAX_HANDOFFS) corrupt();
      const handoffIds = new Set();
      for (const handoff of room.handoffs) {
        if (!handoff || !isText(handoff.id, 128) || handoffIds.has(handoff.id) || !agents.has(handoff.from)
            || (handoff.to !== null && handoff.to !== undefined && !agents.has(handoff.to))
            || handoff.to === handoff.from || !Array.isArray(handoff.resources)
            || handoff.resources.length < 1 || handoff.resources.length > 64
            || new Set(handoff.resources).size !== handoff.resources.length
            || handoff.resources.some(r => !isText(r)) || !isText(handoff.reason)
            || !isText(handoff.requestedAt) || !['pending', 'accepted', 'declined'].includes(handoff.state)
            || !validClaimMeta(handoff.meta)) corrupt();
        if (handoff.respondedAt !== undefined && !isText(handoff.respondedAt)) corrupt();
        if (handoff.respondedBy !== undefined && !isText(handoff.respondedBy, 128)) corrupt();
        if (handoff.transferred !== undefined && (!Array.isArray(handoff.transferred)
            || handoff.transferred.some(r => !isText(r)))) corrupt();
        if (handoff.offeredBy !== undefined && (!isText(handoff.offeredBy, 128) || !agents.has(handoff.offeredBy))) corrupt();
        if (handoff.offeredTo !== undefined && handoff.offeredTo !== null
            && (!isText(handoff.offeredTo, 128) || !agents.has(handoff.offeredTo))) corrupt();
        if (handoff.generations !== undefined) {
          if (!Array.isArray(handoff.generations) || handoff.generations.length < 1 || handoff.generations.length > 64) corrupt();
          for (const generation of handoff.generations) {
            if (!generation || !isText(generation.resource) || !isText(generation.claimedAt)
                || !isText(generation.agentId, 128) || !agents.has(generation.agentId)) corrupt();
          }
        }
        handoffIds.add(handoff.id);
      }
    }
    if (room.bulletin !== undefined) {
      if (!room.bulletin || typeof room.bulletin !== 'object' || Array.isArray(room.bulletin)
          || !Array.isArray(room.bulletin.versions) || room.bulletin.versions.length < 1
          || room.bulletin.versions.length > MAX_BULLETIN_VERSIONS) corrupt();
      let expected = room.bulletin.versions[0].version;
      for (const record of room.bulletin.versions) {
        if (!record || !Number.isSafeInteger(record.version) || record.version !== expected || record.version < 1
            || !isText(record.title, 480) || !isText(record.body, 16384) || !isText(record.source, 4096)
            || !isText(record.hash, 64) || !/^[a-f0-9]{64}$/u.test(record.hash) || !isText(record.ts)
            || bulletinHash(record.title, record.body, record.source) !== record.hash
            || !Array.isArray(record.acks) || record.acks.length > MAX_RETAINED_AGENTS
            || new Set(record.acks.map(a => a?.agentId)).size !== record.acks.length
            || record.acks.some(a => !a || !agents.has(a.agentId) || !isText(a.at))) corrupt();
        expected--;
      }
    }
    if (room.processes !== undefined) {
      if (!Array.isArray(room.processes) || room.processes.length > MAX_PROCESSES) corrupt();
      const processIds = new Set(), processPids = new Set();
      for (const row of room.processes) {
        if (!row || !isText(row.id, 128) || processIds.has(row.id) || !agents.has(row.agentId)
            || !Number.isSafeInteger(row.pid) || row.pid < 1 || processPids.has(row.pid)
            || (row.command !== undefined && !isText(row.command, 4096))
            || (row.cwd !== undefined && !isText(row.cwd, 4096))
            || (row.port !== undefined && (!Number.isInteger(row.port) || row.port < 1 || row.port > 65535))
            || (row.deployment !== undefined && !isText(row.deployment, 4096))
            || (row.note !== undefined && !isText(row.note, 1024))
            || !isText(row.startedAt) || !isText(row.lastVerifiedAt)) corrupt();
        processIds.add(row.id); processPids.add(row.pid);
      }
    }
  }
  if (state.machineClaims !== undefined) {
    if (!Array.isArray(state.machineClaims) || state.machineClaims.length > MAX_CLAIMS) corrupt();
    const resources = new Set();
    for (const c of state.machineClaims) {
      if (!c || !isText(c.resource,128) || resources.has(c.resource) || !isText(c.claimedAt) || !validClaimMeta(c.meta)
          || !state.rooms.find(r=>r.project===c.project)?.agents.some(a=>a.agentId===c.agentId)) corrupt();
      resources.add(c.resource);
    }
  }
  if (state.branchClaims !== undefined && !validBranchClaims(state, validClaimMeta, MAX_CLAIMS)) corrupt();
  if (state.releaseLog !== undefined && (!Array.isArray(state.releaseLog) || state.releaseLog.length>10000
      || state.releaseLog.some(e=>!e||!isText(e.as,128)||!isText(e.at)||!isText(e.project)||!Array.isArray(e.released)))) corrupt();
  if (messageCount > MAX_MESSAGES || state.nextCursor !== Math.max(largest, roomCursorMax) + 1) corrupt();
  if (validated) for (const room of state.rooms) for (const message of room.messages) validated.add(message);
}
export async function verifyAttachmentReferences(directory, stateLike) {
  const refs = new Map();
  for (const room of stateLike?.rooms ?? []) {
    for (const message of room?.messages ?? []) {
      for (const item of message?.attachments ?? []) {
        if (!item || typeof item.sha256 !== 'string') continue;
        let row = refs.get(item.sha256);
        if (!row) {
          row = { sha256: item.sha256, messages: [], sizes: new Set() };
          refs.set(item.sha256, row);
        }
        if (typeof message?.messageId === 'string' && !row.messages.includes(message.messageId)) row.messages.push(message.messageId);
        if (Number.isSafeInteger(item.size)) row.sizes.add(item.size);
      }
    }
  }
  const missing = [];
  const corrupt = [];
  if (typeof directory !== 'string' || !directory) {
    for (const row of refs.values()) corrupt.push({ sha256: row.sha256, reason: 'unreadable', messages: [...row.messages] });
    return { missing, corrupt };
  }
  for (const row of refs.values()) {
    if (!/^[a-f0-9]{64}$/u.test(row.sha256)) {
      corrupt.push({ sha256: row.sha256, reason: 'unreadable', messages: [...row.messages] });
      continue;
    }
    const file = path.join(directory, 'attachments', row.sha256);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) {
        corrupt.push({ sha256: row.sha256, reason: 'unreadable', messages: [...row.messages] });
        continue;
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        missing.push({ sha256: row.sha256, messages: [...row.messages] });
        continue;
      }
      corrupt.push({ sha256: row.sha256, reason: 'unreadable', messages: [...row.messages] });
      continue;
    }
    if (row.sizes.size > 1) {
      corrupt.push({ sha256: row.sha256, reason: 'size-mismatch', messages: [...row.messages] });
      continue;
    }
    const expected = [...row.sizes][0];
    let bytes;
    try {
      const handle = await fs.open(file, 'r');
      try {
        const current = await handle.stat();
        if (!current.isFile()) throw new Error('unreadable');
        if (current.size > ATTACHMENT_FILE_LIMIT) throw new Error('oversize');
        const buffer = Buffer.alloc(current.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length !== current.size) throw new Error('unreadable');
        bytes = buffer.subarray(0, length);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        missing.push({ sha256: row.sha256, messages: [...row.messages] });
        continue;
      }
      if (error.message === 'oversize') {
        corrupt.push({ sha256: row.sha256, reason: 'size-mismatch', messages: [...row.messages] });
        continue;
      }
      corrupt.push({ sha256: row.sha256, reason: 'unreadable', messages: [...row.messages] });
      continue;
    }
    if (expected !== undefined && bytes.length !== expected) {
      corrupt.push({ sha256: row.sha256, reason: 'size-mismatch', messages: [...row.messages] });
      continue;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
      corrupt.push({ sha256: row.sha256, reason: 'hash-mismatch', messages: [...row.messages] });
      continue;
    }
  }
  return { missing, corrupt };
}
async function readBody(request) {
  if (Number(request.headers['content-length']) > MAX_REQUEST)
    fail('REQUEST_TOO_LARGE', 'Request exceeds 128 KiB.', 413);
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_REQUEST) fail('REQUEST_TOO_LARGE', 'Request exceeds 128 KiB.', 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('INVALID_JSON', 'Request must be a JSON object.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_JSON', 'Request must be a JSON object.');
  return value;
}
function json(response, status, value) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

// Startup discovery is separate from ownership of the durable writer. A
// proven-dead lease may be reclaimed, but ambiguous ownership fails closed.
async function writerLease(directory, fsp = fs) {
  const file = path.join(directory, 'writer.lock');
  const recovery = path.join(directory, 'writer-recovery.lock');
  const nonce = randomUUID();
  const bytes = JSON.stringify({ version: 1, pid: process.pid, nonce });
  async function exists(name) {
    try { await fsp.stat(name); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function removeOwn(name, expected) {
    try { if (await fsp.readFile(name, 'utf8') === expected) await fsp.unlink(name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function create(name, content) {
    const handle = await fsp.open(name, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
  }
  async function acquire(recovering = false) {
    if (!recovering && await exists(recovery)) throw new Error('Writer recovery ownership is unknown; retained for manual inspection.');
    await create(file, bytes);
    // A recovery claimant may appear between the precheck and exclusive
    // creation. This lease cannot activate while its sentinel exists.
    if (!recovering && await exists(recovery)) {
      await removeOwn(file, bytes);
      throw new Error('Writer recovery is in progress; retry startup.');
    }
  }
  try { await acquire(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let sentinel = false;
    try {
      await create(recovery, bytes);
      sentinel = true;
      const retained = await fsp.readFile(file, 'utf8');
      let owner;
      try { owner = JSON.parse(retained); } catch { throw new Error('Writer lock is corrupt or ownership is unknown; retained.'); }
      if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1
          || typeof owner.nonce !== 'string' || !owner.nonce) throw new Error('Writer ownership is unknown; retained.');
      try {
        process.kill(owner.pid, 0);
        throw new Error('Another live broker owns this data directory.');
      } catch (probe) {
        if (probe.code !== 'ESRCH') throw new Error('Another live broker owns this data directory, or ownership cannot be proved dead.');
      }
      // Every new lease checks the sentinel before activation, and only one
      // recoverer can hold it. No active writer can replace this dead lease.
      if (await fsp.readFile(file, 'utf8') !== retained) throw new Error('Writer ownership changed during recovery; retry startup.');
      await fsp.unlink(file);
      await acquire(true);
    } finally {
      if (sentinel) await removeOwn(recovery, bytes);
    }
  }
  return () => removeOwn(file, bytes);
}
export async function offlineRestore(dataDir, incoming, { allowIncomplete, dryRun, schemaVersion, fs: seam } = {}) {
  const fsp = seam ?? fs;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    fail('INVALID_INPUT', 'incoming must be an object.');
  }
  if (schemaVersion !== undefined && !SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion))
    fail('SCHEMA_MISMATCH', `Export schema ${schemaVersion} is not supported by this runtime.`, 400,
      { expected: SCHEMA_VERSION, supported: SUPPORTED_SCHEMA_VERSIONS });
  if (dryRun !== undefined && typeof dryRun !== 'boolean') fail('INVALID_INPUT', 'dryRun must be boolean.');
  if (allowIncomplete !== undefined && typeof allowIncomplete !== 'boolean') fail('INVALID_INPUT', 'allowIncomplete must be boolean.');
  try { validateStore(structuredClone(incoming)); }
  catch { fail('INVALID_RESTORE', 'Restored state failed validation; the ledger was left intact.'); }
  const serialized = JSON.stringify(incoming);
  const bytes = Buffer.byteLength(serialized);
  if (bytes > MAX_STORE) fail('STORE_LIMIT', 'Relay state exceeds its storage bound.', 409, { bytes, limit: MAX_STORE });
  let directory;
  try { directory = await fsp.realpath(dataDir); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (dryRun === true) {
      const verified = await verifyAttachmentReferences(path.resolve(dataDir), incoming);
      return { valid: !verified.missing.length && !verified.corrupt.length, dryRun: true,
        missingAttachments: verified.missing, corruptAttachments: verified.corrupt,
        rooms: incoming.rooms.length, messages: incoming.rooms.reduce((n,r)=>n+r.messages.length,0), bytes };
    }
    await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 });
    directory = await fsp.realpath(dataDir);
  }
  if (!(await fsp.stat(directory)).isDirectory()) throw new Error('dataDir must be a directory.');
  const release = await writerLease(directory, fsp);
  try {
    const stateFile = path.join(directory, 'state.json');
    try {
      const seen = await fsp.lstat(stateFile);
      if (seen.isSymbolicLink()) fail('SYMLINK_STATE', `Refusing offline restore with symlinked state file ${stateFile}; resolve it manually.`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const verified = await verifyAttachmentReferences(directory, incoming);
    const missingAttachments = verified.missing ?? [];
    const corruptAttachments = verified.corrupt ?? [];
    const rooms = incoming.rooms.length;
    const messages = incoming.rooms.reduce((total, room) => total + room.messages.length, 0);
    if (dryRun === true) return { valid: !missingAttachments.length && !corruptAttachments.length,
      dryRun: true, missingAttachments, corruptAttachments, rooms, messages, bytes };
    if ((missingAttachments.length || corruptAttachments.length) && allowIncomplete !== true) {
      fail('INCOMPLETE_ATTACHMENTS', 'Restored state references missing or corrupt attachments; the ledger was left intact.', 409, { missingAttachments, corruptAttachments });
    }
    let backup = null;
    try {
      const current = await fsp.readFile(stateFile);
      const name = `state.backup-${Date.now()}.json`;
      const backupPath = path.join(directory, name);
      const backupHandle = await fsp.open(backupPath, 'wx', 0o600);
      try {
        await backupHandle.writeFile(current);
        await backupHandle.sync();
      } finally {
        await backupHandle.close();
      }
      await fsp.chmod(backupPath, 0o600);
      backup = name;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
    let renamed = false;
    try {
      const file = await fsp.open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(serialized);
        await file.sync();
      } finally {
        await file.close();
      }
      let dir;
      try {
        dir = await fsp.open(directory, 'r');
        await dir.sync();
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code) && !(process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code))) throw error;
      } finally {
        await dir?.close();
      }
      await fsp.rename(temporary, stateFile);
      renamed = true;
      let dirAfter;
      try {
        dirAfter = await fsp.open(directory, 'r');
        await dirAfter.sync();
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code) && !(process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code))) throw error;
      } finally {
        await dirAfter?.close();
      }
    } catch (error) {
      if (renamed) throw error;
      await fsp.unlink(temporary).catch(() => {});
      throw error;
    }
    return { restored: true, backup, missingAttachments, corruptAttachments, rooms, messages, bytes };
  } finally {
    await release();
  }
}

/** Caller owns startup discovery; this function exclusively owns the writer. */
export async function createBroker({ dataDir, port = 0, serverFactory = http.createServer, staleMinutes = 30,
  pruneAfterMinutes = DEFAULT_PRUNE_IDLE_MINUTES, ephemeralPruneMinutes = DEFAULT_EPHEMERAL_IDLE_MINUTES,
  pruneIntervalMs = DEFAULT_SWEEP_INTERVAL_MS, presenceFlushMs = 30000, compactAfterDays = DEFAULT_COMPACT_AFTER_DAYS } = {}) {
  if (!Number.isFinite(staleMinutes)||staleMinutes<0) throw new Error('Invalid stale presence threshold.');
  if (!Number.isFinite(pruneAfterMinutes)||pruneAfterMinutes<0||!Number.isFinite(ephemeralPruneMinutes)||ephemeralPruneMinutes<0
      ||!Number.isFinite(pruneIntervalMs)||pruneIntervalMs<1) throw new Error('Invalid prune thresholds.');
  if (!Number.isFinite(presenceFlushMs) || presenceFlushMs < 1) throw new Error('Invalid presence flush interval.');
  if (!Number.isFinite(compactAfterDays) || compactAfterDays < 0) throw new Error('Invalid compaction age.');
  if (!path.isAbsolute(dataDir ?? '') || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('An absolute dataDir and a valid TCP port are required.');
  }
  const directory = await fs.realpath(dataDir);
  if (!(await fs.stat(directory)).isDirectory()) throw new Error('dataDir must be a directory.');
  if (activeStores.has(directory)) throw new Error('A broker already owns this data directory in this process.');
  activeStores.add(directory);
  const stateFile = path.join(directory, 'state.json');
  const tokenFile = path.join(directory, 'token');
  let server;
  let releaseLease;
  // Write path. `state` is the latest applied ledger; `durable` is the last one on disk.
  // Mutations apply in memory under the serial lock and are written in batches: one atomic
  // replacement (temp file, fsync, rename, directory fsync) covers every mutation applied before
  // it started. A response is released only once everything its operation observed is durable,
  // so clients never see state that a failed write could take back. Presence refreshes are kept
  // in memory and ride along with the next write, or a periodic flush.
  let state, durable, token, closing = false, faulted = false;
  let writer = Promise.resolve();
  let appliedSeq = 0, durableSeq = 0, flushing = null, rollingBack = false, presenceDirty = false, carriedPresence = false, presenceRequested = false;
  const seqWaiters = [];
  const validated = new WeakSet();
  const messageJson = createMessageCache();
  const waiters = new Set();

  // Windows refuses to replace a file another process has open (a dashboard or tool reading
  // state.json), reporting EPERM/EACCES/EBUSY; that clears within milliseconds, so retry briefly.
  async function replaceFile(from, to) {
    for (let attempt = 0; ; attempt++) {
      try { return await fs.rename(from, to); }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 10 + attempt * 10));
      }
    }
  }
  async function persist(text) {
    const bytes = text;
    const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
    let renamed = false;
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
      await replaceFile(temporary, stateFile);
      renamed = true;
      let dir;
      try { dir = await fs.open(directory, 'r'); await dir.sync(); }
      catch (error) {
        // Directory flushing is unavailable on Windows and some filesystems.
        if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)
            && !(process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code))) throw error;
      } finally { await dir?.close(); }
    } catch (error) {
      // A failure after replacement has an unknown durable result. Never
      // overwrite it using the older in-memory snapshot; require restart.
      if (renamed) faulted = true;
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }
  function serial(operation) {
    const applied = writer.then(async () => {
      if (closing || faulted) fail('BROKER_UNAVAILABLE', 'Broker is closing or requires restart.', 503);
      return { value: await operation(), seq: appliedSeq };
    });
    writer = applied.catch(() => {});
    return applied.then(async ({ value, seq }) => { await durableThrough(seq); return value; });
  }
  function durableThrough(seq) {
    if (seq <= durableSeq) return undefined;
    if (faulted) return Promise.reject(new RpcError('BROKER_UNAVAILABLE', 'Broker is closing or requires restart.', 503));
    return new Promise((resolve, reject) => { seqWaiters.push({ seq, resolve, reject }); scheduleFlush(); });
  }
  // Release waiters in arrival order, so responses leave in the order their operations ran.
  function settle(throughSeq, error) {
    const due = [], kept = [];
    for (const row of seqWaiters) (error ? row.seq > durableSeq : row.seq <= throughSeq) ? due.push(row) : kept.push(row);
    seqWaiters.splice(0, seqWaiters.length, ...kept);
    for (const row of due) error ? row.reject(error) : row.resolve();
  }
  // A presence-only write (requested by the presence timer or shutdown) carries no mutation:
  // nobody waits on it, and if it fails nothing is rolled back; presence is simply retried.
  const presenceWanted = () => presenceRequested && presenceDirty;
  function scheduleFlush() {
    if (flushing || rollingBack || faulted || (appliedSeq === durableSeq && !presenceWanted())) return;
    flushing = (async () => {
      // Yield once so requests already queued behind this one join the same batch.
      await new Promise(resolve => setImmediate(resolve));
      let presenceOnly = false;
      try {
        while ((appliedSeq > durableSeq || presenceWanted()) && !rollingBack && !faulted) {
          const target = appliedSeq, next = state;
          presenceOnly = target === durableSeq; presenceRequested = false;
          carriedPresence = presenceDirty || carriedPresence; presenceDirty = false;
          const [chunks, bytes] = encodeState(next, messageJson);
          if (bytes > MAX_STORE) fail('STORE_LIMIT', 'Relay history reached its storage bound.', 409);
          await persist(chunks.join(''));
          durable = next; durableSeq = target; carriedPresence = false;
          if (!presenceOnly) { settle(target); wake(); }
        }
      } catch (error) {
        // Presence lives on in memory; mark it unwritten so a later write carries it again.
        if (carriedPresence) { presenceDirty = true; carriedPresence = false; }
        if (presenceOnly) return;
        // Nothing past durableSeq may be observed. A failure after the rename faulted the
        // broker (restart required); otherwise revert to the durable ledger inside the lock.
        settle(durableSeq, error);
        if (!faulted) {
          rollingBack = true;
          writer = writer.then(() => {
            state = durable; appliedSeq = durableSeq; rollingBack = false;
            settle(durableSeq, error);
          });
        }
      } finally {
        flushing = null;
        if (appliedSeq > durableSeq) scheduleFlush();
      }
    })();
  }
  async function drain() {
    presenceRequested = presenceDirty;
    while ((appliedSeq > durableSeq || presenceWanted()) && !faulted && !rollingBack) {
      scheduleFlush();
      if (!flushing) break;
      await flushing;
    }
  }
  function roomFor(project, required = true) {
    const room = state.rooms.find(r => r.project === project);
    if (!room && required) fail('UNKNOWN_ROOM', 'Register an agent in this project first.', 404);
    return room;
  }
  function agentFor(room, value) {
    const id = text(value, 'agentId');
    const agent = room.agents.find(a => a.agentId === id);
    if (!agent || agent.left) fail('UNKNOWN_AGENT', 'Agent is not registered in this project.', 404);
    return agent;
  }
  function messageFor(room, value, agentId) {
    const message = room.messages.find(m => m.messageId === text(value, 'messageId'));
    if (!message || !message.recipients.includes(agentId)) fail('UNKNOWN_MESSAGE', 'No recipient message with that ID exists in this project.', 404);
    return message;
  }
  function inbox(room, agentId, unacked = true, after = 0) {
    // Messages are in ascending cursor order (validateStore enforces it), so only the tail past
    // `after` can match: long-poll wakes stay proportional to new traffic, not history.
    let start = room.messages.length;
    while (start > 0 && room.messages[start - 1].cursor > after) start--;
    // Schema 1 keeps the read state on the message; schema 2 keeps it in the agent's cursor.
    const agent = isSchema2(state) ? room.agents.find(candidate => candidate.agentId === agentId) : undefined;
    const rows = [];
    for (const m of room.messages.slice(start)) {
      if (!m.recipients.includes(agentId)) continue;
      const acked = hasReadMessage(agentId, m, agent);
      if (unacked && acked) continue;
      rows.push({
        messageId: m.messageId, from: m.from, to: m.to, ...(m.summary!==undefined?{summary:m.summary}:{}), body: m.body,
        ...(m.replyTo !== undefined ? { replyTo: m.replyTo } : {}), createdAt: m.createdAt,
        cursor: m.cursor, recipients: [...m.recipients], acked,
        ...(m.attachments?{attachments:structuredClone(m.attachments)}:{}),
        notified: m.notified.filter(n => n.agentId === agentId).map(n => ({ ...n }))
      });
    }
    return rows;
  }
  function wake() {
    // Waiters only ever see durable messages.
    for (const waiter of [...waiters]) {
      try {
        const room = durable.rooms.find(r => r.project === waiter.project);
        if (!room) {
          waiter.finish({ messages: [], cursor: waiter.after ?? 0 });
          continue;
        }
        if (room.cursor <= (waiter.after ?? 0)) continue;
        const messages = inbox(room, waiter.agentId, true, waiter.after);
        if (messages.length) waiter.finish({ messages, cursor: room.cursor });
      } catch {
        try {
          waiter.finish({ messages: [], cursor: waiter.after ?? 0 });
        } catch {}
      }
    }
  }
  const pruneDefaults = () => ({ idleMinutes: pruneAfterMinutes || DEFAULT_PRUNE_IDLE_MINUTES, ephemeralIdleMinutes: ephemeralPruneMinutes });
  // Apply one mutation in memory (atomically: a throwing mutator leaves the ledger untouched)
  // and queue it for the next batched write. Callers run inside serial(), which holds their
  // response until the write that contains this mutation is durable.
  async function change(mutator) {
    const { next, result } = mutate(state, mutator);
    if (next === state) return result;
    validateStore(next, { validated });
    if (stateBytes(next, messageJson) > MAX_STORE) fail('STORE_LIMIT', 'Relay history reached its storage bound.', 409);
    state = next; appliedSeq++;
    scheduleFlush();
    return result;
  }
  // Archive one room's finished history and drop unreferenced dormant identities. Runs inside
  // serial(): the archive file is durable before the smaller ledger is written.
  async function compactRoom(project, { olderThanDays, dryRun = false, dropIdentities = false }) {
    const room = state.rooms.find(r => r.project === project);
    const bytesBefore = stateBytes(state, messageJson);
    if (!room) return { dryRun, archivedMessages: 0, removedIdentities: 0, retainedMessages: 0, bytesBefore, bytesAfter: bytesBefore, archive: null };
    const plan = planCompaction(state, room, { olderThanDays, dropIdentities });
    const report = { dryRun, olderThanDays, archivedMessages: plan.archived.length, removedIdentities: plan.identities.length,
      retainedMessages: plan.retainedCount, bytesBefore };
    if (dryRun || (!plan.archived.length && !plan.identities.length)) return { ...report, bytesAfter: bytesBefore, archive: null };
    const archive = await writeArchive(directory, plan);
    const applied = await change(next => applyCompaction(next.rooms.find(r => r.project === project), plan, archive ?? { name: null }));
    return { ...report, ...applied, bytesAfter: stateBytes(state, messageJson), archive };
  }
  // Presence is volatile: refresh it in memory (at most once a second per agent) and let the
  // next write, or the periodic presence flush, carry it to disk.
  async function seen(project,agentId){
    const agent=agentFor(roomFor(project),agentId);
    const now=Date.now();
    if(now-Date.parse(agent.updatedAt)<1000)return;
    agent.updatedAt=new Date(now).toISOString();presenceDirty=true;
  }
  function longPoll(project, room, agentId, after, timeoutMs, response) {
    const ready = inbox(room, agentId, true, after);
    if (ready.length || timeoutMs === 0 || response.destroyed) return Promise.resolve({ messages: ready, cursor: room.cursor });
    return new Promise(resolve => {
      const waiter = { project, agentId, after, finish: result => {
        if (!waiters.delete(waiter)) return;
        clearTimeout(timer);
        response.off('close', aborted);
        resolve(result);
      } };
      const aborted = () => {
        try {
          const current = durable.rooms.find(r => r.project === project);
          waiter.finish({ messages: [], cursor: current?.cursor ?? waiter.after ?? 0 });
        } catch {
          try {
            waiter.finish({ messages: [], cursor: waiter.after ?? 0 });
          } catch {}
        }
      };
      const timer = setTimeout(aborted, timeoutMs);
      response.once('close', aborted);
      waiters.add(waiter);
    });
  }

  async function rpc(input, response) {
    const op = text(input.op, 'op', 32);
    if (op === 'capabilities') return {features:['inbox-filters','bulk-ack','machine-claims','presence','attachments','summary','capacity','retire','groups','claim-narrow','handoffs','claim-provenance','receipts','followups','history','bulletins','process-records','storage-maintenance','derived-notice-bounds','tasks','readiness','live-broadcast','dormant-delivery','ephemeral','prune','branch-claims','ownership','git-context','work-items','work-tree','work-import','compaction'],runtime:{package:brokerPackage,protocol:1,schema:state.version}};
    if (op === 'rooms') return serial(() => ({rooms: projectSummaries(state).map(summary => ({ ...summary,
      groupId: state.rooms.find(room => room.project === summary.project)?.group?.id ?? null }))}));
    // Retained rooms remain observable even if their project directory moved.
    const project = ['snapshot', 'outbox', 'receipt', 'history', 'getBulletin'].includes(op) && state.rooms.some(r => r.project === input.project)
      ? input.project : await canonicalProject(input.project);
    if (op === 'detectGroup') {
      const commonDir = await gitCommonDir(project);
      const room = state.rooms.find(r => r.project === project);
      return {
        git: commonDir !== null,
        commonDir,
        suggestion: commonDir === null ? null : { groupId: commonDir },
        matches: commonDir === null ? [] : state.rooms
          .filter(r => r.project !== project && (r.group?.commonDir ?? null) === commonDir)
          .map(r => ({ project: r.project, groupId: r.group?.id ?? null, commonDir: r.group.commonDir })),
        room: room?.group ? { groupId: room.group.id, commonDir: room.group.commonDir ?? null,
          verified: groupView(state, room).verified } : null
      };
    }
    // Read-only and git-bound: gather outside the writer turn, then build from the freshest immutable state.
    if (op === 'ownership') {
      const threshold = input.staleMinutes ?? staleMinutes;
      if (!Number.isFinite(threshold) || threshold < 0) fail('INVALID_INPUT', 'Invalid stale minutes.');
      // Read-only and outside the serial lock (it runs git): show only durable state.
      return ownershipView({ state: () => durable, project, staleMinutes: threshold });
    }
    // Install a waiter while holding the same serial turn as its inbox read;
    // release the writer immediately, never await its long poll in the writer.
    if (op === 'wait') {
      const after = input.after ?? 0;
      const timeoutMs = input.timeoutMs ?? 25000;
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(timeoutMs)
          || timeoutMs < 0 || timeoutMs > 30000) fail('INVALID_INPUT', 'Invalid wait cursor or timeout.');
      let pending;
      await serial(async () => {
        const room = roomFor(project);
        const agent = agentFor(room, input.agentId);
        await seen(project,agent.agentId);
        pending = longPoll(project, roomFor(project), agent.agentId, after, timeoutMs, response);
      });
      return pending;
    }
    const detectedCommonDir = op === 'register' && input.groupId !== undefined ? await gitCommonDir(project) : undefined;
    const branchGit = op === 'branches' ? await gitCommonDir(project) : undefined;
    return serial(async () => {
      if (op === 'register') {
        const agentId = text(input.agentId, 'agentId');
        const runner = text(input.runner, 'runner', 80);
        const sessionId = input.sessionId === undefined ? undefined : text(input.sessionId, 'sessionId', 256);
        const groupId = input.groupId === undefined ? undefined : text(input.groupId, 'groupId', 128);
        if (input.test !== undefined && typeof input.test !== 'boolean') fail('INVALID_INPUT', 'test must be boolean.');
        if (input.ephemeral !== undefined && typeof input.ephemeral !== 'boolean') fail('INVALID_INPUT', 'ephemeral must be boolean.');
        if (isBroadcast(agentId)) fail('INVALID_INPUT', 'agentId may not be a broadcast audience name.');
        return change(next => {
          let room = next.rooms.find(r => r.project === project);
          if (!room) {
            if (next.rooms.length >= MAX_ROOMS) fail('ROOM_LIMIT', 'Too many project rooms.', 409);
            next.rooms.push(room = { project, agents: [], messages: [], claims: [], cursor: 0 });
          }
          let agent = room.agents.find(a => a.agentId === agentId);
          const now = new Date().toISOString();
          const activeCount = () => room.agents.filter(a => !a.left).length;
          const leftCount = () => room.agents.length - activeCount();
          if (!agent) {
            if (room.agents.length >= MAX_RETAINED_AGENTS)
              fail('CAPACITY', 'Retained identity history reached its hard bound; the ledger was left intact.', 409,
                { used: room.agents.length, limit: MAX_RETAINED_AGENTS, left: leftCount(), bound: 'retained',
                  recovery: 'export the ledger, then start a new data directory and re-register; pending work must be handed over explicitly' });
            if (activeCount() >= MAX_AGENTS_PER_PROJECT)
              fail('CAPACITY', 'Active agent capacity is full; the ledger was left intact.', 409,
                { used: activeCount(), limit: MAX_AGENTS_PER_PROJECT, left: leftCount(), bound: 'active',
                  recovery: 'have agents leave or retire identities' });
            room.agents.push(agent = { agentId, runner, registeredAt: now, updatedAt: now,
              status: 'idle', frozen: false, resources: [], task: null });
          } else if (agent.retired) {
            fail('RETIRED', 'Identity is retired; it stays resolvable for history but cannot register again.', 409);
          } else if (agent.left && activeCount() >= MAX_AGENTS_PER_PROJECT) {
            fail('CAPACITY', 'Active agent capacity is full; the ledger was left intact.', 409,
              { used: activeCount(), limit: MAX_AGENTS_PER_PROJECT, left: leftCount(), bound: 'active',
                recovery: 'have agents leave or retire identities' });
          }
          delete agent.left; agent.runner = runner; agent.updatedAt = now;
          if (sessionId !== undefined) agent.sessionId = sessionId;
          if (input.test !== undefined) agent.test = input.test;
          if (input.ephemeral !== undefined) agent.ephemeral = input.ephemeral;
          if (groupId !== undefined) room.group = { id: groupId, commonDir: detectedCommonDir ?? null };
          return { agent, capacity: { used: activeCount(), limit: MAX_AGENTS_PER_PROJECT }, group: groupView(next, room) };
        });
      }
      if (op === 'snapshot') {
        const limit = input.limit ?? 100;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('INVALID_INPUT', 'Snapshot limit must be between 1 and 200.');
        const view = roomSnapshot(project, roomFor(project, false), limit, state, staleMinutes, pruneDefaults());
        return { ...view, window: { limit, offset: view.totalMessages - view.messages.length, total: view.totalMessages } };
      }
      if (op === 'history') {
        const since = input.since ?? 0, before = input.before, limit = input.limit ?? MAX_MESSAGES;
        if (!Number.isSafeInteger(since) || since < 0 || (before !== undefined && (!Number.isSafeInteger(before) || before < 0))
          || !Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGES)
          fail('INVALID_INPUT', 'Invalid history cursor or limit.');
        if (input.acked !== undefined && typeof input.acked !== 'boolean') fail('INVALID_INPUT', 'acked must be boolean.');
        const agentId = input.agentId === undefined ? undefined : text(input.agentId, 'agentId');
        const from = input.from === undefined ? undefined : text(input.from, 'from');
        const to = input.to === undefined ? undefined : text(input.to, 'to');
        const afterMs = timestamp(input.afterTs, 'afterTs'), beforeMs = timestamp(input.beforeTs, 'beforeTs');
        const historyRoom = roomFor(project, false);
        const messages = historyRoom?.messages ?? [];
        let thread;
        if (input.threadOf !== undefined) {
          const anchor = text(input.threadOf, 'threadOf');
          if (!messages.some(m => m.messageId === anchor))
            fail('UNKNOWN_MESSAGE', 'No message with that ID exists in this project.', 404);
          const children = new Map();
          for (const message of messages) {
            if (message.replyTo === undefined) continue;
            const rows = children.get(message.replyTo) ?? [];
            rows.push(message.messageId);
            children.set(message.replyTo, rows);
          }
          thread = new Set();
          const pending = [...(children.get(anchor) ?? [])];
          while (pending.length) {
            const id = pending.shift();
            if (thread.has(id)) continue;
            thread.add(id);
            pending.push(...(children.get(id) ?? []));
          }
        }
        const matched = messages.filter(m =>
          (agentId === undefined || m.from === agentId || m.recipients.includes(agentId))
          && (from === undefined || m.from === from)
          && (to === undefined || m.to === to || (isBroadcast(m.to) && m.recipients.includes(to)))
          && (input.acked === undefined || (isSchema2(state) ? fullyRead(m, historyRoom) : m.ackedBy.length === m.recipients.length) === input.acked)
          && (afterMs === undefined || Date.parse(m.createdAt) > afterMs)
          && (beforeMs === undefined || Date.parse(m.createdAt) < beforeMs)
          && (thread === undefined || thread.has(m.messageId))
          && m.cursor > since && (before === undefined || m.cursor < before));
        const rows = before === undefined ? matched.slice(0, limit) : matched.slice(-limit).reverse();
        const label = [];
        if (input.since !== undefined && before !== undefined) label.push(`cursors ${since}-${before}`);
        else if (input.since !== undefined) label.push(`cursors after ${since}`);
        else if (before !== undefined) label.push(`cursors before ${before}`);
        if (input.afterTs !== undefined) label.push(`after ${input.afterTs}`);
        if (input.beforeTs !== undefined) label.push(`before ${input.beforeTs}`);
        return { messages: rows.map(m => structuredClone(messageView(m, historyRoom))),
          nextCursor: rows.at(-1)?.cursor ?? (before === undefined ? since : before),
          done: matched.length <= limit,
          scope: { totalMatching: matched.length, searchedFrom: input.since ?? messages[0]?.cursor ?? 0,
            windowLabel: label.length ? label.join(', ') : 'full retained history',
            ...(roomFor(project, false)?.archived ? { archived: { messages: roomFor(project, false).archived.messages,
              through: roomFor(project, false).archived.through, files: roomFor(project, false).archived.files.length } } : {}) } };
      }
      if (op === 'outbox') {
        const from = text(input.from, 'from');
        const since = input.since ?? 0, limit = input.limit ?? MAX_MESSAGES;
        if (!Number.isSafeInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGES)
          fail('INVALID_INPUT', 'Invalid outbox cursor or limit.');
        const recipientsLimit = input.recipientsLimit ?? 25;
        const pendingLimit = input.pendingLimit ?? 25;
        if (!Number.isInteger(recipientsLimit) || recipientsLimit < 1)
          fail('INVALID_INPUT', 'Invalid outbox recipient or pending limit.');
        if (!Number.isInteger(pendingLimit) || pendingLimit < 1)
          fail('INVALID_INPUT', 'Invalid outbox recipient or pending limit.');
        const messageId = input.messageId === undefined ? undefined : text(input.messageId, 'messageId');
        const room = roomFor(project, false);
        const matched = (room?.messages ?? []).filter(m => m.from === from && m.cursor > since
          && (messageId === undefined || m.messageId === messageId));
        const rows = matched.slice(0, limit);
        return { messages: rows.map(m => {
          const full = messageReceipt(m, room);
          const pending = pendingReceipts(m, room);
          return { ...full, recipients: full.recipients.slice(0, recipientsLimit), recipientsTotal: full.recipients.length,
            pending: pending.slice(0, pendingLimit), pendingTotal: pending.length };
        }), nextCursor: rows.at(-1)?.cursor ?? since, done: matched.length <= limit };
      }
      if (op === 'receipt') {
        const room = roomFor(project, false);
        const message = room?.messages.find(m => m.messageId === text(input.messageId, 'messageId'));
        if (!message) fail('UNKNOWN_MESSAGE', 'No message with that ID exists in this project.', 404);
        const recipientsOffset = input.recipientsOffset ?? 0;
        const recipientsLimit = input.recipientsLimit;
        const pendingOffset = input.pendingOffset ?? 0;
        const pendingLimit = input.pendingLimit ?? 25;
        if (!Number.isSafeInteger(recipientsOffset) || recipientsOffset < 0)
          fail('INVALID_INPUT', 'Invalid receipt recipient cursor or limit.');
        if (recipientsLimit !== undefined && (!Number.isInteger(recipientsLimit) || recipientsLimit < 1))
          fail('INVALID_INPUT', 'Invalid receipt recipient cursor or limit.');
        if (!Number.isSafeInteger(pendingOffset) || pendingOffset < 0)
          fail('INVALID_INPUT', 'Invalid receipt pending cursor or limit.');
        if (!Number.isInteger(pendingLimit) || pendingLimit < 1)
          fail('INVALID_INPUT', 'Invalid receipt pending cursor or limit.');
        const full = messageReceipt(message, room);
        const recipientsTotal = full.recipients.length;
        const limit = recipientsLimit ?? recipientsTotal;
        const page = full.recipients.slice(recipientsOffset, recipientsOffset + limit);
        const allPending = pendingReceipts(message, room);
        const pendingTotal = allPending.length;
        const pending = allPending.slice(pendingOffset, pendingOffset + pendingLimit);
        return { ...full, recipients: page, recipientsTotal, recipientsLimit: limit, recipientsOffset,
          pending, pendingTotal, pendingLimit, pendingOffset };
      }
      if (op === 'agents') {
        const room = roomFor(project, false);
        const threshold=input.staleMinutes??staleMinutes;
        if (input.within!==undefined&&(!Number.isFinite(input.within)||input.within<0)) fail('INVALID_INPUT','Invalid active window.');
        if (!Number.isFinite(threshold)||threshold<0) fail('INVALID_INPUT','Invalid stale minutes.');
        if (input.transport!==undefined&&!['connected','disconnected','unknown'].includes(input.transport))
          fail('INVALID_INPUT','transport must be connected, disconnected, or unknown.');
        if (input.test!==undefined&&typeof input.test!=='boolean') fail('INVALID_INPUT','test must be boolean.');
        const offset = input.offset ?? 0;
        const limit = input.limit;
        if (!Number.isSafeInteger(offset) || offset < 0)
          fail('INVALID_INPUT', 'Invalid agents cursor or limit.');
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
          fail('INVALID_INPUT', 'Invalid agents cursor or limit.');
        const filtered = presence(room?.agents??[],input.active?(input.within??30):undefined)
          .filter(row => input.transport === undefined || transportState(row) === input.transport)
          .filter(row => input.test === undefined || (row.test ?? false) === input.test);
        const total = filtered.length;
        const listed = limit === undefined ? filtered.slice(offset) : filtered.slice(offset, offset + limit);
        return structuredClone({ agents: listed, total,
          claims: annotateClaims([...projectClaims(room,threshold),...machineClaims(state,threshold)], room),
          cursor: room?.cursor ?? 0, groupId: room?.group?.id ?? null,
          counts: { stored: room?.agents.length ?? 0, left: (room?.agents??[]).filter(a=>a.left).length,
            recentlySeen: presence(room?.agents??[],input.within??30).length, active: presence(room?.agents??[]).length,
            capacityLimit: MAX_AGENTS_PER_PROJECT,
            ...registryCounts(state, room, { withinMinutes: input.within ?? DEFAULT_LIVE_WINDOW_MINUTES, ...pruneDefaults() }) },
          warnings: handoffWarnings(room) });
      }
      if (op === 'groupAgents') {
        const room = roomFor(project, false);
        const groupId = input.groupId === undefined ? room?.group?.id ?? null : text(input.groupId, 'groupId', 128);
        if (groupId === null) fail('UNKNOWN_GROUP', 'This room has no coordination group; pass groupId explicitly.', 404);
        const rooms = state.rooms.filter(candidate => candidate.group?.id === groupId);
        return structuredClone({ groupId,
          rooms: rooms.map(candidate => ({ project: candidate.project, groupId: candidate.group.id,
            commonDir: candidate.group.commonDir ?? null, verified: groupView(state, candidate).verified,
            agentCount: presence(candidate.agents).length })),
          agents: rooms.flatMap(candidate => presence(candidate.agents).map(agent => ({ ...agent, project: candidate.project }))) });
      }
      if (op === 'handoffs') {
        const room = roomFor(project, false);
        return structuredClone({ handoffs: (room?.handoffs ?? []).map(handoff => {
          const held = handoff.resources.filter(resource => (room?.claims ?? []).some(claim => claim.resource === resource));
          return { ...handoff, holder: room?.claims.find(claim => claim.resource === held[0])?.agentId ?? null, held };
        }) });
      }
      if (op === 'blocked') return structuredClone(blockedView(roomFor(project, false)));
      if (op === 'tasks') {
        const action = text(input.action, 'action', 16);
        if (!['upsert', 'list', 'complete', ...WORK_ACTIONS].includes(action)) fail('INVALID_INPUT', 'action must be upsert, list, complete, tree, move, remove, or import.');
        const room = roomFor(project, false);
        if (action === 'tree') return work.tree(room?.tasks ?? [], input, taskViewer(room, state));
        if (action === 'import' && input.dryRun !== undefined && input.dryRun !== null && input.dryRun !== false) {
          const request = work.parseImport(input), ledger = structuredClone(room?.tasks ?? []);
          const scratch = { ...(room ?? { project, agents: [] }), tasks: ledger };
          const done = work.importInto(ledger, request, { creator: 'dry-run', limit: MAX_TASKS, now: new Date().toISOString(),
            hasAgent: id => scratch.agents.some(a => a.agentId === id && !a.left) });
          return { dryRun: true, created: done.created.map(t => t.id), updated: done.updated.map(t => t.id),
            unchanged: done.unchanged.map(t => t.id), tree: work.planTree(request, ledger, done.actions) };
        }
        if (['move', 'remove', 'import'].includes(action)) {
          const agent = agentFor(roomFor(project), input.agentId).agentId;
          const request = action === 'import' ? work.parseImport(input) : undefined;
          return change(next => {
            const target = next.rooms.find(r => r.project === project), now = new Date().toISOString();
            const ledger = target.tasks ?? [];
            let out;
            if (action === 'move') { const moved = work.move(ledger, input, now); target.tasks = ledger; out = { task: taskViewer(target, next)(moved) }; }
            else if (action === 'remove') out = work.remove(ledger, input);
            else {
              const done = work.importInto(ledger, request, { creator: agent, limit: MAX_TASKS, now,
                hasAgent: id => target.agents.some(a => a.agentId === id && !a.left) });
              target.tasks = ledger;
              const view = taskViewer(target, next);
              out = { dryRun: false, created: done.created.map(view), updated: done.updated.map(view), unchanged: done.unchanged.map(t => t.id) };
            }
            target.tasks = ledger;
            return out;
          });
        }
        if (action === 'list') {
          const taskState = input.state === undefined ? undefined : text(input.state, 'state', 16);
          if (taskState !== undefined && !['open', 'complete'].includes(taskState)) fail('INVALID_INPUT', 'state must be open or complete.');
          if (input.blocked !== undefined && typeof input.blocked !== 'boolean') fail('INVALID_INPUT', 'blocked must be boolean.');
          const owner = input.owner === undefined ? undefined : text(input.owner, 'owner');
          const derived = derivedStatuses(room?.tasks ?? []);
          const matches = work.listFilter(input, derived);
          const view = taskViewer(room, state);
          const rows = (room?.tasks ?? [])
            .filter(task => (taskState === undefined || task.state === taskState) && (owner === undefined || task.owner === owner))
            .filter(matches)
            .map(view)
            .filter(view => input.blocked === undefined || view.blocked === input.blocked);
          return { tasks: rows };
        }
        const agent = agentFor(roomFor(project), input.agentId).agentId;
        const refs = value => value === undefined ? undefined
          : (Array.isArray(value) && value.length <= 64 && value.every(r => typeof r === 'string' && r.length > 0 && Buffer.byteLength(r) <= 4096)
            ? [...new Set(value.map(r => r.trim()))] : fail('INVALID_INPUT', 'References must be up to 64 nonempty bounded strings.'));
        if (action === 'complete') {
          const id = text(input.id, 'id');
          return change(next => {
            const target = next.rooms.find(r => r.project === project);
            const task = target.tasks?.find(candidate => candidate.id === id);
            if (!task) fail('UNKNOWN_TASK', 'No task with that ID exists in this project.', 404);
            setStatus(task, 'done', new Date().toISOString());
            if (input.verification !== undefined) task.verification = text(input.verification, 'verification', 4096);
            if (input.completionAck !== undefined) {
              if (typeof input.completionAck !== 'boolean') fail('INVALID_INPUT', 'completionAck must be boolean.');
              task.completionAck = input.completionAck;
            }
            task.updatedAt = new Date().toISOString();
            return { task: taskViewer(target, next)(task) };
          });
        }
        const id = input.id === undefined ? randomUUID() : text(input.id, 'id');
        const owner = input.owner === undefined ? undefined : text(input.owner, 'owner');
        if (owner !== undefined) agentFor(roomFor(project), owner);
        const expectedRecipient = input.expectedRecipient === undefined ? undefined : text(input.expectedRecipient, 'expectedRecipient');
        if (expectedRecipient !== undefined) agentFor(roomFor(project), expectedRecipient);
        const handoffId = input.handoffId === undefined ? undefined : text(input.handoffId, 'handoffId');
        if (handoffId !== undefined && !(room?.handoffs ?? []).some(h => h.id === handoffId))
          fail('UNKNOWN_HANDOFF', 'No handoff request with that ID exists in this project.', 404);
        const blockedBy = refs(input.blockedBy), resources = refs(input.resources);
        const sourceRevision = input.sourceRevision === undefined ? undefined : text(input.sourceRevision, 'sourceRevision', 256);
        const verification = input.verification === undefined ? undefined : text(input.verification, 'verification', 4096);
        const patch = work.parseFields(input);
        return change(next => {
          const target = next.rooms.find(r => r.project === project);
          const ledger = target.tasks ?? [];
          let task = ledger.find(candidate => candidate.id === id);
          if (!task) {
            if (input.title === undefined) fail('INVALID_INPUT', 'New tasks require a title.');
            if (ledger.length >= MAX_TASKS) fail('TASK_LIMIT', 'Task records reached their bound.', 409);
            const at = new Date().toISOString();
            task = { id, creator: agent, title: text(input.title, 'title', 480), state: 'open', createdAt: at, updatedAt: at,
              ...(owner !== undefined ? { owner } : {}), ...(blockedBy !== undefined ? { blockedBy } : {}),
              ...(resources !== undefined ? { resources } : {}), ...(sourceRevision !== undefined ? { sourceRevision } : {}),
              ...(verification !== undefined ? { verification } : {}),
              ...(expectedRecipient !== undefined ? { expectedRecipient } : {}),
              ...(handoffId !== undefined ? { handoffId } : {}) };
            ledger.push(task);
            target.tasks = ledger;
            work.apply(ledger, task, patch, at);
          } else {
            if (input.title !== undefined) task.title = text(input.title, 'title', 480);
            if (owner !== undefined) task.owner = owner;
            if (blockedBy !== undefined) task.blockedBy = blockedBy;
            if (resources !== undefined) task.resources = resources;
            if (sourceRevision !== undefined) task.sourceRevision = sourceRevision;
            if (verification !== undefined) task.verification = verification;
            if (expectedRecipient !== undefined) task.expectedRecipient = expectedRecipient;
            if (handoffId !== undefined) task.handoffId = handoffId;
            if (task.state === 'complete' && (input.title !== undefined || blockedBy !== undefined)) task.state = 'open';
            work.reopened(task);
            work.apply(ledger, task, patch, new Date().toISOString());
            task.updatedAt = new Date().toISOString();
          }
          return { task: taskViewer(target, next)(task) };
        });
      }
      if (op === 'getBulletin') {
        const versions = roomFor(project, false)?.bulletin?.versions ?? [];
        if (input.version !== undefined) {
          if (!Number.isSafeInteger(input.version) || input.version < 1) fail('INVALID_INPUT', 'version must be a positive integer.');
          const record = versions.find(row => row.version === input.version);
          if (!record) fail('UNKNOWN_BULLETIN', 'No retained bulletin with that version exists.', 404);
          return bulletinView(record);
        }
        const current = versions[0];
        return current ? { ...bulletinView(current), versions: versions.map(row => ({ version: row.version, hash: row.hash, ts: row.ts })) }
          : { version: 0, title: null, body: null, source: null, hash: null, ts: null, acks: [], versions: [] };
      }
      if (op === 'processes') {
        const action = text(input.action, 'action', 16);
        const owner = input.agentId === undefined ? undefined : text(input.agentId, 'agentId');
        const rows = roomFor(project, false)?.processes ?? [];
        if (action === 'list') {
          const now = Date.now(), iso = new Date(now).toISOString();
          const views = rows.filter(row => owner === undefined || row.agentId === owner).map(row => ({
            record: row, alive: probeAlive(row.pid),
            verifiedAt: now - Date.parse(row.lastVerifiedAt) >= 1000 ? iso : row.lastVerifiedAt }));
          const stale = views.some(({ record, verifiedAt }) => verifiedAt !== record.lastVerifiedAt);
          const rowView = ({ record, alive, verifiedAt }) => processView({ ...record, lastVerifiedAt: verifiedAt }, alive);
          if (!stale) return { processes: views.map(rowView), liveness: { ...livenessView } };
          return change(next => {
            const target = next.rooms.find(r => r.project === project);
            for (const { record, verifiedAt } of views) {
              const stored = target.processes?.find(candidate => candidate.id === record.id);
              if (stored) stored.lastVerifiedAt = verifiedAt;
            }
            return { processes: views.map(rowView), liveness: { ...livenessView } };
          });
        }
        if (action === 'register') {
          if (owner === undefined) fail('INVALID_INPUT', 'register requires agentId.');
          agentFor(roomFor(project), owner);
          const pid = input.pid;
          if (!Number.isSafeInteger(pid) || pid < 1) fail('INVALID_INPUT', 'pid must be a positive integer.');
          const command = input.command === undefined ? undefined : text(input.command, 'command', 4096);
          const cwd = input.cwd === undefined ? undefined : text(input.cwd, 'cwd', 4096);
          const deployment = input.deployment === undefined ? undefined : text(input.deployment, 'deployment', 4096);
          const note = input.note === undefined ? undefined : text(input.note, 'note', 1024);
          let port;
          if (input.port !== undefined) {
            port = input.port;
            if (!Number.isInteger(port) || port < 1 || port > 65535) fail('INVALID_INPUT', 'port must be an integer between 1 and 65535.');
          }
          if (rows.some(row => row.pid === pid)) fail('PROCESS_EXISTS', 'A record for this PID already exists.', 409);
          return change(next => {
            const target = next.rooms.find(r => r.project === project);
            const ledger = target.processes ?? [];
            if (ledger.length >= MAX_PROCESSES)
              fail('PROCESS_LIMIT', 'Process records reached their bound; the ledger was left intact.', 409,
                { used: ledger.length, limit: MAX_PROCESSES, recovery: 'remove finished process records' });
            const at = new Date().toISOString();
            const record = { id: randomUUID(), agentId: owner, pid, startedAt: at, lastVerifiedAt: at,
              ...(command !== undefined ? { command } : {}), ...(cwd !== undefined ? { cwd } : {}),
              ...(port !== undefined ? { port } : {}), ...(deployment !== undefined ? { deployment } : {}),
              ...(note !== undefined ? { note } : {}) };
            ledger.push(record);
            target.processes = ledger;
            return { process: processView(record, probeAlive(pid)) };
          });
        }
        if (action === 'remove') {
          if (input.id === undefined && input.pid === undefined) fail('INVALID_INPUT', 'remove requires id or pid.');
          const id = input.id === undefined ? undefined : text(input.id, 'id');
          const pid = input.pid;
          if (pid !== undefined && (!Number.isSafeInteger(pid) || pid < 1)) fail('INVALID_INPUT', 'pid must be a positive integer.');
          const matches = row => (id === undefined || row.id === id) && (pid === undefined || row.pid === pid)
            && (owner === undefined || row.agentId === owner);
          return change(next => {
            const target = next.rooms.find(r => r.project === project);
            const all = target.processes ?? [];
            const removed = all.filter(matches);
            target.processes = all.filter(row => !matches(row));
            return { removed: removed.map(row => processView(row, probeAlive(row.pid))),
              processes: target.processes.map(row => processView(row, probeAlive(row.pid))) };
          });
        }
        fail('INVALID_INPUT', 'action must be register, list, or remove.');
      }
      async function attachmentInventory() {
        const rows = [];
        try {
          for (const name of await fs.readdir(path.join(directory, 'attachments'))) {
            if (name.startsWith('.')) continue;
            const full = path.join(directory, 'attachments', name);
            const stat = await fs.stat(full);
            if (stat.isFile()) rows.push({ sha256: name, size: stat.size });
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        return rows;
      }
      if (op === 'usage') {
        let messages = 0, projectClaimCount = 0, handoffCount = 0, processCount = 0, taskCount = 0, followupCount = 0;
        let storedAgents = 0, leftAgents = 0, activeAgents = 0, maxNotices = 0, largest = null, tightest = null, bulletinRooms = 0;
        const detail = [], itemKinds = Object.fromEntries(KINDS.map(name => [name, 0])), itemStatuses = Object.fromEntries(STATUSES.map(name => [name, 0]));
        let openItems = 0;
        for (const room of state.rooms) {
          const roomStored = room.agents.length;
          const roomLeft = room.agents.filter(a => a.left).length;
          const roomActive = roomStored - roomLeft;
          const roomClaims = room.claims.length;
          const roomHandoffs = (room.handoffs ?? []).length;
          const roomProcesses = (room.processes ?? []).length;
          const roomMessages = room.messages.length;
          const roomTasks = (room.tasks ?? []).length;
          const roomBranchClaims = (state.branchClaims ?? []).filter(c => c.project === room.project).length;
          const derived = derivedStatuses(room.tasks ?? []);
          for (const task of room.tasks ?? []) {
            itemKinds[kindOf(task)]++; itemStatuses[reportedStatus(task, derived)]++;
            if (task.state === 'open') openItems++;
          }
          messages += roomMessages;
          projectClaimCount += roomClaims;
          handoffCount += roomHandoffs;
          processCount += roomProcesses;
          taskCount += roomTasks;
          storedAgents += roomStored;
          leftAgents += roomLeft;
          activeAgents += roomActive;
          if (room.bulletin !== undefined) bulletinRooms++;
          for (const message of room.messages) {
            followupCount += (message.followups ?? []).length;
            if (message.notified.length > maxNotices) {
              maxNotices = message.notified.length;
              largest = { messageId: message.messageId, markers: message.notified.length,
                recipients: message.recipients.length, allowance: noticeAllowance(message.recipients.length) };
            }
            if (message.notified.length > 0) {
              const allowance = noticeAllowance(message.recipients.length);
              const remaining = allowance - message.notified.length;
              if (tightest === null || remaining < tightest.remaining)
                tightest = { messageId: message.messageId, remaining, allowance };
            }
          }
          detail.push({ project: room.project, agents: { stored: roomStored, left: roomLeft, active: roomActive },
            claims: roomClaims, branchClaims: roomBranchClaims, handoffs: roomHandoffs, processes: roomProcesses, messages: roomMessages, tasks: roomTasks });
        }
        const machineUsed = state.machineClaims?.length ?? 0;
        const branchUsed = state.branchClaims?.length ?? 0;
        const releaseUsed = state.releaseLog?.length ?? 0;
        const storeBytes = stateBytes(state, messageJson);
        const stored = await attachmentInventory();
        const attachmentBytes = stored.reduce((total, row) => total + row.size, 0);
        let retainedHead = MAX_RETAINED_AGENTS, activeHead = MAX_AGENTS_PER_PROJECT, claimsHead = MAX_CLAIMS;
        let handoffsHead = MAX_HANDOFFS, processesHead = MAX_PROCESSES, tasksHead = MAX_TASKS;
        if (state.rooms.length) {
          retainedHead = Math.min(...state.rooms.map(r => MAX_RETAINED_AGENTS - r.agents.length));
          activeHead = Math.min(...state.rooms.map(r => MAX_AGENTS_PER_PROJECT - r.agents.filter(a => !a.left).length));
          claimsHead = Math.min(...state.rooms.map(r => MAX_CLAIMS - r.claims.length));
          handoffsHead = Math.min(...state.rooms.map(r => MAX_HANDOFFS - (r.handoffs ?? []).length));
          processesHead = Math.min(...state.rooms.map(r => MAX_PROCESSES - (r.processes ?? []).length));
          tasksHead = Math.min(...state.rooms.map(r => MAX_TASKS - (r.tasks ?? []).length));
        }
        const machineHead = MAX_CLAIMS - machineUsed;
        const noticesHead = tightest ? tightest.remaining : MAX_NOTICES;
        const releaseHead = 10000 - releaseUsed;
        const headroom = { messages: MAX_MESSAGES - messages, storeBytes: MAX_STORE - storeBytes,
          rooms: MAX_ROOMS - state.rooms.length, agentsRetained: retainedHead, agentsActive: activeHead,
          claims: claimsHead, machineClaims: machineHead, branchClaims: MAX_CLAIMS - branchUsed, notices: noticesHead,
          handoffs: handoffsHead, processes: processesHead, tasks: tasksHead, releaseLog: releaseHead,
          attachmentBytes: ATTACHMENT_TOTAL_LIMIT - attachmentBytes };
        const noticesDenominator = tightest ? tightest.allowance : MAX_NOTICES;
        const nearLimit = [
          headroom.messages / MAX_MESSAGES < 0.1 ? 'messages' : null,
          headroom.storeBytes < STORE_RESERVE ? 'store' : null,
          headroom.rooms / MAX_ROOMS < 0.1 ? 'rooms' : null,
          headroom.agentsRetained / MAX_RETAINED_AGENTS < 0.1 ? 'agents-retained' : null,
          headroom.agentsActive / MAX_AGENTS_PER_PROJECT < 0.1 ? 'agents-active' : null,
          headroom.claims / MAX_CLAIMS < 0.1 ? 'claims' : null,
          headroom.machineClaims / MAX_CLAIMS < 0.1 ? 'machine-claims' : null,
          headroom.branchClaims / MAX_CLAIMS < 0.1 ? 'branch-claims' : null,
          headroom.notices / noticesDenominator < 0.1 ? 'notices' : null,
          headroom.handoffs / MAX_HANDOFFS < 0.1 ? 'handoffs' : null,
          headroom.processes / MAX_PROCESSES < 0.1 ? 'processes' : null,
          headroom.tasks / MAX_TASKS < 0.1 ? 'tasks' : null,
          headroom.releaseLog / 10000 < 0.1 ? 'release-log' : null,
          headroom.attachmentBytes / ATTACHMENT_TOTAL_LIMIT < 0.1 ? 'attachments' : null,
        ].filter(Boolean);
        return { messages: { used: messages, limit: MAX_MESSAGES },
          store: { usedBytes: storeBytes, limitBytes: MAX_STORE, reserveBytes: STORE_RESERVE },
          rooms: { count: state.rooms.length, limit: MAX_ROOMS, detail },
          agents: { stored: storedAgents, left: leftAgents, active: activeAgents,
            retainedLimit: MAX_RETAINED_AGENTS, activeLimit: MAX_AGENTS_PER_PROJECT },
          claims: { used: projectClaimCount + machineUsed, project: projectClaimCount, machine: machineUsed, limit: MAX_CLAIMS },
          notices: { used: maxNotices, baseLimit: MAX_NOTICES, perRecipientAllowance: NOTICES_PER_RECIPIENT, largest, tightest },
          handoffs: { used: handoffCount, limit: MAX_HANDOFFS },
          processes: { used: processCount, limit: MAX_PROCESSES },
          branchClaims: { used: branchUsed, limit: MAX_CLAIMS },
          tasks: { used: taskCount, limit: MAX_TASKS },
          workItems: { total: taskCount, open: openItems, byKind: itemKinds, byStatus: itemStatuses, limit: MAX_TASKS },
          followups: { used: followupCount, perMessageLimit: MAX_FOLLOWUPS },
          releaseLog: { used: releaseUsed, limit: 10000 },
          bulletins: { rooms: bulletinRooms, versionsLimit: MAX_BULLETIN_VERSIONS },
          attachments: { count: stored.length, bytes: attachmentBytes, limitBytes: ATTACHMENT_TOTAL_LIMIT },
          headroom, nearLimit };
      }
      if (op === 'export') {
        return { schemaVersion: state.version, exportedAt: new Date().toISOString(),
          state: structuredClone(state), attachmentHashes: await attachmentInventory() };
      }
      if (op === 'auditAttachments') {
        if (input.dryRun !== true)
          fail('ATTACHMENT_AUDIT_DRY_RUN_REQUIRED', 'Attachment audit requires dryRun:true; nothing was changed.', 400);
        const referenced = new Map();
        for (const room of state.rooms) {
          for (const message of room.messages) {
            for (const item of message.attachments ?? []) {
              const rows = referenced.get(item.sha256) ?? [];
              rows.push(message.messageId);
              referenced.set(item.sha256, rows);
            }
          }
        }
        const stored = await attachmentInventory();
        const unreferenced = stored.filter(row => !referenced.has(row.sha256))
          .map(row => ({ ...row, messages: [] }));
        return { unreferenced, referenced: referenced.size, stored: stored.length,
          storedBytes: stored.reduce((total, row) => total + row.size, 0),
          unreferencedBytes: unreferenced.reduce((total, row) => total + row.size, 0) };
      }
      if (op === 'restore') {
        if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean')
          fail('INVALID_INPUT', 'dryRun must be boolean.');
        if (input.allowIncomplete !== undefined && typeof input.allowIncomplete !== 'boolean')
          fail('INVALID_INPUT', 'allowIncomplete must be boolean.');
        const incoming = input.state;
        if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming))
          fail('INVALID_INPUT', 'state must be an object.');
        if (input.schemaVersion !== undefined && !SUPPORTED_SCHEMA_VERSIONS.includes(input.schemaVersion))
          fail('SCHEMA_MISMATCH', `Export schema ${input.schemaVersion} is not supported by this runtime.`, 400,
            { expected: SCHEMA_VERSION, supported: SUPPORTED_SCHEMA_VERSIONS });
        try { validateStore(structuredClone(incoming)); }
        catch { fail('INVALID_RESTORE', 'Restored state failed validation; the ledger was left intact.', 400); }
        const verified = await verifyAttachmentReferences(directory, incoming);
        const missingAttachments = verified.missing;
        const corruptAttachments = verified.corrupt;
        const rooms = incoming.rooms.length;
        const messages = incoming.rooms.reduce((total, room) => total + room.messages.length, 0);
        if (input.dryRun === true)
          return { valid: missingAttachments.length === 0 && corruptAttachments.length === 0, dryRun: true,
            missingAttachments, corruptAttachments, rooms, messages };
        if ((missingAttachments.length || corruptAttachments.length) && input.allowIncomplete !== true)
          fail('INCOMPLETE_ATTACHMENTS', 'Restored state references missing or corrupt attachments; the ledger was left intact.', 409,
            { missingAttachments, corruptAttachments });
        for (const waiter of [...waiters]) {
          try {
            const current = state.rooms.find(r => r.project === waiter.project);
            waiter.finish({ messages: [], cursor: current?.cursor ?? waiter.after ?? 0 });
          } catch {
            try {
              waiter.finish({ messages: [], cursor: waiter.after ?? 0 });
            } catch {}
          }
        }
        waiters.clear();
        return change(next => {
          for (const key of Object.keys(next)) delete next[key];
          Object.assign(next, structuredClone(incoming));
          return { restored: true, missingAttachments, corruptAttachments,
            rooms: next.rooms.length,
            messages: next.rooms.reduce((total, room) => total + room.messages.length, 0) };
        });
      }
      if (op === 'compact') {
        const dryRun = input.dryRun === undefined ? true : input.dryRun;
        if (typeof dryRun !== 'boolean') fail('INVALID_INPUT', 'dryRun must be boolean.');
        if (input.dropIdentities !== undefined && typeof input.dropIdentities !== 'boolean') fail('INVALID_INPUT', 'dropIdentities must be boolean.');
        const olderThanDays = input.olderThanDays ?? (compactAfterDays || DEFAULT_COMPACT_AFTER_DAYS);
        if (!Number.isFinite(olderThanDays) || olderThanDays < 0) fail('INVALID_INPUT', 'olderThanDays must be a nonnegative number.');
        return compactRoom(project, { olderThanDays, dryRun, dropIdentities: input.dropIdentities ?? false });
      }
      if (op === 'prune') {
        const dryRun = input.dryRun === undefined ? true : input.dryRun;
        if (typeof dryRun !== 'boolean') fail('INVALID_INPUT', 'dryRun must be boolean.');
        if (input.includeTest !== undefined && typeof input.includeTest !== 'boolean') fail('INVALID_INPUT', 'includeTest must be boolean.');
        const idleMinutes = minutes(input.idleMinutes, 'idleMinutes', fail, pruneDefaults().idleMinutes);
        const ephemeralIdleMinutes = minutes(input.ephemeralIdleMinutes, 'ephemeralIdleMinutes', fail, ephemeralPruneMinutes);
        const target = roomFor(project, false);
        const plan = planPrune(state, target ?? { agents: [] }, { idleMinutes, ephemeralIdleMinutes, includeTest: input.includeTest === true });
        if (dryRun || !plan.candidates.length) return pruneReport(plan, { dryRun });
        const ids = plan.candidates.map(a => a.agentId);
        return change(next => pruneReport(plan, { dryRun, pruned: markDormant(next.rooms.find(r => r.project === project), ids) }));
      }
      if (op === 'branches') {
        // Branch claims are scoped to the repo (git common dir, or the project path outside git) and held by project+agent.
        const action = text(input.action, 'action', 16);
        if (!['claim', 'release', 'forceRelease', 'list'].includes(action))
          fail('INVALID_INPUT', 'action must be claim, release, forceRelease, or list.');
        const repo = branchGit ?? project;
        const threshold = input.staleMinutes ?? staleMinutes;
        if (!Number.isFinite(threshold) || threshold < 0) fail('INVALID_INPUT', 'Invalid stale minutes.');
        const inRepo = source => (source.branchClaims ?? []).filter(c => c.repo === repo);
        const views = source => inRepo(source).map(c => branchClaimView(source, c, threshold));
        if (action === 'list') return { repo, git: branchGit !== null, claims: views(state) };
        if (action === 'forceRelease') {
          const as = text(input.agentId, 'human ID');
          const branch = branchName(input.branch);
          const reason = text(input.reason, 'reason', 1024);
          if (!inRepo(state).some(c => c.branch === branch)) fail('UNKNOWN_CLAIM', 'No branch claim for that branch exists in this repo.', 404);
          if ((state.releaseLog ?? []).length >= 10000) fail('LOG_LIMIT', 'Forced release log reached its bound.', 409);
          return change(next => {
            const released = inRepo(next).filter(c => c.branch === branch);
            next.branchClaims = next.branchClaims.filter(c => !released.includes(c));
            const receipt = { as, at: new Date().toISOString(), project, scope: 'branch', repo, reason, released };
            (next.releaseLog ??= []).push(receipt);
            return { released, claims: views(next), receipt };
          });
        }
        const holderRoom = roomFor(project);
        const holder = agentFor(holderRoom, input.agentId).agentId;
        await seen(project, holder);
        const mine = c => c.project === project && c.agentId === holder;
        if (action === 'release') {
          const branch = input.branch === undefined ? undefined : branchName(input.branch);
          return change(next => {
            const released = inRepo(next).filter(c => mine(c) && (branch === undefined || c.branch === branch));
            next.branchClaims = (next.branchClaims ?? []).filter(c => !released.includes(c));
            return { released: released.map(c => c.branch), claims: views(next) };
          });
        }
        const branch = branchName(input.branch);
        const note = input.note === undefined ? undefined : text(input.note, 'note', 1024);
        const meta = claimMeta(input.meta);
        const held = inRepo(state).find(c => c.branch === branch);
        if (held && !mine(held))
          fail('CLAIM_CONFLICT', 'Branch is already claimed; no claim was acquired.', 409,
            { branch, repo, conflicts: [branchClaimView(state, held, threshold)] });
        if (held && note === undefined && meta === undefined) return { claim: structuredClone(held), created: false, owned: inRepo(state).filter(mine).map(c => c.branch) };
        if (!held && (state.branchClaims ?? []).length >= MAX_CLAIMS) fail('CLAIM_LIMIT', 'Branch claims reached their bound.', 409);
        return change(next => {
          const rows = next.branchClaims ??= [];
          let claim = rows.find(c => c.repo === repo && c.branch === branch);
          if (!claim) rows.push(claim = { repo, branch, agentId: holder, project, claimedAt: new Date().toISOString() });
          if (note !== undefined) claim.note = note;
          if (meta !== undefined) claim.meta = meta;
          return { claim: snapshot(claim), created: !held, owned: inRepo(next).filter(mine).map(c => c.branch) };
        });
      }
      let room = roomFor(project);
      if (op === 'send') {
        const from = agentFor(room, input.from).agentId;
        if (state.rooms.reduce((count, r) => count + r.messages.length, 0) >= MAX_MESSAGES)
          fail('MESSAGE_LIMIT', 'Relay history reached its message bound.', 409);
        if (stateBytes(state, messageJson) > MAX_STORE - STORE_RESERVE)
          fail('STORE_LOW_HEADROOM', 'Relay store is nearly full; sends pause so acknowledgement, status, and recovery stay available.', 409,
            { reserveBytes: STORE_RESERVE, recovery: 'export the ledger, then archive history in a fresh data directory' });
        await seen(project,from);room=roomFor(project);
        const to = text(input.to, 'to');
        const body = text(input.body, 'body', 16384, false);
        const messageId = input.messageId === undefined ? randomUUID() : text(input.messageId, 'messageId');
        const summary=input.summary===undefined?undefined:text(input.summary,'summary',480,false);
        if(summary!==undefined&&Array.from(summary).length>120)fail('INVALID_INPUT','Summary must be at most 120 characters.');
        const replyTo = input.replyTo === undefined ? undefined : text(input.replyTo, 'replyTo');
        let attachments;
        try { attachments = await storeAttachments(directory,input.attachments); }
        catch(e){fail('ATTACHMENT_ERROR',e.message,409);}
        const prior = room.messages.find(m => m.messageId === messageId);
        if (prior) {
          if (prior.from !== from || prior.to !== to || prior.body !== body || prior.replyTo !== replyTo || prior.summary !== summary || JSON.stringify(prior.attachments??[])!==JSON.stringify(attachments))
            fail('MESSAGE_ID_CONFLICT', 'Message ID already belongs to different content.', 409);
          return { messageId, recipients: [...prior.recipients], duplicate: true, cursor: prior.cursor };
        }
        const within = minutes(input.within, 'within', fail, undefined);
        let recipients, audience, recipientDormant = false;
        if (isBroadcast(to)) {
          ({ recipients, audience } = broadcastAudience(room, from, to, { within: within ?? DEFAULT_LIVE_WINDOW_MINUTES }));
          if (!recipients.length) fail('NO_RECIPIENTS', audience.mode === 'live'
            ? `No live recipient seen within ${audience.within} minutes; ${audience.excluded} other non-left agent(s) were excluded. Retry with to "*all" or a larger within.`
            : 'No registered recipient exists.', 409, { audience: audience.mode, within: audience.within, excluded: audience.excluded });
        } else {
          // Durable inboxes keep working for dormant (left, not retired) identities.
          const target = room.agents.find(a => a.agentId === to);
          if (!target || target.retired) fail('UNKNOWN_AGENT', 'Agent is not registered in this project.', 404);
          recipients = [target.agentId]; recipientDormant = isDormant(target);
          audience = { mode: 'direct', within: null, excluded: 0 };
        }
        if (replyTo !== undefined && !room.messages.some(m => m.messageId === replyTo))
          fail('UNKNOWN_REPLY', 'Reply target does not exist in this project.', 404);
        return change(next => {
          const target = next.rooms.find(r => r.project === project);
          const cursor = next.nextCursor++;
          target.cursor = cursor;
          const broadcast = isBroadcast(to);
          const schema2 = isSchema2(next);
          target.messages.push({ messageId, from, to, body, ...(replyTo ? { replyTo } : {}),
            ...(summary!==undefined?{summary}:{}),...(attachments.length?{attachments}:{}),createdAt: new Date().toISOString(), cursor, recipients, ackedBy: [], notified: [],
            // Schema 2 marks the kind of every message and keeps the audience rule of a broadcast
            // next to the audience snapshot it was sent to.
            ...(schema2 ? { kind: broadcast ? 'broadcast' : 'direct' } : {}),
            ...(schema2 && broadcast ? { audience: { mode: audience.mode, within: audience.within ?? null, excluded: audience.excluded ?? 0 } } : {}) });
          return { messageId, recipients, duplicate: false, cursor, audience, ...(recipientDormant ? { recipientDormant: true } : {}) };
        });
      }
      if (op === 'release' && input.force === true) {
        const as=text(input.agentId,'human ID');
        if (!input.resources?.length) fail('INVALID_INPUT','Forced release requires explicit resources.');
        const machine=input.scope==='machine';
        if (input.scope!==undefined&&!['machine','project'].includes(input.scope)) fail('INVALID_INPUT','Invalid scope.');
        const resources=machine?strings(input.resources,'resources').map(r=>text(r,'machine resource')):
          await Promise.all(strings(input.resources,'resources').map(r=>canonicalResource(project,r)));
        return change(next=>{
          const target=machine?next:next.rooms.find(r=>r.project===project),key=machine?'machineClaims':'claims';
          const released=(target[key]??[]).filter(c=>resources.includes(c.resource));
          target[key]=(target[key]??[]).filter(c=>!resources.includes(c.resource));
          if ((next.releaseLog??[]).length>=10000) fail('LOG_LIMIT','Forced release log reached its bound.',409);
          const receipt={as,at:new Date().toISOString(),project,scope:machine?'machine':'project',released};
          (next.releaseLog??=[]).push(receipt);
          return {released,claims:target[key],receipt};
        });
      }
      if (op === 'retire') {
        const id = text(input.agentId, 'agentId');
        if (input.relinquish !== undefined && typeof input.relinquish !== 'boolean')
          fail('INVALID_INPUT', 'relinquish must be boolean.');
        // The same obligation set that guards prune, the sweep and ephemeral leave: one definition.
        const owed = obligationIndex(state, room).get(id) ?? emptyObligations();
        if (hasObligations(owed) && input.relinquish !== true)
          fail('RETIRE_BLOCKED', 'Agent holds obligations; resolve them or retire with relinquish:true.', 409, { ...owed });
        return change(next => {
          const agent = next.rooms.find(r => r.project === project).agents.find(a => a.agentId === id);
          if (!agent) fail('UNKNOWN_AGENT', 'Agent is not registered in this project.', 404);
          agent.left = true; agent.retired = true; agent.updatedAt = new Date().toISOString();
          if (input.relinquish === true)
            return { retired: id,
              stranded: { ...owed },
              recovery: 'Claims stay held by the retired identity; use forced release with explicit resources (branch force-release for branch claims), resolve handoffs explicitly, remove finished process records, and reassign or complete open tasks.' };
          return { retired: id };
        });
      }
      const agentId = (() => {
        if (op === 'respondHandoff') {
          const responder = text(input.agentId, 'agentId');
          const found = room.agents.find(a => a.agentId === responder);
          if (!found) fail('UNKNOWN_AGENT', 'Agent is not registered in this project.', 404);
          return found.agentId;
        }
        return agentFor(room, input.agentId).agentId;
      })();
      const responderLeft = op === 'respondHandoff'
        && (room.agents.find(a => a.agentId === agentId)?.left === true);
      if (!responderLeft) { await seen(project, agentId); room = roomFor(project); }
      if (op === 'fetch') {
        const message=room.messages.find(m=>m.messageId===text(input.messageId,'messageId'));
        if(!message||(message.from!==agentId&&!message.recipients.includes(agentId)))fail('UNKNOWN_MESSAGE','Only sender and recipients may fetch this message.',404);
        const out=text(input.out,'out',4096);if(!path.isAbsolute(out))fail('INVALID_INPUT','Output directory must be absolute.');
        try{return {files:await fetchAttachments(directory,message.attachments??[],out)};}catch(e){fail('ATTACHMENT_ERROR',e.message,409);}
      }
      if (op === 'leave' && input.ifIdle !== undefined && typeof input.ifIdle !== 'boolean') fail('INVALID_INPUT', 'ifIdle must be boolean.');
      if (op === 'leave' && input.ifIdle === true) {
        const owed = obligationIndex(state, room).get(agentId);
        if (hasObligations(owed)) return { left: false, kept: true, obligations: owed };
      }
      if (op === 'leave') return change(next=>{
        const agent=next.rooms.find(r=>r.project===project).agents.find(a=>a.agentId===agentId);
        agent.left=true;agent.updatedAt=new Date().toISOString();return {left:agentId};
      });
      if (op === 'inbox') {
        if (input.unacked !== undefined && typeof input.unacked !== 'boolean') fail('INVALID_INPUT', 'unacked must be boolean.');
        const since = input.since ?? 0, limit = input.limit ?? MAX_MESSAGES;
        if (!Number.isSafeInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGES)
          fail('INVALID_INPUT', 'Invalid inbox cursor or limit.');
        const from = input.from === undefined ? undefined : text(input.from, 'from');
        const messages = inbox(room, agentId, input.unacked ?? true, since).filter(m => from === undefined || m.from === from).slice(0, limit);
        return { messages, cursor: messages.at(-1)?.cursor ?? since, roomCursor: room.cursor };
      }
      if (op === 'setBulletin') {
        const title = text(input.title, 'title', 480);
        const body = text(input.body, 'body', 16384, false);
        const source = text(input.source, 'source', 4096);
        if (input.version !== undefined) {
          if (!Number.isSafeInteger(input.version) || input.version < 0) fail('INVALID_INPUT', 'version must be a nonnegative integer.');
          const current = room.bulletin?.versions[0]?.version ?? 0;
          if (input.version !== current) fail('VERSION_CONFLICT', 'Bulletin changed since that version; reload before updating.', 409, { current });
        }
        return change(next => {
          const target = next.rooms.find(r => r.project === project);
          const versions = target.bulletin?.versions ?? [];
          const record = { version: (versions[0]?.version ?? 0) + 1, title, body, source,
            hash: bulletinHash(title, body, source), ts: new Date().toISOString(), acks: [] };
          target.bulletin = { versions: [record, ...versions].slice(0, MAX_BULLETIN_VERSIONS) };
          return bulletinView(record);
        });
      }
      if (op === 'ackBulletin') {
        const versions = room.bulletin?.versions ?? [];
        const current = versions[0];
        if (!current) fail('NO_BULLETIN', 'No policy bulletin is set.', 404);
        if (input.version === undefined) fail('INVALID_INPUT', 'version is required to bind the acknowledgement.');
        if (!Number.isSafeInteger(input.version) || input.version < 1) fail('INVALID_INPUT', 'version must be a positive integer.');
        const requested = versions.find(row => row.version === input.version);
        if (!requested) fail('UNKNOWN_BULLETIN', 'No retained bulletin with that version exists.', 404);
        if (input.hash !== undefined && (typeof input.hash !== 'string' || input.hash !== requested.hash))
          fail('BULLETIN_MISMATCH', 'Bulletin hash does not match the retained version; reload before acknowledging.', 409,
            { current: current.version, requested: { version: requested.version, hash: input.hash } });
        if (!requested.acks.some(row => row.agentId === agentId) && requested.acks.length >= MAX_RETAINED_AGENTS)
          fail('BULLETIN_ACK_LIMIT', 'Bulletin acknowledgements reached their retained bound; the ledger was left intact.', 409,
            { used: requested.acks.length, limit: MAX_RETAINED_AGENTS,
              recovery: 'publish a new bulletin version to collect fresh acknowledgements; retained acks stay bound to their version' });
        const duplicate = requested.acks.some(row => row.agentId === agentId);
        if (duplicate) return { version: requested.version, current: current.version,
          stale: requested.version !== current.version,
          acks: requested.acks.map(row => row.agentId), duplicate: true };
        return change(next => {
          const targetRoom = next.rooms.find(r => r.project === project);
          const target = targetRoom.bulletin.versions.find(row => row.version === input.version);
          if (!target) fail('UNKNOWN_BULLETIN', 'No retained bulletin with that version exists.', 404);
          if (input.hash !== undefined && input.hash !== target.hash)
            fail('BULLETIN_MISMATCH', 'Bulletin hash does not match the retained version; reload before acknowledging.', 409,
              { current: targetRoom.bulletin.versions[0].version, requested: { version: target.version, hash: input.hash } });
          if (target.acks.some(row => row.agentId === agentId)) {
            const nowCurrent = targetRoom.bulletin.versions[0].version;
            return { version: target.version, current: nowCurrent, stale: target.version !== nowCurrent,
              acks: target.acks.map(row => row.agentId), duplicate: true };
          }
          if (target.acks.length >= MAX_RETAINED_AGENTS)
            fail('BULLETIN_ACK_LIMIT', 'Bulletin acknowledgements reached their retained bound; the ledger was left intact.', 409,
              { used: target.acks.length, limit: MAX_RETAINED_AGENTS,
                recovery: 'publish a new bulletin version to collect fresh acknowledgements; retained acks stay bound to their version' });
          target.acks.push({ agentId, at: new Date().toISOString() });
          const nowCurrent = targetRoom.bulletin.versions[0].version;
          return { version: target.version, current: nowCurrent, stale: target.version !== nowCurrent,
            acks: target.acks.map(row => row.agentId), duplicate: false };
        });
      }
      if (op === 'requestFollowup') {
        const message = room.messages.find(m => m.messageId === text(input.messageId, 'messageId'));
        if (!message || (message.from !== agentId && !message.recipients.includes(agentId)))
          fail('UNKNOWN_MESSAGE', 'Only sender and recipients may request follow-up for this message.', 404);
        const note = input.note === undefined ? undefined : text(input.note, 'note', 1024);
        return change(next => {
          const target = next.rooms.find(r => r.project === project).messages.find(m => m.messageId === message.messageId);
          if ((target.followups ?? []).length >= MAX_FOLLOWUPS)
            fail('FOLLOWUP_LIMIT', 'Follow-up records reached their bound.', 409);
          const followup = { id: randomUUID(), agentId, ...(note !== undefined ? { note } : {}), at: new Date().toISOString() };
          (target.followups ??= []).push(followup);
          return { followup };
        });
      }
      if (op === 'ack' || op === 'notified') {
        // Schema 1 keeps the read state on the message; schema 2 keeps it in the agent's cursor.
        const cursorModel = isSchema2(state);
        if (op === 'ack' && (input.all !== undefined || input.through !== undefined)) {
          if ((input.all !== undefined && input.all !== true) || (input.through !== undefined && (!Number.isSafeInteger(input.through) || input.through < 0))
              || input.messageId !== undefined || (input.all && input.through !== undefined)) fail('INVALID_INPUT', 'Choose id, all, or through.');
          return change(next => {
            const targetRoom = next.rooms.find(r => r.project === project);
            const agent = targetRoom.agents.find(candidate => candidate.agentId === agentId);
            const messages = targetRoom.messages.filter(m => m.recipients.includes(agentId)
              && !hasReadMessage(agentId, m, agent) && (input.all || m.cursor <= input.through));
            const at = new Date().toISOString();
            for (const m of messages) { m.ackedBy.push(agentId); (m.acks ??= []).push({ agentId, at }); }
            // Schema 2 folds the broadcasts just read into the agent's cursor, so the ledger
            // keeps one number per agent instead of one row per broadcast.
            if (cursorModel) advanceReadCursor(agent, targetRoom, { at });
            return { acked: messages.length };
          });
        }
        const message = messageFor(room, input.messageId, agentId);
        const adapter = op === 'notified' ? text(input.adapter, 'adapter', 80) : undefined;
        const reader = room.agents.find(candidate => candidate.agentId === agentId);
        const duplicate = op === 'ack' ? hasReadMessage(agentId, message, reader)
          : message.notified.some(n => n.agentId === agentId && n.adapter === adapter);
        if (duplicate) return { messageId: message.messageId, acked: hasReadMessage(agentId, message, reader), duplicate: true };
        if (op === 'notified' && message.notified.length >= noticeAllowance(message.recipients.length))
          fail('NOTICE_LIMIT', 'Message transport metadata reached its bound.', 409,
            { used: message.notified.length, allowance: noticeAllowance(message.recipients.length),
              recipients: message.recipients.length });
        return change(next => {
          const targetRoom = next.rooms.find(r => r.project === project);
          const target = targetRoom.messages.find(m => m.messageId === message.messageId);
          const agent = targetRoom.agents.find(candidate => candidate.agentId === agentId);
          if (op === 'ack') {
            const at = new Date().toISOString();
            target.ackedBy.push(agentId); (target.acks ??= []).push({ agentId, at });
            if (cursorModel) advanceReadCursor(agent, targetRoom, { at });
          }
          else target.notified.push({ agentId, adapter, at: new Date().toISOString() });
          return { messageId: target.messageId, acked: hasReadMessage(agentId, target, agent), duplicate: false };
        });
      }
      if (op === 'status') {
        const patch = {};
        if (input.status !== undefined) patch.status = text(input.status, 'status', 80);
        if (input.frozen !== undefined) {
          if (typeof input.frozen !== 'boolean') fail('INVALID_INPUT', 'frozen must be boolean.');
          patch.frozen = input.frozen;
        }
        if (input.resources !== undefined) patch.resources = strings(input.resources, 'resources', true);
        if (input.task !== undefined) {
          if (input.task !== null && typeof input.task !== 'string'
              && (!input.task || typeof input.task !== 'object' || Array.isArray(input.task))) fail('INVALID_INPUT', 'Invalid task metadata.');
          if (Buffer.byteLength(JSON.stringify(input.task)) > 8192) fail('INVALID_INPUT', 'Task metadata exceeds 8 KiB.');
          patch.task = input.task;
        }
        if (input.transport !== undefined) {
          if (!input.transport || typeof input.transport !== 'object' || Array.isArray(input.transport))
            fail('INVALID_INPUT', 'transport must be an object.');
          const adapter = text(input.transport.adapter, 'transport.adapter', 80);
          if (!['connected', 'disconnected', 'unknown'].includes(input.transport.state))
            fail('INVALID_INPUT', 'transport.state must be connected, disconnected, or unknown.');
          if (input.transport.push !== undefined && typeof input.transport.push !== 'boolean')
            fail('INVALID_INPUT', 'transport.push must be boolean.');
          const at = input.transport.ts === undefined ? new Date().toISOString()
            : new Date(timestamp(input.transport.ts, 'transport.ts')).toISOString();
          patch.transport = { adapter, state: input.transport.state, ts: at, source: 'adapter-report',
            ...(input.transport.push === undefined ? {} : { push: input.transport.push }) };
        }
        if (input.git !== undefined) {
          // Optional report for agents working outside their room's checkout; null clears it.
          const report = input.git;
          if (report !== null && (typeof report !== 'object' || Array.isArray(report)
              || Object.keys(report).some(key => !['branch', 'head', 'worktree'].includes(key))))
            fail('INVALID_INPUT', 'git may contain only branch, head, and worktree.');
          if (report === null) patch.git = null;
          else {
            const git = {};
            if (report.branch !== undefined) git.branch = report.branch === null ? null : branchName(report.branch, 'git.branch');
            if (report.head !== undefined) git.head = text(report.head, 'git.head', 128);
            if (report.worktree !== undefined) {
              git.worktree = text(report.worktree, 'git.worktree', 4096);
              if (!path.isAbsolute(git.worktree)) fail('INVALID_INPUT', 'git.worktree must be an absolute path.');
            }
            if (!Object.keys(git).length) fail('INVALID_INPUT', 'git must report a branch, head, or worktree.');
            patch.git = { ...git, ts: new Date().toISOString() };
          }
        }
        if (!Object.keys(patch).length) return { agent: structuredClone(agentFor(room, agentId)), claims: [...projectClaims(room,staleMinutes),...machineClaims(state,staleMinutes)] };
        return change(next => {
          const agent = next.rooms.find(r => r.project === project).agents.find(a => a.agentId === agentId);
          Object.assign(agent, patch, { updatedAt: new Date().toISOString() });
          if (agent.git === null) delete agent.git;
          if (patch.status !== undefined || patch.task !== undefined || patch.frozen !== undefined) agent.statusAt = agent.updatedAt;
          return { agent, claims: [...projectClaims(next.rooms.find(r=>r.project===project),staleMinutes),...machineClaims(next,staleMinutes)] };
        });
      }
      if (op === 'claimNarrow') {
        const resource = await canonicalResource(project, text(input.resource, 'resource', 4096));
        const narrow = await Promise.all(strings(input.resources, 'resources').map(r => canonicalResource(project, r)));
        const meta = claimMeta(input.meta);
        if (namedResources.has(resource)) fail('INVALID_INPUT', 'Named resources cannot be narrowed.');
        if (narrow.some(r => r === resource || !within(resource, r)))
          fail('INVALID_INPUT', 'Narrowed resources must be strict paths inside the claimed resource.');
        if (new Set(narrow).size !== narrow.length) fail('INVALID_INPUT', 'Narrowed resources must be distinct.');
        if (!room.claims.some(c => c.agentId === agentId && c.resource === resource))
          fail('NOT_HOLDER', 'Only the current holder can narrow a claim; no claim was changed.', 409);
        return change(next => {
          const target = next.rooms.find(r => r.project === project);
          const index = target.claims.findIndex(c => c.agentId === agentId && c.resource === resource);
          if (index < 0) fail('NOT_HOLDER', 'Only the current holder can narrow a claim; no claim was changed.', 409);
          const conflicts = target.claims.filter(c => c.agentId !== agentId && narrow.some(r => resourceConflict(c.resource, r)));
          if (conflicts.length) fail('CLAIM_CONFLICT', 'Resources are already claimed; no claim was acquired.', 409, { conflicts });
          if (target.claims.length - 1 + narrow.filter(r => !target.claims.some(c => c.resource === r)).length > MAX_CLAIMS)
            fail('CLAIM_LIMIT', 'Project resource claims reached their bound.', 409);
          const inherited = meta ?? target.claims[index]?.meta;
          target.claims.splice(index, 1);
          for (const child of narrow) {
            if (!target.claims.some(c => c.resource === child))
              target.claims.push({ agentId, resource: child, claimedAt: new Date().toISOString(), ...(inherited ? { meta: inherited } : {}) });
          }
          return { released: [resource], claimed: narrow,
            claims: target.claims, owned: target.claims.filter(c => c.agentId === agentId) };
        });
      }
      if (op === 'claim' || op === 'release') {
        if (input.scope!==undefined&&!['machine','project'].includes(input.scope)) fail('INVALID_INPUT','Invalid scope.');
        const meta = op === 'claim' ? claimMeta(input.meta) : undefined;
        if (input.scope==='machine') {
          const resources=input.resources===undefined&&op==='release'?undefined:strings(input.resources,'resources').map(r=>text(r,'machine resource'));
          const claims=state.machineClaims??[];
          const own=c=>c.agentId===agentId&&c.project===project;
          const conflicts=claims.filter(c=>!own(c)&&resources?.includes(c.resource));
          if(op==='claim'&&conflicts.length)fail('CLAIM_CONFLICT','Machine resources are already claimed; no claim was acquired.',409,{conflicts});
          return change(next=>{
            const rows=next.machineClaims??=[];
            if(op==='release'){
              const released=rows.filter(c=>own(c)&&(resources===undefined||resources.includes(c.resource)));
              next.machineClaims=rows.filter(c=>!released.includes(c));return {released,claims:next.machineClaims};
            }
            if(rows.length+resources.filter(r=>!rows.some(c=>c.resource===r)).length>MAX_CLAIMS)fail('CLAIM_LIMIT','Machine claims reached their bound.',409);
            for(const resource of resources)if(!rows.some(c=>c.resource===resource))rows.push({agentId,project,resource,claimedAt:new Date().toISOString(),...(meta?{meta}:{})});
            return {claims:rows,owned:rows.filter(own)};
          });
        }
        const resources = input.resources === undefined && op === 'release' ? undefined
          : await Promise.all(strings(input.resources, 'resources').map(r => canonicalResource(project, r)));
        if (op === 'claim') {
          const conflicts = room.claims.filter(c => c.agentId !== agentId
            && resources.some(r => resourceConflict(c.resource, r)));
          if (conflicts.length) fail('CLAIM_CONFLICT', 'Resources are already claimed; no claim was acquired.', 409, { conflicts });
        }
        return change(next => {
          const target = next.rooms.find(r => r.project === project);
          if (op === 'release') {
            const released = target.claims.filter(c => c.agentId === agentId
              && (resources === undefined || resources.includes(c.resource))).map(c => c.resource);
            target.claims = target.claims.filter(c => c.agentId !== agentId
              || (resources !== undefined && !resources.includes(c.resource)));
            return { released, claims: target.claims };
          }
          if (target.claims.length + resources.filter(resource => !target.claims.some(c => c.resource === resource)).length > MAX_CLAIMS)
            fail('CLAIM_LIMIT', 'Project resource claims reached their bound.', 409);
          for (const resource of resources) {
            if (!target.claims.some(c => c.agentId === agentId && c.resource === resource))
              target.claims.push({ agentId, resource, claimedAt: new Date().toISOString(), ...(meta ? { meta } : {}) });
          }
          return { claims: target.claims, owned: target.claims.filter(c => c.agentId === agentId) };
        });
      }
      if (op === 'requestHandoff') {
        const to = input.to === undefined ? null : text(input.to, 'to');
        const reason = text(input.reason, 'reason', 1024);
        const resources = await Promise.all(strings(input.resources, 'resources').map(r => canonicalResource(project, r)));
        const meta = claimMeta(input.meta);
        if (to !== null) {
          if (to === agentId) fail('INVALID_INPUT', 'Handoff target must be another agent.');
          agentFor(room, to);
        }
        const held = resources.filter(r => room.claims.some(c => c.resource === r && c.agentId === agentId));
        const byTarget = to === null ? [] : resources.filter(r => room.claims.some(c => c.resource === r && c.agentId === to));
        if (held.length !== resources.length && (to === null || byTarget.length !== resources.length))
          fail('NOT_HOLDER', 'Handoff resources must be fully held by the requester or the named holder; no request was recorded.', 409);
        const holder = held.length === resources.length ? agentId : to;
        const generations = resources.map(resource => {
          const claim = room.claims.find(c => c.resource === resource && c.agentId === holder);
          return { resource, claimedAt: claim.claimedAt, agentId: claim.agentId };
        });
        return change(next => {
          const target = next.rooms.find(r => r.project === project);
          if ((target.handoffs ?? []).length >= MAX_HANDOFFS) fail('HANDOFF_LIMIT', 'Handoff records reached their bound.', 409);
          const handoff = { id: randomUUID(), from: agentId, to, resources: [...resources], reason, state: 'pending',
            requestedAt: new Date().toISOString(), offeredBy: holder, offeredTo: to,
            generations: generations.map(g => ({ ...g })), ...(meta ? { meta } : {}) };
          (target.handoffs ??= []).push(handoff);
          return { handoff };
        });
      }
      if (op === 'respondHandoff') {
        const id = text(input.id, 'id');
        if (typeof input.accept !== 'boolean') fail('INVALID_INPUT', 'accept must be boolean.');
        const record = room.handoffs?.find(h => h.id === id);
        if (!record) fail('UNKNOWN_HANDOFF', 'No handoff request with that ID exists in this project.', 404);
        if (record.state !== 'pending') fail('HANDOFF_CLOSED', 'Handoff request is already resolved.', 409);
        const legacy = record.offeredBy === undefined;
        if (legacy) {
          if (record.to !== null && record.to !== agentId) fail('NOT_RECIPIENT', 'Only the named recipient may respond to this handoff.', 403);
        } else {
          const offeredTo = record.offeredTo ?? record.to;
          if (offeredTo !== null && offeredTo !== undefined && agentId !== offeredTo)
            fail('HANDOFF_STALE', 'Handoff responder is not the offered counterparty; no claims were transferred.', 409,
              { offeredBy: record.offeredBy, offeredTo, responder: agentId, from: record.from });
        }
        if (record.to === null && record.from === agentId) fail('INVALID_INPUT', 'The requester cannot respond to their own open handoff.');
        const resources = input.resources === undefined ? [...record.resources]
          : await Promise.all(strings(input.resources, 'resources').map(r => canonicalResource(project, r)));
        if (!resources.length || resources.some(r => !record.resources.includes(r)))
          fail('INVALID_INPUT', 'Responded resources must belong to the handoff request.');
        if (!input.accept) {
          return change(next => {
            const handoff = next.rooms.find(r => r.project === project).handoffs.find(h => h.id === id);
            Object.assign(handoff, { state: 'declined', respondedAt: new Date().toISOString(), respondedBy: agentId });
            return { handoff };
          });
        }
        const stale = (details) => fail('HANDOFF_STALE', 'Handoff ownership changed since the offer; no claims were transferred.', 409, details);
        const rows = resources.map(resource => room.claims.find(c => c.resource === resource));
        if (!legacy) {
          const offeredBy = record.offeredBy;
          const offeredTo = record.offeredTo ?? record.to;
          const live = candidate => {
            const row = room.agents.find(a => a.agentId === candidate);
            return row && !row.left && !row.retired;
          };
          if (!live(record.from) || (offeredTo !== null && offeredTo !== undefined && !live(offeredTo))
              || !live(agentId) || !live(offeredBy))
            stale({ offeredBy, offeredTo, from: record.from, responder: agentId, reason: 'party-retired' });
          if (rows.some(row => !row))
            stale({ offeredBy, offeredTo, holder: null, responder: agentId, reason: 'unclaimed' });
          const holder = rows[0].agentId;
          if (rows.some(row => row.agentId !== holder))
            stale({ offeredBy, offeredTo, holder, responder: agentId, reason: 'split-holder' });
          if (holder !== offeredBy)
            stale({ offeredBy, offeredTo, holder, responder: agentId, reason: 'holder-changed' });
          for (const resource of resources) {
            const expected = (record.generations ?? []).find(g => g.resource === resource);
            const current = room.claims.find(c => c.resource === resource);
            if (expected && (current.claimedAt !== expected.claimedAt || current.agentId !== expected.agentId))
              stale({ offeredBy, offeredTo, holder, responder: agentId, reason: 'generation-changed', resource });
          }
          const recipient = holder === record.from ? agentId : record.from;
          if (recipient === holder) stale({ offeredBy, offeredTo, holder, responder: agentId, reason: 'no-counterparty' });
          if (!live(recipient)) stale({ offeredBy, offeredTo, holder, responder: agentId, recipient, reason: 'recipient-retired' });
          return change(next => {
            const target = next.rooms.find(r => r.project === project);
            const handoff = target.handoffs.find(h => h.id === id);
            if (handoff.state !== 'pending') fail('HANDOFF_CLOSED', 'Handoff request is already resolved.', 409);
            const at = new Date().toISOString();
            for (const resource of resources) {
              const claim = target.claims.find(c => c.resource === resource);
              if (!claim || claim.agentId !== holder || claim.claimedAt !== room.claims.find(c => c.resource === resource).claimedAt)
                fail('HANDOFF_STALE', 'Handoff ownership changed since the offer; no claims were transferred.', 409,
                  { offeredBy, offeredTo, holder, responder: agentId, reason: 'race-changed' });
              Object.assign(claim, { agentId: recipient, claimedAt: at, transferredFrom: holder, transferredAt: at });
            }
            Object.assign(handoff, { state: 'accepted', respondedAt: at, respondedBy: agentId, transferred: [...resources] });
            return { handoff, transferred: resources.map(resource => target.claims.find(c => c.resource === resource)),
              claims: target.claims };
          });
        }
        if (legacy) fail('HANDOFF_STALE', 'Handoff ownership changed since the offer; no claims were transferred.', 409,
          { reason: 'legacy-unverifiable-direction',
            recovery: 'ask the parties to recreate the offer; the old record is preserved for audit' });
      }
      fail('UNKNOWN_OPERATION', 'Unknown broker operation.');
    });
  }

  try {
    releaseLease = await writerLease(directory);
    try {
      const bytes = await fs.readFile(stateFile);
      if (bytes.length > MAX_STORE) throw new Error('Relay state exceeds its storage bound.');
      state = JSON.parse(bytes.toString('utf8'));
      validateStore(state, { validated });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = { version: 1, nextCursor: 1, rooms: [] };
      await persist(JSON.stringify(state));
    }
    durable = state;
    try {
      token = (await fs.readFile(tokenFile, 'utf8')).trim();
      if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error('Relay token is corrupt; retained without modification.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      token = randomBytes(32).toString('hex');
      const file = await fs.open(tokenFile, 'wx', 0o600);
      try { await file.writeFile(token + '\n'); await file.sync(); }
      finally { await file.close(); }
    }
    const expectedAuthorization = Buffer.from('Bearer ' + token);
    server = serverFactory(async (request, response) => {
      try {
        if (request.method === 'GET' && request.url === '/health') {
          json(response, 200, { ok: true, version: 1 }); return;
        }
        // The versioned path is the current one; /rpc stays as the path older clients speak.
        if (request.method !== 'POST' || (request.url !== '/api/v1/rpc' && request.url !== '/rpc')) fail('NOT_FOUND', 'Endpoint not found.', 404);
        const authorization = Buffer.from(request.headers.authorization ?? '');
        if (authorization.length !== expectedAuthorization.length
            || !timingSafeEqual(authorization, expectedAuthorization)) fail('UNAUTHORIZED', 'Bearer token required.', 401);
        const result = await rpc(await readBody(request), response);
        json(response, 200, { ok: true, ...result });
      } catch (error) {
        json(response, error.httpStatus ?? 503, { ok: false, error: {
          code: error instanceof RpcError ? error.code : 'STORE_IO',
          message: error instanceof RpcError ? error.message : 'Broker could not complete the request.',
          ...(error instanceof RpcError && error.details ? error.details : {})
        } });
      }
    });
    server.requestTimeout = 35000;
    server.headersTimeout = 10000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    // Registry sweep: same plan as op 'prune' (non-dry), always through the serial writer.
    async function sweep() {
      if (closing || faulted) return { pruned: 0 };
      if (compactAfterDays) await serial(async () => {
        for (const room of [...state.rooms]) await compactRoom(room.project, { olderThanDays: compactAfterDays });
      }).catch(() => {});
      if (!pruneAfterMinutes) return { pruned: 0 };
      return serial(async () => {
        const now = Date.now();
        const plans = state.rooms.map(r => [r.project, planPrune(state, r, { ...pruneDefaults(), now }).candidates.map(a => a.agentId)])
          .filter(([, ids]) => ids.length);
        if (!plans.length) return { pruned: 0 };
        return change(next => ({ pruned: plans.reduce((total, [p, ids]) =>
          total + markDormant(next.rooms.find(r => r.project === p), ids), 0) }));
      });
    }
    await sweep().catch(() => {});
    const sweeper = pruneAfterMinutes || compactAfterDays ? setInterval(() => { sweep().catch(() => {}); }, pruneIntervalMs) : undefined;
    sweeper?.unref();
    // Carry in-memory presence to disk when no other write has done so recently.
    const presenceFlusher = setInterval(() => {
      if (!presenceDirty || closing || faulted) return;
      presenceRequested = true; scheduleFlush();
    }, presenceFlushMs);
    presenceFlusher.unref();
    let closePromise;
    const close = () => closePromise ??= (async () => {
      closing = true;
      if (sweeper) clearInterval(sweeper);
      clearInterval(presenceFlusher);
      for (const waiter of [...waiters]) {
        try {
          const current = durable.rooms.find(r => r.project === waiter.project);
          waiter.finish({ messages: [], cursor: current?.cursor ?? waiter.after ?? 0 });
        } catch {
          try {
            waiter.finish({ messages: [], cursor: waiter.after ?? 0 });
          } catch {}
        }
      }
      await writer;
      await drain().catch(() => {});
      await new Promise(resolve => server.close(resolve));
      await releaseLease();
      activeStores.delete(directory);
    })();
    return { url: `http://127.0.0.1:${server.address().port}`, token, close };
  } catch (error) {
    server?.close();
    await releaseLease?.();
    activeStores.delete(directory);
    throw error;
  }
}
