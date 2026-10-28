import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startGateway, TokenStore, RateLimiter, containsLocalPath, repoRelative, sha256, ALLOWED_OPS, DENIED_OPS, MAX_CONCURRENT_WAITS} from '../lib/gateway.mjs';
import {normalizeRepo, resolveRoom, branchOf, originOf} from '../lib/remote-rooms.mjs';
import {approvalQuestion} from '../lib/remote.mjs';
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
  const headers = {authorization: `Bearer ${token.value}`};
  const response = await fetch(`${gateway.url}/rpc`, {
    method: 'POST', headers,
    body: JSON.stringify({op: 'status', project: '/work/somewhere-else'}),
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /bound to one room/);
  assert.equal(calls.length, 0, 'a call for another room never reaches the broker');
  const same = await fetch(`${gateway.url}/rpc`, {
    method: 'POST', headers,
    body: JSON.stringify({op: 'status', project: '/work/alpha'}),
  });
  assert.equal(same.status, 200);
  assert.equal(calls.at(-1)[0], '/work/alpha', 'the token room is the room');
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
  await store.handOver();
  await store.save();
  const names = await fs.readdir(dataDir);
  for (const name of names) {
    const full = path.join(dataDir, name);
    if (!(await fs.lstat(full)).isFile()) continue;
    const text = await fs.readFile(full, 'utf8');
    assert.ok(!text.includes(token.value), `${name} must not hold the token value`);
  }

  const approved = await fetch(`${gateway.url}/pair/${request.requestId}`);
  assert.equal(approved.status, 200);
  const body = await approved.json();
  assert.equal(body.status, 'approved');
  assert.equal(body.room, '.', 'the room path never leaves the machine');
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

test('the gateway never returns a local path', async t => {
  const {gateway} = await gatewayWith(t, {call: async (room) => ({ok: true, project: room, claims: [{resource: `${room}/src/app.js`}], agents: [{agentId: 'a', cwd: room}]})});
  const token = await issue(gateway, {room: '/work/alpha'});
  const response = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers: {authorization: `Bearer ${token.value}`}, body: JSON.stringify({op: 'agents'})});
  const body = await response.json();
  const text = JSON.stringify(body);
  assert.ok(!text.includes('/work/alpha'), 'the room path must not leave the machine');
  assert.equal(body.project, '.');
  assert.equal(body.claims[0].resource, './src/app.js');
});

test('the audit log is rotated instead of growing forever', async t => {
  const dataDir = await temp(t);
  const {AuditLog} = await import('../lib/gateway.mjs');
  const log = new AuditLog(dataDir);
  await log.write({event: 'test', result: 'ok'});
  const file = path.join(dataDir, 'remote-audit.log');
  await fs.writeFile(file, 'x'.repeat(1024 * 1024 + 10));
  await log.write({event: 'test', result: 'rotated'});
  const size = (await fs.stat(file)).size;
  assert.ok(size < 1024 * 1024, 'the live log stays small');
  const rotated = await fs.readFile(`${file}.1`, 'utf8');
  assert.ok(rotated.length > 1024 * 1024, 'the old log is kept beside it');
});

test('a Cloudflare Access token, when configured, is required', async t => {
  const {gateway} = await gatewayWith(t, {access: {clientId: 'id', clientSecret: 'secret'}});
  const token = await issue(gateway);
  const none = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers: {authorization: `Bearer ${token.value}`}, body: JSON.stringify({op: 'agents'})});
  assert.equal(none.status, 401);
  const wrong = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers: {authorization: `Bearer ${token.value}`, 'cf-access-client-id': 'id', 'cf-access-client-secret': 'nope'}, body: JSON.stringify({op: 'agents'})});
  assert.equal(wrong.status, 401);
  const right = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers: {authorization: `Bearer ${token.value}`, 'cf-access-client-id': 'id', 'cf-access-client-secret': 'secret'}, body: JSON.stringify({op: 'agents'})});
  assert.equal(right.status, 200);
});

