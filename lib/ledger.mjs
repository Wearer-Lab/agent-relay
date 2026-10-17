// Write-path helpers for the broker's single in-memory ledger.
//
// Mutations run on immer drafts: a mutator that throws leaves the base untouched, and
// unchanged rooms, agents and messages keep their identity in the next state. That shared
// identity lets serialization reuse each unchanged message's JSON (and byte size) instead of
// re-encoding a large ledger on every write. Message objects are never mutated in place;
// agents may be (lazy presence), so only messages are cached.
import { Immer, isDraft, current } from 'immer';

const immer = new Immer({ autoFreeze: false });

/** structuredClone that also accepts immer drafts (and plain values containing none). */
export function snapshot(value) {
  return isDraft(value) ? current(value) : structuredClone(value);
}

/**
 * Apply a synchronous mutator to a draft of base. Returns the next state (base itself when the
 * mutator changed nothing) and the mutator's result, converted to plain JSON data while the
 * drafts it may reference are still alive. Results are only ever sent as JSON responses.
 */
export function mutate(base, mutator) {
  let result;
  const next = immer.produce(base, draft => {
    const value = mutator(draft);
    if (value && typeof value.then === 'function') throw new Error('Ledger mutators must be synchronous.');
    result = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  });
  return { next, result };
}

const byteLength = text => Buffer.byteLength(text);

/** Per-message JSON and byte-size cache keyed by message object identity. */
export function createMessageCache() {
  const cache = new WeakMap();
  return message => {
    let row = cache.get(message);
    if (!row) { const json = JSON.stringify(message); row = { json, bytes: byteLength(json) }; cache.set(message, row); }
    return row;
  };
}

// Encode an object exactly as JSON.stringify would (same key order, undefined/function members
// omitted), letting one member be produced by a custom encoder. Returns [chunks, bytes].
function encodeObject(object, special) {
  const chunks = ['{'];
  let bytes = 1, first = true;
  for (const key of Object.keys(object)) {
    const value = object[key];
    let part, partBytes;
    if (special && key in special) {
      [part, partBytes] = special[key](value);
    } else {
      const json = JSON.stringify(value);
      if (json === undefined) continue;
      part = json; partBytes = byteLength(json);
    }
    const head = (first ? '' : ',') + JSON.stringify(key) + ':';
    chunks.push(head, ...(Array.isArray(part) ? part : [part]));
    bytes += byteLength(head) + partBytes;
    first = false;
  }
  chunks.push('}');
  return [chunks, bytes + 1];
}

function encodeMessages(messages, row) {
  const chunks = ['['];
  let bytes = 2;
  messages.forEach((message, index) => {
    const { json, bytes: size } = row(message);
    if (index) { chunks.push(','); bytes++; }
    chunks.push(json); bytes += size;
  });
  chunks.push(']');
  return [chunks, bytes];
}

function encodeRooms(rooms, row) {
  const chunks = ['['];
  let bytes = 2;
  rooms.forEach((room, index) => {
    const [part, size] = encodeObject(room, { messages: messages => encodeMessages(messages, row) });
    if (index) { chunks.push(','); bytes++; }
    chunks.push(...part); bytes += size;
  });
  chunks.push(']');
  return [chunks, bytes];
}

/** The state's JSON as chunks plus its exact UTF-8 byte length, reusing cached message JSON. */
export function encodeState(state, row) {
  return encodeObject(state, { rooms: rooms => encodeRooms(rooms, row) });
}

/** Exact byte length of JSON.stringify(state), without building the string. */
export function stateBytes(state, row) {
  return encodeState(state, row)[1];
}

