// The remote end-to-end tests.
//
// The story the roadmap asks for: a remote-mode client never starts a broker,
// the pairing round trip works, the tools behave the same through the
// gateway, and the whole thing works through a tunnel provider without a
// network or a leftover process.
//
// Everything here runs on macOS, Linux and Windows: no fixed port, no shell
// script, no unbounded sleep. Ports are always ephemeral.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createBroker} from '../lib/broker.mjs';
import {startGateway, TokenStore, RateLimiter, AuditLog, createGatewayHandler} from '../lib/gateway.mjs';
import {rpc, remoteRpc} from '../lib/client.mjs';
import {remoteApprove, remoteRevoke, remoteStatus, remoteDoctor, writeState} from '../lib/remote.mjs';
import {planRemoteHost, writeRemoteHostArtifacts, remoteHostInstructions, pointLocalAtHost} from '../lib/remote-host.mjs';
import {createFakeTunnel} from './support/fake-tunnel.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const clientUrl = pathToFileURL(path.join(repoRoot, 'lib', 'client.mjs')).href;

// A temporary directory that goes away with the test.
const temp = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-remote-e2e-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true, maxRetries: 15, retryDelay: 200}));
  return dir;
};

// A checkout the room resolver recognises: a git origin, a branch, a file.
const checkout = async (dir, {repo = 'github.com/org/repo', branch = 'main'} = {}) => {
  const project = path.join(dir, 'project');
  await fs.mkdir(path.join(project, '.git'), {recursive: true});
  await fs.writeFile(path.join(project, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  await fs.writeFile(path.join(project, '.git', 'config'), `[remote "origin"]\n\turl = https://${repo}.git\n`);
  await fs.mkdir(path.join(project, 'src'), {recursive: true});
  await fs.writeFile(path.join(project, 'src', 'app.js'), 'export const app = 1;\n');
  // The broker canonicalises the project with realpath, so the room key is the
  // real path. Everything below uses the same string.
  return fs.realpath(project);
};

// The broker, with the discovery file the local client looks for.
const brokerFor = async t => {
  const directory = await temp(t);
  const broker = await createBroker({dataDir: directory, port: 0});
  t.after(() => broker.close());
  await fs.writeFile(
    path.join(directory, 'broker.json'),
    JSON.stringify({pid: process.pid, url: broker.url, token: broker.token, api: '/api/v1/rpc'}),
    {mode: 0o600},
  );
  return {broker, dataDir: directory};
};

// The same call the gateway makes: one RPC to the broker, in the room.
const brokerCall = async (broker, room, fields) => {
  const response = await fetch(`${broker.url}/api/v1/rpc`, {
    method: 'POST',
    headers: {authorization: `Bearer ${broker.token}`, 'content-type': 'application/json'},
    body: JSON.stringify({project: path.resolve(room), ...fields}),
  });
  const body = await response.json();
  if (!response.ok || body.ok === false) {
    const error = new Error(body.error?.message ?? `Relay HTTP ${response.status}`);
    error.code = body.error?.code;
    throw error;
  }
  return body;
};

// The gateway, on an ephemeral port.
const gatewayFor = async (t, {dataDir, call}) => {
  const gateway = await startGateway({dataDir, port: 0, call});
  t.after(() => gateway.close());
  return gateway;
};

// One RPC through the gateway, the way a cloud agent sends it. The base URL is
// the public one when the call travels through a tunnel.
const throughGateway = async (base, token, fields) => {
  const response = await fetch(`${base.url ?? base}/rpc`, {
    method: 'POST',
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
    body: JSON.stringify(fields),
  });
  const body = await response.json();
  if (!response.ok || body.ok === false) {
    const error = new Error(body.error?.message ?? `Relay HTTP ${response.status}`);
    error.code = body.error?.code;
    throw error;
  }
  return body;
};

// Fields that differ between two runs of the same scenario: clock readings and
// random identifiers. Everything else has to match.
const VOLATILE = new Set([
  'createdAt', 'updatedAt', 'registeredAt', 'claimedAt', 'at', 'ts', 'lastSeenAt',
  'statusAt', 'lastSeenAgeMs', 'transportAgeMs', 'ageMs', 'lastActivityAt', 'messageId',
  // The cloud marker is the one deliberate difference: the gateway says which runner is on
  // the other side of the tunnel, and a local broker never says it.
  'cloud',
]);

// The same normalisation the gateway applies: the room path becomes a dot.
const normalize = (value, project) => {
  if (typeof value === 'string') return value.split(project).join('.');
  if (Array.isArray(value)) return value.map(item => normalize(item, project));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (VOLATILE.has(key)) continue;
      out[key] = normalize(item, project);
    }
    return out;
  }
  return value;
};

