// Registry hygiene: liveness, live-broadcast audiences, dormant identities and pruning.
// Pure functions over broker state; the broker owns all writes and error mapping.

export const DEFAULT_LIVE_WINDOW_MINUTES = 120;
// A connected transport only counts as live while its report is fresh. Watchers refresh
// about every 25 s through `wait`, so a report older than this means the watcher is gone.
export const DEFAULT_TRANSPORT_STALE_MINUTES = 5;
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

// Fallback identities look like `claude-tmp-1712...`: a short-lived process that never had a
// stable session. They are ephemeral even when the flag did not exist yet when they registered.
const TMP_IDENTITY = /(^|[-:])tmp-[a-z0-9][a-z0-9-]*$/i;
export const looksEphemeral = agent => agent?.ephemeral === true
  || (typeof agent?.agentId === 'string' && TMP_IDENTITY.test(agent.agentId));

const ageOf = (value, now) => {
  const at = Date.parse(value ?? '');
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
};

/** Age of the last transport report in milliseconds, or null when the agent never reported one. */
export function transportAgeMs(agent, { now = Date.now() } = {}) {
  return ageOf(agent?.transport?.ts, now);
}

/** A transport is fresh while its report is inside the window; a missing report is not fresh. */
export function isTransportFresh(agent, { now = Date.now(), transportStaleMinutes = DEFAULT_TRANSPORT_STALE_MINUTES } = {}) {
  const age = transportAgeMs(agent, { now });
  return age !== null && age <= transportStaleMinutes * 60000;
}

/** True when the agent still claims a connected transport whose report has gone stale. */
export function isTransportStale(agent, { now = Date.now(), transportStaleMinutes = DEFAULT_TRANSPORT_STALE_MINUTES } = {}) {
  if (agent?.transport?.state !== 'connected') return false;
  if (isTransportFresh(agent, { now, transportStaleMinutes })) return false;
  // Either signal is enough: a fresh `updatedAt` means the agent was seen recently.
  const seen = ageOf(agent.updatedAt, now);
  return seen === null || seen > transportStaleMinutes * 60000;
}

/**
 * Live: not left, and either a connected transport with a fresh report, or seen within the window.
 * A connected transport counts as live only while `updatedAt` or `transport.ts` is inside the
 * stale window; an old "connected" report is a claim, not a fact.
 */
export function isLive(agent, { now = Date.now(), withinMinutes = DEFAULT_LIVE_WINDOW_MINUTES,
  transportStaleMinutes = DEFAULT_TRANSPORT_STALE_MINUTES } = {}) {
  if (!agent || agent.left) return false;
  if (agent.transport?.state === 'connected') {
    if (isTransportFresh(agent, { now, transportStaleMinutes })) return true;
    const seen = ageOf(agent.updatedAt, now);
    return seen !== null && seen <= transportStaleMinutes * 60000;
  }
  const seen = ageOf(agent.updatedAt, now);
  return seen !== null && seen <= withinMinutes * 60000;
}

/** The one liveness classification other views reuse: holder is active|stale|left|retired|missing, `live` is isLive. */
export function liveness(agent, { now = Date.now(), withinMinutes = DEFAULT_LIVE_WINDOW_MINUTES,
  transportStaleMinutes = DEFAULT_TRANSPORT_STALE_MINUTES } = {}) {
  const transportAge = transportAgeMs(agent, { now });
  const staleTransport = isTransportStale(agent, { now, transportStaleMinutes });
  if (!agent) return { holder: 'missing', live: false, lastSeenAgeMs: null, transportAgeMs: null, transportStale: false, stale: true };
  const lastSeenAgeMs = Math.max(0, now - Date.parse(agent.updatedAt));
  if (agent.retired) return { holder: 'retired', live: false, lastSeenAgeMs, transportAgeMs: transportAge, transportStale: staleTransport, stale: true };
  if (agent.left) return { holder: 'left', live: false, lastSeenAgeMs, transportAgeMs: transportAge, transportStale: staleTransport, stale: true };
  const live = isLive(agent, { now, withinMinutes, transportStaleMinutes });
  return { holder: live ? 'active' : 'stale', live, lastSeenAgeMs, transportAgeMs: transportAge, transportStale: staleTransport, stale: !live };
}

/** Broadcast audience: '*' reaches live agents seen within the window, '*all' every non-left agent. */
export function broadcastAudience(room, from, to, { within = DEFAULT_LIVE_WINDOW_MINUTES, now = Date.now(),
  transportStaleMinutes = DEFAULT_TRANSPORT_STALE_MINUTES } = {}) {
  const candidates = (room?.agents ?? []).filter(agent => !agent.left && agent.agentId !== from);
  if (to === BROADCAST_ALL) {
    return { recipients: candidates.map(agent => agent.agentId), audience: { mode: 'all', within: null, excluded: 0 } };
  }
  const live = candidates.filter(agent => isLive(agent, { now, withinMinutes: within, transportStaleMinutes }));
  return { recipients: live.map(agent => agent.agentId),
    audience: { mode: 'live', within, excluded: candidates.length - live.length } };
}

