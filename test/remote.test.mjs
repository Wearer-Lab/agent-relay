import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startGateway, TokenStore, RateLimiter, containsLocalPath, repoRelative, sha256, ALLOWED_OPS, DENIED_OPS} from '../lib/gateway.mjs';
import {normalizeRepo, resolveRoom, branchOf, originOf} from '../lib/remote-rooms.mjs';
import {remoteRpc} from '../lib/client.mjs';

const temp = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-remote-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true, maxRetries: 15, retryDelay: 200}));
  return dir;
};

const gatewayWith = async (t, {call, ...options} = {}) => {
  const dataDir = await temp(t);
  const calls = [];
  const gateway = await startGateway({
    dataDir,
    // Port 0: the test files run in parallel and must not fight over one port.
    port: 0,
    call: call ?? (async (room, fields) => { calls.push([room, fields]); return {ok: true, echoed: fields}; }),
    ...options,
  });
  t.after(() => gateway.close());
  return {gateway, dataDir, calls};
};

const issue = async (gateway, {room = '/work/alpha', agentPrefix = '', runner = 'claude'} = {}) => {
  const token = gateway.store.issue({room, agentPrefix, runner});
  await gateway.store.save();
  return token;
};

test('the gateway allows the coordination operations and refuses the dangerous ones', async t => {
  const {gateway} = await gatewayWith(t);
  assert.ok(ALLOWED_OPS.has('send') && ALLOWED_OPS.has('claim') && ALLOWED_OPS.has('inbox'));
  for (const op of ['fetch', 'export', 'restore', 'prune', 'compact', 'usage', 'retire', 'processes']) {
    assert.ok(DENIED_OPS.has(op), `${op} should be named in the denied list`);
    assert.ok(!ALLOWED_OPS.has(op), `${op} should not be allowed`);
  }
  const token = await issue(gateway);
  const headers = {authorization: `Bearer ${token.value}`};
  const denied = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify({op: 'fetch', id: 'x'})});
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /attachments never leave the machine/);
  const unknown = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify({op: 'definitely-not-an-op'})});
  assert.equal(unknown.status, 403);
  const allowed = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify({op: 'agents'})});
  assert.equal(allowed.status, 200);
});

