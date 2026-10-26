import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// The broker daemon is a Node program. A host that is not Node (Bun, an
// OpenCode binary) cannot spawn it with process.execPath, so the runtime is
// resolved explicitly and recorded next to the data directory.
export const RUNTIME_RECORD_FILE = 'node-runtime.json';
export const RUNTIME_ENV = 'AGENT_RELAY_NODE';
export const MIN_NODE_MAJOR = 20;
export const RUNTIME_INSTALL_HINT = 'https://nodejs.org/en/download';

async function readText(file) {
  return await fsp.readFile(file, 'utf8');
}

/** The host we are running inside: Node, Bun, an OpenCode binary, or unknown. */
export function runtimeHostName(execPath = process.execPath, versions = process.versions) {
  const base = path.basename(String(execPath ?? '')).toLowerCase().replace(/\.exe$/u, '');
  if (base.includes('opencode')) return 'OpenCode';
  if (base.includes('bun')) return 'Bun';
  if (versions?.bun) return 'Bun';
  if (base === 'node' || base.startsWith('node-')) return 'Node';
  return null;
}

/** Ask a binary for its version; only Node answers with a vX.Y.Z version. */
export async function probeNode(command, { exec = execFileAsync, timeout = 5000, minMajor = MIN_NODE_MAJOR } = {}) {
  if (typeof command !== 'string' || !command.trim()) return { ok: false, reason: 'no runtime given' };
  try {
    const { stdout } = await exec(command, ['--version'], { timeout, windowsHide: true });
    const first = String(stdout ?? '').split('\n')[0].trim();
    const match = /^v(\d+)\.(\d+)\.(\d+)/u.exec(first);
    if (!match) return { ok: false, reason: `"${first || 'no output'}" is not a Node version` };
    const major = Number(match[1]);
    if (major < minMajor) return { ok: false, reason: `Node ${first} is older than the required Node ${minMajor}` };
    return { ok: true, version: first, major };
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, reason: 'not found' };
    if (error.code === 'EACCES' || error.code === 'EPERM') return { ok: false, reason: 'not executable' };
    return { ok: false, reason: error.message };
  }
}

/** The first `node` on PATH, if any. */
export async function lookupNodeOnPath({ env = process.env, platform = process.platform, access = fsp.access } = {}) {
  const raw = env.PATH ?? env.Path ?? env.path ?? '';
  const names = platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node'];
  for (const dir of String(raw).split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try { await access(candidate, fs.constants.X_OK); return candidate; }
      catch { /* keep looking */ }
    }
  }
  return null;
}

/** The runtime the setup step recorded in the data directory. */
export async function readRecordedRuntime(dataDir, { readFile = readText } = {}) {
  if (!dataDir) return null;
  try {
    const parsed = JSON.parse(await readFile(path.join(dataDir, RUNTIME_RECORD_FILE)));
    if (typeof parsed?.command === 'string' && parsed.command.trim()) return { command: parsed.command.trim(), source: 'data-dir' };
  } catch { /* nothing recorded */ }
  return null;
}

/** The runtime the setup step recorded in the project bindings. */
export async function readProjectRuntime(project, { readFile = readText } = {}) {
  if (!project) return null;
  const root = path.resolve(project);
  try {
    const parsed = JSON.parse(await readFile(path.join(root, '.agent-relay.json')));
    if (typeof parsed?.node === 'string' && parsed.node.trim()) return { command: parsed.node.trim(), source: 'project' };
  } catch { /* not managed by setup */ }
  try {
    const { parse } = await import('jsonc-parser');
    const parsed = parse(await readFile(path.join(root, '.mcp.json')), [], { allowTrailingComma: true });
    const command = parsed?.mcpServers?.['agent-relay']?.command;
    if (typeof command === 'string' && command.trim()) return { command: command.trim(), source: 'project' };
  } catch { /* no Claude binding */ }
  try {
    const { parse } = await import('smol-toml');
    const parsed = parse(await readFile(path.join(root, '.codex', 'config.toml')), { integersAsBigInt: 'asNeeded' });
    const command = parsed?.mcp_servers?.['agent-relay']?.command;
    if (typeof command === 'string' && command.trim()) return { command: command.trim(), source: 'project' };
  } catch { /* no Codex binding */ }
  return null;
}

