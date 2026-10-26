import { promises as fs } from 'node:fs';
import path from 'node:path';

// Startup hygiene for the data directory. The temporary files of a crashed run
// and the backups of old restores pile up; the broker removes them once it
// holds the writer lease, so no live broker can be using them.
const STALE_TEMP_FILE = /^(?:broker\.json\..*\.tmp|\.state-.*\.tmp)$/u;
const STATE_BACKUP_FILE = /^state\.backup-.*\.json$/u;
export const DEFAULT_STATE_BACKUPS = 3;

/**
 * Remove the stale temporary files and the oldest state backups.
 * Never touches state.json, token, broker.json, broker.log or the writer lock:
 * only the files of a run that is gone.
 */
export async function cleanupDataDir(directory, { keepBackups = DEFAULT_STATE_BACKUPS } = {}) {
  let names = [];
  try { names = await fs.readdir(directory); }
  catch { return { removed: [], kept: [] }; }
  const stale = [];
  const backups = [];
  for (const name of names) {
    if (STALE_TEMP_FILE.test(name)) stale.push(name);
    else if (STATE_BACKUP_FILE.test(name)) backups.push(name);
  }
  const stamped = await Promise.all(backups.map(async name => {
    try { return { name, at: (await fs.stat(path.join(directory, name))).mtimeMs }; }
    catch { return { name, at: 0 }; }
  }));
  stamped.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
  const kept = stamped.slice(0, Math.max(0, keepBackups));
  const dropped = stamped.slice(Math.max(0, keepBackups)).map(row => row.name);
  const removed = [];
  for (const name of [...stale, ...dropped]) {
    try { await fs.rm(path.join(directory, name), { force: true }); removed.push(name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { removed, kept: kept.map(row => row.name) };
}
