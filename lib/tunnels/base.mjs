// Tunnel providers: one interface, several implementations.
//
// Every provider answers the same five questions: is it installed, what does the
// person have to do, how do we start it, how do we stop it, and where is it
// pointing right now. `agent-relay remote on` picks the best available one.
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);

export const run = async (file, args, {timeout = 15000} = {}) => {
  const {stdout, stderr} = await exec(file, args, {timeout, maxBuffer: 1024 * 1024});
  return {stdout: String(stdout ?? ''), stderr: String(stderr ?? '')};
};

export const exists = async file => {
  // `which` is not a program on Windows: it is a shell builtin.
  const [command, args] = process.platform === 'win32' ? ['where', [file]] : ['/usr/bin/env', ['which', file]];
  try { await run(command, args, {timeout: 5000}); return true; }
  catch { return false; }
};

export const spawnBackground = (file, args, {env = process.env, cwd = undefined} = {}) => {
  const child = spawn(file, args, {detached: true, stdio: ['ignore', 'pipe', 'pipe'], env, cwd});
  let output = '';
  child.stdout?.on('data', chunk => { output += chunk; });
  child.stderr?.on('data', chunk => { output += chunk; });
  child.unref();
  // The pipes keep the parent's event loop alive for the child's whole life, so
  // the parent would never exit. Unref them: the child still writes, and the
  // output is read until the child goes away.
  child.stdout?.unref?.();
  child.stderr?.unref?.();
  return {child, pid: child.pid, read: () => output};
};

// Stop a tunnel we started. The pid is the only handle left once the process
// is detached.
export const stopProcess = async pid => {
  if (!pid) return false;
  try { process.kill(pid); return true; }
  catch { return false; }
};

// Wait for a string to appear in a background process's output.
export const waitFor = async (read, needle, {timeout = 20000, interval = 250} = {}) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const output = read();
    const found = output.match(needle);
    if (found) return {output, match: found};
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return {output: read(), match: null};
};

export const TUNNEL_PORT = 47820;
