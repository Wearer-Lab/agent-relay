import http from 'node:http';
import {projectSummaries,roomSnapshot,machineClaims,projectClaims} from './observability.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const MAX_REQUEST = 128 * 1024;
const MAX_STORE = 64 * 1024 * 1024;
const MAX_MESSAGES = 10000;
const MAX_CLAIMS = 4096;
const MAX_NOTICES = 1024;
const activeStores = new Set();
const namedResources = new Set(['build', 'install', 'native']);

class RpcError extends Error {
  constructor(code, message, httpStatus = 400, details) {
    super(message);
    Object.assign(this, { code, httpStatus, details });
  }
}
function fail(code, message, status = 400, details) {
  throw new RpcError(code, message, status, details);
}
function text(value, field, max = 128, trim = true) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max
      || (field !== 'body' && /[\u0000-\u001f]/u.test(value))) {
    fail('INVALID_INPUT', `${field} must be a nonempty bounded string.`);
  }
  return trim ? value.trim() : value;
}
function strings(value, field, allowEmpty = false) {
  if (!Array.isArray(value) || value.length > 64 || (!allowEmpty && value.length === 0)) {
    fail('INVALID_INPUT', `${field} must contain ${allowEmpty ? 'up to' : '1 to'} 64 strings.`);
  }
  return [...new Set(value.map(item => text(item, field, 4096)))];
}
function within(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}
async function canonicalProject(value) {
  const input = text(value, 'project', 4096);
  if (!path.isAbsolute(input)) fail('INVALID_PROJECT', 'project must be an absolute existing directory.');
  try {
    const canonical = await fs.realpath(input);
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch { fail('INVALID_PROJECT', 'project must be an absolute existing directory.'); }
}
async function canonicalResource(project, resource) {
  if (namedResources.has(resource)) return resource;
  const candidate = path.resolve(project, resource);
  const suffix = [];
  let ancestor = candidate;
  let canonical;
  for (;;) {
    try { canonical = path.resolve(await fs.realpath(ancestor), ...suffix); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  if (!within(project, canonical)) fail('INVALID_RESOURCE', 'Path resources must stay inside the project.');
  return canonical;
}
function resourceConflict(a, b) {
  if (namedResources.has(a) || namedResources.has(b)) return a === b;
  if (process.platform === 'win32') { a = a.toLowerCase(); b = b.toLowerCase(); }
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
    || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

export function validateStore(state) {
  const corrupt = () => { throw new Error('Relay state is corrupt or unsupported; retained without modification.'); };
  const isText = (v, limit = 4096) => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= limit;
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.nextCursor)
      || state.nextCursor < 1 || !Array.isArray(state.rooms) || state.rooms.length > 256) corrupt();
  const projects = new Set();
  const cursors = new Set();
  let largest = 0, messageCount = 0;
  for (const room of state.rooms) {
    if (!room || !isText(room.project) || !path.isAbsolute(room.project) || projects.has(room.project)
        || !Array.isArray(room.agents) || room.agents.length > 256 || !Array.isArray(room.messages)
        || !Array.isArray(room.claims) || room.claims.length > MAX_CLAIMS
        || !Number.isSafeInteger(room.cursor) || room.cursor < 0) corrupt();
    projects.add(room.project);
    const agents = new Set();
    for (const agent of room.agents) {
      if (!agent || !isText(agent.agentId, 128) || agents.has(agent.agentId)
          || !isText(agent.runner, 80) || !isText(agent.registeredAt) || !isText(agent.updatedAt)
          || !isText(agent.status, 80) || typeof agent.frozen !== 'boolean'
          || !Array.isArray(agent.resources) || agent.resources.length > 64
          || agent.resources.some(r => !isText(r))) corrupt();
      if (agent.sessionId !== undefined && !isText(agent.sessionId, 256)) corrupt();
      if (agent.task !== null && typeof agent.task !== 'string'
          && (!agent.task || typeof agent.task !== 'object' || Array.isArray(agent.task))) corrupt();
      if (Buffer.byteLength(JSON.stringify(agent.task)) > 8192) corrupt();
      agents.add(agent.agentId);
    }
    const ids = new Set();
    let roomLargest = 0;
    for (const message of room.messages) {
      if (!message || !isText(message.messageId, 128) || ids.has(message.messageId)
          || !agents.has(message.from) || !isText(message.to, 128) || !isText(message.body, 16384)
          || !isText(message.createdAt) || !Number.isSafeInteger(message.cursor) || message.cursor < 1
          || cursors.has(message.cursor) || !Array.isArray(message.recipients) || message.recipients.length === 0
          || new Set(message.recipients).size !== message.recipients.length
          || message.recipients.some(id => !agents.has(id)) || !Array.isArray(message.ackedBy)
          || new Set(message.ackedBy).size !== message.ackedBy.length
          || message.ackedBy.some(id => !message.recipients.includes(id)) || !Array.isArray(message.notified)
          || message.notified.length > MAX_NOTICES) corrupt();
      if (message.to !== '*' && (message.recipients.length !== 1 || message.recipients[0] !== message.to)) corrupt();
      if (message.to === '*' && message.recipients.includes(message.from)) corrupt();
      if (message.replyTo !== undefined && !isText(message.replyTo, 128)) corrupt();
      if (message.notified.some(n => !n || !message.recipients.includes(n.agentId)
          || !isText(n.adapter, 80) || !isText(n.at))) corrupt();
      ids.add(message.messageId); cursors.add(message.cursor);
      largest = Math.max(largest, message.cursor); roomLargest = Math.max(roomLargest, message.cursor);
      messageCount++;
    }
    if (room.cursor !== roomLargest) corrupt();
    if (room.messages.some(m => m.replyTo !== undefined && !ids.has(m.replyTo))) corrupt();
    const resources = new Set();
    for (const claim of room.claims) {
      if (!claim || !agents.has(claim.agentId) || !isText(claim.resource) || resources.has(claim.resource)
          || !isText(claim.claimedAt) || (!namedResources.has(claim.resource)
            && (!path.isAbsolute(claim.resource) || !within(room.project, claim.resource)))) corrupt();
      resources.add(claim.resource);
    }
    for (let i = 0; i < room.claims.length; i++) {
      for (let j = i + 1; j < room.claims.length; j++) {
        if (room.claims[i].agentId !== room.claims[j].agentId
            && resourceConflict(room.claims[i].resource, room.claims[j].resource)) corrupt();
      }
    }
  }
  if (state.machineClaims !== undefined) {
    if (!Array.isArray(state.machineClaims) || state.machineClaims.length > MAX_CLAIMS) corrupt();
    const resources = new Set();
    for (const c of state.machineClaims) {
      if (!c || !isText(c.resource,128) || resources.has(c.resource) || !isText(c.claimedAt)
          || !state.rooms.find(r=>r.project===c.project)?.agents.some(a=>a.agentId===c.agentId)) corrupt();
      resources.add(c.resource);
    }
  }
  if (state.releaseLog !== undefined && (!Array.isArray(state.releaseLog) || state.releaseLog.length>10000
      || state.releaseLog.some(e=>!e||!isText(e.as,128)||!isText(e.at)||!isText(e.project)||!Array.isArray(e.released)))) corrupt();
  if (messageCount > MAX_MESSAGES || state.nextCursor !== largest + 1) corrupt();
}

async function readBody(request) {
  if (Number(request.headers['content-length']) > MAX_REQUEST)
    fail('REQUEST_TOO_LARGE', 'Request exceeds 128 KiB.', 413);
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_REQUEST) fail('REQUEST_TOO_LARGE', 'Request exceeds 128 KiB.', 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('INVALID_JSON', 'Request must be a JSON object.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_JSON', 'Request must be a JSON object.');
  return value;
}
function json(response, status, value) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

// Startup discovery is separate from ownership of the durable writer. A
// proven-dead lease may be reclaimed, but ambiguous ownership fails closed.
async function writerLease(directory) {
  const file = path.join(directory, 'writer.lock');
  const recovery = path.join(directory, 'writer-recovery.lock');
  const nonce = randomUUID();
  const bytes = JSON.stringify({ version: 1, pid: process.pid, nonce });
  async function exists(name) {
    try { await fs.stat(name); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function removeOwn(name, expected) {
    try { if (await fs.readFile(name, 'utf8') === expected) await fs.unlink(name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function create(name, content) {
    const handle = await fs.open(name, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
  }
  async function acquire(recovering = false) {
    if (!recovering && await exists(recovery)) throw new Error('Writer recovery ownership is unknown; retained for manual inspection.');
    await create(file, bytes);
    // A recovery claimant may appear between the precheck and exclusive
    // creation. This lease cannot activate while its sentinel exists.
    if (!recovering && await exists(recovery)) {
      await removeOwn(file, bytes);
      throw new Error('Writer recovery is in progress; retry startup.');
    }
  }
  try { await acquire(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let sentinel = false;
    try {
      await create(recovery, bytes);
      sentinel = true;
      const retained = await fs.readFile(file, 'utf8');
      let owner;
      try { owner = JSON.parse(retained); } catch { throw new Error('Writer lock is corrupt or ownership is unknown; retained.'); }
      if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1
          || typeof owner.nonce !== 'string' || !owner.nonce) throw new Error('Writer ownership is unknown; retained.');
      try {
        process.kill(owner.pid, 0);
        throw new Error('Another live broker owns this data directory.');
      } catch (probe) {
        if (probe.code !== 'ESRCH') throw new Error('Another live broker owns this data directory, or ownership cannot be proved dead.');
      }
      // Every new lease checks the sentinel before activation, and only one
      // recoverer can hold it. No active writer can replace this dead lease.
      if (await fs.readFile(file, 'utf8') !== retained) throw new Error('Writer ownership changed during recovery; retry startup.');
      await fs.unlink(file);
      await acquire(true);
    } finally {
      if (sentinel) await removeOwn(recovery, bytes);
    }
  }
  return () => removeOwn(file, bytes);
}

/** Caller owns startup discovery; this function exclusively owns the writer. */
export async function createBroker({ dataDir, port = 0, serverFactory = http.createServer, staleMinutes = 30 } = {}) {
  if (!Number.isFinite(staleMinutes)||staleMinutes<0) throw new Error('Invalid stale presence threshold.');
  if (!path.isAbsolute(dataDir ?? '') || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('An absolute dataDir and a valid TCP port are required.');
  }
  const directory = await fs.realpath(dataDir);
  if (!(await fs.stat(directory)).isDirectory()) throw new Error('dataDir must be a directory.');
  if (activeStores.has(directory)) throw new Error('A broker already owns this data directory in this process.');
  activeStores.add(directory);
  const stateFile = path.join(directory, 'state.json');
  const tokenFile = path.join(directory, 'token');
  let server;
  let releaseLease;
  let state, token, closing = false, faulted = false;
  let writer = Promise.resolve();
  const waiters = new Set();

  async function persist(next) {
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > MAX_STORE) fail('STORE_LIMIT', 'Relay history reached its storage bound.', 409);
    const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
    let renamed = false;
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
      await fs.rename(temporary, stateFile);
      renamed = true;
      let dir;
      try { dir = await fs.open(directory, 'r'); await dir.sync(); }
      catch (error) {
        // Directory flushing is unavailable on Windows and some filesystems.
        if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)
            && !(process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code))) throw error;
      } finally { await dir?.close(); }
    } catch (error) {
      // A failure after replacement has an unknown durable result. Never
      // overwrite it using the older in-memory snapshot; require restart.
      if (renamed) faulted = true;
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }
  function serial(operation) {
    const result = writer.then(() => {
      if (closing || faulted) fail('BROKER_UNAVAILABLE', 'Broker is closing or requires restart.', 503);
      return operation();
    });
    writer = result.catch(() => {});
    return result;
  }
  function roomFor(project, required = true) {
    const room = state.rooms.find(r => r.project === project);
    if (!room && required) fail('UNKNOWN_ROOM', 'Register an agent in this project first.', 404);
    return room;
  }
  function agentFor(room, value) {
    const id = text(value, 'agentId');
    const agent = room.agents.find(a => a.agentId === id);
    if (!agent) fail('UNKNOWN_AGENT', 'Agent is not registered in this project.', 404);
    return agent;
  }
  function messageFor(room, value, agentId) {
    const message = room.messages.find(m => m.messageId === text(value, 'messageId'));
    if (!message || !message.recipients.includes(agentId)) fail('UNKNOWN_MESSAGE', 'No recipient message with that ID exists in this project.', 404);
    return message;
  }
  function inbox(room, agentId, unacked = true, after = 0) {
    return room.messages.filter(m => m.recipients.includes(agentId) && m.cursor > after
      && (!unacked || !m.ackedBy.includes(agentId))).map(m => ({
        messageId: m.messageId, from: m.from, to: m.to, body: m.body,
        ...(m.replyTo !== undefined ? { replyTo: m.replyTo } : {}), createdAt: m.createdAt,
        cursor: m.cursor, recipients: [...m.recipients], acked: m.ackedBy.includes(agentId),
        notified: m.notified.filter(n => n.agentId === agentId).map(n => ({ ...n }))
      }));
  }
  function wake() {
    for (const waiter of [...waiters]) {
      const room = roomFor(waiter.project);
      const messages = inbox(room, waiter.agentId, true, waiter.after);
      if (messages.length) waiter.finish({ messages, cursor: room.cursor });
    }
  }
  async function change(mutator) {
    const next = structuredClone(state);
    const result = await mutator(next);
    validateStore(next);
    await persist(next);
    state = next;
    wake();
    return result;
  }
  function longPoll(project, room, agentId, after, timeoutMs, response) {
    const ready = inbox(room, agentId, true, after);
    if (ready.length || timeoutMs === 0 || response.destroyed) return Promise.resolve({ messages: ready, cursor: room.cursor });
    return new Promise(resolve => {
      const waiter = { project, agentId, after, finish: result => {
        if (!waiters.delete(waiter)) return;
        clearTimeout(timer);
        response.off('close', aborted);
        resolve(result);
      } };
      const aborted = () => waiter.finish({ messages: [], cursor: roomFor(project).cursor });
      const timer = setTimeout(aborted, timeoutMs);
      response.once('close', aborted);
      waiters.add(waiter);
    });
  }

  async function rpc(input, response) {
    const op = text(input.op, 'op', 32);
    if (op === 'capabilities') return {features:["inbox-filters", "bulk-ack", "machine-claims"]};
    if (op === 'rooms') return serial(() => ({rooms: projectSummaries(state)}));
    // Retained rooms remain observable even if their project directory moved.
    const project = op === 'snapshot' && state.rooms.some(r => r.project === input.project)
      ? input.project : await canonicalProject(input.project);
    // Install a waiter while holding the same serial turn as its inbox read;
    // release the writer immediately, never await its long poll in the writer.
    if (op === 'wait') {
      const after = input.after ?? 0;
      const timeoutMs = input.timeoutMs ?? 25000;
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(timeoutMs)
          || timeoutMs < 0 || timeoutMs > 30000) fail('INVALID_INPUT', 'Invalid wait cursor or timeout.');
      let pending;
      await serial(() => {
        const room = roomFor(project);
        const agent = agentFor(room, input.agentId);
        pending = longPoll(project, room, agent.agentId, after, timeoutMs, response);
      });
      return pending;
    }
    return serial(async () => {
      if (op === 'register') {
        const agentId = text(input.agentId, 'agentId');
        const runner = text(input.runner, 'runner', 80);
        const sessionId = input.sessionId === undefined ? undefined : text(input.sessionId, 'sessionId', 256);
        return change(next => {
          let room = next.rooms.find(r => r.project === project);
          if (!room) {
            if (next.rooms.length >= 256) fail('ROOM_LIMIT', 'Too many project rooms.', 409);
            next.rooms.push(room = { project, agents: [], messages: [], claims: [], cursor: 0 });
          }
          let agent = room.agents.find(a => a.agentId === agentId);
          const now = new Date().toISOString();
          if (!agent) {
            if (room.agents.length >= 256) fail('AGENT_LIMIT', 'Too many registered agents.', 409);
            room.agents.push(agent = { agentId, runner, registeredAt: now, updatedAt: now,
              status: 'idle', frozen: false, resources: [], task: null });
          }
          agent.runner = runner; agent.updatedAt = now;
          if (sessionId !== undefined) agent.sessionId = sessionId;
          return { agent };
        });
      }
      if (op === 'snapshot') {
        const limit = input.limit ?? 100;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('INVALID_INPUT', 'Snapshot limit must be between 1 and 200.');
        return roomSnapshot(project, roomFor(project, false), limit, state, staleMinutes);
      }
      if (op === 'agents') {
        const room = roomFor(project, false);
        const threshold=input.staleMinutes??staleMinutes;
        if (!Number.isFinite(threshold)||threshold<0) fail('INVALID_INPUT','Invalid stale minutes.');
        return structuredClone({ agents: room?.agents??[], claims: [...projectClaims(room,threshold),...machineClaims(state,threshold)], cursor: room?.cursor ?? 0 });
      }
      const room = roomFor(project);
      if (op === 'send') {
        const from = agentFor(room, input.from).agentId;
        const to = text(input.to, 'to');
        const body = text(input.body, 'body', 16384, false);
        const messageId = input.messageId === undefined ? randomUUID() : text(input.messageId, 'messageId');
        const replyTo = input.replyTo === undefined ? undefined : text(input.replyTo, 'replyTo');
        const prior = room.messages.find(m => m.messageId === messageId);
        if (prior) {
          if (prior.from !== from || prior.to !== to || prior.body !== body || prior.replyTo !== replyTo)
            fail('MESSAGE_ID_CONFLICT', 'Message ID already belongs to different content.', 409);
          return { messageId, recipients: [...prior.recipients], duplicate: true, cursor: prior.cursor };
        }
        const recipients = to === '*' ? room.agents.filter(a => a.agentId !== from).map(a => a.agentId)
          : [agentFor(room, to).agentId];
        if (!recipients.length) fail('NO_RECIPIENTS', 'No registered recipient exists.', 409);
        if (replyTo !== undefined && !room.messages.some(m => m.messageId === replyTo))
          fail('UNKNOWN_REPLY', 'Reply target does not exist in this project.', 404);
        if (state.rooms.reduce((count, r) => count + r.messages.length, 0) >= MAX_MESSAGES)
          fail('MESSAGE_LIMIT', 'Relay history reached its message bound.', 409);
        return change(next => {
          const target = next.rooms.find(r => r.project === project);
          const cursor = next.nextCursor++;
          target.cursor = cursor;
          target.messages.push({ messageId, from, to, body, ...(replyTo ? { replyTo } : {}),
            createdAt: new Date().toISOString(), cursor, recipients, ackedBy: [], notified: [] });
          return { messageId, recipients, duplicate: false, cursor };
        });
      }
      if (op === 'release' && input.force === true) {
        const as=text(input.agentId,'human ID');
        if (!input.resources?.length) fail('INVALID_INPUT','Forced release requires explicit resources.');
        const machine=input.scope==='machine';
        if (input.scope!==undefined&&!['machine','project'].includes(input.scope)) fail('INVALID_INPUT','Invalid scope.');
        const resources=machine?strings(input.resources,'resources').map(r=>text(r,'machine resource')):
          await Promise.all(strings(input.resources,'resources').map(r=>canonicalResource(project,r)));
        return change(next=>{
          const target=machine?next:next.rooms.find(r=>r.project===project),key=machine?'machineClaims':'claims';
          const released=(target[key]??[]).filter(c=>resources.includes(c.resource));
          target[key]=(target[key]??[]).filter(c=>!resources.includes(c.resource));
          if ((next.releaseLog??[]).length>=10000) fail('LOG_LIMIT','Forced release log reached its bound.',409);
          (next.releaseLog??=[]).push({as,at:new Date().toISOString(),project,scope:machine?'machine':'project',released});
          return {released,claims:target[key]};
        });
      }
      const agentId = agentFor(room, input.agentId).agentId;
      if (op === 'inbox') {
        if (input.unacked !== undefined && typeof input.unacked !== 'boolean') fail('INVALID_INPUT', 'unacked must be boolean.');
        const since = input.since ?? 0, limit = input.limit ?? MAX_MESSAGES;
        if (!Number.isSafeInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGES)
          fail('INVALID_INPUT', 'Invalid inbox cursor or limit.');
        const from = input.from === undefined ? undefined : text(input.from, 'from');
        const messages = inbox(room, agentId, input.unacked ?? true, since).filter(m => from === undefined || m.from === from).slice(0, limit);
        return { messages, cursor: messages.at(-1)?.cursor ?? since, roomCursor: room.cursor };
      }
      if (op === 'ack' || op === 'notified') {
        if (op === 'ack' && (input.all !== undefined || input.through !== undefined)) {
          if ((input.all !== undefined && input.all !== true) || (input.through !== undefined && (!Number.isSafeInteger(input.through) || input.through < 0))
              || input.messageId !== undefined || (input.all && input.through !== undefined)) fail('INVALID_INPUT', 'Choose id, all, or through.');
          return change(next => {
            const messages = next.rooms.find(r => r.project === project).messages.filter(m => m.recipients.includes(agentId)
              && !m.ackedBy.includes(agentId) && (input.all || m.cursor <= input.through));
            for (const m of messages) m.ackedBy.push(agentId);
            return { acked: messages.length };
          });
        }
        const message = messageFor(room, input.messageId, agentId);
        const adapter = op === 'notified' ? text(input.adapter, 'adapter', 80) : undefined;
        const duplicate = op === 'ack' ? message.ackedBy.includes(agentId)
          : message.notified.some(n => n.agentId === agentId && n.adapter === adapter);
        if (duplicate) return { messageId: message.messageId, acked: message.ackedBy.includes(agentId), duplicate: true };
        if (op === 'notified' && message.notified.length >= MAX_NOTICES)
          fail('NOTICE_LIMIT', 'Message transport metadata reached its bound.', 409);
        return change(next => {
          const target = next.rooms.find(r => r.project === project).messages.find(m => m.messageId === message.messageId);
          if (op === 'ack') target.ackedBy.push(agentId);
          else target.notified.push({ agentId, adapter, at: new Date().toISOString() });
          return { messageId: target.messageId, acked: target.ackedBy.includes(agentId), duplicate: false };
        });
      }
      if (op === 'status') {
        const patch = {};
        if (input.status !== undefined) patch.status = text(input.status, 'status', 80);
        if (input.frozen !== undefined) {
          if (typeof input.frozen !== 'boolean') fail('INVALID_INPUT', 'frozen must be boolean.');
          patch.frozen = input.frozen;
        }
        if (input.resources !== undefined) patch.resources = strings(input.resources, 'resources', true);
        if (input.task !== undefined) {
          if (input.task !== null && typeof input.task !== 'string'
              && (!input.task || typeof input.task !== 'object' || Array.isArray(input.task))) fail('INVALID_INPUT', 'Invalid task metadata.');
          if (Buffer.byteLength(JSON.stringify(input.task)) > 8192) fail('INVALID_INPUT', 'Task metadata exceeds 8 KiB.');
          patch.task = input.task;
        }
        if (!Object.keys(patch).length) return { agent: structuredClone(agentFor(room, agentId)), claims: [...projectClaims(room,staleMinutes),...machineClaims(state,staleMinutes)] };
        return change(next => {
          const agent = next.rooms.find(r => r.project === project).agents.find(a => a.agentId === agentId);
          Object.assign(agent, patch, { updatedAt: new Date().toISOString() });
          return { agent, claims: [...projectClaims(next.rooms.find(r=>r.project===project),staleMinutes),...machineClaims(next,staleMinutes)] };
        });
      }
      if (op === 'claim' || op === 'release') {
        if (input.scope!==undefined&&!['machine','project'].includes(input.scope)) fail('INVALID_INPUT','Invalid scope.');
        if (input.scope==='machine') {
          const resources=input.resources===undefined&&op==='release'?undefined:strings(input.resources,'resources').map(r=>text(r,'machine resource'));
          const claims=state.machineClaims??[];
          const own=c=>c.agentId===agentId&&c.project===project;
          const conflicts=claims.filter(c=>!own(c)&&resources?.includes(c.resource));
          if(op==='claim'&&conflicts.length)fail('CLAIM_CONFLICT','Machine resources are already claimed; no claim was acquired.',409,{conflicts});
          return change(next=>{
            const rows=next.machineClaims??=[];
            if(op==='release'){
              const released=rows.filter(c=>own(c)&&(resources===undefined||resources.includes(c.resource)));
              next.machineClaims=rows.filter(c=>!released.includes(c));return {released,claims:next.machineClaims};
            }
            if(rows.length+resources.filter(r=>!rows.some(c=>c.resource===r)).length>MAX_CLAIMS)fail('CLAIM_LIMIT','Machine claims reached their bound.',409);
            for(const resource of resources)if(!rows.some(c=>c.resource===resource))rows.push({agentId,project,resource,claimedAt:new Date().toISOString()});
            return {claims:rows,owned:rows.filter(own)};
          });
        }
        const resources = input.resources === undefined && op === 'release' ? undefined
          : await Promise.all(strings(input.resources, 'resources').map(r => canonicalResource(project, r)));
        if (op === 'claim') {
          const conflicts = room.claims.filter(c => c.agentId !== agentId
            && resources.some(r => resourceConflict(c.resource, r)));
          if (conflicts.length) fail('CLAIM_CONFLICT', 'Resources are already claimed; no claim was acquired.', 409, { conflicts });
        }
        return change(next => {
          const target = next.rooms.find(r => r.project === project);
          if (op === 'release') {
            const released = target.claims.filter(c => c.agentId === agentId
              && (resources === undefined || resources.includes(c.resource))).map(c => c.resource);
            target.claims = target.claims.filter(c => c.agentId !== agentId
              || (resources !== undefined && !resources.includes(c.resource)));
            return { released, claims: target.claims };
          }
          if (target.claims.length + resources.filter(resource => !target.claims.some(c => c.resource === resource)).length > MAX_CLAIMS)
            fail('CLAIM_LIMIT', 'Project resource claims reached their bound.', 409);
          for (const resource of resources) {
            if (!target.claims.some(c => c.agentId === agentId && c.resource === resource))
              target.claims.push({ agentId, resource, claimedAt: new Date().toISOString() });
          }
          return { claims: target.claims, owned: target.claims.filter(c => c.agentId === agentId) };
        });
      }
      fail('UNKNOWN_OPERATION', 'Unknown broker operation.');
    });
  }

  try {
    releaseLease = await writerLease(directory);
    try {
      const bytes = await fs.readFile(stateFile);
      if (bytes.length > MAX_STORE) throw new Error('Relay state exceeds its storage bound.');
      state = JSON.parse(bytes.toString('utf8'));
      validateStore(state);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = { version: 1, nextCursor: 1, rooms: [] };
      await persist(state);
    }
    try {
      token = (await fs.readFile(tokenFile, 'utf8')).trim();
      if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error('Relay token is corrupt; retained without modification.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      token = randomBytes(32).toString('hex');
      const file = await fs.open(tokenFile, 'wx', 0o600);
      try { await file.writeFile(token + '\n'); await file.sync(); }
      finally { await file.close(); }
    }
    const expectedAuthorization = Buffer.from('Bearer ' + token);
    server = serverFactory(async (request, response) => {
      try {
        if (request.method === 'GET' && request.url === '/health') {
          json(response, 200, { ok: true, version: 1 }); return;
        }
        if (request.method !== 'POST' || request.url !== '/rpc') fail('NOT_FOUND', 'Endpoint not found.', 404);
        const authorization = Buffer.from(request.headers.authorization ?? '');
        if (authorization.length !== expectedAuthorization.length
            || !timingSafeEqual(authorization, expectedAuthorization)) fail('UNAUTHORIZED', 'Bearer token required.', 401);
        const result = await rpc(await readBody(request), response);
        json(response, 200, { ok: true, ...result });
      } catch (error) {
        json(response, error.httpStatus ?? 503, { ok: false, error: {
          code: error instanceof RpcError ? error.code : 'STORE_IO',
          message: error instanceof RpcError ? error.message : 'Broker could not complete the request.',
          ...(error instanceof RpcError && error.details ? error.details : {})
        } });
      }
    });
    server.requestTimeout = 35000;
    server.headersTimeout = 10000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    let closePromise;
    const close = () => closePromise ??= (async () => {
      closing = true;
      for (const waiter of [...waiters]) waiter.finish({ messages: [], cursor: roomFor(waiter.project).cursor });
      await writer;
      await new Promise(resolve => server.close(resolve));
      await releaseLease();
      activeStores.delete(directory);
    })();
    return { url: `http://127.0.0.1:${server.address().port}`, token, close };
  } catch (error) {
    server?.close();
    await releaseLease?.();
    activeStores.delete(directory);
    throw error;
  }
}
