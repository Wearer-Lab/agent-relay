// Registry hygiene: liveness, live-broadcast audiences, dormant identities and pruning.
// Pure functions over broker state; the broker owns all writes and error mapping.

export const DEFAULT_LIVE_WINDOW_MINUTES = 120;
export const DEFAULT_PRUNE_IDLE_MINUTES = 1440;
export const DEFAULT_EPHEMERAL_IDLE_MINUTES = 15;
export const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
export const PRUNE_CANDIDATE_LIMIT = 200;
export const BROADCAST_LIVE = '*';
export const BROADCAST_ALL = '*all';

export const isBroadcast = to => to === BROADCAST_LIVE || to === BROADCAST_ALL;
export const isRetired = agent => agent?.retired === true;
// Dormant identities left (or were pruned) but may re-register; their inbox stays durable.
export const isDormant = agent => agent?.left === true && agent.retired !== true;

/** Live: not left, and either a connected transport or seen within the window. */
export function isLive(agent, { now = Date.now(), withinMinutes = DEFAULT_LIVE_WINDOW_MINUTES } = {}) {
  if (!agent || agent.left) return false;
  if (agent.transport?.state === 'connected') return true;
  const seen = Date.parse(agent.updatedAt);
  return Number.isFinite(seen) && now - seen <= withinMinutes * 60000;
}

/** Broadcast audience: '*' reaches live agents seen within the window, '*all' every non-left agent. */
export function broadcastAudience(room, from, to, { within = DEFAULT_LIVE_WINDOW_MINUTES, now = Date.now() } = {}) {
  const candidates = (room?.agents ?? []).filter(agent => !agent.left && agent.agentId !== from);
  if (to === BROADCAST_ALL) {
    return { recipients: candidates.map(agent => agent.agentId), audience: { mode: 'all', within: null, excluded: 0 } };
  }
  const live = candidates.filter(agent => isLive(agent, { now, withinMinutes: within }));
  return { recipients: live.map(agent => agent.agentId),
    audience: { mode: 'live', within, excluded: candidates.length - live.length } };
}

/** Everything that would be stranded if this identity went away, indexed per agent for one pass. */
export function obligationIndex(state, room) {
  const index = new Map();
  const row = id => {
    let value = index.get(id);
    if (!value) index.set(id, value = { claims: [], machineClaims: [], handoffs: [], processes: [], tasks: [] });
    return value;
  };
  for (const claim of room?.claims ?? []) row(claim.agentId).claims.push(claim.resource);
  for (const claim of state?.machineClaims ?? []) {
    if (claim.project === room?.project) row(claim.agentId).machineClaims.push(claim.resource);
  }
  for (const handoff of room?.handoffs ?? []) {
    if (handoff.state !== 'pending') continue;
    row(handoff.from).handoffs.push(handoff.id);
    if (handoff.to != null && handoff.to !== handoff.from) row(handoff.to).handoffs.push(handoff.id);
  }
  for (const process of room?.processes ?? []) row(process.agentId).processes.push(process.id);
  for (const task of room?.tasks ?? []) {
    if (task.state === 'open' && task.owner != null) row(task.owner).tasks.push(task.id);
  }
  return index;
}
export const hasObligations = value => value !== undefined
  && (value.claims.length > 0 || value.machineClaims.length > 0 || value.handoffs.length > 0
    || value.processes.length > 0 || value.tasks.length > 0);
export const emptyObligations = () => ({ claims: [], machineClaims: [], handoffs: [], processes: [], tasks: [] });

/** Plan (never apply) a prune of one room. Candidates are non-left, non-retired, idle, disconnected and obligation-free. */
export function planPrune(state, room, { idleMinutes = DEFAULT_PRUNE_IDLE_MINUTES,
  ephemeralIdleMinutes = DEFAULT_EPHEMERAL_IDLE_MINUTES, includeTest = false, now = Date.now() } = {}) {
  const index = obligationIndex(state, room);
  const candidates = [];
  const kept = { withObligations: 0, live: 0 };
  let skippedTest = 0;
  for (const agent of room?.agents ?? []) {
    if (agent.left || agent.retired) continue;
    if (agent.test === true && !includeTest) { skippedTest++; continue; }
    const threshold = agent.ephemeral === true && ephemeralIdleMinutes > 0
      ? Math.min(idleMinutes, ephemeralIdleMinutes) : idleMinutes;
    const idle = now - Date.parse(agent.updatedAt);
    if (agent.transport?.state === 'connected' || !(idle >= threshold * 60000)) { kept.live++; continue; }
    if (hasObligations(index.get(agent.agentId))) { kept.withObligations++; continue; }
    candidates.push(agent);
  }
  return { candidates, kept, skippedTest };
}

export function candidateView(agent) {
  return { agentId: agent.agentId, runner: agent.runner, lastSeenAt: agent.updatedAt, ephemeral: agent.ephemeral === true };
}

/** Mark identities dormant. Keeps updatedAt so the record still shows when the agent was last seen. */
export function markDormant(room, agentIds) {
  const ids = new Set(agentIds);
  let count = 0;
  for (const agent of room?.agents ?? []) {
    if (ids.has(agent.agentId) && !agent.left && !agent.retired) { agent.left = true; count++; }
  }
  return count;
}

/** Bounded prune report. `pruned` is zero for a dry run. */
export function pruneReport(plan, { dryRun, pruned = 0 }) {
  return { dryRun, candidates: plan.candidates.slice(0, PRUNE_CANDIDATE_LIMIT).map(candidateView),
    total: plan.candidates.length, pruned, kept: { ...plan.kept }, skippedTest: plan.skippedTest };
}

export function registryCounts(state, room, { now = Date.now(), withinMinutes = DEFAULT_LIVE_WINDOW_MINUTES,
  idleMinutes = DEFAULT_PRUNE_IDLE_MINUTES, ephemeralIdleMinutes = DEFAULT_EPHEMERAL_IDLE_MINUTES } = {}) {
  const agents = room?.agents ?? [];
  return { stored: agents.length,
    live: agents.filter(agent => isLive(agent, { now, withinMinutes })).length,
    dormant: agents.filter(isDormant).length,
    retired: agents.filter(isRetired).length,
    ephemeral: agents.filter(agent => agent.ephemeral === true).length,
    prunable: room ? planPrune(state, room, { idleMinutes, ephemeralIdleMinutes, now }).candidates.length : 0 };
}

/** Single pass over messages; same output as filtering messages once per agent. */
export function pendingByAgent(room) {
  const counts = new Map((room?.agents ?? []).map(agent => [agent.agentId, 0]));
  for (const message of room?.messages ?? []) {
    const acked = message.ackedBy.length ? new Set(message.ackedBy) : null;
    for (const id of message.recipients) {
      if (counts.has(id) && !(acked && acked.has(id))) counts.set(id, counts.get(id) + 1);
    }
  }
  return Object.fromEntries(counts);
}

export function minutes(value, field, fail, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('INVALID_INPUT', `${field} must be a nonnegative number.`);
  return value;
}