// The operations the roadmap lists, in one run.
//
// The scenario is what ONE agent does. A gateway token is bound to one
// identity, so the second agent in the room is set up by the local side, not
// through the tunnel: the cloud agent can talk to it, but it cannot be it.
const scenario = async (call, {local} = {}) => {
  const results = {};
  results.register = await call({op: 'register', agentId: 'cloud-1', runner: 'claude'});
  await local({op: 'register', agentId: 'local-1', runner: 'codex'});
  results.send = await local({op: 'send', from: 'local-1', to: 'cloud-1', body: 'hello from the local agent'});
  results.inbox = await call({op: 'inbox', agentId: 'cloud-1'});
  results.ack = await call({op: 'ack', agentId: 'cloud-1', messageId: results.send.messageId});
  results.wait = await call({op: 'wait', agentId: 'cloud-1', after: 0, timeoutMs: 200});
  results.claim = await call({op: 'claim', agentId: 'cloud-1', resources: ['src/app.js']});
  results.release = await call({op: 'release', agentId: 'cloud-1', resources: ['src/app.js']});
  results.agents = await call({op: 'agents'});
  results.status = await call({op: 'status', agentId: 'cloud-1'});
  return results;
};

// Set the remote-mode environment for one test, and put it back afterwards.
const remoteEnv = (t, {url, token}) => {
  const previous = {url: process.env.AGENT_RELAY_URL, token: process.env.AGENT_RELAY_TOKEN};
  if (url === undefined) delete process.env.AGENT_RELAY_URL; else process.env.AGENT_RELAY_URL = url;
  if (token === undefined) delete process.env.AGENT_RELAY_TOKEN; else process.env.AGENT_RELAY_TOKEN = token;
  t.after(() => {
    if (previous.url === undefined) delete process.env.AGENT_RELAY_URL; else process.env.AGENT_RELAY_URL = previous.url;
    if (previous.token === undefined) delete process.env.AGENT_RELAY_TOKEN; else process.env.AGENT_RELAY_TOKEN = previous.token;
  });
};

