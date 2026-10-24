// Room resolution: a cloud agent says which repository it is in, and we find the
// local room that has the same checkout. No local path ever leaves the machine.
import {promises as fs} from 'node:fs';
import path from 'node:path';

// "github.com/org/repo", "https://github.com/org/repo.git" and
// "git@github.com:org/repo.git" all mean the same repository.
export function normalizeRepo(repo) {
  if (typeof repo !== 'string') return '';
  let value = repo.trim();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  value = value.replace(/^[^@/]+@/, '');
  value = value.replace(/^([^/:]+):(?=\S)/, '$1/');
  value = value.replace(/\.git$/i, '');
  value = value.replace(/\/+$/, '');
  return value.toLowerCase();
}

// The branch a checkout is on, read from .git/HEAD.
export async function branchOf(project) {
  try {
    const head = await fs.readFile(path.join(project, '.git', 'HEAD'), 'utf8');
    const match = head.match(/ref:\s*refs\/heads\/(.+)/);
    return match ? match[1].trim() : '';
  } catch { return ''; }
}

// The origin remote of a checkout, read from .git/config.
export async function originOf(project) {
  const candidates = [path.join(project, '.git', 'config')];
  try {
    const pointer = await fs.readFile(path.join(project, '.git'), 'utf8');
    const match = pointer.match(/gitdir:\s*(.+)/);
    if (match) candidates.unshift(path.join(match[1].trim(), 'config'));
  } catch { /* a plain checkout has a .git directory */ }
  for (const file of candidates) {
    try {
      const config = await fs.readFile(file, 'utf8');
      const section = config.match(/\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/);
      const url = section?.[1]?.match(/^\s*url\s*=\s*(.+)$/m)?.[1]?.trim();
      if (url) return normalizeRepo(url);
    } catch { /* try the next candidate */ }
  }
  return '';
}

// True when the checkout is the main one rather than a linked worktree.
export async function isMainCheckout(project) {
  try {
    const info = await fs.stat(path.join(project, '.git'));
    return info.isDirectory();
  } catch { return false; }
}

// Aliases let a person name a room by hand when the repository does not match.
export async function loadAliases(dataDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dataDir, 'remote-rooms.json'), 'utf8'));
  } catch { return {aliases: {}}; }
}

export async function saveAlias(dataDir, alias, project) {
  const stored = await loadAliases(dataDir);
  stored.aliases[alias] = project;
  await fs.writeFile(path.join(dataDir, 'remote-rooms.json'), JSON.stringify(stored, null, 2), {mode: 0o600});
  return stored.aliases;
}

// Find the local room for a cloud agent.
//
// The rules, in order: an alias the person set up wins; then a checkout with the
// same repository on the requested branch; then the main checkout of that
// repository; then any checkout of it.
export async function resolveRoom({repo, branch = '', rooms = [], aliases = {}}) {
  const wanted = normalizeRepo(repo);
  const alias = aliases[wanted] ?? aliases[repo];
  if (alias) {
    const match = rooms.find(room => room.project === alias);
    if (match) return {room: match.project, reason: 'alias', matched: wanted};
  }
  if (!wanted) return {room: null, reason: 'no-repository'};

  const candidates = [];
  for (const room of rooms) {
    const origin = room.origin ?? await originOf(room.project);
    if (origin !== wanted) continue;
    const branchName = room.branch ?? await branchOf(room.project);
    const main = room.main ?? await isMainCheckout(room.project);
    candidates.push({project: room.project, branch: branchName, main});
  }
  if (!candidates.length) return {room: null, reason: 'no-match', matched: wanted};

  if (branch) {
    const onBranch = candidates.find(candidate => candidate.branch === branch);
    if (onBranch) return {room: onBranch.project, reason: 'branch', matched: wanted};
  }
  const main = candidates.find(candidate => candidate.main);
  if (main) return {room: main.project, reason: 'main-checkout', matched: wanted};
  return {room: candidates[0].project, reason: 'checkout', matched: wanted};
}