test('the gateway needs a token, and an unknown token is refused', async t => {
  const {gateway} = await gatewayWith(t);
  const none = await fetch(`${gateway.url}/rpc`, {method: 'POST', body: JSON.stringify({op: 'agents'})});
  assert.equal(none.status, 401);
  const wrong = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers: {authorization: 'Bearer nope'}, body: JSON.stringify({op: 'agents'})});
  assert.equal(wrong.status, 401);
  const health = await fetch(`${gateway.url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {ok: true, service: 'agent-relay-gateway'});
});

test('the room comes from the token, never from the request', async t => {
  const {gateway, calls} = await gatewayWith(t);
  const token = await issue(gateway, {room: '/work/alpha'});
  const response = await fetch(`${gateway.url}/rpc`, {
    method: 'POST', headers: {authorization: `Bearer ${token.value}`},
    body: JSON.stringify({op: 'status', project: '/work/somewhere-else'}),
  });
  assert.equal(response.status, 200);
  assert.equal(calls.at(-1)[0], '/work/alpha', 'the token decides the room');
  assert.equal(calls.at(-1)[1].project, undefined, 'the request cannot choose a room');
});

test('local paths never cross the gateway, and claims travel as repo-relative paths', async t => {
  const {gateway, calls} = await gatewayWith(t);
  const token = await issue(gateway, {room: '/work/alpha'});
  const headers = {authorization: `Bearer ${token.value}`};
  const absolute = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify({op: 'claim', resource: '/etc/passwd'})});
  assert.equal(absolute.status, 400);
  assert.match((await absolute.json()).error, /Local paths cannot cross the gateway/);
  const attachment = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify({op: 'send', attach: ['/work/alpha/secret.txt']})});
  assert.equal(attachment.status, 400);
  const inside = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify({op: 'claim', resources: ['/work/alpha/src/app.js']})});
  assert.equal(inside.status, 200);
  assert.deepEqual(calls.at(-1)[1].resources, ['src/app.js'], 'the claim became repo-relative');
  assert.ok(containsLocalPath({resource: '../escape'}).includes('resource'));
  assert.equal(repoRelative('/work/alpha/src/app.js', '/work/alpha'), 'src/app.js');
  assert.equal(repoRelative('/other/file.js', '/work/alpha'), '/other/file.js');
});

test('a token may only act for the agent prefix it was issued for', async t => {
  const {gateway} = await gatewayWith(t);
  const token = await issue(gateway, {agentPrefix: 'cloud-claude-'});
  const headers = {authorization: `Bearer ${token.value}`};
  const own = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify({op: 'status', agentId: 'cloud-claude-1'})});
  assert.equal(own.status, 200);
  const other = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify({op: 'status', agentId: 'local-codex-1'})});
  assert.equal(other.status, 403);
  assert.match((await other.json()).error, /may only act for agents starting with cloud-claude-/);
});

test('pairing asks for a code, approval hands over a token once, and the request expires', async t => {
  const {gateway, dataDir} = await gatewayWith(t);
  const paired = await fetch(`${gateway.url}/pair`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({repo: 'github.com/org/repo', runner: 'claude'})});
  assert.equal(paired.status, 200);
  const request = await paired.json();
  assert.match(request.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  const waiting = await fetch(`${gateway.url}/pair/${request.requestId}`);
  assert.equal(waiting.status, 202);

  const store = await new TokenStore(dataDir).load();
  const row = store.findPairing(request.code);
  const token = store.issue({room: '/work/alpha', runner: 'claude'});
  store.approve(row, token, token.value);
  await store.save();

  const approved = await fetch(`${gateway.url}/pair/${request.requestId}`);
  assert.equal(approved.status, 200);
  const body = await approved.json();
  assert.equal(body.status, 'approved');
  assert.equal(body.room, '/work/alpha');
  assert.ok(body.token, 'the agent receives a token');

  const again = await fetch(`${gateway.url}/pair/${request.requestId}`);
  assert.equal((await again.json()).token, null, 'the token value is handed over only once');

  const expired = await new TokenStore(dataDir, {now: () => Date.now() + 11 * 60 * 1000}).load();
  assert.equal(expired.findPairing(request.code), null, 'a pairing request expires after ten minutes');
});

test('tokens are stored as hashes, expire, and can be revoked', async t => {
  const dataDir = await temp(t);
  const store = await new TokenStore(dataDir).load();
  const token = store.issue({room: '/work/alpha', runner: 'claude', ttlMs: 1000});
  await store.save();
  const raw = JSON.parse(await fs.readFile(path.join(dataDir, 'remote-tokens.json'), 'utf8'));
  assert.equal(raw.tokens[0].hash, sha256(token.value), 'only the hash is stored');
  assert.ok(!JSON.stringify(raw).includes(token.value), 'the token value is never written down');
  assert.ok(store.find(token.value), 'the token works');
  store.revoke(token.id);
  await store.save();
  assert.equal(store.find(token.value), null, 'a revoked token stops working');
  const gone = await new TokenStore(dataDir).load();
  assert.equal(gone.find(token.value), null);
  const second = store.issue({room: '/work/alpha', ttlMs: 1000});
  const later = new TokenStore(dataDir, {now: () => Date.now() + 5000});
  assert.equal(later.find(second.value), null, 'an expired token stops working');
});

test('the gateway rate limits a token and an address', async () => {
  const limiter = new RateLimiter({perToken: 3, perIp: 10, windowMs: 60000});
  for (let i = 0; i < 3; i++) assert.equal(limiter.check('t1', '1.1.1.1').allowed, true);
  const blocked = limiter.check('t1', '1.1.1.1');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter > 0);
  assert.equal(limiter.check('t2', '2.2.2.2').allowed, true, 'another token has its own bucket');
});

test('the gateway refuses too many pairing requests at once', async t => {
  const {gateway} = await gatewayWith(t);
  for (let i = 0; i < 5; i++) {
    const response = await fetch(`${gateway.url}/pair`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({repo: 'github.com/org/repo'})});
    assert.equal(response.status, 200);
  }
  const sixth = await fetch(`${gateway.url}/pair`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({repo: 'github.com/org/repo'})});
  assert.equal(sixth.status, 429);
  assert.match((await sixth.json()).error, /Too many agents are waiting/);
});

test('the gateway writes an audit trail without token values', async t => {
  const {gateway, dataDir} = await gatewayWith(t);
  const token = await issue(gateway);
  await fetch(`${gateway.url}/rpc`, {method: 'POST', headers: {authorization: `Bearer ${token.value}`}, body: JSON.stringify({op: 'agents'})});
  await fetch(`${gateway.url}/rpc`, {method: 'POST', headers: {authorization: 'Bearer wrong'}, body: JSON.stringify({op: 'agents'})});
  const log = await fs.readFile(path.join(dataDir, 'remote-audit.log'), 'utf8');
  const rows = log.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(rows.some(row => row.event === 'rpc' && row.op === 'agents' && row.result === 'ok'));
  assert.ok(rows.some(row => row.result === 'unauthorized'));
  assert.ok(!log.includes(token.value), 'no token value reaches the log');
});

test('a repository is recognised in every spelling, and rooms resolve to the right checkout', async t => {
  assert.equal(normalizeRepo('https://github.com/org/repo.git'), 'github.com/org/repo');
  assert.equal(normalizeRepo('git@github.com:org/repo.git'), 'github.com/org/repo');
  assert.equal(normalizeRepo('github.com/org/repo'), 'github.com/org/repo');
  const dir = await temp(t);
  const project = path.join(dir, 'repo');
  await fs.mkdir(path.join(project, '.git'), {recursive: true});
  await fs.writeFile(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(path.join(project, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/org/repo.git\n');
  assert.equal(await originOf(project), 'github.com/org/repo');
  assert.equal(await branchOf(project), 'main');

  const rooms = [{project, branch: 'main', origin: 'github.com/org/repo', main: true}];
  assert.equal((await resolveRoom({repo: 'github.com/org/repo', rooms})).room, project);
  assert.equal((await resolveRoom({repo: 'git@github.com:org/repo.git', rooms})).room, project);
  assert.equal((await resolveRoom({repo: 'github.com/other/repo', rooms})).room, null);
  assert.equal((await resolveRoom({repo: 'github.com/org/repo', branch: 'feature', rooms})).room, project, 'the branch does not change the room here');
  const aliased = await resolveRoom({repo: 'github.com/fork/repo', rooms, aliases: {'github.com/fork/repo': project}});
  assert.equal(aliased.reason, 'alias');
  assert.equal(aliased.room, project, 'an alias wins over the repository match');
});

test('remote mode talks to the gateway and never starts a broker', async t => {
  const {gateway, calls} = await gatewayWith(t);
  const token = await issue(gateway, {room: '/work/alpha'});
  const previous = {url: process.env.AGENT_RELAY_URL, token: process.env.AGENT_RELAY_TOKEN};
  process.env.AGENT_RELAY_URL = gateway.url;
  process.env.AGENT_RELAY_TOKEN = token.value;
  t.after(() => {
    if (previous.url === undefined) delete process.env.AGENT_RELAY_URL; else process.env.AGENT_RELAY_URL = previous.url;
    if (previous.token === undefined) delete process.env.AGENT_RELAY_TOKEN; else process.env.AGENT_RELAY_TOKEN = previous.token;
  });
  const result = await remoteRpc('/work/alpha', {op: 'agents'});
  assert.equal(result.ok, true);
  assert.equal(calls.at(-1)[0], '/work/alpha');

  await assert.rejects(() => remoteRpc('/work/alpha', {op: 'fetch'}), error => error.code === 'OP_DENIED');
  await assert.rejects(() => remoteRpc('/work/alpha', {op: 'agents'}, {token: 'nope'}), error => error.code === 'TOKEN_REJECTED');
  await assert.rejects(() => remoteRpc('/work/alpha', {op: 'agents'}, {url: 'http://127.0.0.1:45999', token: token.value}), error => error.code === 'GATEWAY_OFF');
});
