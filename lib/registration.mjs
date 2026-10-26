// One identity rule for the adapters and for the broker that stores it.
//
// A process takes its identity from the runner session it belongs to: one identity per
// runner session id. A second process with the same session id therefore attaches to the
// same identity instead of creating another one, and the identity a process uses never
// changes when its registration is deferred.
//
// A process without a stable runner session keeps a temporary identity. That identity is
// remembered in the data dir per parent process tree, so a restart inside the same session
// reuses it instead of leaving another identity behind.
//
// The module also owns the two broadcast guards: a probe that just registered never
// receives a '*' broadcast, and '*all' is rate limited per sender and recovers on its own.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BROADCAST_ALL, BROADCAST_LIVE, looksEphemeral } from './registry.mjs';

export const FALLBACK_SESSION_PREFIX = 'tmp-';
// A probe has one minute to prove it is there.
export const PROBE_WINDOW_MS = 60_000;
// '*all' is a deliberate, expensive operation: five an hour per sender.
export const BROADCAST_ALL_LIMIT = 5;
export const BROADCAST_ALL_WINDOW_MS = 60 * 60 * 1000;

// The identity namespace of every runner. The separator belongs to the identity:
// `claude-<session>` and `opencode:<session>` are the shapes the adapters already publish,
// so stored rooms, inboxes and plugin state keep resolving.
const RUNNER_NAMESPACES = new Map([
  ['claude', { namespace: 'claude', separator: '-' }],
  ['codex', { namespace: 'codex', separator: '-' }],
  ['opencode', { namespace: 'opencode', separator: ':' }],
]);

/** The identity of one runner session: the rule every adapter and the broker share. */
export function sessionIdentity(runner, sessionId) {
  const spec = RUNNER_NAMESPACES.get(runner) ?? { namespace: String(runner ?? 'agent'), separator: '-' };
  return `${spec.namespace}${spec.separator}${sessionId}`;
}

/** The process tree a temporary identity belongs to: the process that started this one. */
export function processTreeKey(pid = process.pid, parentPid = process.ppid) {
  return String(parentPid || pid);
}

/** Where the temporary identities of one process tree are remembered. */
export function fallbackIdentityFile(dataDir, treeKey = processTreeKey()) {
  return path.join(dataDir, 'sessions', `tree-${treeKey}.json`);
}

const fallbackCache = new Map();

