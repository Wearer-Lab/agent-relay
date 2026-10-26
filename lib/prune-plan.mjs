// Ephemeral identities and the prune plan the broker applies.
//
// Fallback identities (`claude-tmp-<uuid>`) are short-lived by construction, even when the stored
// `ephemeral` flag did not exist yet when they registered. `lib/registry.mjs` owns the pattern
// (`looksEphemeral`), the liveness definition and the prune plan; this module only applies the
// pattern to the plan, the sweep and the prune report, so there is never a second liveness rule.
import { looksEphemeral, planPrune, obligationIndex, hasObligations, isLive, isTransportFresh,
  DEFAULT_LIVE_WINDOW_MINUTES, DEFAULT_TRANSPORT_STALE_MINUTES } from './registry.mjs';

/** The room as the prune plan should see it: legacy fallback identities flagged ephemeral. */
export function withEphemeralFlags(room) {
  if (!room) return room;
  const agents = (room.agents ?? []).map(agent => (agent.ephemeral === true || !looksEphemeral(agent)
    ? agent : { ...agent, ephemeral: true }));
  return { ...room, agents };
}

/** The prune plan, with legacy fallback identities treated as ephemeral. */
export function planPruneEphemeral(state, room, options = {}) {
  return planPrune(state, withEphemeralFlags(room), options);
}

/**
 * Why the prune plan kept the identities it kept: truly live ones, identities that only claim a
 * connected transport they have not refreshed, identities nobody has seen for a while, and
 * identities that still hold obligations. The existing `kept` counters keep their shape; this is
 * the split the prune report adds next to them.
 */
export function pruneBreakdown(state, room, { plan, idleMinutes, ephemeralIdleMinutes, includeTest = false,
  now = Date.now(), withinMinutes = DEFAULT_LIVE_WINDOW_MINUTES,
  transportStaleMinutes = DEFAULT_TRANSPORT_STALE_MINUTES } = {}) {
  const index = obligationIndex(state, room);
  const candidates = new Set((plan?.candidates ?? []).map(agent => agent.agentId));
  const out = { live: 0, connectedNotSeen: 0, notSeen: 0, withObligations: 0 };
  for (const agent of room?.agents ?? []) {
    if (agent.left || agent.retired) continue;
    if (agent.test === true && !includeTest) continue;
    if (candidates.has(agent.agentId)) continue;
    const ephemeral = agent.ephemeral === true || looksEphemeral(agent);
    const threshold = ephemeral && ephemeralIdleMinutes > 0
      ? Math.min(idleMinutes, ephemeralIdleMinutes) : idleMinutes;
    const idle = now - Date.parse(agent.updatedAt);
    // A connected transport protects an identity only while its report is fresh.
    const fresh = agent.transport?.state === 'connected'
      && (isTransportFresh(agent, { now, transportStaleMinutes }) || idle <= transportStaleMinutes * 60000);
    if (fresh) { out.live++; continue; }
    if (idle < threshold * 60000) {
      if (isLive(agent, { now, withinMinutes, transportStaleMinutes })) out.live++;
      else if (agent.transport?.state === 'connected') out.connectedNotSeen++;
      else out.notSeen++;
      continue;
    }
    if (hasObligations(index.get(agent.agentId))) { out.withObligations++; continue; }
    out.notSeen++;
  }
  return out;
}

/** Ephemeral identities that still hold something: kept by the sweep, never retired, and reported. */
export function ephemeralHolders(state, room, { ephemeralIdleMinutes = 0, now = Date.now() } = {}) {
  const index = obligationIndex(state, room);
  const rows = [];
  for (const agent of room?.agents ?? []) {
    if (agent.left || agent.retired) continue;
    if (!looksEphemeral(agent)) continue;
    if (!((now - Date.parse(agent.updatedAt)) >= ephemeralIdleMinutes * 60000)) continue;
    const obligations = index.get(agent.agentId);
    if (!hasObligations(obligations)) continue;
    rows.push({ agentId: agent.agentId, runner: agent.runner,
      obligations: { claims: [...obligations.claims], machineClaims: [...obligations.machineClaims],
        branchClaims: [...obligations.branchClaims], handoffs: [...obligations.handoffs],
        processes: [...obligations.processes], tasks: [...obligations.tasks] } });
  }
  return rows;
}

/** Retire identities that will never come back. They stay resolvable for history. */
export function retireIdentities(room, agentIds) {
  const ids = new Set(agentIds);
  let count = 0;
  for (const agent of room?.agents ?? []) {
    if (!ids.has(agent.agentId) || agent.retired === true) continue;
    agent.left = true; agent.retired = true; count++;
  }
  return count;
}
