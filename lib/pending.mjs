// Pending deliveries, honestly split.
//
// "Awaiting acknowledgement" mixes four different things, and one number for all four hides the
// only part anybody can act on:
//
// - awaiting-live:    a live agent can still read this delivery.
// - awaiting-dormant: the recipient left (or is simply unseen), so the delivery waits in a durable
//                     inbox for an identity that may come back.
// - awaiting-retired: the recipient is retired, so it can never come back: the delivery is finished
//                     and only the cleanup is left.
// - expired:          the delivery outlived its time to live and waits for the archive.
//
// Precedence, strongest fact first: expiry beats the identity state (an expired delivery is
// archived whatever the recipient does), then retirement, then liveness. A delivery that is neither
// expired, retired nor live is held for a dormant identity: nobody can read it now, it may return.
//
// The breakdown groups deliveries five ways, all read-only:
// - by recipient: the identity that owes the acknowledgement, biggest first.
// - by state:    the four groups above.
// - by age:      under-1h, 1h-to-1d, 1d-to-7d, 7d-to-30d, over-30d.
// - by sender:   who sent it, biggest first.
// - by kind:     broadcast, direct, task, handoff, bulletin.
//
// Pure functions over broker state. The broker owns all writes and error mapping; nothing here
// registers an observer, acknowledges a message or takes the writer lease.

import { isLive, isDormant, isRetired, transportAgeMs,
  DEFAULT_LIVE_WINDOW_MINUTES, DEFAULT_TRANSPORT_STALE_MINUTES } from './registry.mjs';

export const PENDING_STATES = ['awaiting-live', 'awaiting-dormant', 'awaiting-retired', 'expired'];
export const PENDING_GROUPINGS = ['recipient', 'state', 'age', 'sender', 'kind'];
export const DELIVERY_KINDS = ['broadcast', 'direct', 'task', 'handoff', 'bulletin'];

// A delivery outlives its TTL and then waits for the archive. Broadcasts expire fast (standing
// traffic nobody reads twice); a direct message keeps a dormant inbox durable for a month.
export const DEFAULT_BROADCAST_TTL_DAYS = 7;
export const DEFAULT_DIRECT_TTL_DAYS = 30;

export const DEFAULT_PENDING_LIMIT = 50;
export const MAX_PENDING_LIMIT = 500;
// Grouping by recipient or by sender can name thousands of identities; the table stays bounded.
export const MAX_PENDING_GROUPS = 50;
export const DEFAULT_BLOCKER_LIMIT = 10;

// Age buckets, youngest first.
export const AGE_BUCKETS = [
  { key: 'under-1h', max: 60 * 60 * 1000 },
  { key: '1h-to-1d', max: 24 * 60 * 60 * 1000 },
  { key: '1d-to-7d', max: 7 * 24 * 60 * 60 * 1000 },
  { key: '7d-to-30d', max: 30 * 24 * 60 * 60 * 1000 },
  { key: 'over-30d', max: Infinity },
];

const COUNT_KEY = { 'awaiting-live': 'live', 'awaiting-dormant': 'dormant', 'awaiting-retired': 'retired', expired: 'expired' };
const GROUP_ORDER = { state: PENDING_STATES, age: AGE_BUCKETS.map(bucket => bucket.key), kind: DELIVERY_KINDS };

/** The age bucket a delivery falls into. */
export const ageBucket = ageMs => (AGE_BUCKETS.find(bucket => ageMs < bucket.max) ?? AGE_BUCKETS.at(-1)).key;

/** A broadcast audience ('*' or '*all') reaches many identities; a direct message reaches one. */
export const isBroadcastAudience = to => to === '*' || to === '*all';

/** How long a delivery of this message stays readable before it is expired. */
export function ttlFor(message, { broadcastTtlDays = DEFAULT_BROADCAST_TTL_DAYS,
  directTtlDays = DEFAULT_DIRECT_TTL_DAYS } = {}) {
  const days = isBroadcastAudience(message?.to) ? broadcastTtlDays : directTtlDays;
  return Math.max(0, days) * 864e5;
}

/**
 * What kind of work a delivery carries.
 *
 * - broadcast: the message went to a broadcast audience.
 * - task:      the sender handed the recipient an open task.
 * - handoff:   the sender handed the recipient a handoff request.
 * - bulletin:  the sender published the current bulletin, the message carries it, and the
 *              recipient has not acknowledged that version yet.
 * - direct:    everything else, a plain message to one named identity.
 */
