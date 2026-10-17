import { execFile } from 'node:child_process';
import { snapshot } from './ledger.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gitCommonDir } from './gitworktree.mjs';
import { liveness } from './registry.mjs';
import { derivedStatuses, kindOf, reportedStatus } from './workitems.mjs';

// Branch ownership: git helpers, branch-claim validation and the read-only ownership view.
// Git is advisory input. Every helper returns null (never throws) when git cannot answer.
export const BRANCH_LIST_LIMIT = 500;
export const OWNERSHIP_LIMIT = 300;
export const BRANCH_NAME_BYTES = 256;
const ARTIFACTS_PER_BRANCH = 25;

function git(args, cwd, { timeout = 5000, maxBuffer = 4 * 1024 * 1024, exec = execFile } = {}) {
  return new Promise(resolve => {
    try {
      exec('git', args, { cwd, timeout, maxBuffer, windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout)));
    } catch { resolve(null); }
  });
}
async function canonical(value) {
  try { return await fs.realpath(value); } catch { return path.normalize(value); }
}
const stripHeads = ref => ref.startsWith('refs/heads/') ? ref.slice(11) : ref;
const iso = value => { const ms = Date.parse(value); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };

/** {branch|null (detached), head|null (unborn), worktree, commonDir} or null when dir is not inside a git checkout. */
export async function gitContext(dir, options) {
  try {
    if (typeof dir !== 'string' || !dir) return null;
    const [top, symbolic, head, commonDir] = await Promise.all([
      git(['rev-parse', '--show-toplevel'], dir, options), git(['symbolic-ref', '-q', 'HEAD'], dir, options),
      git(['rev-parse', '--verify', '-q', 'HEAD'], dir, options), gitCommonDir(dir, options)]);
    if (top === null || !top.trim() || commonDir === null) return null;
    const branch = symbolic === null || !symbolic.trim() ? null : stripHeads(symbolic.trim());
    return { branch, head: head === null || !head.trim() ? null : head.trim(), worktree: await canonical(top.trim()), commonDir };
  } catch { return null; }
}

/** `git worktree list --porcelain` for the repo owning commonDirOrDir -> [{path, head, branch|null, detached, bare, prunable}] or null. */
export async function listWorktrees(commonDirOrDir, options) {
  try {
    if (typeof commonDirOrDir !== 'string' || !commonDirOrDir) return null;
    const cwd = path.basename(commonDirOrDir) === '.git' ? path.dirname(commonDirOrDir) : commonDirOrDir;
    const out = await git(['worktree', 'list', '--porcelain'], cwd, options);
    if (out === null) return null;
    const rows = [];
    for (const block of out.split(/\r?\n\r?\n/u)) {
      const lines = block.split(/\r?\n/u).filter(Boolean);
      if (!lines.length || !lines[0].startsWith('worktree ')) continue;
      const row = { path: lines[0].slice(9), head: null, branch: null, detached: false, bare: false, prunable: false };
      for (const line of lines.slice(1)) {
        if (line.startsWith('HEAD ')) row.head = line.slice(5).trim() || null;
        else if (line.startsWith('branch ')) row.branch = stripHeads(line.slice(7).trim());
        else if (line === 'detached') row.detached = true;
        else if (line === 'bare') row.bare = true;
        else if (line === 'prunable' || line.startsWith('prunable ')) row.prunable = true;
      }
      if (/^0+$/u.test(row.head ?? '')) row.head = null;
      row.path = row.prunable ? path.normalize(row.path) : await canonical(row.path);
      rows.push(row);
    }
    return rows;
  } catch { return null; }
}

/** Local branches, newest commit first, bounded to 500 -> [{name, head, upstream|null, committedAt|null}] or null. */
export async function listBranches(dir, options) {
  try {
    if (typeof dir !== 'string' || !dir) return null;
    const cwd = path.basename(dir) === '.git' ? path.dirname(dir) : dir;
    const out = await git(['for-each-ref', 'refs/heads', '--sort=-committerdate', `--count=${BRANCH_LIST_LIMIT}`,
      '--format=%(refname)%09%(objectname)%09%(upstream:short)%09%(committerdate:iso-strict)'], cwd, options);
    if (out === null) return null;
    return out.split(/\r?\n/u).filter(Boolean).map(line => {
      const [ref, head, upstream, date] = line.split('\t');
      return { name: stripHeads(ref), head: head || null, upstream: upstream || null, committedAt: iso(date) };
    }).slice(0, BRANCH_LIST_LIMIT);
  } catch { return null; }
}

