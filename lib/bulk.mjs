// Bulk cleanup for the local operator: stale identities, stale claims and the audit trail.
//
// The obligation set is registry.mjs's `obligationIndex`, so prune, the sweep and these commands
// agree on what an obligation is. Nothing here writes `state.json`: the broker owns the writes,
// the error mapping and the audit file. Every function is pure over broker state.
//
// Safety rules that hold everywhere below:
//   - a live identity is never touched (it is reported as skipped-live instead);
//   - an identity that still holds an obligation is never stranded (it is reported as kept);
//   - a claim held by a live owner is never released;
//   - every applied bulk action is written to a bounded audit log, never with a token in it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hasObligations, liveness, obligationIndex,
  DEFAULT_LIVE_WINDOW_MINUTES, DEFAULT_TRANSPORT_STALE_MINUTES } from './registry.mjs';

export const DEFAULT_BULK_IDLE_HOURS = 24;
export const BULK_LIST_LIMIT = 200;
export const MAX_ROOM_NOTICES = 100;
export const MAX_AUDIT_BYTES = 1024 * 1024;
export const AUDIT_FILE_NAME = 'bulk-audit.log';
export const RELEASE_LOG_LIMIT = 10000;
const HOUR_MS = 3600000;

/** Milliseconds since a stored timestamp, or null when it cannot be read. */
function ageMs(value, now) {
  const at = Date.parse(value ?? '');
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

const finiteOrNull = value => (Number.isFinite(value) ? value : null);

/** The one liveness definition, applied to the owner of a claim. */
function ownerState(agent, { now, staleMinutes, transportStaleMinutes }) {
  const view = liveness(agent, { now, withinMinutes: staleMinutes, transportStaleMinutes });
  return { holder: view.holder, live: view.live, lastSeenAgeMs: finiteOrNull(view.lastSeenAgeMs) };
}
/**
 * Plan a bulk leave/retire for one room. Never mutates.
 *
 * Scope: `prefix` (agent id prefix) and `runner` narrow the population. `idleHours` is the
 * wall-clock idleness floor. A live identity is never a candidate; an identity that holds an
 * obligation is kept. `mode` is 'leave' (mark dormant) or 'retire' (mark dormant and finished).
 */
export function planBulkCleanup(state, room, { mode = 'leave', idleHours = DEFAULT_BULK_IDLE_HOURS,
  prefix, runner, now = Date.now(), withinMinutes = DEFAULT_LIVE_WINDOW_MINUTES,
  transportStaleMinutes = DEFAULT_TRANSPORT_STALE_MINUTES } = {}) {
  const index = obligationIndex(state, room);
  const thresholdMs = Math.max(0, Number.isFinite(idleHours) ? idleHours : 0) * HOUR_MS;
  const candidates = [];
  const kept = [];
  const skippedLive = [];
  for (const agent of room?.agents ?? []) {
    if (prefix !== undefined && !String(agent.agentId).startsWith(prefix)) continue;
    if (runner !== undefined && agent.runner !== runner) continue;
    const view = liveness(agent, { now, withinMinutes, transportStaleMinutes });
    if (view.live) { skippedLive.push(agent.agentId); continue; }
    const lastSeenAgeMs = ageMs(agent.updatedAt, now) ?? 0;
    if (lastSeenAgeMs < thresholdMs) continue;
    if (agent.retired === true) continue;                   // already finished
    if (mode === 'leave' && agent.left === true) continue;  // already dormant
    const owed = index.get(agent.agentId);
    if (hasObligations(owed)) { kept.push({ agentId: agent.agentId, obligations: owed }); continue; }
    candidates.push({ agentId: agent.agentId, runner: agent.runner, lastSeenAgeMs });
  }
  return { candidates, kept, skippedLive };
}

/** The bulk report. `changed` is 0 on a dry run; every list is bounded, `total` carries the counts. */
export function bulkReport(plan, { dryRun, mode, scope, changed = 0 } = {}) {
  const bound = list => list.slice(0, BULK_LIST_LIMIT);
  return {
    dryRun,
    mode,
    candidates: bound(plan.candidates),
    kept: bound(plan.kept),
    skippedLive: bound(plan.skippedLive),
    changed,
    total: { candidates: plan.candidates.length, kept: plan.kept.length, skippedLive: plan.skippedLive.length },
    ...(scope ? { scope } : {})
  };
}

/** Apply a plan to a room (a draft is fine). Returns the number of identities changed. */
export function applyBulkCleanup(room, plan, { mode = 'leave', now = Date.now() } = {}) {
  const ids = new Set(plan.candidates.map(row => row.agentId));
  const at = new Date(now).toISOString();
  let changed = 0;
  for (const agent of room?.agents ?? []) {
    if (!ids.has(agent.agentId)) continue;
    agent.left = true;
    if (mode === 'retire') agent.retired = true;
    agent.updatedAt = at;
    changed++;
  }
  return changed;
}

/**
 * Every claim in the room whose owner is no longer live (left, retired, or idle past the
 * window), with the claim age and the owner's state.
 */
export function staleClaimList(state, room, { now = Date.now(), staleMinutes = 30,
  transportStaleMinutes = DEFAULT_TRANSPORT_STALE_MINUTES } = {}) {
  if (!room) return [];
  const rows = [];
  const push = (claim, agent, scope, resource) => {
    const view = ownerState(agent, { now, staleMinutes, transportStaleMinutes });
    if (view.live) return;
    rows.push({ resource, agentId: claim.agentId, scope,
      ageMs: ageMs(claim.claimedAt, now) ?? 0,
      lastSeenAgeMs: view.lastSeenAgeMs, holder: view.holder });
  };
  for (const claim of room?.claims ?? []) {
    push(claim, room?.agents?.find(agent => agent.agentId === claim.agentId), 'project', claim.resource);
  }
  for (const claim of state?.machineClaims ?? []) {
    if (room && claim.project !== room.project) continue;
    push(claim, room?.agents?.find(agent => agent.agentId === claim.agentId), 'machine', claim.resource);
  }
  for (const claim of state?.branchClaims ?? []) {
    if (room && claim.project !== room.project) continue;
    const ownerRoom = state?.rooms?.find(candidate => candidate.project === claim.project);
    push(claim, ownerRoom?.agents?.find(agent => agent.agentId === claim.agentId), 'branch', claim.branch);
  }
  return rows;
}

/**
 * Plan an opt-in release of stale claims. Only owners that are dormant (left) or retired
 * qualify; a claim held by a live or merely idle owner is never released.
 */
export function planStaleClaimRelease(state, room, { now = Date.now(), hours = 0,
  transportStaleMinutes = DEFAULT_TRANSPORT_STALE_MINUTES } = {}) {
  const plan = { project: [], machine: [], branch: [] };
  if (!room) return { ...plan, total: 0 };
  const windowMs = Math.max(0, Number.isFinite(hours) ? hours : 0) * HOUR_MS;
  const dormant = agent => {
    if (!agent) return false;
    const { holder } = liveness(agent, { now, withinMinutes: 0, transportStaleMinutes });
    return holder === 'left' || holder === 'retired';
  };
  const old = claim => (ageMs(claim.claimedAt, now) ?? 0) >= windowMs;
  for (const claim of room?.claims ?? []) {
    const agent = room?.agents?.find(candidate => candidate.agentId === claim.agentId);
    if (dormant(agent) && old(claim)) plan.project.push({ resource: claim.resource, agentId: claim.agentId });
  }
  for (const claim of state?.machineClaims ?? []) {
    if (room && claim.project !== room.project) continue;
    const agent = room?.agents?.find(candidate => candidate.agentId === claim.agentId);
    if (dormant(agent) && old(claim)) plan.machine.push({ resource: claim.resource, agentId: claim.agentId });
  }
  for (const claim of state?.branchClaims ?? []) {
    if (room && claim.project !== room.project) continue;
    const ownerRoom = state?.rooms?.find(candidate => candidate.project === claim.project);
    const agent = ownerRoom?.agents?.find(candidate => candidate.agentId === claim.agentId);
    if (dormant(agent) && old(claim)) plan.branch.push({ resource: claim.branch, agentId: claim.agentId });
  }
  plan.total = plan.project.length + plan.machine.length + plan.branch.length;
  return plan;
}

/**
 * Apply a release plan to a draft state and room: drop the claims, write one release-log entry
 * per scope and leave a notice in the room so the participants learn about it.
 */
export function applyStaleClaimRelease(state, room, plan, { now = Date.now(), as = 'daemon',
  reason = 'stale-owner' } = {}) {
  const at = new Date(now).toISOString();
  const released = [];
  if (plan.project.length) {
    const gone = new Set(plan.project.map(row => row.resource));
    room.claims = room.claims.filter(claim => !gone.has(claim.resource));
    released.push(...plan.project.map(row => ({ ...row, scope: 'project' })));
  }
  if (plan.machine.length) {
    const gone = new Set(plan.machine.map(row => row.resource));
    state.machineClaims = (state.machineClaims ?? []).filter(claim =>
      !(claim.project === room.project && gone.has(claim.resource)));
    released.push(...plan.machine.map(row => ({ ...row, scope: 'machine' })));
  }
  if (plan.branch.length) {
    const gone = new Set(plan.branch.map(row => row.resource));
    state.branchClaims = (state.branchClaims ?? []).filter(claim =>
      !(claim.project === room.project && gone.has(claim.branch)));
    released.push(...plan.branch.map(row => ({ ...row, scope: 'branch' })));
  }
  if (released.length) {
    for (const scope of ['project', 'machine', 'branch']) {
      const rows = released.filter(row => row.scope === scope);
      if (!rows.length) continue;
      (state.releaseLog ??= []).push({ as, at, project: room.project, scope, reason,
        released: rows.map(row => row.resource) });
    }
    const notice = { id: randomUUID(), at, kind: 'stale-claim-released', reason,
      agentIds: [...new Set(released.map(row => row.agentId))],
      resources: released.map(row => row.resource),
      text: `Released ${released.length} stale claim(s) held by a dormant or retired owner: `
        + released.map(row => `${row.resource} (${row.scope}, ${row.agentId})`).join(', ') };
    if (!Array.isArray(room.notices)) room.notices = [];
    room.notices.push(notice);
    if (room.notices.length > MAX_ROOM_NOTICES) room.notices.splice(0, room.notices.length - MAX_ROOM_NOTICES);
  }
  return { released, notice: released.length ? { ...room.notices.at(-1) } : null };
}

const SECRET_KEY = /^(token|secret|password|authorization|bearer|apikey|api_key|credential)$/i;
const MAX_AUDIT_STRING = 512;

/** Never let a token, a secret or an unbounded string reach the audit log. */
export function scrubAuditValue(value, key = '') {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => scrubAuditValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrubAuditValue(item, name)]));
  }
  if (typeof value === 'string') return value.length > MAX_AUDIT_STRING ? value.slice(0, MAX_AUDIT_STRING) : value;
  return value;
}