test('a token cannot post as somebody else, nor force a release or sweep a room', async t => {
  const {gateway} = await gatewayWith(t);
  const token = await issue(gateway, {agentPrefix: 'cloud-'});
  const headers = {authorization: `Bearer ${token.value}`};
  const post = body => fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify(body)});

  // `from` is the sender a message claims, and `agentId` is the agent it acts
  // as: a request that carries both must be checked against both.
  const own = await post({op: 'send', agentId: 'cloud-1', from: 'cloud-1', to: 'cloud-2', body: 'hi'});
  assert.equal(own.status, 200);
  const masked = await post({op: 'send', agentId: 'cloud-1', from: 'local-codex-1', to: 'cloud-2', body: 'hi'});
  assert.equal(masked.status, 403, 'a local sender cannot hide behind an allowed agentId');
  assert.match((await masked.json()).error, /may only act for agents starting with cloud-/);

  const forced = await post({op: 'release', agentId: 'cloud-1', force: true, resources: ['src/app.js']});
  assert.equal(forced.status, 403);
  assert.match((await forced.json()).error, /forced release needs a local human/);
  const sweep = await post({op: 'leave', agentId: 'cloud-1', stale: true, apply: true});
  assert.equal(sweep.status, 403);
  assert.match((await sweep.json()).error, /bulk sweep/);
});

test('a path inside a nested object is refused too', async t => {
  const {gateway} = await gatewayWith(t);
  const token = await issue(gateway);
  const nested = await fetch(`${gateway.url}/rpc`, {
    method: 'POST', headers: {authorization: `Bearer ${token.value}`},
    body: JSON.stringify({op: 'status', agentId: 'cloud-1', task: {file: '/etc/passwd'}}),
  });
  assert.equal(nested.status, 400);
  assert.match((await nested.json()).error, /Local paths cannot cross the gateway/);
});

test('concurrent pairings do not take the gateway down', async t => {
  const {gateway} = await gatewayWith(t);
  const answers = await Promise.all(Array.from({length: 6}, () => fetch(`${gateway.url}/pair`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({repo: 'github.com/org/repo', runner: 'claude'}),
  })));
  for (const answer of answers) assert.ok(answer.status === 200 || answer.status === 429, `got ${answer.status}`);
  const health = await fetch(`${gateway.url}/health`);
  assert.equal(health.status, 200, 'the gateway is still answering');
});

test('a revoke is not undone by a write that started before it', async t => {
  const {gateway, dataDir} = await gatewayWith(t);
  const token = await issue(gateway);
  const {TokenStore} = await import('../lib/gateway.mjs');
  const store = await new TokenStore(dataDir).load();
  store.revoke(token.id);
  await store.save();
  // The gateway still has the token in memory from before the revoke.
  const response = await fetch(`${gateway.url}/rpc`, {
    method: 'POST', headers: {authorization: `Bearer ${token.value}`},
    body: JSON.stringify({op: 'agents'}),
  });
  assert.equal(response.status, 401, 'a revoked token stops working even if a request was in flight');
});

test('a pairing request is bounded and free of control characters', async t => {
  const {gateway} = await gatewayWith(t);
  const huge = await fetch(`${gateway.url}/pair`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({repo: 'x'.repeat(400)}),
  });
  assert.equal(huge.status, 400);
  const escape = await fetch(`${gateway.url}/pair`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({repo: '\u001b[31mgithub.com/org/repo\u001b[0m'}),
  });
  assert.equal(escape.status, 200);
  const {TokenStore} = await import('../lib/gateway.mjs');
  const store = await new TokenStore(gateway.store.file.replace(/remote-tokens\.json$/, '')).load();
  const pending = store.pendingPairings();
  assert.ok(pending.every(row => !/[\u0000-\u001f]/u.test(row.repo)), 'no control character is stored');
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

