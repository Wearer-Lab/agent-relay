// The remote lifecycle: one command turns the gateway and a tunnel on, another
// turns them off, and a third says what is going on.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startGateway, DEFAULT_GATEWAY_PORT, TokenStore, AuditLog} from './gateway.mjs';
import {run} from './tunnels/base.mjs';
import {resolveRoom, loadAliases, saveAlias, originOf, branchOf} from './remote-rooms.mjs';
import * as tunnels from './tunnels/index.mjs';

const cli = fileURLToPath(new URL('../bin/agent-relay.mjs', import.meta.url));
const stateFile = dataDir => path.join(dataDir, 'remote-state.json');

export const readState = async dataDir => {
  try { return JSON.parse(await fs.readFile(stateFile(dataDir), 'utf8')); }
  catch { return {}; }
};

// Merges into whatever is on disk: a caller that writes the tunnel URL must not
// drop the dashboard secret it never read.
export const writeState = async (dataDir, state) => {
  const current = await readState(dataDir);
  const merged = {...current, ...state};
  const file = stateFile(dataDir);
  await fs.writeFile(file, JSON.stringify(merged, null, 2), {mode: 0o600});
  // The mode on write only applies when the file is created, so an older file
  // with a wider mode keeps it. Tighten it every time.
  await fs.chmod(file, 0o600).catch(() => {});
  return merged;
};

const alive = pid => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

// The read-only dashboard rides on the same public URL, behind its own secret.
// The pages are the dashboard's own routes: a hard-coded list drifts from them and the
// views that disappear are the ones nobody notices are missing.
export const DASHBOARD_PAGES = new Set([...Object.keys((await import('./dashboard.mjs')).VIEW_PATHS), '/index.html']);

export async function dashboardFor({dataDir, project, origin, call}) {
  const {createDashboardHandler, createObserver} = await import('./dashboard.mjs');
  const {randomBytes} = await import('node:crypto');
  const state = await readState(dataDir);
  const secret = state.dashboardSecret ?? randomBytes(32).toString('hex');
  await writeState(dataDir, {dashboardSecret: secret, dashboardSecretAt: state.dashboardSecretAt ?? new Date().toISOString()});

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
    // The tunnel may have died while the gateway stayed up. Ask the provider
    // before claiming that everything is already on.
    const existing = state.provider ? tunnels.byId[state.provider] : null;
    const alive = existing?.status ? await existing.status().catch(() => ({running: false})) : {running: false};
    if (alive.running) {
      return {ok: true, url: state.url, message: 'Already on. The public URL is unchanged.', reused: true};
    }
  }

  const gateway = state.gatewayPid && alive(state.gatewayPid) ? {pid: state.gatewayPid, port: state.gatewayPort ?? port} : await startGatewayProcess({dataDir, port});
  // Record the gateway before the tunnel starts, so a failure below leaves
  // something `remote off` can stop instead of an orphan on the port.
  await writeState(dataDir, {gatewayPid: gateway.pid, gatewayPort: gateway.port});
  if (!await waitForGateway(gateway.port)) {
    return {ok: false, message: `The gateway did not start on port ${gateway.port}. Run \`agent-relay remote gateway\` to see why.`};
  }
  const abandon = async message => {
    try { process.kill(gateway.pid); } catch { /* it is already gone */ }
    await writeState(dataDir, {gatewayPid: null, gatewayPort: null});
    return {ok: false, message};
  };

  const picked = await tunnels.pick({preferred: provider});
  if (!picked.provider) {
    return abandon(picked.hint ?? 'No tunnel provider is available.');
  }
  if (!picked.state.signedIn && picked.provider.signIn) {
    const signedIn = await picked.provider.signIn();
    if (!signedIn.ok) return abandon(signedIn.message);
  }
  const started = await picked.provider.start({port: gateway.port, hostname, configDir: dataDir});
  if (!started.ok) return abandon(started.message);

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
    // The dashboard link is a bearer secret too: closing the URL drops it.
    await writeState(dataDir, {url: null, gatewayPid: null, provider: null, revoked: count, dashboardSecret: null, dashboardSecretAt: null});
    return {ok: true, message: `Closed the public URL and revoked ${count} token${count === 1 ? '' : 's'} and the dashboard link.`};
  }
  await writeState(dataDir, {url: null, gatewayPid: null, provider: null, dashboardSecret: null, dashboardSecretAt: null});
  return {ok: true, message: 'Closed the public URL. Tokens stay until they expire; use `agent-relay remote revoke --all` to drop them now.'};
}

