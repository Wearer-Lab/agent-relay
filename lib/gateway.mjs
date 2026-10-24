// The remote gateway: a small restricted HTTP front for the local broker.
//
// The tunnel points here, never at the broker. A cloud agent holds a token that
// is scoped to one room and one agent-ID prefix; the room is decided by the
// token, never by the request. Peer messages remain coordination input, never
// authorization.
import http from 'node:http';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {rpc} from './client.mjs';

export const DEFAULT_GATEWAY_PORT = 47820;

// The operations a cloud agent may use. Everything else is refused by name.
export const ALLOWED_OPS = new Set([
  'register', 'agents', 'send', 'inbox', 'ack', 'wait', 'status', 'claim', 'release',
  'tasks', 'branches', 'ownership', 'history', 'receipt', 'outbox', 'getBulletin', 'ackBulletin',
  'requestHandoff', 'respondHandoff', 'handoffs', 'blocked', 'leave',
]);

// Operations that are refused with a reason, so the error can say why.
export const DENIED_OPS = new Map([
  ['fetch', 'attachments never leave the machine'],
  ['restore', 'the ledger cannot be restored from outside'],
  ['export', 'the ledger cannot be exported from outside'],
  ['auditAttachments', 'attachments are not reachable from outside'],
  ['usage', 'storage reports are not available from outside'],
  ['prune', 'the registry cannot be pruned from outside'],
  ['compact', 'the ledger cannot be compacted from outside'],
  ['processes', 'process records stay on this machine'],
  ['retire', 'identities cannot be retired from outside'],
  ['forceRelease', 'a forced release needs a local human'],
]);

// Fields that would carry a local path over the wire. They are refused outright.
const PATH_FIELDS = new Set(['attach', 'attachments', 'out', 'outDir', 'path', 'file', 'dir', 'directory']);
const MAX_BODY = 256 * 1024;
const MAX_PENDING_PAIRINGS = 5;
const MAX_AUDIT_BYTES = 1024 * 1024;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export const pairingCode = () => Array.from(randomBytes(6), byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');

const isLocalPath = value => {
  if (typeof value !== 'string') return false;
  return value.startsWith('/') || value.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(value) || value.includes('..');
};

// A path may travel only as a repo-relative path.
export function containsLocalPath(fields) {
  const found = [];
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (PATH_FIELDS.has(key)) { found.push(key); continue; }
    if (typeof value === 'string' && isLocalPath(value)) found.push(key);
    if (Array.isArray(value)) for (const item of value) if (typeof item === 'string' && isLocalPath(item)) found.push(key);
  }
  return [...new Set(found)];
}

// Rewrite a claim resource to a repo-relative path when it points inside the room.
export function repoRelative(resource, room) {
  if (typeof resource !== 'string' || !room) return resource;
  const normalized = resource.replace(/\\/g, '/');
  const root = room.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized.startsWith(root)) return resource;
  const relative = normalized.slice(root.length).replace(/^\/+/, '');
  return relative || '.';
}

const readJson = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
};

const writeJson = async (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), {mode: 0o600});
  await fs.rename(tmp, file);
};