/**
 * Resolve a real Node runtime for the broker daemon.
 *
 * Order: the explicit environment override, the runtime recorded by the setup
 * step, this process when it already runs Node, then `node` on PATH. The host
 * binary is never spawned blindly: a Bun or OpenCode binary is probed and
 * rejected with a message that names the fix.
 *
 * @returns {Promise<{command: string, source: 'env'|'data-dir'|'project'|'exec-path'|'path', version: string|null}>}
 * @throws {Error} one message naming the single fix when no Node runtime exists
 */
export async function resolveNodeRuntime({
  project = '', dataDir = '', env = process.env, execPath = process.execPath, versions = process.versions,
  probe = probeNode, lookup = lookupNodeOnPath, readFile = readText, minMajor = MIN_NODE_MAJOR,
} = {}) {
  const override = String(env[RUNTIME_ENV] ?? '').trim();
  if (override) {
    const result = await probe(override);
    if (!result.ok) {
      throw new Error(`${RUNTIME_ENV} points at ${override}, which is not a usable Node runtime (${result.reason}). `
        + `Fix it with one command: \`${RUNTIME_ENV}=/path/to/node agent-relay setup --refresh\`.`);
    }
    return { command: override, source: 'env', version: result.version ?? null };
  }
  const candidates = [];
  const recorded = await readRecordedRuntime(dataDir, { readFile });
  if (recorded) candidates.push(recorded);
  const bound = await readProjectRuntime(project, { readFile });
  if (bound) candidates.push(bound);
  const host = runtimeHostName(execPath, versions);
  // process.execPath is only trusted when this process already runs Node.
  if (host === 'Node') candidates.push({ command: execPath, source: 'exec-path' });
  const onPath = await lookup({ env });
  if (onPath) candidates.push({ command: onPath, source: 'path' });
  const tried = [];
  for (const candidate of candidates) {
    if (candidate.source === 'exec-path') return { command: candidate.command, source: candidate.source, version: versions?.node ?? null };
    const result = await probe(candidate.command);
    if (result.ok) return { command: candidate.command, source: candidate.source, version: result.version ?? null };
    tried.push(`${candidate.command} (${result.reason})`);
  }
  const hostNote = host && host !== 'Node' ? ` This host runs ${host}, not Node.` : '';
  throw new Error(`Agent relay needs Node ${minMajor} or newer to run its broker, and no usable Node runtime was found.${hostNote} `
    + `Install Node from ${RUNTIME_INSTALL_HINT}, then run \`agent-relay setup --refresh\` once to record it `
    + `(or set ${RUNTIME_ENV}=/path/to/node). Looked at: ${tried.length ? tried.join(', ') : 'nothing'}.`);
}

/** Record the runtime next to the data directory so the next host can reuse it. */
export async function recordNodeRuntime(dataDir, runtime, { now = Date.now(), readFile = readText } = {}) {
  if (!dataDir || !runtime?.command) return null;
  const file = path.join(dataDir, RUNTIME_RECORD_FILE);
  try {
    const current = JSON.parse(await readFile(file));
    if (current?.command === runtime.command) return file;
  } catch { /* nothing recorded yet */ }
  const payload = { version: 1, command: runtime.command, source: runtime.source ?? 'unknown',
    nodeVersion: runtime.version ?? null, recordedAt: new Date(now).toISOString() };
  await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fsp.writeFile(file, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  return file;
}

/**
 * Rename a file, retrying the Windows sharing failures (EPERM, EACCES, EBUSY)
 * that clear within milliseconds when another process still holds the file.
 */
export async function renameWithRetry(from, to, {
  rename = (source, target) => fsp.rename(source, target),
  platform = process.platform, attempts = 20, codes = ['EPERM', 'EACCES', 'EBUSY'],
  delay = attempt => 10 + attempt * 10,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) {
      if (platform !== 'win32' || attempt >= attempts || !codes.includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, delay(attempt)));
    }
  }
}
