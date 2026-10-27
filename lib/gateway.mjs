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
import {localRpc} from './client.mjs';

export const DEFAULT_GATEWAY_PORT = 47820;
// The pending pairing requests live here, not in the broker. The dashboard reads them
// from this one route; it can show them, never approve or deny them.
export const PAIRINGS_PATH = '/api/v1/pairings';

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
  ['pending', 'the backlog breakdown stays on this machine'],
  ['staleClaims', 'the claim view stays on this machine'],
  ['processes', 'process records stay on this machine'],
  ['retire', 'identities cannot be retired from outside'],
  ['forceRelease', 'a forced release needs a local human'],
]);

// Work that is allowed by name but refused by shape.
export const deniedShape = (op, fields = {}) => {
  if (op === 'release' && fields.force === true) return 'A forced release needs a local human.';
  if (op === 'leave' && ['stale', 'idleHours', 'prefix', 'runner'].some(key => fields[key] !== undefined)) {
    return 'A bulk sweep of identities needs a local human.';
  }
  if (op === 'register' && fields.actor !== undefined) return 'The actor of a registration is decided by the gateway.';
  return null;
};

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
export function containsLocalPath(fields, {depth = 0} = {}) {
  const found = [];
  const walk = (value, key, level) => {
    if (level > 4) return;
    if (PATH_FIELDS.has(key)) { found.push(key); return; }
    if (typeof value === 'string') { if (isLocalPath(value)) found.push(key); return; }
    if (Array.isArray(value)) { for (const item of value) walk(item, key, level + 1); return; }
    if (value && typeof value === 'object') { for (const [inner, item] of Object.entries(value)) walk(item, inner, level + 1); }
  };
  for (const [key, value] of Object.entries(fields ?? {})) walk(value, key, depth);
  return [...new Set(found)];
}

// Rewrite a claim resource to a repo-relative path when it points inside the room.
export function repoRelative(resource, room) {
  if (typeof resource !== 'string' || !room) return resource;
  const normalized = resource.replace(/\\/g, '/');
  const root = room.replace(/\\/g, '/').replace(/\/+$/, '');
  // Inside the room means the same path or a child of it: a plain string
  // prefix would turn /work/application/x into "lication/x".
  if (!(normalized === root || normalized.startsWith(root + '/'))) return resource;
  const relative = normalized.slice(root.length).replace(/^\/+/, '');
  return relative || '.';
}

const readJson = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
};

// The temporary name has to be unique per write: two concurrent writes that
// share a name make the second rename fail, and an unhandled rejection takes
// the whole gateway down.
const writeJson = async (file, value) => {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), {mode: 0o600});
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, {force: true}).catch(() => {});
    throw error;
  }
};