test('a remote-mode client never starts or discovers a local broker', async t => {
  const dir = await temp(t);
  const project = await checkout(dir);
  const {broker, dataDir} = await brokerFor(t);
  await brokerCall(broker, project, {op: 'register', agentId: 'local-1', runner: 'codex'});
  const gateway = await gatewayFor(t, {dataDir, call: (room, fields) => brokerCall(broker, room, fields)});
  const token = gateway.store.issue({room: project, runner: 'claude'});
  await gateway.store.save();

  // In this process: the remote path never touches the data directory.
  remoteEnv(t, {url: gateway.url, token: token.value});
  const untouched = path.join(dir, 'never-written');
  const result = await rpc(project, {op: 'agents'}, {dataDir: untouched});
  assert.equal(result.ok, true);
  assert.ok(result.agents.some(agent => agent.agentId === 'local-1'), 'the gateway answered');
  await assert.rejects(() => fs.stat(untouched), error => error.code === 'ENOENT', 'no data directory is written');
  await assert.rejects(() => fs.stat(path.join(untouched, 'broker.json')), error => error.code === 'ENOENT');

  // In a fresh process: nothing is spawned either. The data directory the
  // client would use does not even come into existence.
  const childHome = path.join(dir, 'child-home');
  const script = `
    import {rpc} from ${JSON.stringify(clientUrl)};
    const answer = await rpc(${JSON.stringify(project)}, {op: 'agents'});
    process.stdout.write(JSON.stringify(answer));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: {...process.env, AGENT_RELAY_URL: gateway.url, AGENT_RELAY_TOKEN: token.value, AGENT_RELAY_HOME: childHome},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 0, `the remote client failed: ${stderr}`);
  assert.equal(JSON.parse(stdout).ok, true);
  await assert.rejects(() => fs.stat(childHome), error => error.code === 'ENOENT', 'the client wrote no data directory');
  await assert.rejects(() => fs.stat(path.join(childHome, 'broker.json')), error => error.code === 'ENOENT', 'no broker was discovered');
});

test('the pairing round trip hands a working token to the cloud agent', async t => {
  const dir = await temp(t);
  const project = await checkout(dir);
  const {broker, dataDir} = await brokerFor(t);
  await brokerCall(broker, project, {op: 'register', agentId: 'local-1', runner: 'codex'});
  const rooms = [];
  const gateway = await gatewayFor(t, {
    dataDir,
    call: async (room, fields) => { rooms.push(room); return brokerCall(broker, room, fields); },
  });

  // The cloud agent asks to join.
  const paired = await fetch(`${gateway.url}/pair`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({repo: 'github.com/org/repo', branch: 'main', runner: 'claude', sessionId: 'cloud-1'}),
  });
  assert.equal(paired.status, 200);
  const request = await paired.json();
  assert.match(request.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  assert.ok(request.requestId);

  // The agent waits.
  const waiting = await fetch(`${gateway.url}/pair/${request.requestId}`);
  assert.equal(waiting.status, 202);

  // The local operator approves, the way the CLI does.
  const known = (await brokerCall(broker, project, {op: 'rooms'})).rooms;
  const approved = await remoteApprove({dataDir, code: request.code, rooms: known});
  assert.equal(approved.ok, true);
  assert.equal(approved.room, project, 'the token is scoped to the room that matches the repository');

  // The agent collects its token.
  const collected = await fetch(`${gateway.url}/pair/${request.requestId}`);
  assert.equal(collected.status, 200);
  const handed = await collected.json();
  assert.equal(handed.status, 'approved');
  assert.equal(handed.room, '.', 'the room path never leaves the machine');
  assert.ok(handed.token, 'the agent receives a token');

  // The token works.
  const used = await throughGateway(gateway, handed.token, {op: 'agents'});
  assert.ok(used.agents.some(agent => agent.agentId === 'local-1'));

  // The room comes from the token: the request cannot choose another one.
  await throughGateway(gateway, handed.token, {op: 'status', project: path.join(dir, 'elsewhere'), agentId: 'local-1'});
  assert.equal(rooms.at(-1), project, 'the token decides the room');
  assert.equal(gateway.store.find(handed.token).room, project, 'the token is scoped to one room');

  // The token value is handed over once.
  const again = await fetch(`${gateway.url}/pair/${request.requestId}`);
  assert.equal((await again.json()).token, null, 'the token value is handed over only once');
});

test('the pairing code is not a bearer secret, and the token store holds no token value', async t => {
  const {broker, dataDir} = await brokerFor(t);
  const gateway = await gatewayFor(t, {dataDir, call: (room, fields) => brokerCall(broker, room, fields)});
  const paired = await fetch(`${gateway.url}/pair`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({repo: 'github.com/org/repo', runner: 'claude'}),
  });
  const request = await paired.json();
  assert.match(request.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);

  // The code is what a person reads off a screen. It must not work as a bearer secret.
  const byCode = await fetch(`${gateway.url}/pair/${request.code}`);
  assert.equal(byCode.status, 404, 'the code is not accepted over the wire');
  assert.equal((await byCode.json()).token, undefined);

  // The approver mints the token; the store keeps only the hash.
  const store = await new TokenStore(dataDir).load();
  const row = store.findPairing(request.code);
  const token = store.issue({room: '/work/alpha', runner: 'claude'});
  store.approve(row, token, token.value);
  await store.save();
  const raw = await fs.readFile(path.join(dataDir, 'remote-tokens.json'), 'utf8');
  assert.ok(!raw.includes(token.value), 'the token value is never written to the token store');
  assert.ok(raw.includes(token.row.hash), 'the store keeps the hash');
  const pending = await fs.readFile(path.join(dataDir, 'remote-pending-tokens.json'), 'utf8');
  assert.ok(pending.includes(token.value), 'the value waits in the short-lived handover file');

  // The waiting agent collects it once, by request id.
  const approved = await fetch(`${gateway.url}/pair/${request.requestId}`);
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).token, token.value);
  const after = await fs.readFile(path.join(dataDir, 'remote-pending-tokens.json'), 'utf8');
  assert.ok(!after.includes(token.value), 'the value is gone once it has been handed over');
});

test('the tools behave the same through the gateway', async t => {  const dir = await temp(t);
  const project = await checkout(dir);
  const local = await brokerFor(t);
  const remote = await brokerFor(t);

  // The local side: the real client, which discovers the broker the way the
  // daemon leaves it.
  const discovery = JSON.parse(await fs.readFile(path.join(local.dataDir, 'broker.json'), 'utf8'));
  assert.equal(discovery.url, local.broker.url);
  assert.equal((await fetch(`${discovery.url}/health`)).ok, true, 'the broker answers on its discovery url');
  const locally = async fields => rpc(project, fields, {dataDir: local.dataDir});

  // The remote side: the real gateway, in front of another broker.
  const gateway = await gatewayFor(t, {dataDir: remote.dataDir, call: (room, fields) => brokerCall(remote.broker, room, fields)});
  const token = gateway.store.issue({room: project, runner: 'claude'});
  await gateway.store.save();
  const remotely = async fields => throughGateway(gateway, token.value, fields);

  const localResults = await scenario(locally, {local: locally});
  // On the remote side the second agent is a local one, so it is set up on the
  // broker behind the gateway rather than through the tunnel.
  const remoteResults = await scenario(remotely, {local: fields => brokerCall(remote.broker, project, fields)});
  // The scenario is not empty: it really sent, received, claimed and released.
  assert.deepEqual(localResults.send.recipients, ['cloud-1']);
  assert.equal(localResults.inbox.messages.length, 1);
  assert.equal(localResults.ack.acked, true);
  assert.equal(localResults.claim.owned.length, 1);
  assert.equal(localResults.release.released.length, 1);
  assert.deepEqual(
    normalize(remoteResults, project),
    normalize(localResults, project),
    'the gateway answers exactly like the broker',
  );
  // The one deliberate difference: the gateway marks what came through it.
  assert.equal(remoteResults.register.agent.cloud.runner, 'claude');
  assert.equal(localResults.register.agent.cloud, undefined);
});

test('the whole story works through a fake tunnel provider', async t => {
  const dir = await temp(t);
  const project = await checkout(dir);
  const {broker, dataDir} = await brokerFor(t);
  await brokerCall(broker, project, {op: 'register', agentId: 'local-1', runner: 'codex'});
  const gateway = await gatewayFor(t, {dataDir, call: (room, fields) => brokerCall(broker, room, fields)});

  // The tunnel: a provider that answers like the real ones, without a network.
  const tunnel = createFakeTunnel();
  t.after(() => tunnel.stop());
  const started = await tunnel.start({port: gateway.port});
  assert.equal(started.ok, true);
  const publicUrl = started.url;
  assert.notEqual(publicUrl, gateway.url, 'the public URL is the tunnel, not the gateway');

  // The cloud agent asks to join through the tunnel.
  const paired = await fetch(`${publicUrl}/pair`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({repo: 'github.com/org/repo', branch: 'main', runner: 'claude'}),
  });
  assert.equal(paired.status, 200);
  const request = await paired.json();

  // The local operator approves.
  const known = (await brokerCall(broker, project, {op: 'rooms'})).rooms;
  const approved = await remoteApprove({dataDir, code: request.code, rooms: known});
  assert.equal(approved.ok, true);

  // The agent collects its token.
  const collected = await fetch(`${publicUrl}/pair/${request.requestId}`);
  assert.equal(collected.status, 200);
  const handed = await collected.json();
  assert.ok(handed.token);

  // The agent registers and sends.
  const registered = await throughGateway(publicUrl, handed.token, {op: 'register', agentId: 'cloud-1', runner: 'claude'});
  assert.equal(registered.agent.agentId, 'cloud-1');
  const sent = await throughGateway(publicUrl, handed.token, {op: 'send', from: 'cloud-1', to: 'local-1', body: 'hello from the cloud'});
  assert.equal(sent.duplicate, false);

  // The local agent answers, and the cloud agent waits for it.
  await brokerCall(broker, project, {op: 'send', from: 'local-1', to: 'cloud-1', body: 'hello from the local agent'});
  const waited = await throughGateway(publicUrl, handed.token, {op: 'wait', agentId: 'cloud-1', after: 0, timeoutMs: 1000});
  assert.ok(waited.messages.some(message => message.body === 'hello from the local agent'), 'the cloud agent receives the message');

  // The cloud agent claims a file, as a repo-relative path.
  const claimed = await throughGateway(publicUrl, handed.token, {op: 'claim', agentId: 'cloud-1', resources: ['src/app.js']});
  assert.equal(claimed.owned.length, 1);
  assert.equal(claimed.owned[0].resource, './src/app.js', 'the claim travels as a repo-relative path');

  // The audit trail says what happened, and never says a token value.
  const audit = await AuditLog.read(dataDir);
  assert.ok(audit.some(row => row.event === 'pair' && row.result === 'pending'), 'the pairing request is recorded');
  assert.ok(audit.some(row => row.event === 'approve' && row.result === 'approved'), 'the approval is recorded');
  assert.ok(audit.some(row => row.event === 'rpc' && row.op === 'send' && row.result === 'ok'), 'the send is recorded');
  assert.ok(audit.some(row => row.event === 'rpc' && row.op === 'claim' && row.result === 'ok'), 'the claim is recorded');
  assert.ok(!JSON.stringify(audit).includes(handed.token), 'no token value reaches the audit log');

  // The tunnel saw the traffic, and the status command reports the tokens.
  assert.ok(tunnel.requests.length >= 4, 'the tunnel forwarded the requests');
  const status = await remoteStatus({dataDir});
  assert.equal(status.ok, true);
  assert.equal(status.tokens.length, 1);
  assert.equal(status.tokens[0].room, project);

  // Revoking the token closes the door at once.
  const revoked = await remoteRevoke({dataDir, id: approved.tokenId});
  assert.equal(revoked.ok, true);
  const after = await fetch(`${publicUrl}/rpc`, {
    method: 'POST', headers: {authorization: `Bearer ${handed.token}`, 'content-type': 'application/json'},
    body: JSON.stringify({op: 'agents'}),
  });
  assert.equal(after.status, 401, 'a revoked token stops working');
  const afterAudit = await AuditLog.read(dataDir);
  assert.ok(afterAudit.some(row => row.event === 'revoke' && row.result === 'revoked'), 'the revocation is recorded');
});

test('the gateway refuses a local path and an operation that is not on the allowlist', async t => {
  const dir = await temp(t);
  const project = await checkout(dir);
  const {broker, dataDir} = await brokerFor(t);
  const gateway = await gatewayFor(t, {dataDir, call: (room, fields) => brokerCall(broker, room, fields)});
  const token = gateway.store.issue({room: project, runner: 'claude'});
  await gateway.store.save();
  const headers = {authorization: `Bearer ${token.value}`, 'content-type': 'application/json'};

  const absolute = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify({op: 'claim', resource: '/etc/passwd'})});
  assert.equal(absolute.status, 400);
  assert.match((await absolute.json()).error, /Local paths cannot cross the gateway/);

  const attachment = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify({op: 'send', attach: ['/etc/passwd']})});
  assert.equal(attachment.status, 400);

  const denied = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify({op: 'fetch', id: 'x'})});
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /attachments never leave the machine/);

  const unknown = await fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify({op: 'definitely-not-an-op'})});
  assert.equal(unknown.status, 403);
  assert.match((await unknown.json()).error, /not available through the gateway/);
});

test('the rate limit answers 429 with a Retry-After', async t => {
  const dataDir = await temp(t);
  const store = await new TokenStore(dataDir).load();
  const limiter = new RateLimiter({perToken: 2, perIp: 100, windowMs: 60_000});
  const audit = new AuditLog(dataDir);
  const handler = createGatewayHandler({
    store, limiter, audit,
    call: async () => ({ok: true}),
    resolveRoom: async () => null,
  });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  const url = `http://127.0.0.1:${server.address().port}`;

  const token = store.issue({room: path.join(os.tmpdir(), 'alpha'), runner: 'claude'});
  await store.save();
  const headers = {authorization: `Bearer ${token.value}`, 'content-type': 'application/json'};
  for (let i = 0; i < 2; i++) {
    const allowed = await fetch(`${url}/rpc`, {method: 'POST', headers, body: JSON.stringify({op: 'agents'})});
    assert.equal(allowed.status, 200);
  }
  const blocked = await fetch(`${url}/rpc`, {method: 'POST', headers, body: JSON.stringify({op: 'agents'})});
  assert.equal(blocked.status, 429);
  const retryAfter = Number(blocked.headers.get('retry-after'));
  assert.ok(retryAfter > 0, 'the answer says when to come back');
  assert.match((await blocked.json()).error, /Too many requests/);
});

