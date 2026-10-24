// Tailscale Funnel: the default. Free, a stable URL, no domain of your own and
// no request cap. It needs the open-source tailscale build on macOS.
import {exists, run, spawnBackground, waitFor} from './base.mjs';

export const id = 'tailscale';
export const name = 'Tailscale Funnel';
export const stable = true;

const INSTALL = {
  darwin: 'brew install tailscale && open -a Tailscale',
  linux: 'curl -fsSL https://tailscale.com/install.sh | sh',
  win32: 'winget install tailscale.tailscale',
};

export async function detect() {
  if (!await exists('tailscale')) {
    return {available: false, installed: false, hint: `Install Tailscale first: ${INSTALL[process.platform] ?? INSTALL.linux}`};
  }
  const {stdout} = await run('tailscale', ['status', '--json'], {timeout: 8000}).catch(() => ({stdout: ''}));
  let signedIn = false;
  try { signedIn = JSON.parse(stdout)?.BackendState === 'Running'; } catch { signedIn = false; }
  return {available: true, installed: true, signedIn, hint: signedIn ? '' : 'Run `tailscale up` once to sign in; it opens a browser.'};
}

export async function signIn() {
  const state = await detect();
  if (!state.installed) return {ok: false, message: state.hint};
  if (state.signedIn) return {ok: true, message: 'Already signed in.'};
  await run('tailscale', ['up'], {timeout: 120000}).catch(error => ({stdout: '', stderr: error.message}));
  const after = await detect();
  return after.signedIn ? {ok: true, message: 'Signed in to Tailscale.'} : {ok: false, message: 'Tailscale is not signed in yet. Finish the browser approval and run this again.'};
}

export async function start({port}) {
  const {read} = spawnBackground('tailscale', ['funnel', '--bg', String(port)]);
  const {output, match} = await waitFor(read, /https:\/\/[a-z0-9.-]+\.ts\.net/i);
  if (!match) {
    const hint = output.includes('Funnel' ) && /denied|not enabled|requires/i.test(output)
      ? 'Tailscale asked to enable Funnel. Approve it in the browser, then run this again.'
      : 'Tailscale Funnel did not start. Run `tailscale funnel --bg 47820` to see why.';
    return {ok: false, message: hint, output};
  }
  return {ok: true, url: match[0], message: `Funnel is serving ${port}.`};
}

export async function stop({port}) {
  await run('tailscale', ['funnel', 'reset', String(port)], {timeout: 10000}).catch(() => {});
  return {ok: true, message: 'Funnel closed.'};
}

export async function status() {
  const state = await detect();
  return {running: state.signedIn, url: null, message: state.installed ? (state.signedIn ? 'Signed in.' : state.hint) : state.hint};
}