// The token store: hashed tokens with a room, an agent-ID prefix, a runner and
// an expiry. Token values are never written down.
export class TokenStore {
  constructor(dataDir, {now = Date.now} = {}) {
    this.file = path.join(dataDir, 'remote-tokens.json');
    this.now = now;
    this.tokens = new Map();
    this.pairings = new Map();
  }
  async load() {
    const stored = await readJson(this.file, {tokens: [], pairings: []});
    this.tokens = new Map((stored.tokens ?? []).map(row => [row.id, row]));
    this.pairings = new Map((stored.pairings ?? []).map(row => [row.id, row]));
    this.stamp = await this.currentStamp();
    return this;
  }
  async save() {
    await writeJson(this.file, {tokens: [...this.tokens.values()], pairings: [...this.pairings.values()]});
  }
  // Another process (the CLI approving or revoking) writes the same file.
  // Reload so the gateway sees the change without a restart.
  async reload() {
    const stored = await readJson(this.file, {tokens: [], pairings: []});
    this.tokens = new Map((stored.tokens ?? []).map(row => [row.id, row]));
    this.pairings = new Map((stored.pairings ?? []).map(row => [row.id, row]));
    this.stamp = await this.currentStamp();
    return this;
  }
  async currentStamp() {
    try { const info = await fs.stat(this.file); return `${info.mtimeMs}:${info.size}`; }
    catch { return ''; }
  }
  // Cheap check: only read the file again when it actually changed.
  async sync() {
    const stamp = await this.currentStamp();
    if (stamp !== this.stamp) await this.reload();
    return this;
  }
  // Create a token. The value is returned once; only its hash is stored.
  issue({room, agentPrefix = '', runner = 'remote', ttlMs = 24 * 60 * 60 * 1000, alwaysOn = false}) {
    const value = randomToken();
    const id = randomUUID();
    const row = {
      id, hash: sha256(value), room, agentPrefix, runner,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: alwaysOn ? null : new Date(this.now() + ttlMs).toISOString(),
      lastUsedAt: null, revokedAt: null,
    };
    this.tokens.set(id, row);
    return {id, value, row};
  }
  // Find the token a bearer value belongs to, in constant time.
  find(value) {
    if (typeof value !== 'string' || value.length < 16) return null;
    const hash = sha256(value);
    for (const row of this.tokens.values()) {
      if (row.revokedAt) continue;
      const candidate = Buffer.from(row.hash, 'hex');
      const given = Buffer.from(hash, 'hex');
      if (candidate.length !== given.length) continue;
      if (!timingSafeEqual(candidate, given)) continue;
      if (row.expiresAt && new Date(row.expiresAt).getTime() <= this.now()) continue;
      return row;
    }
    return null;
  }
  touch(row) {
    row.lastUsedAt = new Date(this.now()).toISOString();
  }
  revoke(id) {
    const row = this.tokens.get(id);
    if (!row) return false;
    row.revokedAt = new Date(this.now()).toISOString();
    return true;
  }
  revokeAll() {
    let count = 0;
    for (const row of this.tokens.values()) if (!row.revokedAt) { row.revokedAt = new Date(this.now()).toISOString(); count++; }
    return count;
  }
  live() {
    return [...this.tokens.values()].filter(row => !row.revokedAt && (!row.expiresAt || new Date(row.expiresAt).getTime() > this.now()));
  }
  // A cloud agent asks to join. It gets a code to show its user.
  requestPairing({repo, branch = '', runner = 'remote', sessionId = ''}) {
    this.expirePairings();
    if (this.pairings.size >= MAX_PENDING_PAIRINGS) return {error: 'too_many_pending'};
    const code = pairingCode();
    const id = randomUUID();
    const row = {id, code, repo, branch, runner, sessionId, createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + PAIRING_TTL_MS).toISOString(), approvedAt: null, deniedAt: null, tokenId: null};
    this.pairings.set(id, row);
    return row;
  }
  expirePairings() {
    const now = this.now();
    for (const [id, row] of this.pairings) {
      if (new Date(row.expiresAt).getTime() <= now) this.pairings.delete(id);
    }
  }
  pendingPairings() {
    this.expirePairings();
    return [...this.pairings.values()].filter(row => !row.approvedAt && !row.deniedAt);
  }
  findPairing(idOrCode) {
    this.expirePairings();
    for (const row of this.pairings.values()) if (row.id === idOrCode || row.code === idOrCode) return row;
    return null;
  }
  approve(row, token, value) {
    row.approvedAt = new Date(this.now()).toISOString();
    row.tokenId = token.id;
    // The value is held only until the waiting agent collects it, then erased.
    row.tokenValue = value ?? null;
  }
  deny(row) {
    row.deniedAt = new Date(this.now()).toISOString();
  }
}

// Rate limiting: a token and an address each get their own bucket.
export class RateLimiter {
  constructor({perToken = 240, perIp = 240, windowMs = 60_000, now = Date.now} = {}) {
    this.perToken = perToken; this.perIp = perIp; this.windowMs = windowMs; this.now = now;
    this.buckets = new Map();
  }
  hit(key, limit) {
    const at = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.reset <= at) {
      this.buckets.set(key, {count: 1, reset: at + this.windowMs});
      return {allowed: true, remaining: limit - 1};
    }
    bucket.count++;
    if (bucket.count > limit) return {allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.reset - at) / 1000))};
    return {allowed: true, remaining: limit - bucket.count};
  }
  check(tokenId, ip) {
    const token = this.hit(`token:${tokenId}`, this.perToken);
    if (!token.allowed) return token;
    const address = this.hit(`ip:${ip}`, this.perIp);
    if (!address.allowed) return address;
    return {allowed: true};
  }
}

