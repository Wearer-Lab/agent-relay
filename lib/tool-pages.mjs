import {randomUUID, createHash} from 'node:crypto';

export const MAX_TOOL_BYTES = 64 * 1024;

function compactPage(response, maxBytes) {
  const size = () => Buffer.byteLength(JSON.stringify(response));
  const messages = response?.messages;
  if (Array.isArray(messages)) {
    let bytes = size();
    let omitted = 0;
    while (messages.length > 1 && bytes > maxBytes) {
      messages.pop();
      omitted++;
      bytes = size();
    }
    if (bytes > maxBytes && messages.length === 1 && Array.isArray(messages[0]?.recipients)) {
      const row = messages[0];
      if (!Number.isSafeInteger(row.recipientsTotal)) row.recipientsTotal = row.recipients.length;
      if (!Number.isSafeInteger(row.pendingTotal) && Array.isArray(row.pending)) row.pendingTotal = row.pending.length;
      while (bytes > maxBytes && (row.recipients.length > 1 || (Array.isArray(row.pending) && row.pending.length > 1))) {
        if (Array.isArray(row.pending) && row.pending.length > 1 && row.pending.length >= row.recipients.length) row.pending.pop();
        else if (row.recipients.length > 1) row.recipients.pop();
        else if (Array.isArray(row.pending) && row.pending.length > 1) row.pending.pop();
        else break;
        bytes = size();
      }
    }
    const paged = { ...response, messages, byteSize: bytes, maxBytes,
      omitted: omitted ? { count: omitted, resumeCursor: messages.at(-1)?.cursor ?? 0 } : null };
    if (omitted) {
      const resume = messages.at(-1)?.cursor ?? 0;
      if (Object.hasOwn(response, 'cursor')) paged.cursor = resume;
      if (Object.hasOwn(response, 'nextCursor')) paged.nextCursor = resume;
      if (Object.hasOwn(response, 'done')) paged.done = false;
      paged.omitted.resumeCursor = resume;
    }
    return paged;
  }
  if (Array.isArray(response?.recipients) && Number.isSafeInteger(response?.recipientsTotal)) {
    let bytes = size();
    const pending = Array.isArray(response.pending) ? response.pending : null;
    while (bytes > maxBytes && (response.recipients.length > 1 || (pending && pending.length > 1))) {
      if (pending && pending.length > 1 && (pending.length >= response.recipients.length || response.recipients.length <= 1)) pending.pop();
      else if (response.recipients.length > 1) response.recipients.pop();
      else if (pending && pending.length > 1) pending.pop();
      else break;
      bytes = size();
    }
    return { ...response, byteSize: bytes, maxBytes };
  }
  if (Array.isArray(response?.agents) && Number.isSafeInteger(response?.total)) {
    let bytes = size();
    while (response.agents.length > 1 && bytes > maxBytes) {
      response.agents.pop();
      bytes = size();
    }
    if (bytes > maxBytes && Array.isArray(response.claims) && response.claims.length > 0) {
      let omittedClaims = 0;
      while (response.claims.length > 0 && bytes > maxBytes) {
        response.claims.pop();
        omittedClaims++;
        bytes = size();
      }
      return { ...response, byteSize: bytes, maxBytes, claimsOmitted: omittedClaims ? { count: omittedClaims } : null };
    }
    if (bytes <= maxBytes && response.agents.length === response.total && (!Array.isArray(response.claims) || size() <= maxBytes)) {
      return response;
    }
    return { ...response, byteSize: bytes, maxBytes };
  }
  if (Array.isArray(response?.tasks)) {
    let bytes = size();
    if (bytes <= maxBytes) return response;
    let omitted = 0;
    const total = response.tasks.length;
    while (response.tasks.length > 1 && bytes > maxBytes) {
      response.tasks.pop();
      omitted++;
      bytes = size();
    }
    return { ...response, byteSize: bytes, maxBytes, total, omitted: omitted ? { count: omitted } : null, hasMore: omitted > 0 };
  }
  if (Array.isArray(response?.handoffs)) {
    let bytes = size();
    if (bytes <= maxBytes) return response;
    let omitted = 0;
    const total = response.handoffs.length;
    while (response.handoffs.length > 1 && bytes > maxBytes) {
      response.handoffs.pop();
      omitted++;
      bytes = size();
    }
    return { ...response, byteSize: bytes, maxBytes, total, omitted: omitted ? { count: omitted } : null, hasMore: omitted > 0 };
  }
  if (Array.isArray(response?.processes)) {
    let bytes = size();
    if (bytes <= maxBytes) return response;
    let omitted = 0;
    const total = response.processes.length;
    while (response.processes.length > 1 && bytes > maxBytes) {
      response.processes.pop();
      omitted++;
      bytes = size();
    }
    return { ...response, byteSize: bytes, maxBytes, total, omitted: omitted ? { count: omitted } : null, hasMore: omitted > 0 };
  }
  if (Array.isArray(response?.rooms) && Array.isArray(response?.agents)) {
    let bytes = size();
    if (bytes <= maxBytes) return response;
    let omittedAgents = 0;
    while (response.agents.length > 1 && bytes > maxBytes) {
      response.agents.pop();
      omittedAgents++;
      bytes = size();
    }
    return { ...response, byteSize: bytes, maxBytes, omittedAgents: omittedAgents ? { count: omittedAgents } : null };
  }
  if (response && typeof response === 'object' && Array.isArray(response?.acks) && Number.isSafeInteger(response?.version)) {
    let bytes = size();
    if (bytes <= maxBytes) return response;
    let omitted = 0;
    const total = response.acks.length;
    while (response.acks.length > 1 && bytes > maxBytes) {
      response.acks.pop();
      omitted++;
      bytes = size();
    }
    return { ...response, byteSize: bytes, maxBytes, acksTotal: total, acksOmitted: omitted ? { count: omitted } : null };
  }
  return response;
}


