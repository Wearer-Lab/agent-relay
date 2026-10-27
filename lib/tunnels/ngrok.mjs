// ngrok: an alternative that needs an account and has a monthly request cap.
import {exists, run, spawnBackground, stopProcess, waitFor} from './base.mjs';

export const id = 'ngrok';
export const name = 'ngrok';
export const stable = true;

const state = {pid:null};

export async function detect() {
  if (!await exists('ngrok')) {
    return {available: false, installed: false, hint: 'Install ngrok first: brew install ngrok'};
  }
  const {stdout} = await run('ngrok', ['config', 'check'], {timeout: 8000}).catch(() => ({stdout: ''}));
  const signedIn = /authtoken|valid/i.test(stdout);
  return {available: true, installed: true, signedIn, hint: signedIn ? '' : 'Run `ngrok config add-authtoken <token>` once.'};
}

export async function signIn() {
  const state = await detect();
  if (!state.installed) return {ok: false, message: state.hint};
  if (state.signedIn) return {ok: true, message: 'Already signed in.'};
  return {ok: false, message: 'ngrok has no authtoken yet. Run `ngrok config add-authtoken <token>` and try again.'};
}

export async function start({port, domain}) {
  const args = ['http', '--log', 'stdout'];
  if (domain) args.push(`--url=${domain}`);
  args.push(String(port));
  const {read, pid} = spawnBackground('ngrok', args);
  state.pid = pid;
  const {output, match} = await waitFor(read, /https:\/\/[a-z0-9-]+\.(ngrok-free\.app|ngrok\.io)/i);
  if (!match) return {ok: false, message: 'ngrok did not start.', output};
  return {ok: true, url: match[0], message: 'ngrok is serving the gateway. The free plan caps requests, so remote long polls are shortened.'};
}

export async function stop() {
  await stopProcess(state.pid);
  return {ok: true, message: 'ngrok stopped.'};
}

export async function status() {
  const state = await detect();
  return {running: state.installed, url: null, message: state.installed ? (state.signedIn ? 'Signed in.' : state.hint) : state.hint};
}