export async function remoteStatus({dataDir}) {
  const state = await readState(dataDir);
  const store = await new TokenStore(dataDir).load();
  const pending = store.pendingPairings();
  // The gateway is ours only if the recorded process is still alive. A port
  // that answers could be somebody else's service.
  const gatewayUp = Boolean(state.gatewayPid && alive(state.gatewayPid))
    && Boolean(state.gatewayPort ? await waitForGateway(state.gatewayPort, {timeout: 2000}) : false);
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
  const waiting = store.pendingPairings().length;
  // A cloud agent waiting for a human is a normal state, not a fault.
  checks.push({name: 'Pairing requests waiting', ok: true, detail: waiting ? `${waiting} waiting for approval` : 'none'});
  if (project) {
    const {rooms} = await (await import('./client.mjs')).localRpc(project ?? process.cwd(), {op: 'rooms'}).catch(() => ({rooms: []}));
    const resolved = await resolveRoom({repo: await originOf(project), branch: await branchOf(project), rooms, aliases: await loadAliases(dataDir)});
    checks.push({name: 'This project resolves to a room', ok: Boolean(resolved.room), detail: resolved.room ?? resolved.reason});
  }
  return {ok: checks.every(check => check.ok), checks};
}

// The question a person answers before a token exists. The checkout is in the
// question, so the yes is for a path and not only for a repository name.
export function approvalQuestion(code, checkout) {
  return `Approve ${code} for ${checkout}? [y/N] `;
}

// Approve a waiting cloud agent and hand it a token scoped to its room.
export async function remoteApprove({dataDir, code, alwaysOn = false, ttlMs, agentPrefix = '', project, rooms: givenRooms}) {
  const store = await new TokenStore(dataDir).load();
  const row = store.findPairing(code);
  if (!row) return {ok: false, message: 'No waiting request has that code.'};
  if (row.approvedAt) return {ok: false, message: 'That request was already approved.'};

  // The rooms come from the local broker, so the room list is never asked of the cloud agent.
  const rooms = givenRooms ?? (await (await import('./client.mjs')).localRpc(project ?? process.cwd(), {op: 'rooms'}).catch(() => ({rooms: []}))).rooms;
  const resolved = await resolveRoom({repo: row.repo, branch: row.branch, rooms, aliases: await loadAliases(dataDir)});
  if (!resolved.room) {
    return {ok: false, message: `No local room matches ${row.repo}${row.branch ? ` (${row.branch})` : ''}. Add one with \`agent-relay remote room add ${row.repo} <path>\`, or approve from the right project directory.`};
  }
  const token = store.issue({room: resolved.room, agentPrefix, runner: row.runner, alwaysOn, ttlMs});
  store.approve(row, token, token.value);
  // The value goes to the running gateway over the local socket. It is not written down.
  // If the gateway is not there, the approval is dropped and nothing is saved.
  try { await store.handOver(); }
  catch (error) {
    store.forgetApproval(row, token.id);
    return {ok: false, message: error.message};
  }
  await store.save();
  await new AuditLog(dataDir).write({event: 'approve', runner: row.runner, room: resolved.room, result: 'approved', tokenId: token.id});
  return {ok: true, message: `Approved ${row.runner} for checkout ${resolved.room}. The agent now has a token.`, tokenId: token.id, room: resolved.room, runner: row.runner};
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
  if (!count) return {ok: false, message: all ? 'There was no token to revoke.' : 'No token with that id.'};
  await store.save();
  await new AuditLog(dataDir).write({event: 'revoke', result: 'revoked', count});
  return {ok: true, message: `Revoked ${count} token${count === 1 ? '' : 's'}.`};
}