// Retain the complete response before compacting it. A continuation reads an
// immutable snapshot, so changes in presence or collection order cannot skip rows.
export function createToolPages({maxBytes = MAX_TOOL_BYTES, maxStoredBytes = 64 * 1024 * 1024,
  maxSnapshots = 16, ttlMs = 5 * 60 * 1000, now = Date.now} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2048) throw new Error('Invalid tool page budget.');
  if (!Number.isSafeInteger(maxSnapshots) || maxSnapshots < 1 || !Number.isSafeInteger(maxStoredBytes) || maxStoredBytes < 1
      || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('Invalid tool snapshot budget.');
  const snapshots = new Map();
  let storedBytes = 0;
  const drop = token => {
    const row = snapshots.get(token);
    if (row) storedBytes -= row.bytes;
    snapshots.delete(token);
  };
  const prune = () => {
    for (const [token, row] of snapshots) if (row.expiresAt <= now()) drop(token);
  };
  function measured(value) {
    value.maxBytes = maxBytes;
    value.byteSize = 0;
    // byteSize includes its own digits and every continuation/metadata field.
    for (let i = 0; i < 4; i++) value.byteSize = Buffer.byteLength(JSON.stringify(value));
    if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new Error('Tool page exceeds its byte budget.');
    return value;
  }
  function continuationMetadata(value, {op, offset = 0}) {
    if (op === 'receipt' && Array.isArray(value.recipients)) {
      for (const [key, prefix] of [['recipients', 'Recipients'], ['pending', 'Pending']]) {
        if (!Array.isArray(value[key]) || !Number.isSafeInteger(value[key + 'Total'])) continue;
        const next = (value[key + 'Offset'] ?? 0) + value[key].length;
        value['next' + prefix + 'Offset'] = next;
        value['hasMore' + prefix] = next < value[key + 'Total'];
      }
    }
    if (op === 'agents' && Array.isArray(value.agents) && Number.isSafeInteger(value.total)) {
      value.nextOffset = offset + value.agents.length;
      value.hasMore = value.nextOffset < value.total;
    }
    return value;
  }
  return {
    bound(response, context = {}) {
      const original = JSON.stringify(response);
      const bytes = Buffer.byteLength(original);
      // Leave space for counters and independently resumable broker pages.
      let value = continuationMetadata(compactPage(JSON.parse(original), maxBytes - 2048), context);
      if (bytes <= maxBytes - 2048) return measured(value);
      prune();
      if (bytes > maxStoredBytes) throw new Error('Response exceeds snapshot storage budget; narrow the original query.');
      while (snapshots.size >= maxSnapshots || storedBytes + bytes > maxStoredBytes) drop(snapshots.keys().next().value);
      const token = randomUUID(), expiresAt = now() + ttlMs;
      const sha256 = createHash('sha256').update(original).digest('hex');
      snapshots.set(token, {text: original, bytes, sha256, expiresAt, owner: context.owner});
      storedBytes += bytes;
      const continuation = {tool: 'relay_read_page', token, offset: 0, encoding: 'json-text',
        totalChars: original.length, sha256, expiresAt,
        instructions: 'Concatenate text chunks in offset order, then parse the complete original JSON when done is true. Read omitted message details before acknowledging.'};
      value.continuation = continuation;
      value.truncated = true;
      if (Buffer.byteLength(JSON.stringify(value)) > maxBytes - 128) {
        // Even one row can exceed the budget (marker history, escaped text,
        // large metadata). Never imply that the omitted body was read.
        value = {ok: response.ok ?? true, truncated: true, detailsOmitted: true, continuation};
      }
      return measured(value);
    },
    read(token, offset = 0, owner) {
      prune();
      const row = snapshots.get(token);
      if (!row || row.owner !== owner) throw new Error('Unknown or expired relay page token; repeat the original read.');
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > row.text.length) throw new Error('Invalid relay page offset.');
      const envelope = end => ({ok: true, token, encoding: 'json-text', offset, nextOffset: end,
        done: end === row.text.length, totalChars: row.text.length, sha256: row.sha256,
        expiresAt: row.expiresAt, text: row.text.slice(offset, end), byteSize: 0, maxBytes});
      let low = offset, high = Math.min(row.text.length, offset + maxBytes);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(JSON.stringify(envelope(mid))) <= maxBytes - 32) low = mid;
        else high = mid - 1;
      }
      return measured(envelope(low));
    },
    clear(owner) {
      for (const [token, row] of snapshots) if (owner === undefined || row.owner === owner) drop(token);
    },
  };
}