/**
 * The operator's bulk-action audit log: one JSON object per line in the data directory, bounded
 * and rotated. The gateway's `remote-audit.log` is for cloud agents; this one is for the local
 * operator's bulk actions, and it never holds a token.
 */
export class BulkAuditLog {
  constructor(dataDir, { now = Date.now, fileName = AUDIT_FILE_NAME } = {}) {
    this.file = path.join(dataDir, fileName);
    this.now = now;
  }
  async write(entry) {
    const line = JSON.stringify({ at: new Date(this.now()).toISOString(), ...scrubAuditValue(entry) }) + '\n';
    // Keep the trail bounded: one rotated file beside it, then the newest wins.
    try {
      const info = await fs.stat(this.file);
      if (info.size > MAX_AUDIT_BYTES) {
        await fs.rm(`${this.file}.1`, { force: true }).catch(() => {});
        await fs.rename(this.file, `${this.file}.1`);
      }
    } catch { /* no file yet */ }
    await fs.appendFile(this.file, line, { mode: 0o600 });
  }
  static async read(dataDir, limit = 200) {
    try {
      const text = await fs.readFile(path.join(dataDir, AUDIT_FILE_NAME), 'utf8');
      return text.split('\n').filter(Boolean).slice(-limit)
        .map(line => { try { return JSON.parse(line); } catch { return { raw: line }; } });
    } catch { return []; }
  }
}
