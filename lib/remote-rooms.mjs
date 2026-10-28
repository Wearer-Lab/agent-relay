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

// Where a checkout's git directory really is. A linked worktree has a .git FILE
// that points at it, and the main checkout has a .git directory.
const gitDirOf = async project => {
  const dot = path.join(project, '.git');
  try {
    const info = await fs.stat(dot);
    if (info.isDirectory()) return dot;
    const pointer = await fs.readFile(dot, 'utf8');
    const match = pointer.match(/gitdir:\s*(.+)/);
    if (!match) return dot;
    const target = match[1].trim();
    return path.isAbsolute(target) ? target : path.resolve(project, target);
  } catch { return dot; }
};

// The branch a checkout is on. For a linked worktree the HEAD lives in the
// worktree's own git directory, not in the common one.
export async function branchOf(project) {
  try {
    const head = await fs.readFile(path.join(await gitDirOf(project), 'HEAD'), 'utf8');
    const match = head.match(/ref:\s*refs\/heads\/(.+)/);
    return match ? match[1].trim() : '';
  } catch { return ''; }
}

// The origin remote of a checkout. The config lives in the COMMON git
// directory, which every worktree of a repository shares.
export async function originOf(project) {
  const candidates = [];
  try {
    const dir = await gitDirOf(project);
    candidates.push(path.join(dir, 'config'));
    try {
      const common = (await fs.readFile(path.join(dir, 'commondir'), 'utf8')).trim();
      candidates.push(path.resolve(dir, common, 'config'));
    } catch { /* no commondir: a plain checkout */ }
  } catch { /* no git at all */ }
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
  stored.aliases[normalizeRepo(alias) ?? alias] = project;
  await fs.writeFile(path.join(dataDir, 'remote-rooms.json'), JSON.stringify(stored, null, 2), {mode: 0o600});
  return stored.aliases;
}

// Find the local room for a cloud agent.
//
// The rules, in order: an alias the person set up wins; then a checkout with the
// same repository on the requested branch. A named branch that no checkout is on
// does not fall through to main: that would approve the agent into the wrong
// checkout. With no branch named, the main checkout wins, then any checkout.
export async function resolveRoom({repo, branch = '', rooms = [], aliases = {}}) {
  const wanted = normalizeRepo(repo);
  // Only the normalised name is looked up: the caller's raw string is attacker
  // controlled and must not select a room.
  const alias = aliases[wanted];
  if (alias) {
    const match = rooms.find(room => room.project === alias || path.resolve(room.project) === path.resolve(alias));
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
    return {room: null, reason: 'branch-unmatched', matched: wanted};
  }
  const main = candidates.find(candidate => candidate.main);
  if (main) return {room: main.project, reason: 'main-checkout', matched: wanted};
  return {room: candidates[0].project, reason: 'checkout', matched: wanted};
}