// An audit trail of what cloud agents did, without ever writing a token value.
export class AuditLog {
  constructor(dataDir, {now = Date.now} = {}) {
    this.file = path.join(dataDir, 'remote-audit.log');
    this.now = now;
  }
  async write(entry) {
    const line = JSON.stringify({at: new Date(this.now()).toISOString(), ...entry}) + '\n';
    // Keep the trail bounded: one rotated file beside it, then the newest wins.
    try {
      const info = await fs.stat(this.file);
      if (info.size > MAX_AUDIT_BYTES) await fs.rename(this.file, `${this.file}.1`);
    } catch { /* no file yet */ }
    await fs.appendFile(this.file, line, {mode: 0o600});
  }
  static async read(dataDir, limit = 200) {
    try {
      const text = await fs.readFile(path.join(dataDir, 'remote-audit.log'), 'utf8');
      return text.split('\n').filter(Boolean).slice(-limit).map(line => { try { return JSON.parse(line); } catch { return {raw: line}; } });
    } catch { return []; }
  }
}

// Nothing that names a local path may leave the machine: the room path becomes a dot,
// and everything inside it is rewritten to the repo-relative form.
export function scrubPaths(value, room) {
  if (!room) return value;
  const root = room.replace(/\\/g, '/').replace(/\/+$/, '');
  const walk = input => {
    if (typeof input === 'string') {
      if (!input.includes(root)) return input;
      return input.split(root).join('.');
    }
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(input)) out[key] = key === 'project' ? '.' : walk(item);
      return out;
    }
    return input;
  };
  return walk(value);
}

const readBody = async request => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

