// The remote lifecycle: one command turns the gateway and a tunnel on, another
// turns them off, and a third says what is going on.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startGateway, DEFAULT_GATEWAY_PORT, TokenStore, AuditLog} from './gateway.mjs';
import {resolveRoom, loadAliases, saveAlias, originOf, branchOf} from './remote-rooms.mjs';
import * as tunnels from './tunnels/index.mjs';

const cli = fileURLToPath(new URL('../bin/agent-relay.mjs', import.meta.url));
const stateFile = dataDir => path.join(dataDir, 'remote-state.json');

export const readState = async dataDir => {
  try { return JSON.parse(await fs.readFile(stateFile(dataDir), 'utf8')); }
  catch { return {}; }
};

export const writeState = async (dataDir, state) => {
  await fs.writeFile(stateFile(dataDir), JSON.stringify(state, null, 2), {mode: 0o600});
  return state;
};

const alive = pid => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

// The read-only dashboard rides on the same public URL, behind its own secret.
export const DASHBOARD_PAGES = new Set(['/', '/flight-plan/', '/runways/', '/agents/', '/messages/', '/claims/']);

export async function dashboardFor({dataDir, project, origin, call}) {
  const {createDashboardHandler, createObserver} = await import('./dashboard.mjs');
  const {randomBytes} = await import('node:crypto');
  const state = await readState(dataDir);
  const secret = state.dashboardSecret ?? randomBytes(32).toString('hex');
  await writeState(dataDir, {...state, dashboardSecret: secret});

  const files = new Map();
  files.set('/index.html', {type: 'text/html; charset=utf-8', body: await fs.readFile(new URL('./dashboard/index.html', import.meta.url))});
  for (const name of ['dashboard.css', 'dashboard.js', 'model.js', 'theme.js', 'logo.svg', 'favicon.svg']) {
    files.set(`/assets/${name}`, {type: assetType(name), body: await fs.readFile(new URL(`./dashboard/assets/${name}`, import.meta.url))});
  }
  for (const name of ['BubbledotICG-FinePos.woff2', 'GeistPixel-Circle.woff2', 'Inter-latin.woff2']) {
    files.set(`/assets/fonts/${name}`, {type: 'font/woff2', body: await fs.readFile(new URL(`./dashboard/assets/fonts/${name}`, import.meta.url))});
  }
  const observer = createObserver({project, dataDir, ...(call ? {call} : {})});
  const handler = createDashboardHandler({
    project, secret, origin: () => (typeof origin === 'function' ? origin() : origin),
    getRooms: observer.getRooms, getSnapshot: observer.getSnapshot, getHistory: observer.getHistory,
    getWork: observer.getWork, getOwnership: observer.getOwnership, getUsage: observer.getUsage,
    assets: files,
  });
  return {handler, secret, pages: DASHBOARD_PAGES};
}

const assetType = name => ({
  'dashboard.css': 'text/css; charset=utf-8',
  'dashboard.js': 'text/javascript; charset=utf-8',
  'model.js': 'text/javascript; charset=utf-8',
  'theme.js': 'text/javascript; charset=utf-8',
  'logo.svg': 'image/svg+xml',
  'favicon.svg': 'image/svg+xml',
}[name] ?? 'application/octet-stream');

// The gateway runs as its own process, like the broker daemon.
export async function startGatewayProcess({dataDir, port = DEFAULT_GATEWAY_PORT, log = null}) {
  const child = spawn(process.execPath, [cli, 'remote', 'gateway', '--data-dir', dataDir, '--port', String(port)], {
    detached: true, stdio: ['ignore', log ? 'pipe' : 'ignore', log ? 'pipe' : 'ignore'], windowsHide: true,
  });
  child.unref();
  return {pid: child.pid, port};
}