test('the approval question names the checkout before the operator says yes', () => {
  assert.equal(approvalQuestion('K7Q2PX', '/work/alpha'), 'Approve K7Q2PX for /work/alpha? [y/N] ');
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
  const unmatched = await resolveRoom({repo: 'github.com/org/repo', branch: 'feature', rooms});
  assert.equal(unmatched.room, null, 'a named branch with no checkout on it is not the main checkout');
  assert.equal(unmatched.reason, 'branch-unmatched');
  const feature = path.join(dir, 'feature');
  const withFeature = [...rooms, {project: feature, branch: 'feature', origin: 'github.com/org/repo', main: false}];
  assert.equal((await resolveRoom({repo: 'github.com/org/repo', branch: 'feature', rooms: withFeature})).room, feature, 'a checkout on the named branch wins');
  assert.equal((await resolveRoom({repo: 'github.com/org/repo', rooms: withFeature})).reason, 'main-checkout', 'no named branch still falls back to main');
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

test('a token is bound to one identity once the agent has registered', async t => {
  const {gateway, calls} = await gatewayWith(t);
  const token = await issue(gateway);
  const headers = {authorization: `Bearer ${token.value}`};
  const post = body => fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify(body)});

  // Before the agent registers, a read has no identity to read as.
  const early = await post({op: 'history', agentId: 'cloud-1'});
  assert.equal(early.status, 403);
  assert.match((await early.json()).error, /Register first/);

  const registered = await post({op: 'register', agentId: 'cloud-1', runner: 'claude'});
  assert.equal(registered.status, 200);

  // The token is bound now: a second identity is refused.
  const other = await post({op: 'register', agentId: 'cloud-2', runner: 'claude'});
  assert.equal(other.status, 403);
  assert.match((await other.json()).error, /bound to the agent cloud-1/);
  const asOther = await post({op: 'inbox', agentId: 'cloud-2'});
  assert.equal(asOther.status, 403, 'a token cannot read another identity\'s inbox');
  const asSelf = await post({op: 'inbox', agentId: 'cloud-1'});
  assert.equal(asSelf.status, 200, 'the bound identity still works');

  // A request that names no agent at all is read as the bound one, never as
  // the whole room.
  const anonymous = await post({op: 'history'});
  assert.equal(anonymous.status, 200);
  const history = await anonymous.json();
  assert.ok(history.ok, 'the request went through');
});

test('the rate limiter has an address bucket of its own, and the window resets', () => {
  let clock = 1_000_000;
  const limiter = new RateLimiter({perToken: 10, perIp: 2, windowMs: 1000, now: () => clock});
  assert.equal(limiter.check('t1', '1.1.1.1').allowed, true);
  assert.equal(limiter.check('t2', '1.1.1.1').allowed, true);
  const blocked = limiter.check('t3', '1.1.1.1');
  assert.equal(blocked.allowed, false, 'the address bucket is separate from the token bucket');
  assert.ok(blocked.retryAfter >= 1);
  assert.equal(limiter.check('t4', '2.2.2.2').allowed, true, 'another address has its own bucket');
  clock += 1001;
  assert.equal(limiter.check('t5', '1.1.1.1').allowed, true, 'the window resets');
});

test('a paired token is kept for one gateway and one repository only', async t => {
  const http = await import('node:http');
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const execFileAsync = promisify(execFile);

  // A checkout with an origin, so the client knows what to pair with.
  const dir = await temp(t);
  const project = path.join(dir, 'project');
  await fs.mkdir(project);
  await execFileAsync('git', ['init', '-q', project]);
  await execFileAsync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.com/org/repo.git']);

  // A fake gateway that pairs on request and says what it was given.
  const fake = async (label) => {
    const state = {pairs: 0, tokens: []};
    const server = http.createServer((req, res) => {
      const answer = (code, body) => { res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(body)); };
      if (req.method === 'POST' && req.url === '/pair') {
        state.pairs++;
        return answer(200, {requestId: `req-${state.pairs}`, code: 'ABC123'});
      }
      if (req.method === 'GET' && req.url.startsWith('/pair/')) {
        return answer(200, {status: 'approved', room: '.', token: `token-${label}`});
      }
      state.tokens.push(req.headers.authorization ?? '');
      return answer(200, {ok: true, label});
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    return {url: `http://127.0.0.1:${server.address().port}`, state};
  };

  const first = await fake('first');
  const second = await fake('second');

  // The client polls for the approval; a short interval keeps the test quick.
  const one = await remoteRpc(project, {op: 'agents'}, {url: first.url, pollMs: 20});
  assert.equal(one.label, 'first');
  assert.equal(first.state.pairs, 1, 'the client paired once');
  const two = await remoteRpc(project, {op: 'agents'}, {url: first.url, pollMs: 20});
  assert.equal(two.label, 'first');
  assert.equal(first.state.pairs, 1, 'the token is reused for the same gateway');

  // Another gateway must not get the first token.
  const three = await remoteRpc(project, {op: 'agents'}, {url: second.url, pollMs: 20});
  assert.equal(three.label, 'second');
  assert.equal(second.state.pairs, 1, 'the second gateway had to pair on its own');
  assert.ok(second.state.tokens.every(value => value === 'Bearer token-second'),
    'no token from another gateway is sent');
  assert.ok(first.state.tokens.every(value => value === 'Bearer token-first'),
    'the first gateway only ever saw its own token');
});

test('a token may hold a few waits, and one more is refused with Retry-After', async t => {
  let started = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const {gateway} = await gatewayWith(t, {call: async (_room, fields) => {
    if (fields.op === 'wait') { started += 1; await gate; }
    return {ok: true};
  }});
  const token = await issue(gateway);
  const headers = {authorization: `Bearer ${token.value}`, 'content-type': 'application/json'};
  const open = [];
  for (let i = 0; i < MAX_CONCURRENT_WAITS; i++) {
    open.push(fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify({op: 'wait', agentId: 'a'})}));
  }
  const deadline = Date.now() + 2000;
  while (started < MAX_CONCURRENT_WAITS && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(started, MAX_CONCURRENT_WAITS);
  try {
    const extra = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify({op: 'wait', agentId: 'a'})});
    assert.equal(extra.status, 429);
    assert.equal(extra.headers.get('retry-after'), '1');
    assert.match((await extra.json()).error, /Too many open waits for this token/);
  } finally {
    release();
  }
  const finished = await Promise.all(open);
  assert.ok(finished.every(response => response.status === 200));
});

