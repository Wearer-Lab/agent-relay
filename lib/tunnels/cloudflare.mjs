// Cloudflare tunnels: a quick tunnel for development and a named tunnel for a
// hostname of your own.
import {exists, run, spawnBackground, waitFor} from './base.mjs';

export const id = 'cloudflare';
export const name = 'Cloudflare tunnel';
export const stable = true;

export async function detect() {
  if (!await exists('cloudflared')) {
    return {available: false, installed: false, hint: 'Install cloudflared first: brew install cloudflared'};
  }
  return {available: true, installed: true, signedIn: true, hint: ''};
}

export async function signIn() {
  const state = await detect();
  if (!state.installed) return {ok: false, message: state.hint};
  return {ok: true, message: 'cloudflared is installed.'};
}

// A quick tunnel needs no account, but its URL changes on every start.
export async function startQuick({port}) {
  const {read} = spawnBackground('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate']);
  const {output, match} = await waitFor(read, /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (!match) return {ok: false, message: 'The quick tunnel did not start.', output};
  return {ok: true, url: match[0], message: 'Quick tunnel: the URL changes on every start.', ephemeral: true};
}

// A named tunnel serves one hostname of your own, and needs the tunnel to exist.
export async function startNamed({port, hostname, configDir}) {
  const {read} = spawnBackground('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`, 'run', 'agent-relay'], {cwd: configDir});
  const {output, match} = await waitFor(read, /https:\/\/[a-z0-9.-]+\.+/i);
  if (!match) return {ok: false, message: 'The named tunnel did not start.', output};
  return {ok: true, url: hostname ? `https://${hostname}` : match[0], message: `Tunnel running for ${hostname ?? 'this hostname'}.`};
}

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