export function deliveryKind(message, recipient, room) {
  if (isBroadcastAudience(message?.to)) return 'broadcast';
  const tasks = room?.tasks ?? [];
  if (tasks.some(task => task.owner === recipient && task.creator === message?.from && task.state === 'open')) return 'task';
  const handoffs = room?.handoffs ?? [];
  if (handoffs.some(handoff => handoff.from === message?.from && handoff.to === recipient)) return 'handoff';
  const bulletin = room?.bulletin?.versions?.[0];
  if (bulletin && bulletin.source === message?.from && carriesBulletin(message, bulletin)
      && !(bulletin.acks ?? []).some(row => row.agentId === recipient)) return 'bulletin';
  return 'direct';
}

// The announcement of a bulletin carries its title or its text.
const carriesBulletin = (message, bulletin) => message.summary === bulletin.title
  || message.body === bulletin.body
  || (typeof bulletin.title === 'string' && bulletin.title.length > 0 && message.body.includes(bulletin.title));

/** The group a single delivery belongs to. */
export function deliveryState({ agent, ageMs, ttlMs, now = Date.now(),
  withinMinutes = DEFAULT_LIVE_WINDOW_MINUTES, transportStaleMinutes = DEFAULT_TRANSPORT_STALE_MINUTES }) {
  if (ageMs > ttlMs) return 'expired';
  if (isRetired(agent)) return 'awaiting-retired';
  if (isDormant(agent)) return 'awaiting-dormant';
  if (isLive(agent, { now, withinMinutes, transportStaleMinutes })) return 'awaiting-live';
  // Registered but unseen (never left): nobody can read it now and it may come back.
  return 'awaiting-dormant';
}

/**
 * Every pending delivery of a room, one row per (message, unacknowledged recipient).
 *
 * `counts` splits the deliveries into the four groups, `byAgent` splits them per identity.
 */
export function pendingDeliveries(room, { now = Date.now(), withinMinutes = DEFAULT_LIVE_WINDOW_MINUTES,
  transportStaleMinutes = DEFAULT_TRANSPORT_STALE_MINUTES, broadcastTtlDays = DEFAULT_BROADCAST_TTL_DAYS,
  directTtlDays = DEFAULT_DIRECT_TTL_DAYS } = {}) {
  const agents = new Map((room?.agents ?? []).map(agent => [agent.agentId, agent]));
  const counts = { live: 0, dormant: 0, retired: 0, expired: 0 };
  const byAgent = new Map();
  const rows = [];
  for (const message of room?.messages ?? []) {
    const acked = new Set(message.ackedBy ?? []);
    const created = Date.parse(message.createdAt);
    const ageMs = Number.isFinite(created) ? Math.max(0, now - created) : 0;
    const ttl = ttlFor(message, { broadcastTtlDays, directTtlDays });
    for (const recipient of message.recipients ?? []) {
      if (acked.has(recipient)) continue;
      const agent = agents.get(recipient);
      const state = deliveryState({ agent, ageMs, ttlMs: ttl, now, withinMinutes, transportStaleMinutes });
      const key = COUNT_KEY[state];
      counts[key]++;
      if (agent) {
        const entry = byAgent.get(recipient) ?? { live: 0, dormant: 0, retired: 0, expired: 0 };
        entry[key]++;
        byAgent.set(recipient, entry);
      }
      rows.push({ messageId: message.messageId, from: message.from, to: message.to,
        kind: deliveryKind(message, recipient, room), createdAt: message.createdAt, ageMs, state,
        recipient, recipients: [...(message.recipients ?? [])], cursor: message.cursor });
    }
  }
  return { rows, counts, byAgent, total: rows.length };
}

/** The split of a room's pending deliveries, with the per-identity split. */
export function pendingSplit(room, options = {}) {
  const { counts, byAgent, total } = pendingDeliveries(room, options);
  return { total, counts: { ...counts }, headline: counts.live,
    byAgent: Object.fromEntries([...byAgent].map(([agentId, entry]) => [agentId,
      { ...entry, total: entry.live + entry.dormant + entry.retired + entry.expired }])) };
}

function groupKey(row, by) {
  if (by === 'recipient') return row.recipient;
  if (by === 'sender') return row.from;
  if (by === 'age') return ageBucket(row.ageMs);
  if (by === 'kind') return row.kind;
  return row.state;
}