export function createGatewayHandler({store, limiter, audit, call, resolveRoom, dashboard = null, logger = null}) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');

    // The read-only dashboard rides on the same public URL, behind its own secret.
    if (dashboard && (url.pathname.startsWith('/api/v1/') || url.pathname.startsWith('/assets/') || dashboard.pages.has(url.pathname))) {
      return dashboard.handler(request, response);
    }
    const send = (status, body, headers = {}) => {
      response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers});
      response.end(JSON.stringify(body));
    };

    // Health is public and says nothing about the relay.
    if (request.method === 'GET' && url.pathname === '/health') {
      return send(200, {ok: true, service: 'agent-relay-gateway'});
    }

    // Pairing: the cloud agent asks to join.
    if (request.method === 'POST' && url.pathname === '/pair') {
      const ip = request.socket.remoteAddress ?? 'unknown';
      const limit = limiter.check('pair', ip);
      if (!limit.allowed) return send(429, {error: 'Too many pairing requests. Try again in a minute.'}, {'Retry-After': String(limit.retryAfter)});
      let body;
      try { body = await readBody(request); } catch (error) { return send(400, {error: error.message}); }
      if (!body.repo || typeof body.repo !== 'string') return send(400, {error: 'A repository is required.'});
      const row = store.requestPairing({repo: body.repo, branch: body.branch ?? '', runner: body.runner ?? 'remote', sessionId: body.sessionId ?? ''});
      if (row.error) return send(429, {error: 'Too many agents are waiting for approval. Approve or deny one first.'});
      await store.save();
      await audit.write({event: 'pair', repo: row.repo, branch: row.branch, runner: row.runner, result: 'pending'});
      return send(200, {requestId: row.id, code: row.code, expiresAt: row.expiresAt});
    }

    // The waiting agent polls for the outcome of its pairing request.
    if (request.method === 'GET' && url.pathname.startsWith('/pair/')) {
      const id = url.pathname.slice('/pair/'.length);
      const ip = request.socket.remoteAddress ?? 'unknown';
      const limit = limiter.check('pair-poll', ip);
      if (!limit.allowed) return send(429, {error: 'Too many polls. Try again in a minute.'}, {'Retry-After': String(limit.retryAfter)});
      // The approval happens in another process, so read the store again.
      await store.sync();
      await store.reload();
      const row = store.findPairing(id);
      if (!row) return send(404, {error: 'This pairing request is unknown or has expired.'});
      if (row.deniedAt) return send(403, {error: 'This request was denied.'});
      if (!row.approvedAt) return send(202, {status: 'pending', code: row.code});
      const token = store.tokens.get(row.tokenId);
      if (!token) return send(410, {error: 'That token has expired. Ask for a new one.'});
      const value = row.tokenValue ?? null;
      if (value) {
        // Hand it over once, then forget the value everywhere but the hash.
        row.tokenValue = null;
        await store.save();
      }
      return send(200, {status: 'approved', room: token.room, agentPrefix: token.agentPrefix, runner: token.runner, tokenId: token.id, token: value});
    }

    // Everything else needs a token.
    const authorization = request.headers.authorization ?? '';
    const value = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    await store.sync();
    let token = store.find(value);
    if (!token) { await store.reload(); token = store.find(value); }
    if (!token) {
      await audit.write({event: 'rpc', result: 'unauthorized'});
      return send(401, {error: 'This gateway needs a token from agent-relay remote approve.'});
    }
    const ip = request.socket.remoteAddress ?? 'unknown';
    const limit = limiter.check(token.id, ip);
    if (!limit.allowed) return send(429, {error: 'Too many requests. Slow down.'}, {'Retry-After': String(limit.retryAfter)});

    if (request.method !== 'POST' || url.pathname !== '/rpc') return send(404, {error: 'Unknown gateway endpoint.'});
    let body;
    try { body = await readBody(request); } catch (error) { return send(400, {error: error.message}); }

    const op = body.op;
    if (!op) return send(400, {error: 'An operation is required.'});
    if (DENIED_OPS.has(op)) {
      await audit.write({event: 'rpc', tokenId: token.id, runner: token.runner, room: token.room, op, result: 'denied'});
      return send(403, {error: `The operation ${op} is not available through the gateway: ${DENIED_OPS.get(op)}.`});
    }
    if (!ALLOWED_OPS.has(op)) {
      await audit.write({event: 'rpc', tokenId: token.id, runner: token.runner, room: token.room, op, result: 'unknown'});
      return send(403, {error: `The operation ${op} is not available through the gateway.`});
    }

    const fields = {...body};
    delete fields.op;
    delete fields.project;

    // The room comes from the token, never from the request.
    const room = token.room;

    // Claims inside the room become repo-relative before anything is checked.
    if (Array.isArray(fields.resources)) fields.resources = fields.resources.map(resource => repoRelative(resource, room));
    const paths = containsLocalPath(fields);
    if (paths.length) {
      await audit.write({event: 'rpc', tokenId: token.id, runner: token.runner, room, op, result: 'path-refused', fields: paths});
      return send(400, {error: `Local paths cannot cross the gateway: ${paths.join(', ')}. Use repo-relative paths.`});
    }

    // The agent id is scoped too: a token may only act for its own prefix.
    if (fields.agentId && token.agentPrefix && !fields.agentId.startsWith(token.agentPrefix)) {
      await audit.write({event: 'rpc', tokenId: token.id, runner: token.runner, room, op, result: 'agent-refused'});
      return send(403, {error: `This token may only act for agents starting with ${token.agentPrefix}.`});
    }

    try {
      const result = await call(room, {...fields, op});
      store.touch(token);
      await store.save();
      await audit.write({event: 'rpc', tokenId: token.id, runner: token.runner, room, op, result: 'ok'});
      return send(200, {ok: true, ...scrubPaths(result, room)});
    } catch (error) {
      await audit.write({event: 'rpc', tokenId: token.id, runner: token.runner, room, op, result: 'error', error: error.message});
      const status = error.code === 'UNKNOWN_OPERATION' ? 403 : 400;
      return send(status, {error: error.message, code: error.code ?? null});
    }
  };
}

export async function startGateway({dataDir, port = DEFAULT_GATEWAY_PORT, call = rpc, now = Date.now, host = '127.0.0.1', dashboard = null}) {
  await fs.mkdir(dataDir, {recursive: true, mode: 0o700});
  const store = await new TokenStore(dataDir, {now}).load();
  const limiter = new RateLimiter({now});
  const audit = new AuditLog(dataDir, {now});
  const handler = createGatewayHandler({store, limiter, audit, call, dashboard});
  const server = http.createServer(handler);
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    store,
    limiter,
    audit,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
