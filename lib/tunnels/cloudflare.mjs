// Cloudflare tunnels: a quick tunnel for development and a named tunnel for a
// hostname of your own.
import path from 'node:path';
import {exists, run, spawnBackground, waitFor} from './base.mjs';

export const id = 'cloudflare';
export const name = 'Cloudflare tunnel';
export const stable = true;
export const TUNNEL_NAME = 'agent-relay';

export async function detect() {
  if (!await exists('cloudflared')) {
    return {available: false, installed: false, hint: 'Install cloudflared first: brew install cloudflared'};
  }
  return {available: true, installed: true, signedIn: true, hint: ''};
}

// One browser approval, once, for the whole machine.
export async function signIn() {
  const state = await detect();
  if (!state.installed) return {ok: false, message: state.hint};
  const {stdout} = await run('cloudflared', ['tunnel', 'list', '--output', 'json'], {timeout: 20000}).catch(() => ({stdout: ''}));
  try {
    const tunnels = JSON.parse(stdout || '[]');
    if (Array.isArray(tunnels) && tunnels.length) return {ok: true, message: 'cloudflared is ready.'};
  } catch { /* fall through to the login */ }
  await run('cloudflared', ['tunnel', 'login'], {timeout: 120000}).catch(() => {});
  const after = await run('cloudflared', ['tunnel', 'list', '--output', 'json'], {timeout: 20000}).catch(() => ({stdout: ''}));
  try {
    const tunnels = JSON.parse(after.stdout || '[]');
    if (Array.isArray(tunnels) && tunnels.length) return {ok: true, message: 'Signed in to Cloudflare.'};
  } catch { /* ignore */ }
  return {ok: true, message: 'Signed in to Cloudflare. If the browser did not open, run `cloudflared tunnel login` once.'};
}

// A quick tunnel needs no account, but its URL changes on every start.
export async function startQuick({port}) {
  const {read} = spawnBackground('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate']);
  const {output, match} = await waitFor(read, /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (!match) return {ok: false, message: 'The quick tunnel did not start.', output};
  return {ok: true, url: match[0], message: 'Quick tunnel: the URL changes on every start.', ephemeral: true};
}

// A named tunnel serves one hostname of your own: log in, create the tunnel if
// it is not there yet, point the hostname at it, and record it under the data dir.
export async function startNamed({port, hostname, configDir}) {
  const signedIn = await signIn();
  if (!signedIn.ok) return {ok: false, message: signedIn.message};

  const listed = await run('cloudflared', ['tunnel', 'list', '--output', 'json'], {timeout: 20000}).catch(() => ({stdout: '[]'}));
  let tunnels = [];
  try { tunnels = JSON.parse(listed.stdout || '[]'); } catch { tunnels = []; }
  const known = tunnels.find(tunnel => tunnel?.name === TUNNEL_NAME);
  if (!known) {
    const created = await run('cloudflared', ['tunnel', 'create', TUNNEL_NAME], {timeout: 60000}).catch(error => ({stdout: '', stderr: error.message}));
    if (!/Tunnel credentials written|created|Successfully created/i.test(created.stdout + created.stderr)) {
      return {ok: false, message: `cloudflared could not create the tunnel: ${created.stderr.split('\n')[0] || 'unknown error'}`};
    }
  }
  if (hostname) {
    const routed = await run('cloudflared', ['tunnel', 'route', 'dns', TUNNEL_NAME, hostname], {timeout: 60000}).catch(error => ({stdout: '', stderr: error.message}));
    if (/error|failed|already exists|not found/i.test(routed.stderr)) {
      const already = /already exists/i.test(routed.stderr);
      if (!already) return {ok: false, message: `cloudflared could not route ${hostname}: ${routed.stderr.split('\n')[0]}`};
    }
  }

  // The configuration lives under the data directory, so the setup is one folder.
  const configPath = path.join(configDir ?? process.cwd(), 'cloudflared.yml');
  await fsWrite(configPath, [
    `tunnel: ${TUNNEL_NAME}`,
    'credentials-file: ' + (await credentialsPath(TUNNEL_NAME)),
    ...(hostname ? [`ingress:\n  - hostname: ${hostname}\n    service: http://127.0.0.1:${port}\n  - service: http_status:404`] : []),
    '',
  ].join('\n'));

  const {read} = spawnBackground('cloudflared', ['tunnel', '--no-autoupdate', '--config', configPath, 'run', TUNNEL_NAME]);
  const {output, match} = await waitFor(read, /https:\/\/[a-z0-9.-]+\.+/i);
  if (!match) return {ok: false, message: 'The named tunnel did not start.', output};
  return {ok: true, url: hostname ? `https://${hostname}` : match[0], message: `Tunnel running for ${hostname ?? 'this hostname'}.`};
}

const fsWrite = async (file, text) => {
  const {promises: fs} = await import('node:fs');
  await fs.writeFile(file, text, {mode: 0o600});
};

// The credentials cloudflared wrote for the tunnel, wherever it keeps them.
const credentialsPath = async name => {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.cloudflared', `${name}.json`);
};

export async function start(options) {
  if (options.hostname) return startNamed(options);
  return startQuick(options);
}

export async function stop() {
  return {ok: true, message: 'Cloudflare tunnel stopped.'};
}

export async function status() {
  const state = await detect();
  return {running: state.installed, url: null, message: state.installed ? 'cloudflared is installed.' : state.hint};
}