test('a token is a grant over one room and one identity', async t => {
  const {gateway, calls} = await gatewayWith(t);
  const token = await issue(gateway, {room: '/work/alpha', agentPrefix: 'cloud-'});
  const headers = {authorization: `Bearer ${token.value}`, 'content-type': 'application/json'};
  const post = fields => fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify(fields)});

  const otherRoom = await post({op: 'agents', project: '/work/elsewhere'});
  assert.equal(otherRoom.status, 403);
  assert.match((await otherRoom.json()).error, /bound to one room/);
  assert.equal(calls.length, 0, 'a call for another room never reaches the broker');

  const sameRoom = await post({op: 'agents', project: '/work/alpha'});
  assert.equal(sameRoom.status, 200);
  assert.equal(calls.at(-1)[0], '/work/alpha');
  const omitted = await post({op: 'register', agentId: 'cloud-1', runner: 'claude'});
  assert.equal(omitted.status, 200);
  assert.equal(gateway.store.find(token.value).agentId, 'cloud-1');

  const otherAgent = await post({op: 'status', agentId: 'cloud-2'});
  assert.equal(otherAgent.status, 403);
  assert.match((await otherAgent.json()).error, /bound to the agent cloud-1/);
  const rebound = await post({op: 'register', agentId: 'cloud-2', runner: 'claude'});
  assert.equal(rebound.status, 403);
  assert.equal(gateway.store.find(token.value).agentId, 'cloud-1', 'a bound token does not take a second identity');

  const own = await post({op: 'claim', resources: ['src/app.js']});
  assert.equal(own.status, 200);
  assert.equal(calls.at(-1)[1].agentId, 'cloud-1', 'the bound identity is imposed when the call omits it');
  assert.equal(calls.at(-1)[0], '/work/alpha');
});

test('an always-on token expires, and use renews it; a paired token does not slide', async t => {
  const dataDir = await temp(t);
  let now = 1_700_000_000_000;
  const store = await new TokenStore(dataDir, {now: () => now}).load();
  const paired = store.issue({room: '/work/alpha', ttlMs: 1000});
  const always = store.issue({room: '/work/alpha', ttlMs: 1000, alwaysOn: true});
  assert.equal(paired.row.sliding, false);
  assert.equal(always.row.sliding, true);
  assert.ok(always.row.expiresAt, 'an always-on token has an expiry');
  const pairedExpiry = paired.row.expiresAt;
  const alwaysExpiry = always.row.expiresAt;
  now += 400;
  store.touch(paired.row);
  store.touch(always.row);
  assert.equal(paired.row.expiresAt, pairedExpiry, 'a paired session keeps the expiry it was issued with');
  assert.notEqual(always.row.expiresAt, alwaysExpiry, 'use renews an always-on token');
  now = Date.parse(always.row.expiresAt) + 1;
  assert.equal(store.find(always.value), null, 'an always-on token dies when it is left unused');
  now = Date.parse(pairedExpiry) - 1;
  assert.ok(store.find(paired.value), 'the paired token is still inside its original window');
  // A row from before this change has no expiry and no sliding flag. It is left alone.
  store.tokens.set('old', {id: 'old', hash: sha256('legacy-always-on-token-value'), room: '/work/alpha', agentPrefix: '', runner: 'claude', agentId: null, expiresAt: null, revokedAt: null});
  assert.ok(store.find('legacy-always-on-token-value'), 'an already-issued always-on token with no expiry stays valid');
});