export async function remoteRoomAdd({dataDir, alias, project}) {
  // The broker reports a room by its real path, so the alias is stored the
  // same way: otherwise the alias never matches and the approval fails.
  const resolved = await fs.realpath(path.resolve(project)).catch(() => path.resolve(project));
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
  // With --url-in-env the URL stays out of git: the cloud environment provides it.
  const server = {
    command: process.execPath,
    args: [cliPath, 'mcp', '--project', project, '--runner', runner],
    // The marker tells `agent-relay setup` that this entry is ours, so a
    // later setup refresh does not refuse it and a second `remote add`
    // overwrites it instead of accusing the operator.
    env: {...(urlInEnv ? {} : {AGENT_RELAY_URL: url}), AGENT_RELAY_MANAGED: '1'},
  };

  const file = runner === 'codex' ? path.join(project, '.codex', 'config.toml') : path.join(project, '.mcp.json');
  await fs.mkdir(path.dirname(file), {recursive: true});

  if (runner === 'codex') {
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    const env = urlInEnv ? '' : `\nenv = { AGENT_RELAY_URL = ${JSON.stringify(url)} }`;
    const section = `[mcp_servers.agent-relay]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}${env}`;
    if (text.includes('[mcp_servers.agent-relay]')) return {ok: false, message: 'This repository already has an agent-relay Codex entry; edit it by hand.'};
    // An inline `mcp_servers = { ... }` table cannot be extended by a named
    // table: the file would stop parsing. Say so instead of breaking it.
    if (/^\s*mcp_servers\s*=/mu.test(text) && !/^\s*\[mcp_servers/mu.test(text)) {
      return {ok: false, message: 'This repository configures mcp_servers inline, so a named table cannot be added. Merge the agent-relay entry into the inline table by hand.'};
    }
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
    servers['agent-relay'] = {...existing, ...server, env: {...existing?.env, ...server.env}};
    data.mcpServers = servers;
    await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  const cloud = runner === 'codex'
    ? [`Set AGENT_RELAY_URL=${url} in the Codex cloud environment, and allow POST to ${url}.`]
    : [`Set AGENT_RELAY_URL=${url} in the Claude cloud environment and allow network access to ${url}.`];
  if (alwaysOn) cloud.push('Add AGENT_RELAY_TOKEN as a secret in that environment; approve it once with `agent-relay remote approve <code> --always-on`.');
  if (urlInEnv) cloud.push(`The URL was kept out of the repository. Set it in the cloud environment: AGENT_RELAY_URL=${url}`);

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

  const approved = await remoteApprove({dataDir, code: body.code, project});
  if (!approved.ok) return {ok: false, message: approved.message};

  const polled = await fetch(`${state.url}/pair/${body.requestId}`).catch(() => null);
  const token = polled ? (await polled.json().catch(() => ({}))).token : null;
  if (!token) return {ok: false, message: 'The approval did not hand over a token. Run `agent-relay remote approve` again.'};

  try {
    const answered = await fetch(`${state.url}/rpc`, {
      method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
      body: JSON.stringify({op: 'agents'}),
    }).catch(() => null);
    if (!answered?.ok) return {ok: false, message: 'The token was refused by the gateway.'};
    return {ok: true, message: `The public URL works end to end for ${runner}. The test token has been revoked.`};
  } finally {
    // Whatever happened, the test leaves no live token behind.
    await remoteRevoke({dataDir, id: approved.tokenId}).catch(() => {});
  }
}

// The room a waiting request would join, for the approval list.
export async function resolveRoomFor({dataDir, repo, branch = '', rooms}) {
  const {resolveRoom, loadAliases} = await import('./remote-rooms.mjs');
  const list = rooms ?? (await (await import('./client.mjs')).localRpc(process.cwd(), {op: 'rooms'}).catch(() => ({rooms: []}))).rooms;
  return resolveRoom({repo, branch, rooms: list, aliases: await loadAliases(dataDir)});
}

// Survive a restart: a launchd job, a systemd user unit or a Task Scheduler
// entry that starts the gateway again when the machine boots.
export async function remotePersist({dataDir, enable = true, port = DEFAULT_GATEWAY_PORT, project}) {
  const cliPath = fileURLToPath(new URL('../bin/agent-relay.mjs', import.meta.url));
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const platform = process.platform;
  // The boot job runs the broker's runtime, not the host binary: on a Bun or
  // OpenCode host, `process.execPath` is the wrong program to start.
  const {resolveNodeRuntime} = await import('./runtime.mjs');
  let runtime = process.execPath;
  try { runtime = (await resolveNodeRuntime({project: project ?? '', dataDir})).command; }
  catch { /* the recorded runtime is used as it stands */ }

  if (platform === 'darwin') {
    const dir = path.join(home, 'Library', 'LaunchAgents');
    const file = path.join(dir, 'dev.agent-relay.gateway.plist');
    if (!enable) {
      await fs.rm(file, {force: true});
      await run('launchctl', ['unload', file]).catch(() => {});
      return {ok: true, message: 'The launchd job is gone. The gateway stops with the machine.'};
    }
    await fs.mkdir(dir, {recursive: true});
    // A path with an ampersand would make the plist invalid, and launchctl
    // would silently never start the job.
    const xml = value => String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.agent-relay.gateway</string>
  <key>ProgramArguments</key>
  <array><string>${xml(runtime)}</string><string>${xml(cliPath)}</string><string>remote</string><string>gateway</string><string>--data-dir</string><string>${xml(dataDir)}</string><string>--port</string><string>${xml(port)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(path.join(dataDir, 'gateway.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(dataDir, 'gateway.log'))}</string>
</dict>
</plist>
`;
    await fs.writeFile(file, plist, {mode: 0o644});
    await run('launchctl', ['unload', file]).catch(() => {});
    await run('launchctl', ['load', file], {timeout: 30000}).catch(() => {});
    return {ok: true, message: `The gateway now starts with the machine (${file}).`};
  }

  if (platform === 'linux') {
    const dir = path.join(home, '.config', 'systemd', 'user');
    const file = path.join(dir, 'agent-relay-gateway.service');
    if (!enable) {
      await run('systemctl', ['--user', 'disable', '--now', 'agent-relay-gateway.service']).catch(() => {});
      await fs.rm(file, {force: true});
      return {ok: true, message: 'The systemd unit is gone. The gateway stops with the machine.'};
    }
    await fs.mkdir(dir, {recursive: true});
    // systemd splits ExecStart on whitespace, so every argument is quoted.
    const quote = value => `"${String(value).replace(/(["\\$])/gu, '\\$1')}"`;
    const unit = `[Unit]
Description=Agent Relay remote gateway
After=network.target

[Service]
ExecStart=${quote(runtime)} ${quote(cliPath)} remote gateway --data-dir ${quote(dataDir)} --port ${quote(port)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
    await fs.writeFile(file, unit, {mode: 0o644});
    await run('systemctl', ['--user', 'daemon-reload']).catch(() => {});
    await run('systemctl', ['--user', 'enable', '--now', 'agent-relay-gateway.service'], {timeout: 30000}).catch(() => {});
    return {ok: true, message: `The gateway now starts with the machine (${file}).`};
  }

  if (platform === 'win32') {
    const command = `\"${runtime}\" \"${cliPath}\" remote gateway --data-dir \"${dataDir}\" --port ${port}`;
    if (!enable) {
      await run('schtasks', ['/Delete', '/TN', 'AgentRelayGateway', '/F']).catch(() => {});
      return {ok: true, message: 'The scheduled task is gone. The gateway stops with the machine.'};
    }
    await run('schtasks', ['/Create', '/TN', 'AgentRelayGateway', '/TR', command, '/SC', 'ONLOGON', '/F'], {timeout: 30000}).catch(() => {});
    return {ok: true, message: 'The gateway now starts when you log in (Task Scheduler: AgentRelayGateway).'};
  }

  return {ok: false, message: `No persistent job is known for ${platform}.`};
}

// A Cloudflare Access service token, so the public URL needs one more secret.
export async function remoteAccess({dataDir, clientId, clientSecret, remove = false}) {
  const file = path.join(dataDir, 'remote-access.json');
  if (remove) {
    await fs.rm(file, {force: true});
    return {ok: true, message: 'The gateway no longer asks for a Cloudflare Access token.'};
  }
  const id = clientId ?? process.env.AGENT_RELAY_ACCESS_CLIENT_ID;
  const secret = clientSecret ?? process.env.AGENT_RELAY_ACCESS_CLIENT_SECRET;
  if (!id || !secret) return {ok: false, message: 'Set AGENT_RELAY_ACCESS_CLIENT_ID and AGENT_RELAY_ACCESS_CLIENT_SECRET, or pass --access-client-id and --access-client-secret.'};
  await fs.mkdir(dataDir, {recursive: true, mode: 0o700});
  await fs.writeFile(file, JSON.stringify({clientId: id, clientSecret: secret}), {mode: 0o600});
  return {ok: true, message: 'The gateway now asks for a Cloudflare Access token.'};
}

export async function readAccess(dataDir) {
  try {
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'remote-access.json'), 'utf8'));
    return stored.clientId && stored.clientSecret ? stored : null;
  } catch { return null; }
}