export async function waitForGateway(port, {timeout = 15000} = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(1500)});
      if (response.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

// Turn the gateway and a tunnel on, and print where the cloud agent should go.
export async function remoteOn({dataDir, provider, port = DEFAULT_GATEWAY_PORT, hostname, project}) {
  const state = await readState(dataDir);
  if (state.gatewayPid && alive(state.gatewayPid) && state.url) {
    return {ok: true, url: state.url, message: 'Already on. The public URL is unchanged.', reused: true};
  }

  const gateway = state.gatewayPid && alive(state.gatewayPid) ? {pid: state.gatewayPid, port: state.gatewayPort ?? port} : await startGatewayProcess({dataDir, port});
  if (!await waitForGateway(gateway.port)) {
    return {ok: false, message: `The gateway did not start on port ${gateway.port}. Run \`agent-relay remote gateway\` to see why.`};
  }

  const picked = await tunnels.pick({preferred: provider});
  if (!picked.provider) {
    return {ok: false, message: picked.hint ?? 'No tunnel provider is available.', gateway: gateway};
  }
  if (!picked.state.signedIn && picked.provider.signIn) {
    const signedIn = await picked.provider.signIn();
    if (!signedIn.ok) return {ok: false, message: signedIn.message, gateway};
  }
  const started = await picked.provider.start({port: gateway.port, hostname, configDir: dataDir});
  if (!started.ok) return {ok: false, message: started.message, gateway};

  await writeState(dataDir, {
    gatewayPid: gateway.pid, gatewayPort: gateway.port,
    provider: picked.provider.id, url: started.url, hostname: hostname ?? null,
    startedAt: new Date().toISOString(),
  });
  return {
    ok: true, url: started.url, provider: picked.provider.id, providerName: picked.provider.name,
    message: started.message, gatewayPort: gateway.port,
    next: `Now run: agent-relay remote add claude   (or: add codex)`,
  };
}

export async function remoteOff({dataDir, revokeAll = false}) {
  const state = await readState(dataDir);
  const stopped = [];
  if (state.provider) {
    const provider = tunnels.byId[state.provider];
    if (provider?.stop) await provider.stop({port: state.gatewayPort}).catch(() => {});
    stopped.push(state.provider);
  }
  if (state.gatewayPid && alive(state.gatewayPid)) {
    try { process.kill(state.gatewayPid); } catch { /* already gone */ }
  }
  if (revokeAll) {
    const store = await new TokenStore(dataDir).load();
    const count = store.revokeAll();
    await store.save();
    await writeState(dataDir, {...state, url: null, gatewayPid: null, revoked: count});
    return {ok: true, message: `Closed the public URL and revoked ${count} token${count === 1 ? '' : 's'}.`};
  }
  await writeState(dataDir, {...state, url: null, gatewayPid: null});
  return {ok: true, message: 'Closed the public URL. Tokens stay until they expire; use `agent-relay remote revoke --all` to drop them now.'};
}

export async function remoteStatus({dataDir}) {
  const state = await readState(dataDir);
  const store = await new TokenStore(dataDir).load();
  const pending = store.pendingPairings();
  const gatewayUp = state.gatewayPort ? await waitForGateway(state.gatewayPort, {timeout: 2000}) : false;
  let tunnel = {running: false, message: 'No tunnel is running.'};
  if (state.provider) {
    const provider = tunnels.byId[state.provider];
    if (provider?.status) tunnel = await provider.status().catch(() => ({running: false, message: 'The provider did not answer.'}));
  }
  return {
    ok: true,
    url: state.url ?? null,
    provider: state.provider ?? null,
    gateway: {running: gatewayUp, port: state.gatewayPort ?? null, pid: state.gatewayPid ?? null},
    tunnel,
    pendingPairings: pending.map(row => ({code: row.code, repo: row.repo, branch: row.branch, runner: row.runner, id: row.id})),
    tokens: store.live().map(row => ({id: row.id, room: row.room, runner: row.runner, agentPrefix: row.agentPrefix, expiresAt: row.expiresAt, lastUsedAt: row.lastUsedAt})),
  };
}

// End to end: the tunnel, the gateway, the broker and the room lookup.
export async function remoteDoctor({dataDir, project}) {
  const checks = [];
  const state = await readState(dataDir);
  checks.push({name: 'A tunnel is running', ok: Boolean(state.url), detail: state.url ?? 'none. Run `agent-relay remote on`.'});
  const gatewayUp = state.gatewayPort ? await waitForGateway(state.gatewayPort, {timeout: 3000}) : false;
  checks.push({name: 'The gateway answers', ok: gatewayUp, detail: gatewayUp ? `127.0.0.1:${state.gatewayPort}` : 'not running'});
  if (state.url && gatewayUp) {
    const started = Date.now();
    let ok = false;
    try {
      const response = await fetch(`${state.url}/health`, {signal: AbortSignal.timeout(8000)});
      ok = response.ok;
    } catch { /* the tunnel is down */ }
    checks.push({name: 'The public URL reaches the gateway', ok, detail: ok ? `${Date.now() - started} ms` : 'the tunnel is not answering. Run `agent-relay remote on` again.'});
  }
  const store = await new TokenStore(dataDir).load();
  checks.push({name: 'No pairing is waiting', ok: store.pendingPairings().length === 0, detail: `${store.pendingPairings().length} pending`});
  if (project) {
    const {rooms} = await (await import('./client.mjs')).rpc(project, {op: 'rooms'}).catch(() => ({rooms: []}));
    const resolved = await resolveRoom({repo: await originOf(project), branch: await branchOf(project), rooms, aliases: await loadAliases(dataDir)});
    checks.push({name: 'This project resolves to a room', ok: Boolean(resolved.room), detail: resolved.room ?? resolved.reason});
  }
  return {ok: checks.every(check => check.ok), checks};
}

// Approve a waiting cloud agent and hand it a token scoped to its room.
export async function remoteApprove({dataDir, code, alwaysOn = false, ttlMs, agentPrefix = '', project, rooms: givenRooms}) {
  const store = await new TokenStore(dataDir).load();
  const row = store.findPairing(code);
  if (!row) return {ok: false, message: 'No waiting request has that code.'};
  if (row.approvedAt) return {ok: false, message: 'That request was already approved.'};

  // The rooms come from the local broker, so the room list is never asked of the cloud agent.
  const rooms = givenRooms ?? (await (await import('./client.mjs')).rpc(project ?? process.cwd(), {op: 'rooms'}).catch(() => ({rooms: []}))).rooms;
  const resolved = await resolveRoom({repo: row.repo, branch: row.branch, rooms, aliases: await loadAliases(dataDir)});
  if (!resolved.room) {
    return {ok: false, message: `No local room matches ${row.repo}${row.branch ? ` (${row.branch})` : ''}. Add one with \`agent-relay remote room add ${row.repo} <path>\`, or approve from the right project directory.`};
  }
  const token = store.issue({room: resolved.room, agentPrefix, runner: row.runner, alwaysOn, ttlMs});
  store.approve(row, token, token.value);
  await store.save();
  await new AuditLog(dataDir).write({event: 'approve', runner: row.runner, room: resolved.room, result: 'approved', tokenId: token.id});
  return {ok: true, message: `Approved ${row.runner} for ${resolved.room}. The agent now has a token.`, tokenId: token.id, room: resolved.room, runner: row.runner};
}

export async function remoteDeny({dataDir, code}) {
  const store = await new TokenStore(dataDir).load();
  const row = store.findPairing(code);
  if (!row) return {ok: false, message: 'No waiting request has that code.'};
  store.deny(row);
  await store.save();
  await new AuditLog(dataDir).write({event: 'deny', runner: row.runner, result: 'denied'});
  return {ok: true, message: 'Denied.'};
}

export async function remoteRevoke({dataDir, id, all = false}) {
  const store = await new TokenStore(dataDir).load();
  const count = all ? store.revokeAll() : store.revoke(id) ? 1 : 0;
  if (!count) return {ok: false, message: 'No token with that id.'};
  await store.save();
  await new AuditLog(dataDir).write({event: 'revoke', result: 'revoked', count});
  return {ok: true, message: `Revoked ${count} token${count === 1 ? '' : 's'}.`};
}

export async function remoteRoomAdd({dataDir, alias, project}) {
  const resolved = path.resolve(project);
  await fs.mkdir(dataDir, {recursive: true, mode: 0o700});
  await saveAlias(dataDir, alias, resolved);
  return {ok: true, message: `Room alias ${alias} now points at this project.`};
}

// Wire a repository for a cloud agent. The URL goes into the configuration; a
// token never does.
export async function remoteAdd({dataDir, project, runner = 'claude', alwaysOn = false, urlInEnv = false}) {
  const state = await readState(dataDir);
  const url = state.url;
  if (!url) return {ok: false, message: 'No public URL yet. Run `agent-relay remote on` first.'};

  const cliPath = fileURLToPath(new URL('../bin/agent-relay.mjs', import.meta.url));
  const server = {
    command: process.execPath,
    args: [cliPath, 'mcp', '--project', project, '--runner', runner],
    env: {AGENT_RELAY_URL: url},
  };

  const file = runner === 'codex' ? path.join(project, '.codex', 'config.toml') : path.join(project, '.mcp.json');
  await fs.mkdir(path.dirname(file), {recursive: true});

  if (runner === 'codex') {
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    const section = `[mcp_servers.agent-relay]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\nenv = { AGENT_RELAY_URL = ${JSON.stringify(url)} }`;
    if (text.includes('[mcp_servers.agent-relay]')) return {ok: false, message: 'This repository already has an agent-relay Codex entry; edit it by hand.'};
    await fs.writeFile(file, `${text.replace(/\s*$/, '')}\n\n${section}\n`, 'utf8');
  } else {
    let data = {};
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    if (text.trim()) {
      try { data = JSON.parse(text); } catch { return {ok: false, message: 'The .mcp.json in this repository is not valid JSON; fix it by hand.'}; }
    }
    const servers = data.mcpServers ?? {};
    const existing = servers['agent-relay'];
    if (existing && existing.env?.AGENT_RELAY_MANAGED !== '1') return {ok: false, message: 'This repository already has an agent-relay MCP entry that Agent Relay did not write; edit it by hand.'};
    servers['agent-relay'] = server;
    data.mcpServers = servers;
    await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  const cloud = runner === 'codex'
    ? [`Set AGENT_RELAY_URL=${url} in the Codex cloud environment, and allow POST to ${url}.`]
    : [`Set AGENT_RELAY_URL=${url} in the Claude cloud environment and allow network access to ${url}.`];
  if (alwaysOn) cloud.push('Add AGENT_RELAY_TOKEN as a secret in that environment; approve it once with `agent-relay remote approve <code> --always-on`.');
  if (urlInEnv) cloud.push('The URL was kept out of the repository: set it in the cloud environment instead.');

  return {
    ok: true,
    message: `Wired ${runner} in ${path.relative(project, file) || file}.`,
    clipboard: cloud.join('\n'),
    url,
  };
}

// Simulate the cloud agent's first call, from this machine, through the public
// URL, so problems show up before a cloud session starts.
export async function remoteTest({dataDir, runner = 'claude', project}) {
  const state = await readState(dataDir);
  if (!state.url) return {ok: false, message: 'No public URL yet. Run `agent-relay remote on` first.'};
  const {originOf, branchOf} = await import('./remote-rooms.mjs');
  const repo = await originOf(project);
  if (!repo) return {ok: false, message: 'This project has no git origin, so a cloud agent could not find its room.'};

  const paired = await fetch(`${state.url}/pair`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({repo, branch: await branchOf(project), runner, sessionId: `test-${Date.now()}`}),
  }).catch(error => ({ok: false, status: 0, json: async () => ({error: error.message})}));
  const body = await paired.json().catch(() => ({}));
  if (!paired.ok) return {ok: false, message: `The public URL did not accept the pairing request: ${body.error ?? paired.status}`};

  const approved = await remoteApprove({dataDir, code: body.code});
  if (!approved.ok) return {ok: false, message: approved.message};

  const polled = await fetch(`${state.url}/pair/${body.requestId}`).catch(() => null);
  const token = polled ? (await polled.json().catch(() => ({}))).token : null;
  if (!token) return {ok: false, message: 'The approval did not hand over a token. Run `agent-relay remote approve` again.'};

  const answered = await fetch(`${state.url}/rpc`, {
    method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
    body: JSON.stringify({op: 'agents'}),
  }).catch(() => null);
  if (!answered?.ok) return {ok: false, message: 'The token was refused by the gateway.'};
  await remoteRevoke({dataDir, id: approved.tokenId});
  return {ok: true, message: `The public URL works end to end for ${runner}. The test token has been revoked.`};
}

// A one-time link to the read-only dashboard, through the public URL.
export async function remoteDashboard({dataDir, project}) {
  const state = await readState(dataDir);
  if (!state.url) return {ok: false, message: 'No public URL yet. Run `agent-relay remote on` first.'};
  if (!state.dashboardSecret) return {ok: false, message: 'The gateway is not running with the dashboard. Run `agent-relay remote gateway` or `agent-relay remote on` again.'};
  return {
    ok: true,
    url: `${state.url}/#${state.dashboardSecret}`,
    message: 'Read-only dashboard, through the public URL. The link expires with the gateway.',
  };
}

export {startGateway, DEFAULT_GATEWAY_PORT};