test('a tunnel that is down says exactly what to run to fix it', async t => {  const dir = await temp(t);
  const project = await checkout(dir);
  const {broker, dataDir} = await brokerFor(t);
  const gateway = await gatewayFor(t, {dataDir, call: (room, fields) => brokerCall(broker, room, fields)});
  const token = gateway.store.issue({room: project, runner: 'claude'});
  await gateway.store.save();

  const tunnel = createFakeTunnel();
  t.after(() => tunnel.stop());
  const started = await tunnel.start({port: gateway.port});
  await writeState(dataDir, {url: started.url, gatewayPort: gateway.port, provider: 'fake'});

  // The tunnel goes away.
  await tunnel.stop();
  assert.equal(tunnel.running, false);

  // The client knows what to run.
  await assert.rejects(
    () => remoteRpc(project, {op: 'agents'}, {url: started.url, token: token.value}),
    error => error.code === 'GATEWAY_OFF' && /agent-relay remote on/.test(error.message),
    'the client says which command fixes it',
  );

  // The doctor says the same, for the tunnel itself.
  const doctor = await remoteDoctor({dataDir});
  const check = doctor.checks.find(row => row.name === 'The public URL reaches the gateway');
  assert.ok(check, 'the doctor checks the public URL');
  assert.equal(check.ok, false);
  assert.match(check.detail, /agent-relay remote on/);
});