// A one-time link to the read-only dashboard, through the public URL.
export const DASHBOARD_LINK_TTL_MS = 24 * 60 * 60 * 1000;

// A one-time link to the read-only dashboard, through the public URL.
export async function remoteDashboard({dataDir, project, revoke = false}) {
  const state = await readState(dataDir);
  if (!state.url) return {ok: false, message: 'No public URL yet. Run `agent-relay remote on` first.'};
  if (revoke) {
    await writeState(dataDir, {dashboardSecret: null, dashboardSecretAt: null});
    return {ok: true, message: 'The dashboard link is revoked. Every link handed out before now stops working.'};
  }
  if (!state.dashboardSecret) return {ok: false, message: 'The gateway is not running with the dashboard. Run `agent-relay remote gateway` or `agent-relay remote on` again.'};
  const age = state.dashboardSecretAt ? Date.now() - new Date(state.dashboardSecretAt).getTime() : Infinity;
  if (age > DASHBOARD_LINK_TTL_MS) {
    return {ok: false, message: 'That dashboard link has expired. Run `agent-relay remote dashboard --revoke` and then `agent-relay remote on` to get a new one.'};
  }
  return {
    ok: true,
    url: `${state.url}/#${state.dashboardSecret}`,
    message: 'Read-only dashboard, through the public URL. The link is valid for 24 hours; revoke it with `agent-relay remote dashboard --revoke`.',
  };
}

export {startGateway, DEFAULT_GATEWAY_PORT};