/** Group the rows, keeping the fixed vocabularies complete and the open ones bounded. */
function groupRows(rows, by) {
  const counts = new Map();
  for (const row of rows) {
    const key = groupKey(row, by);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const order = GROUP_ORDER[by];
  if (order) return { groups: order.map(key => ({ key, count: counts.get(key) ?? 0 })), total: order.length, truncated: false };
  const entries = [...counts].map(([key, count]) => ({ key, count }));
  entries.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { groups: entries.slice(0, MAX_PENDING_GROUPS), total: entries.length, truncated: entries.length > MAX_PENDING_GROUPS };
}

/**
 * The pending breakdown of one room: the totals, the group table and one page of rows.
 * Read-only: it never registers an observer, acknowledges anything or takes the writer lease.
 */
export function pendingBreakdown(room, { by = 'state', limit = DEFAULT_PENDING_LIMIT, offset = 0, ...options } = {}) {
  const { rows, counts, byAgent, total } = pendingDeliveries(room, options);
  const { groups, groupsTotal, truncated } = groupRows(rows, by);
  return { total, counts: { ...counts }, groups, rows: rows.slice(offset, offset + limit), offset, limit,
    by, groupsTotal, groupsTruncated: truncated,
    byAgent: Object.fromEntries([...byAgent].map(([agentId, entry]) => [agentId,
      { ...entry, total: entry.live + entry.dormant + entry.retired + entry.expired }])) };
}

/**
 * The identities that keep old messages from being archived.
 *
 * A message waits for the archive when it is old enough, carries no attachment, and somebody has
 * not acknowledged it. The identities that still owe an acknowledgement are the blockers: each one
 * names how many messages it pins and how many pending rows it holds.
 */
export function compactionBlockers(state, room, { olderThanDays = 14, now = Date.now(),
  limit = DEFAULT_BLOCKER_LIMIT, withinMinutes = DEFAULT_LIVE_WINDOW_MINUTES,
  transportStaleMinutes = DEFAULT_TRANSPORT_STALE_MINUTES, broadcastTtlDays = DEFAULT_BROADCAST_TTL_DAYS,
  directTtlDays = DEFAULT_DIRECT_TTL_DAYS } = {}) {
  const cutoff = now - Math.max(0, olderThanDays) * 864e5;
  const agents = new Map((room?.agents ?? []).map(agent => [agent.agentId, agent]));
  const held = new Map();
  for (const message of room?.messages ?? []) {
    const created = Date.parse(message.createdAt);
    if (!Number.isFinite(created) || created >= cutoff) continue;      // too young to be archived
    if ((message.attachments ?? []).length) continue;                  // attachments keep it, not an identity
    const acked = new Set(message.ackedBy ?? []);
    const ageMs = Math.max(0, now - created);
    const ttl = ttlFor(message, { broadcastTtlDays, directTtlDays });
    for (const recipient of message.recipients ?? []) {
      if (acked.has(recipient)) continue;
      const agent = agents.get(recipient);
      if (isRetired(agent)) continue;      // finished: a retired identity can never come back
      if (ageMs > ttl) continue;           // expired: the archive takes it, the identity does not block
      const entry = held.get(recipient) ?? { agentId: recipient, messages: 0 };
      entry.messages++;
      held.set(recipient, entry);
    }
  }
  const { byAgent } = pendingDeliveries(room, { now, withinMinutes, transportStaleMinutes, broadcastTtlDays, directTtlDays });
  const rows = [...held.values()].map(entry => {
    const agent = agents.get(entry.agentId);
    const backlog = byAgent.get(entry.agentId);
    return { agentId: entry.agentId, messages: entry.messages,
      rows: backlog ? backlog.live + backlog.dormant + backlog.retired + backlog.expired : entry.messages,
      live: isLive(agent, { now, withinMinutes, transportStaleMinutes }),
      lastSeenAgeMs: agent ? Math.max(0, now - Date.parse(agent.updatedAt)) : null,
      transportAgeMs: transportAgeMs(agent, { now }) };
  });
  rows.sort((a, b) => b.messages - a.messages || b.rows - a.rows || (a.agentId < b.agentId ? -1 : 1));
  return rows.slice(0, limit);
}

const BLOCKER_EXPORTS = ['compactionBlockers', 'blockers', 'planBlockers'];

function normalizeBlockers(value) {
  const list = Array.isArray(value) ? value : (value?.blockers ?? []);
  return list.map(row => ({ agentId: row.agentId ?? row.id ?? null,
    messages: row.messages ?? row.messageCount ?? row.messagesPinned ?? 0,
    rows: row.rows ?? row.rowCount ?? row.pendingRows ?? row.messagesPinned ?? 0,
    live: row.live ?? null,
    lastSeenAgeMs: row.lastSeenAgeMs ?? null,
    transportAgeMs: row.transportAgeMs ?? null }));
}

/**
 * The blockers of a room, preferring the compaction module's own computation when it publishes one.
 * The fallback here keeps the same rule (an unacknowledged, unexpired recipient of an old message),
 * so the warning never disappears silently.
 */
export async function resolveBlockers(state, room, options = {}) {
  try {
    const compaction = await import('./compaction.mjs');
    for (const name of BLOCKER_EXPORTS) {
      if (typeof compaction[name] !== 'function') continue;
      const rows = normalizeBlockers(await compaction[name](state, room, options));
      if (rows.length) return rows;
    }
  } catch { /* The compaction module has no blocker computation yet: use the local one. */ }
  return compactionBlockers(state, room, options);
}
