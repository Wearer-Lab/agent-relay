import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitCommonDir } from '../lib/gitworktree.mjs';
const run = promisify(execFile);

test('gitCommonDir resolves one common directory for a checkout and its linked worktrees', async t => {
  try { await run('git', ['--version']); } catch { t.skip('git is unavailable'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-git-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const worktree = path.join(root, 'wt');
  await fs.mkdir(repo);
  await run('git', ['init'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'file.txt'), 'x');
  await run('git', ['add', 'file.txt'], { cwd: repo });
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'], { cwd: repo });
  await run('git', ['worktree', 'add', worktree, '-b', 'feature'], { cwd: repo });
  const common = await gitCommonDir(repo);
  assert.equal(common, path.join(await fs.realpath(repo), '.git'));
  assert.equal(await gitCommonDir(worktree), common);
  assert.equal(await gitCommonDir(root), null);
  assert.equal(await gitCommonDir(path.join(root, 'missing')), null);
});

test('gitCommonDir fails closed on git errors and empty discovery output', async () => {
  const fails = (command, args, options, callback) => callback(new Error('spawn git ENOENT'));
  const empty = (command, args, options, callback) => callback(null, '  \n');
  assert.equal(await gitCommonDir(process.cwd(), { exec: fails }), null);
  assert.equal(await gitCommonDir(process.cwd(), { exec: empty }), null);
});