// A lock file, so the gateway and the CLI never write the store at the same time.
const withLock = async (file, fn, {timeout = 5000} = {}) => {
  const lock = `${file}.lock`;
  const deadline = Date.now() + timeout;
  let handle = null;
  for (;;) {
    try { handle = await fs.open(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() > deadline) {
        // A lock left behind by a crashed process must not block the relay.
        await fs.rm(lock, {force: true}).catch(() => {});
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await fn(); }
  finally { await handle.close().catch(() => {}); await fs.rm(lock, {force: true}).catch(() => {}); }
};

// The token store: hashed tokens with a room, an agent-ID prefix, a runner and
// an expiry. Token values are never written down.
export class TokenStore {
  constructor(dataDir, {now = Date.now} = {}) {
    this.file = path.join(dataDir, 'remote-tokens.json');
    // The value of a token that was approved but not yet collected. It lives in its own file
    // for a few minutes, not in the token store: only the hash of a token is ever stored.
    this.pendingFile = path.join(dataDir, 'remote-pending-tokens.json');
    this.now = now;
    this.tokens = new Map();
    this.pairings = new Map();
    this.pending = new Map();
  }
  async load() {
    const stored = await readJson(this.file, {tokens: [], pairings: []});
    this.tokens = new Map((stored.tokens ?? []).map(row => [row.id, row]));
    this.pairings = new Map((stored.pairings ?? []).map(row => [row.id, row]));
    this.pending = new Map(Object.entries(await readJson(this.pendingFile, {})));
    this.stamp = await this.currentStamp();
    return this;
  }
  /**
   * Write the store without losing the other process's work, and without
   * bringing a revoked token back to life.
   *
   * The gateway and the CLI both write this file. The rows are merged by id and
   * the file is written under a lock, so a request that started before the
   * operator revoked a token cannot write the old row back.
   */
  async save() {
    await withLock(this.file, async () => {
      const stored = await readJson(this.file, {tokens: [], pairings: []});
      const merge = (mine, theirs) => {
        const out = new Map((theirs ?? []).map(row => [row.id, row]));
        for (const row of mine) {
          const previous = out.get(row.id);
          if (!previous) { out.set(row.id, row); continue; }
          // A revocation or an expiry on disk is final: it is never overwritten
          // with an older value from memory.
          const merged = {...previous, ...row};
          if (previous.revokedAt && !row.revokedAt) merged.revokedAt = previous.revokedAt;
          if (previous.expiresAt && !row.expiresAt) merged.expiresAt = previous.expiresAt;
          out.set(row.id, merged);
        }
        return [...out.values()];
      };
      const tokens = merge(this.tokens.values(), stored.tokens);
      const pairings = merge(this.pairings.values(), stored.pairings);
      // A pairing row never carries a token value: the value waits in the pending file.
      await writeJson(this.file, {tokens, pairings: pairings.map(({tokenValue, ...row}) => row)});
    });
    // The pending values live in their own file. Merging never removes one, so a stale
    // in-memory map cannot drop a value another process is still holding.
    const onDisk = await readJson(this.pendingFile, {});
    await writeJson(this.pendingFile, {...onDisk, ...Object.fromEntries(this.pending)});
  }
  async savePending() {
    await writeJson(this.pendingFile, Object.fromEntries(this.pending));
  }
  /** Forget one pending value, in memory and on disk, so it can never be handed over twice. */
  async removePending(id) {
    this.pending.delete(id);
    const onDisk = await readJson(this.pendingFile, {});
    delete onDisk[id];
    await writeJson(this.pendingFile, onDisk);
  }
  // Another process (the CLI approving or revoking) writes the same file.
  // Reload so the gateway sees the change without a restart.
  async reload() {
    const stored = await readJson(this.file, {tokens: [], pairings: []});
    this.tokens = new Map((stored.tokens ?? []).map(row => [row.id, row]));
    this.pairings = new Map((stored.pairings ?? []).map(row => [row.id, row]));
    this.pending = new Map(Object.entries(await readJson(this.pendingFile, {})));
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
      // The identity this token acts as. It is bound on the first registration
      // and never widened afterwards: a token that can act as anybody is a
      // token that can be anybody.
      agentId: null,
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
      // A hand-edited or truncated row must not throw out of the handler.
      if (typeof row.hash !== 'string' || !/^[0-9a-f]{64}$/iu.test(row.hash)) continue;
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
    // Only the rows that are still waiting count: an approved or a denied
    // request must not keep the next agent out.
    if (this.pendingPairings().length >= MAX_PENDING_PAIRINGS) return {error: 'too_many_pending'};
    const code = pairingCode();
    const id = randomUUID();
    const row = {id, code, repo, branch, runner, sessionId, createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + PAIRING_TTL_MS).toISOString(), approvedAt: null, deniedAt: null, tokenId: null};
    this.pairings.set(id, row);
    return row;
  }
  expirePairings() {
    const now = this.now();
    for (const [id, row] of this.pairings) {
      if (new Date(row.expiresAt).getTime() <= now) {
        this.pairings.delete(id);
        // The handover value goes with it: a token nobody collected must not
        // sit on the disk for the life of the installation.
        this.pending.delete(id);
      }
    }
  }
  pendingPairings() {
    this.expirePairings();
    return [...this.pairings.values()].filter(row => !row.approvedAt && !row.deniedAt);
  }
  /**
   * Find a pairing by its id or by its code. The code is what a person reads off a screen,
   * so it stays a local lookup: the gateway never accepts a code over the wire.
   */
  findPairing(idOrCode) {
    this.expirePairings();
    for (const row of this.pairings.values()) if (row.id === idOrCode || row.code === idOrCode) return row;
    return null;
  }
  /** The only lookup the public endpoint may use: the request id, never the code. */
  findPairingById(id) {
    this.expirePairings();
    for (const row of this.pairings.values()) if (row.id === id) return row;
    return null;
  }
  approve(row, token, value) {
    row.approvedAt = new Date(this.now()).toISOString();
    row.tokenId = token.id;
    // The value waits in the pending file, not in the token store, and only until the
    // waiting agent collects it.
    if (value) this.pending.set(row.id, value);
  }
  /** The value of an approved token, handed over exactly once. */
  collectValue(row) {
    const value = this.pending.get(row.id) ?? null;
    if (value !== null) { this.pending.delete(row.id); }
    return value;
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
    this.sampled = new Map();
  }
  /** One line per event and source per minute, so a flood cannot drown the trail. */
  shouldWrite(event, key = '', {windowMs = 60000} = {}) {
    const id = `${event}:${key}`;
    const at = this.now();
    const last = this.sampled.get(id);
    if (last !== undefined && at - last < windowMs) return false;
    this.sampled.set(id, at);
    return true;
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
  const root = room ? room.replace(/\\/g, '/').replace(/\/+$/, '') : '';
  const walk = input => {
    if (typeof input === 'string') {
      // The room root first, so a path inside it becomes relative.
      const text = root && input.includes(root) ? input.split(root).join('.') : input;
      // Any other absolute path is a local path too, and it does not cross.
      return text.replace(/(^|[\s'"(])(\/[A-Za-z0-9._-][^\s'"),;]*)/gu, (all, before, absolute) => {
        const base = absolute.split('/').filter(Boolean).pop() ?? '';
        return `${before}./${base}`;
      }).replace(/[A-Za-z]:\\[^\s'"),;]*/gu, (all) => `./${all.split(/[\\/]/).filter(Boolean).pop() ?? ''}`);
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

// A pairing request lands in the operator's terminal, so every field is
// bounded and stripped of control characters: a 200 KB "repository" carrying
// ANSI escapes must not be able to rewrite the approval prompt.
export const validatePairing = body => {
  const field = (value, max) => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') return null;
    const clean = value.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
    if (clean.length > max) return null;
    return clean;
  };
  const repo = field(body?.repo, 200);
  if (!repo) return {error: 'A repository of at most 200 characters is required.'};
  const branch = field(body?.branch, 200);
  const runner = field(body?.runner, 80);
  const sessionId = field(body?.sessionId, 120);
  if (branch === null || runner === null || sessionId === null) return {error: 'A pairing request field is too long.'};
  return {repo, branch, runner: runner || 'remote', sessionId};
};

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

export function createGatewayHandler({store, limiter, audit, call, resolveRoom, dashboard = null, access = null, logger = null}) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const replyJson = (status, body, headers = {}) => {
      response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers});
      response.end(JSON.stringify(body));
    };

    // A Cloudflare Access service token, when one is configured, is required.
    if (access) {
      const givenId = request.headers['cf-access-client-id'] ?? '';
      const givenSecret = request.headers['cf-access-client-secret'] ?? '';
      const matches = givenId.length === access.clientId.length && givenSecret.length === access.clientSecret.length
        && timingSafeEqual(Buffer.from(givenId), Buffer.from(access.clientId))
        && timingSafeEqual(Buffer.from(givenSecret), Buffer.from(access.clientSecret));
      if (!matches) return replyJson(401, {error: 'This gateway needs a Cloudflare Access service token.'});
    }

    const send = (status, body, headers = {}) => {
      response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers});
      response.end(JSON.stringify(body));
    };

    // The pending pairing requests are the gateway's own. The dashboard may show them,
    // read-only: it never approves or denies anything, and only a GET is answered.
    if (dashboard && request.method === 'GET' && url.pathname === PAIRINGS_PATH) {
      if (!dashboard.secret) return send(404, {error: 'Not found.'});
      const expected = Buffer.from(`Bearer ${dashboard.secret}`);
      const given = Buffer.from(request.headers.authorization ?? '');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return send(401, {error: 'Open the dashboard using its CLI link.'});
      }
      await store.sync();
      const body = {available: true, pairings: store.pendingPairings().map(row => ({
        code: row.code, runner: row.runner, repo: row.repo, branch: row.branch,
        createdAt: row.createdAt, expiresAt: row.expiresAt,
      }))};
      // The tower polls this every few seconds: an unchanged list answers 304.
      const tag = `"${createHash('sha256').update(JSON.stringify(body)).digest('hex')}"`;
      if (request.headers['if-none-match'] === tag) {
        response.writeHead(304, {'Cache-Control': 'no-store', ETag: tag});
        response.end();
        return;
      }
      return send(200, body, {ETag: tag});
    }

    // The read-only dashboard rides on the same public URL, behind its own secret.
    // The page set comes from the dashboard's own routes, with and without the
    // trailing slash, so a path that is one slash short is a redirect and not a 401.
    if (dashboard && (url.pathname.startsWith('/api/v1/') || url.pathname.startsWith('/assets/')
        || dashboard.pages.has(url.pathname) || dashboard.pages.has(url.pathname + '/'))) {
      return dashboard.handler(request, response);
    }

    // Health is public and says nothing about the relay.
    if (request.method === 'GET' && url.pathname === '/health') {
      return send(200, {ok: true, service: 'agent-relay-gateway'});
    }

    // The address the request really came from. Behind a tunnel every caller
    // shares one loopback address, so the forwarded address is the one that
    // matters.
    const ip = String(request.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
      || (request.socket.remoteAddress ?? 'unknown');

    // Pairing: the cloud agent asks to join.
    if (request.method === 'POST' && url.pathname === '/pair') {
      const limit = limiter.check('pair', ip);
      if (!limit.allowed) return send(429, {error: 'Too many pairing requests. Try again in a minute.'}, {'Retry-After': String(limit.retryAfter)});
      // A browser on another site must not be able to fill the approval list.
      if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) {
        return send(403, {error: 'This gateway does not accept cross-origin pairing requests.'});
      }
      let body;
      try { body = await readBody(request); } catch (error) { return send(400, {error: error.message}); }
      const pairing = validatePairing(body);
      if (pairing.error) return send(400, {error: pairing.error});
      const row = store.requestPairing(pairing);
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
      // Only the request id works here. The six-character code is what a person reads off a
      // screen and shows it to the agent; if the endpoint accepted it, the code would be a
      // bearer secret that hands out a token to whoever guessed it.
      const row = store.findPairingById(id);
      if (!row) return send(404, {error: 'This pairing request is unknown or has expired.'});
      if (row.deniedAt) return send(403, {error: 'This request was denied.'});
      if (!row.approvedAt) return send(202, {status: 'pending', code: row.code});
      const token = store.tokens.get(row.tokenId);
      if (!token) return send(410, {error: 'That token has expired. Ask for a new one.'});
      const value = store.collectValue(row);
      if (value !== null) {
        // Hand it over once, then forget the value everywhere but the hash.
        await store.removePending(row.id);
      }
      // The room path never leaves the machine, not even in the pairing answer.
      return send(200, {status: 'approved', room: '.', agentPrefix: token.agentPrefix, runner: token.runner, tokenId: token.id, token: value});
    }

    // Everything else needs a token. The limit runs first: an unauthenticated
    // flood must not be able to spend the broker's time or the audit trail.
    const limit = limiter.check(`ip:${ip}`, ip);
    if (!limit.allowed) return send(429, {error: 'Too many requests. Slow down.'}, {'Retry-After': String(limit.retryAfter)});
    const authorization = request.headers.authorization ?? '';
    const value = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    await store.sync();
    let token = store.find(value);
    if (!token) { await store.reload(); token = store.find(value); }
    if (!token) {
      // One audit line per rejected request would drown the trail.
      if (audit.shouldWrite('unauthorized', ip)) await audit.write({event: 'rpc', result: 'unauthorized', ip});
      return send(401, {error: 'This gateway needs a token from agent-relay remote approve.'});
    }
    const tokenLimit = limiter.check(token.id, ip);
    if (!tokenLimit.allowed) return send(429, {error: 'Too many requests. Slow down.'}, {'Retry-After': String(tokenLimit.retryAfter)});

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
    // Some dangerous work hides inside an allowed operation, so the shape is
    // checked too: a forced release and a bulk sweep both need a human.
    const shape = deniedShape(op, body);
    if (shape) {
      await audit.write({event: 'rpc', tokenId: token.id, runner: token.runner, room: token.room, op, result: 'denied', why: shape});
      return send(403, {error: shape});
    }

    const fields = {...body};
    delete fields.op;
    delete fields.project;

    // The room comes from the token, never from the request.
    const room = token.room;

    // The actor is the gateway's business, not the caller's.
    delete fields.actor;

    // Claims inside the room become repo-relative before anything is checked.
    if (Array.isArray(fields.resources)) fields.resources = fields.resources.map(resource => repoRelative(resource, room));
    const paths = containsLocalPath(fields);
    if (paths.length) {
      await audit.write({event: 'rpc', tokenId: token.id, runner: token.runner, room, op, result: 'path-refused', fields: paths});
      return send(400, {error: `Local paths cannot cross the gateway: ${paths.join(', ')}. Use repo-relative paths.`});
    }

    // The agent id is scoped too: a token may only act for its own prefix. A send names
    // the sender in `from`, so BOTH spellings are checked: `agentId ?? from` would let a
    // request that carries an allowed agentId carry a local `from` and post a message
    // that claims to come from a local agent.
    const identities = [fields.agentId, fields.from].filter(value => typeof value === 'string' && value);
    for (const identity of identities) {
      if (token.agentPrefix && !identity.startsWith(token.agentPrefix)) {
        await audit.write({event: 'rpc', tokenId: token.id, runner: token.runner, room, op, result: 'agent-refused', identity});
        return send(403, {error: `This token may only act for agents starting with ${token.agentPrefix}.`});
      }
    }
    // Once a token has registered, it is bound to that one identity: it reads
    // only that agent's conversations and writes only as that agent.
    if (token.agentId) {
      for (const identity of identities) {
        if (identity !== token.agentId) {
          await audit.write({event: 'rpc', tokenId: token.id, runner: token.runner, room, op, result: 'identity-refused', identity});
          return send(403, {error: `This token is bound to the agent ${token.agentId}.`});
        }
      }
      // The identity is not merely checked, it is imposed. A request that names
      // no agent at all would otherwise read the whole room.
      if (op === 'send' || op === 'outbox') fields.from = token.agentId;
      else if (op !== 'register') fields.agentId = token.agentId;
    } else if (op === 'history' || op === 'inbox' || op === 'outbox') {
      // Reading needs an identity to read as, and the token does not have one
      // until the agent registers. Registering is the first thing a cloud agent
      // does, so this window is short.
      await audit.write({event: 'rpc', tokenId: token.id, runner: token.runner, room, op, result: 'unbound'});
      return send(403, {error: 'Register first: a token is bound to one agent, and that agent is not known yet.'});
    }

    // The gateway is the only place that knows a request came through it, so it is the
    // only place that may say so. The marker rides along with the register and send
    // requests; the broker records it on the agent row and on the message row, and the
    // dashboard reads it back from there. A client cannot claim to be local or cloud.
    if (op === 'register' || op === 'send') {
      fields.cloud = {runner: token.runner, prefix: token.agentPrefix};
    }

    try {
      const result = await call(room, {...fields, op});
      // The first successful registration binds the token to that identity.
      if (op === 'register' && typeof fields.agentId === 'string' && fields.agentId) token.agentId = fields.agentId;
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

export async function startGateway({dataDir, port = DEFAULT_GATEWAY_PORT, call = null, now = Date.now, host = '127.0.0.1', dashboard = null, access = null}) {
  await fs.mkdir(dataDir, {recursive: true, mode: 0o700});
  const store = await new TokenStore(dataDir, {now}).load();
  const limiter = new RateLimiter({now});
  const audit = new AuditLog(dataDir, {now});
  // The gateway always talks to the local broker. With AGENT_RELAY_URL set in
  // the environment it would otherwise call the relay it is serving.
  const localCall = call ?? ((room, fields) => localRpc(room, fields, {dataDir}));
  const handler = createGatewayHandler({store, limiter, audit, call: localCall, dashboard, access});
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