test('the hosted relay artifacts say what to run, and nothing is deployed', async t => {
  const dir = await temp(t);
  const rooms = [{name: 'speechify', repo: 'github.com/org/repo', branch: 'main'}];
  const plan = planRemoteHost({rooms, url: 'https://relay.example'});
  assert.equal(plan.ok, true);
  assert.equal(plan.provider, 'tailscale');

  // The artifacts: a compose file, the units and a cloud-init snippet.
  const names = plan.files.map(file => file.name);
  assert.ok(names.includes('agent-relay.compose.yml'));
  assert.ok(names.includes('agent-relay-broker.service'));
  assert.ok(names.includes('agent-relay-gateway.service'));
  assert.ok(names.includes('agent-relay-tunnel.service'));
  assert.ok(names.includes('cloud-init.yml'));

  const compose = plan.files.find(file => file.name === 'agent-relay.compose.yml').contents;
  assert.match(compose, /agent-relay", "daemon"/, 'the broker runs as a service');
  assert.match(compose, /agent-relay", "remote", "gateway"/, 'the gateway runs as a service');
  assert.match(compose, /127\.0\.0\.1:47820:47820/, 'the gateway is only reachable on loopback');

  const brokerUnit = plan.files.find(file => file.name === 'agent-relay-broker.service').contents;
  assert.match(brokerUnit, /agent-relay daemon --data-dir \/opt\/agent-relay\/data/);
  const gatewayUnit = plan.files.find(file => file.name === 'agent-relay-gateway.service').contents;
  assert.match(gatewayUnit, /agent-relay remote gateway --data-dir \/opt\/agent-relay\/data --port 47820/);

  const cloudInit = plan.files.find(file => file.name === 'cloud-init.yml').contents;
  assert.match(cloudInit, /git clone --branch main https:\/\/github\.com\/org\/repo\.git \/opt\/agent-relay\/rooms\/speechify/, 'the room is put on the host');
  assert.match(cloudInit, /systemctl enable --now agent-relay-broker\.service/);

  // The steps, and the local wiring.
  const printed = remoteHostInstructions(plan);
  assert.match(printed, /agent-relay remote approve/, 'the steps say how to approve an agent');
  assert.match(printed, /agent-relay remote revoke --all/, 'the steps say how to revoke everything');
  assert.match(printed, /AGENT_RELAY_URL=https:\/\/relay\.example/, 'the local side points at the hosted relay');
  assert.ok(!printed.includes('AGENT_RELAY_TOKEN=' + 'ey'), 'no token value is printed');

  // The artifacts are written, and nothing else happens.
  const written = await writeRemoteHostArtifacts({dir, rooms, url: 'https://relay.example'});
  assert.equal(written.ok, true);
  assert.equal(written.written.length, plan.files.length);
  for (const file of written.written) {
    assert.ok((await fs.stat(file.path)).isFile(), `${file.name} is on disk`);
  }

  // The local machine points at the hosted relay.
  const local = await temp(t);
  const pointed = await pointLocalAtHost({dataDir: local, url: 'https://relay.example'});
  assert.equal(pointed.ok, true);
  const state = JSON.parse(await fs.readFile(path.join(local, 'remote-state.json'), 'utf8'));
  assert.equal(state.url, 'https://relay.example');
  assert.equal(state.hosted, true);
});

test('a cloud agent cannot take over a local identity', async t => {
  const dir = await temp(t);
  const project = await checkout(dir);
  const {broker, dataDir} = await brokerFor(t);
  // A local agent owns this identity.
  await brokerCall(broker, project, {op: 'register', agentId: 'local-codex-1', runner: 'codex'});
  const gateway = await startGateway({
    dataDir, port: 0,
    call: (room, fields) => brokerCall(broker, room, fields),
  });
  t.after(() => gateway.close());
  const token = gateway.store.issue({room: project, runner: 'claude'});
  await gateway.store.save();
  const headers = {authorization: `Bearer ${token.value}`};
  const post = body => fetch(`${gateway.url}/rpc`, {method: 'POST', headers, body: JSON.stringify(body)});

  const takeover = await post({op: 'register', agentId: 'local-codex-1', runner: 'claude'});
  assert.equal(takeover.status, 400, 'the takeover is refused');
  assert.match((await takeover.json()).error, /identity|Identity/);

  // And it cannot post as that local agent either.
  const asLocal = await post({op: 'send', from: 'local-codex-1', to: 'local-codex-1', body: 'not me'});
  assert.equal(asLocal.status, 400);
});