const control = /[\u0000-\u001f]/u;
function validText(value, limit = 4096) { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= limit; }
export function validBranchName(value) {
  return validText(value, BRANCH_NAME_BYTES) && !control.test(value) && value === value.trim();
}
/** Validator for the optional agent.git report stored by the status op. */
export function validAgentGit(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['branch', 'head', 'worktree', 'ts'].includes(key))
    && (value.branch === undefined || value.branch === null || validBranchName(value.branch))
    && (value.head === undefined || (validText(value.head, 128) && !control.test(value.head)))
    && (value.worktree === undefined || (validText(value.worktree) && !control.test(value.worktree)))
    && validText(value.ts);
}
/** Validator for state.branchClaims; true when every claim is well formed, unique per repo+branch and held by a stored agent. */
export function validBranchClaims(state, validClaimMeta, limit) {
  const claims = state.branchClaims;
  if (!Array.isArray(claims) || claims.length > limit) return false;
  const keys = new Set();
  for (const claim of claims) {
    if (!claim || typeof claim !== 'object' || !validText(claim.repo) || control.test(claim.repo) || !validBranchName(claim.branch)) return false;
    const room = state.rooms.find(r => r.project === claim.project);
    const has = id => typeof id === 'string' && room?.agents.some(a => a.agentId === id);
    if (!has(claim.agentId) || !validText(claim.claimedAt) || !validClaimMeta(claim.meta)
        || (claim.note !== undefined && (!validText(claim.note, 1024) || control.test(claim.note)))
        || (claim.transferredFrom !== undefined && !has(claim.transferredFrom))
        || (claim.transferredAt !== undefined && !validText(claim.transferredAt))) return false;
    const key = `${claim.repo}\0${claim.branch}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

// Liveness is registry.mjs's definition; only the window differs (the ownership stale threshold).
const livenessOf = (agent, staleMinutes, now) => liveness(agent, { now, withinMinutes: staleMinutes });
/** A stored branch claim with holder liveness: holder is active|stale|left|retired|missing. */
export function branchClaimView(state, claim, staleMinutes = 30, now = Date.now()) {
  const agent = state.rooms.find(r => r.project === claim.project)?.agents.find(a => a.agentId === claim.agentId);
  const { holder, live, lastSeenAgeMs } = livenessOf(agent, staleMinutes, now);
  return { ...snapshot(claim), ageMs: Math.max(0, now - Date.parse(claim.claimedAt)), lastSeenAgeMs, holder, live, stale: !live };
}

function within(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
const samePath = (a, b) => path.relative(a, b) === '';

/** Rooms of the repo identified by commonDir: the asking room, group members with that commonDir, and rooms whose git common dir matches (probed once per room). */
export async function repoRooms(state, project, commonDir, { resolve = gitCommonDir } = {}) {
  const cache = new Map();
  const probe = async room => {
    if (!cache.has(room.project)) cache.set(room.project, await resolve(room.project));
    return cache.get(room.project);
  };
  const rooms = state.rooms.filter(room => room.project === project);
  if (commonDir === null) return rooms;
  const rest = state.rooms.filter(room => room.project !== project);
  const unknown = [];
  for (const room of rest) {
    const recorded = room.group?.commonDir ?? null;
    if (recorded === commonDir) rooms.push(room);
    else if (recorded === null) unknown.push(room);
  }
  for (let i = 0; i < unknown.length; i += 8) {
    const batch = unknown.slice(i, i + 8);
    const found = await Promise.all(batch.map(probe));
    batch.forEach((room, index) => { if (found[index] === commonDir) rooms.push(room); });
  }
  return rooms.sort((a, b) => a.project.localeCompare(b.project));
}

const branchRef = value => typeof value === 'string' && value.trim() ? stripHeads(value.trim()).slice(0, BRANCH_NAME_BYTES) : null;
function taskArtifacts(task) {
  const value = task.artifacts;
  const rows = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return rows.filter(item => typeof item === 'string' && item.length > 0).map(item => item.slice(0, 4096));
}

/**
 * Pure ownership view. `gathered` carries what git said: {repo, git, rooms, worktrees, branches}; worktrees/branches are
 * null when the project is not in a git repository (claims then have no branch to match and fall to unassigned).
 */
export function buildOwnership(state, gathered, { staleMinutes = 30, now = Date.now() } = {}) {
  const { repo, rooms, worktrees = null, branches = null } = gathered;
  const checkouts = (worktrees ?? []).filter(w => !w.bare && !w.prunable);
  const claims = (state.branchClaims ?? []).filter(claim => claim.repo === repo);
  const wtFor = room => {
    let best = null;
    for (const w of checkouts) if (within(w.path, room.project) && (!best || w.path.length > best.path.length)) best = w;
    return best;
  };
  const roomWt = new Map(rooms.map(room => [room.project, wtFor(room)]));
  const wtProject = w => {
    const mapped = rooms.filter(room => roomWt.get(room.project) === w);
    return (mapped.find(room => samePath(room.project, w.path)) ?? mapped[0])?.project ?? null;
  };
  const byBranch = new Map();
  const slot = name => {
    if (!byBranch.has(name)) byBranch.set(name, { name, head: null, upstream: null, committedAt: null, exists: false, worktrees: [], claim: null, agents: [], tasks: [], artifacts: [], flags: [] });
    return byBranch.get(name);
  };
  for (const branch of branches ?? []) Object.assign(slot(branch.name), { head: branch.head, upstream: branch.upstream, committedAt: branch.committedAt, exists: true });
  for (const w of checkouts) if (w.branch !== null) slot(w.branch).worktrees.push({ path: w.path, project: wtProject(w) });
  const detached = checkouts.filter(w => w.detached || w.branch === null).map(w => ({ path: w.path, head: w.head, project: wtProject(w), agents: [] }));
  // Live data wins: an agent reporting from its own room's checkout is placed by what that checkout has now.
  for (const room of rooms) {
    const wt = roomWt.get(room.project);
    for (const agent of room.agents) {
      if (agent.left) continue;
      const live = livenessOf(agent, staleMinutes, now).live;
      const reported = agent.git?.branch ?? null;
      const inRoom = typeof agent.git?.worktree === 'string' && wt && samePath(agent.git.worktree, wt.path);
      const derived = wt?.branch ?? null;
      const name = inRoom ? derived : reported !== null && reported !== derived ? reported : derived;
      const row = { agentId: agent.agentId, project: room.project, live, source: name !== null && name === derived ? 'worktree' : 'reported' };
      if (name !== null) slot(name).agents.push(row);
      else if (wt && wt.branch === null) detached.find(d => d.path === wt.path)?.agents.push(row);
    }
  }
  const claimRows = [];
  for (const claim of claims) {
    const view = branchClaimView(state, claim, staleMinutes, now);
    const target = slot(claim.branch);
    target.claim = { agentId: claim.agentId, project: claim.project, claimedAt: claim.claimedAt, note: claim.note ?? null,
      live: view.live, stale: view.stale, holder: view.holder };
    if (branches === null || !target.exists) claimRows.push({ branch: claim.branch, agentId: claim.agentId, project: claim.project,
      claimedAt: claim.claimedAt, note: claim.note ?? null, live: view.live, stale: view.stale, holder: view.holder,
      reason: branches === null ? 'no-git' : 'missing' });
  }
  // Tasks reference a branch by task.branch or a branch:<name> resource; both are read defensively.
  for (const room of rooms) {
    const derived = derivedStatuses(room.tasks ?? []);
    for (const task of room.tasks ?? []) {
      const names = new Set([branchRef(task.branch)].filter(Boolean));
      for (const resource of Array.isArray(task.resources) ? task.resources : [])
        if (typeof resource === 'string' && resource.startsWith('branch:')) { const name = branchRef(resource.slice(7)); if (name) names.add(name); }
      for (const name of names) {
        const target = slot(name);
        target.tasks.push({ id: task.id, title: task.title, kind: kindOf(task), status: reportedStatus(task, derived), state: task.state,
          owner: task.owner ?? null, project: room.project });
        for (const artifact of taskArtifacts(task)) if (!target.artifacts.includes(artifact) && target.artifacts.length < ARTIFACTS_PER_BRANCH) target.artifacts.push(artifact);
      }
    }
  }
  for (const entry of byBranch.values()) {
    const live = entry.agents.filter(agent => agent.live);
    const { claim } = entry;
    if (claim && claim.stale) entry.flags.push('orphaned');
    if (claim && live.length && !live.some(agent => agent.agentId === claim.agentId && agent.project === claim.project)) entry.flags.push('contested');
    if (!claim && live.length) entry.flags.push('unclaimed');
    if (claim && branches !== null && !entry.exists) entry.flags.push('missing');
  }
  const ordered = [...byBranch.values()].sort((a, b) => (b.flags.length > 0) - (a.flags.length > 0)
    || (b.claim !== null) - (a.claim !== null) || (b.committedAt ?? '').localeCompare(a.committedAt ?? '') || a.name.localeCompare(b.name));
  return {
    repo, git: worktrees !== null, rooms: rooms.map(room => room.project),
    branches: ordered.slice(0, OWNERSHIP_LIMIT).map(({ exists, ...entry }) => entry),
    totalBranches: ordered.length, truncated: ordered.length > OWNERSHIP_LIMIT,
    unassigned: { claims: claimRows, worktrees: detached },
    generatedAt: new Date(now).toISOString()
  };
}

/** Gathers git facts outside the broker's writer turn, then builds the view from the freshest state. */
export async function ownershipView({ state, project, staleMinutes = 30, now = Date.now(), resolve = gitCommonDir }) {
  const commonDir = await resolve(project);
  const rooms = await repoRooms(state(), project, commonDir, { resolve });
  const [worktrees, branches] = commonDir === null ? [null, null]
    : await Promise.all([listWorktrees(commonDir), listBranches(commonDir)]);
  const snapshot = state();
  const live = new Set(snapshot.rooms.map(room => room.project));
  const roomRows = rooms.filter(room => live.has(room.project)).map(room => snapshot.rooms.find(r => r.project === room.project));
  return buildOwnership(snapshot, { repo: commonDir ?? project, rooms: roomRows, worktrees, branches: worktrees === null ? null : branches },
    { staleMinutes, now });
}
