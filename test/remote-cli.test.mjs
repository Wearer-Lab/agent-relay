import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {startGateway} from '../lib/gateway.mjs';
import {remoteApprove, remoteDeny, remoteRevoke, remoteStatus, remoteRoomAdd, readState} from '../lib/remote.mjs';
import {loadAliases} from '../lib/remote-rooms.mjs';

const cli = fileURLToPath(new URL('../bin/agent-relay.mjs', import.meta.url));
const temp = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-remote-cli-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true, maxRetries: 15, retryDelay: 200}));
  return dir;
};
const run = (args, {cwd, env} = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, [cli, ...args], {cwd, env: {...process.env, ...env}});
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('exit', code => resolve({code, stdout, stderr}));
});

test('the CLI lists the remote commands and reports an idle remote state', async t => {
  const dataDir = await temp(t);
  const help = await run(['help']);
  assert.match(help.stdout, /agent-relay remote on/);
  const status = await run(['remote', 'status', '--data-dir', dataDir]);
  assert.equal(status.code, 0);
  const state = JSON.parse(status.stdout);
  assert.equal(state.url, null);
  assert.deepEqual(state.pendingPairings, []);
  assert.deepEqual(state.tokens, []);
});

test('a cloud agent pairs, a person approves, and the agent gets a scoped token', async t => {
  const dataDir = await temp(t);
  const gateway = await startGateway({dataDir, call: async (room, fields) => ({ok: true, room, op: fields.op})});
  t.after(() => gateway.close());

  const paired = await fetch(`${gateway.url}/pair`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({repo: 'github.com/org/repo', branch: 'main', runner: 'claude'}),
  });
  const request = await paired.json();

  const approved = await remoteApprove({
    dataDir, code: request.code, project: process.cwd(),
    rooms: [{project: '/work/alpha', origin: 'github.com/org/repo', branch: 'main', main: true}],
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.room, '/work/alpha');

  const polled = await fetch(`${gateway.url}/pair/${request.requestId}`);
  const handed = await polled.json();
  assert.equal(handed.status, 'approved');
  assert.equal(handed.room, '/work/alpha');
  assert.ok(handed.token, 'the waiting agent receives a token');

  const used = await fetch(`${gateway.url}/rpc`, {
    method: 'POST', headers: {authorization: `Bearer ${handed.token}`, 'content-type': 'application/json'},
    body: JSON.stringify({op: 'agents'}),
  });
  assert.equal(used.status, 200);

  const revoked = await remoteRevoke({dataDir, id: approved.tokenId});
  assert.equal(revoked.ok, true);
  const after = await fetch(`${gateway.url}/rpc`, {
    method: 'POST', headers: {authorization: `Bearer ${handed.token}`, 'content-type': 'application/json'},
    body: JSON.stringify({op: 'agents'}),
  });
  assert.equal(after.status, 401, 'a revoked token stops working');
});

test('a denied request is never approved', async t => {
  const dataDir = await temp(t);
  const gateway = await startGateway({dataDir, call: async () => ({ok: true})});
  t.after(() => gateway.close());
  const paired = await fetch(`${gateway.url}/pair`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({repo: 'github.com/org/repo', runner: 'claude'})});
  const request = await paired.json();
  const denied = await remoteDeny({dataDir, code: request.code});
  assert.equal(denied.ok, true);
  const polled = await fetch(`${gateway.url}/pair/${request.requestId}`);
  assert.equal(polled.status, 403);
  const approved = await remoteApprove({dataDir, code: request.code, rooms: []});
  assert.equal(approved.ok, false);
});

test('an unmatched repository is refused, and an alias can point at a room by hand', async t => {
  const dataDir = await temp(t);
  const unmatched = await remoteApprove({dataDir, code: 'NOPE12', rooms: [{project: '/work/alpha', origin: 'github.com/org/repo'}]});
  assert.equal(unmatched.ok, false);
  assert.match(unmatched.message, /No waiting request/);

  const added = await remoteRoomAdd({dataDir, alias: 'github.com/fork/repo', project: '/work/alpha'});
  assert.equal(added.ok, true);
  const aliases = await loadAliases(dataDir);
  assert.equal(aliases.aliases['github.com/fork/repo'], path.resolve('/work/alpha'), 'the alias points at the resolved path');
});

test('the read-only dashboard rides on the same public URL, behind its own secret', async t => {
  const dataDir = await temp(t);
  let origin = 'http://127.0.0.1';
  const {dashboardFor} = await import('../lib/remote.mjs');
  // A stub call keeps the test off the local broker.
  const dashboard = await dashboardFor({dataDir, project: process.cwd(), origin: () => origin, call: async () => ({rooms: []})});
  const gateway = await startGateway({dataDir, port: 0, dashboard, call: async () => ({ok: true})});
  origin = gateway.url;
  t.after(() => gateway.close());

  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /view-overview/, 'the dashboard shell is served');
  const asset = await fetch(`${origin}/assets/dashboard.css`);
  assert.equal(asset.status, 200);
  const font = await fetch(`${origin}/assets/fonts/BubbledotICG-FinePos.woff2`);
  assert.equal(font.status, 200);

  const withSecret = await fetch(`${origin}/api/v1/projects`, {headers: {authorization: `Bearer ${dashboard.secret}`}});
  assert.equal(withSecret.status, 200);
  const without = await fetch(`${origin}/api/v1/projects`);
  assert.equal(without.status, 401, 'the dashboard needs its own secret');
  const wrong = await fetch(`${origin}/api/v1/projects`, {headers: {authorization: 'Bearer nope'}});
  assert.equal(wrong.status, 401);
});

test('the remote status reports the gateway, the tunnel and the live tokens', async t => {
  const dataDir = await temp(t);
  const gateway = await startGateway({dataDir, call: async () => ({ok: true})});
  t.after(() => gateway.close());
  const status = await remoteStatus({dataDir});
  assert.equal(status.ok, true);
  assert.equal(status.gateway.running, false, 'no tunnel means no recorded gateway port');
  assert.deepEqual(status.pendingPairings, []);
});