/** Everything that would be stranded if this identity went away, indexed per agent for one pass. */
export function obligationIndex(state, room) {
  const index = new Map();
  const row = id => {
    let value = index.get(id);
    if (!value) index.set(id, value = { claims: [], machineClaims: [], branchClaims: [], handoffs: [], processes: [], tasks: [] });
    return value;
  };
  for (const claim of room?.claims ?? []) row(claim.agentId).claims.push(claim.resource);
  for (const claim of state?.machineClaims ?? []) {
    if (claim.project === room?.project) row(claim.agentId).machineClaims.push(claim.resource);
  }
  for (const claim of state?.branchClaims ?? []) {
    if (claim.project === room?.project) row(claim.agentId).branchClaims.push(claim.branch);
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
  && (value.claims.length > 0 || value.machineClaims.length > 0 || (value.branchClaims?.length ?? 0) > 0 || value.handoffs.length > 0
    || value.processes.length > 0 || value.tasks.length > 0);
export const emptyObligations = () => ({ claims: [], machineClaims: [], branchClaims: [], handoffs: [], processes: [], tasks: [] });

/** Plan (never apply) a prune of one room. Candidates are non-left, non-retired, idle, disconnected and obligation-free. */
export function planPrune(state, room, { idleMinutes = DEFAULT_PRUNE_IDLE_MINUTES,
  ephemeralIdleMinutes = DEFAULT_EPHEMERAL_IDLE_MINUTES, includeTest = false, now = Date.now(),
  transportStaleMinutes = DEFAULT_TRANSPORT_STALE_MINUTES } = {}) {
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
    // A connected transport protects an identity only while its report is fresh.
    const connected = agent.transport?.state === 'connected'
      && (isTransportFresh(agent, { now, transportStaleMinutes })
        || (ageOf(agent.updatedAt, now) ?? Infinity) <= transportStaleMinutes * 60000);
    if (connected || !(idle >= threshold * 60000)) { kept.live++; continue; }
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
  idleMinutes = DEFAULT_PRUNE_IDLE_MINUTES, ephemeralIdleMinutes = DEFAULT_EPHEMERAL_IDLE_MINUTES,
  transportStaleMinutes = DEFAULT_TRANSPORT_STALE_MINUTES } = {}) {
  const agents = room?.agents ?? [];
  return { stored: agents.length,
    live: agents.filter(agent => isLive(agent, { now, withinMinutes, transportStaleMinutes })).length,
    dormant: agents.filter(isDormant).length,
    retired: agents.filter(isRetired).length,
    ephemeral: agents.filter(agent => agent.ephemeral === true).length,
    staleTransports: agents.filter(agent => isTransportStale(agent, { now, transportStaleMinutes })).length,
    prunable: room ? planPrune(state, room, { idleMinutes, ephemeralIdleMinutes, now, transportStaleMinutes }).candidates.length : 0 };
}

/** The broadcast cursor an agent has read through; 0 when it has read none. */
export const readThroughCursor = agent => Number.isSafeInteger(agent?.readThrough) && agent.readThrough > 0 ? agent.readThrough : 0;

/**
 * True when the recipient has read the message: an explicit ack, or a broadcast cursor that
 * covers it. The cursor only counts for broadcasts; a direct message has its own ack.
 */
export const hasRead = (agentId, message, agent) => {
  if (Array.isArray(message?.ackedBy) && message.ackedBy.includes(agentId)) return true;
  if (!isBroadcast(message?.to)) return false;
  const cursor = readThroughCursor(agent);
  return cursor > 0 && cursor >= message.cursor;
};

/** Single pass over messages; same output as filtering messages once per agent. */
export function pendingByAgent(room) {
  const counts = new Map((room?.agents ?? []).map(agent => [agent.agentId, 0]));
  const agents = new Map((room?.agents ?? []).map(agent => [agent.agentId, agent]));
  for (const message of room?.messages ?? []) {
    const acked = message.ackedBy.length ? new Set(message.ackedBy) : null;
    for (const id of message.recipients) {
      // Schema 2 keeps a broadcast's readers in a cursor, not in ackedBy: an agent that read
      // through the message holds no row for it any more.
      const read = acked?.has(id) || hasRead(id, message, agents.get(id));
      if (counts.has(id) && !read) counts.set(id, counts.get(id) + 1);
    }
  }
  return Object.fromEntries(counts);
}

export function minutes(value, field, fail, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('INVALID_INPUT', `${field} must be a nonnegative number.`);
  return value;
}