function readFallbackStore(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

/** Drop the remembered identities of process trees that are gone; a stale file is noise. */
function pruneFallbackFiles(folder, keep) {
  let entries;
  try { entries = fs.readdirSync(folder); } catch { return; }
  for (const entry of entries) {
    if (entry === keep) continue;
    const match = /^tree-(\d+)\.json$/.exec(entry);
    if (!match || processAlive(Number(match[1]))) continue;
    try { fs.rmSync(path.join(folder, entry), { force: true }); } catch { /* best effort */ }
  }
}

/**
 * The temporary session id of one runner inside one process tree. The id is written to the
 * data dir, so a restart inside the same session reuses it instead of leaving a new
 * identity behind.
 */
export function fallbackSession({ runner, dataDir, treeKey = processTreeKey() } = {}) {
  const key = `${dataDir ?? ''}\u0000${treeKey}\u0000${runner}`;
  const cached = fallbackCache.get(key);
  if (cached) return { sessionId: cached, reused: true };
  if (!dataDir) {
    const sessionId = `${FALLBACK_SESSION_PREFIX}${randomUUID()}`;
    fallbackCache.set(key, sessionId);
    return { sessionId, reused: false };
  }
  const file = fallbackIdentityFile(dataDir, treeKey);
  const store = readFallbackStore(file);
  const known = store[runner];
  if (known && typeof known.sessionId === 'string' && known.sessionId.startsWith(FALLBACK_SESSION_PREFIX)) {
    fallbackCache.set(key, known.sessionId);
    return { sessionId: known.sessionId, reused: true };
  }
  const sessionId = `${FALLBACK_SESSION_PREFIX}${randomUUID()}`;
  store[runner] = { sessionId, at: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
    pruneFallbackFiles(path.dirname(file), path.basename(file));
  } catch { /* An unwritable data dir never blocks the relay: the id stays in this process. */ }
  fallbackCache.set(key, sessionId);
  return { sessionId, reused: false };
}

/**
 * The identity rule: one identity per runner session id.
 * resolveIdentity({ runner, sessionId, agentId, dataDir, treeKey })
 *   -> { agentId, sessionId, ephemeral, fallback, reused }
 * A pinned agent id always wins; otherwise the identity is the session's identity.
 */
export function resolveIdentity({ runner, sessionId, agentId, dataDir, treeKey = processTreeKey() } = {}) {
  if (sessionId !== undefined && sessionId !== null && sessionId !== '') {
    return { agentId: agentId ?? sessionIdentity(runner, sessionId), sessionId,
      ephemeral: false, fallback: false, reused: false };
  }
  const temporary = fallbackSession({ runner, dataDir, treeKey });
  return { agentId: agentId ?? sessionIdentity(runner, temporary.sessionId), sessionId: temporary.sessionId,
    ephemeral: true, fallback: true, reused: temporary.reused };
}

/** True when the agent row carries a transport report: the identity has proved it is there. */
export function hasTransportReport(agent) {
  return Boolean(agent?.transport && typeof agent.transport.ts === 'string' && agent.transport.ts);
}

/**
 * A temporary identity: one an adapter kept because it had no stable runner session.
 * A named identity the owner joined on purpose is not a probe.
 */
export function isTemporaryIdentity(agent) {
  if (typeof agent?.sessionId === 'string' && agent.sessionId.startsWith(FALLBACK_SESSION_PREFIX)) return true;
  // Legacy rows stored the temporary id without its session.
  return looksEphemeral(agent) && agent.ephemeral !== true;
}

/**
 * A probe: a temporary identity that registered moments ago and never reported a transport.
 * It has not proved it is there, so a '*' broadcast must not reach it.
 */
export function isFreshProbe(agent, { now = Date.now(), windowMs = PROBE_WINDOW_MS } = {}) {
  if (!agent || agent.left || agent.retired) return false;
  if (!isTemporaryIdentity(agent)) return false;
  const registeredAt = Date.parse(agent.registeredAt ?? '');
  if (!Number.isFinite(registeredAt)) return false;
  return Math.max(0, now - registeredAt) <= windowMs && !hasTransportReport(agent);
}

/** The probe identities a '*' broadcast must skip. Other audiences are untouched. */
export function probeBroadcastGuard(room, to, { now = Date.now(), windowMs = PROBE_WINDOW_MS } = {}) {
  if (to !== BROADCAST_LIVE) return [];
  return (room?.agents ?? []).filter(agent => isFreshProbe(agent, { now, windowMs })).map(agent => agent.agentId);
}

/** The stable text of the '*all' limit. The CLI and the tools show it verbatim. */
export function broadcastAllLimitMessage(limit = BROADCAST_ALL_LIMIT) {
  return `'*all' broadcast limit reached (${limit} per hour per sender). `
    + 'Use a bulletin for standing rules, or address the agents you mean directly.';
}

/** How many '*all' broadcasts one sender used inside the window, and when the budget returns. */
export function broadcastAllUsage(messages, from, { now = Date.now(), windowMs = BROADCAST_ALL_WINDOW_MS } = {}) {
  let used = 0, oldest = null;
  for (const message of messages ?? []) {
    if (message?.to !== BROADCAST_ALL || message?.from !== from) continue;
    const at = Date.parse(message.createdAt ?? '');
    if (!Number.isFinite(at)) continue;
    const age = now - at;
    if (age < 0 || age >= windowMs) continue;
    used += 1;
    if (oldest === null || at < oldest) oldest = at;
  }
  return { used, oldest, retryAfterMs: oldest === null ? 0 : Math.max(0, windowMs - (now - oldest)) };
}
