// Run several implementation lanes in parallel, each in its own git worktree, and
// collect their reports.
//
//   node scripts/parallel-work.mjs                       # every lane in docs/roadmaps/lanes
//   node scripts/parallel-work.mjs --lanes 01,04          # only these lanes
//   node scripts/parallel-work.mjs --dry-run              # set up the worktrees, print the plan
//   node scripts/parallel-work.mjs --merge                # merge the finished lanes into one branch
//
// A lane is a markdown file under docs/roadmaps/lanes/ that tells a fresh agent what to
// build, which files it owns, and what to report. The lanes run at the same time, each in
// its own worktree and branch, so two agents never edit the same file at the same time.
// Afterwards the orchestrator merges the branches and resolves the few places where two
// lanes needed the same line.
//
// It needs the opencode CLI on the path, which is how this project runs a wave of work
// between releases.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const laneDir = path.join(root, 'docs', 'roadmaps', 'lanes');
const worktreeRoot = path.join(root, '.worktrees');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const has = name => args.includes(`--${name}`);
const wanted = flag('lanes', '')?.split(',').map(v => v.trim()).filter(Boolean) ?? [];
const agent = flag('agent', 'general');
const base = flag('base', 'wave1/base');
const outFile = path.join(root, flag('out', path.join('docs', 'roadmaps', 'reports', `${new Date().toISOString().slice(0, 10)}-parallel-work.md`)));
const mergeInto = flag('merge-into', 'wave1/integrated');

const git = (args, cwd = root) => new Promise((resolve, reject) => {
  const child = spawn('git', args, {cwd, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`)));
});

const lanes = (await fs.readdir(laneDir)).filter(file => file.endsWith('.md') && !['README.md'].includes(file)).sort();
const selected = wanted.length ? lanes.filter(file => wanted.some(w => file.startsWith(w))) : lanes;
if (!selected.length) {
  console.error(`No lanes found in ${laneDir}`);
  process.exit(1);
}

// Each lane gets its own worktree and branch, so a lane never sees another lane's edits.
const worktrees = [];
for (const file of selected) {
  const name = file.replace(/\.md$/, '');
  const directory = path.join(worktreeRoot, name);
  const branch = `lane/${name}`;
  const existing = await git(['branch', '--list', branch]).catch(() => '');
  if (!existing.trim()) await git(['worktree', 'add', '-q', directory, '-b', branch, base]);
  // node_modules is one symlink away in the main checkout; a lane must not install its own.
  await fs.symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir').catch(() => {});
  worktrees.push({file, name, directory, branch});
}

console.log(`${worktrees.length} lane(s) on ${base}:`);
for (const lane of worktrees) console.log(`  ${lane.name}  ->  ${path.relative(root, lane.directory)}  (${lane.branch})`);
if (has('dry-run')) {
  console.log('\nDry run: the worktrees are ready. Drop --dry-run to run the lanes.');
  process.exit(0);
}

const run = lane => new Promise(resolve => {
  const child = spawn('opencode', ['run', '--format', 'json', '--agent', agent, '--title', `lane ${lane.name}`, '--auto', path.join(laneDir, lane.file)], {
    cwd: lane.directory,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, AGENT_RELAY_LANE_WORKTREE: lane.directory, AGENT_RELAY_LANE_BRANCH: lane.branch},
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => resolve({lane, text: '', error: error.message}));
  child.on('close', code => {
    if (code !== 0) return resolve({lane, text: '', error: stderr.trim().split('\n').slice(-3).join('\n') || `exited ${code}`});
    resolve({lane, text: extract(stdout), error: ''});
  });
});

// opencode prints one JSON event per line; the assistant's final text is the part
// that matters. Fall back to the raw output when the shape is unfamiliar.
const extract = output => {
  const lines = output.split('\n').filter(line => line.trim().startsWith('{'));
  const parts = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const text = event?.part?.text ?? event?.text ?? event?.message?.content;
      if (typeof text === 'string' && text.trim()) parts.push(text.trim());
    } catch { /* not an event */ }
  }
  return parts.length ? parts.at(-1) : output.trim();
};

console.log(`\nRunning ${worktrees.length} lane(s) in parallel...`);
const started = Date.now();
const results = await Promise.all(worktrees.map(run));
const minutes = ((Date.now() - started) / 60000).toFixed(1);

const sections = [];
for (const result of results) {
  sections.push(result.error
    ? `## ${result.lane.name}\n\n**The lane did not finish.**\n\n\`\`\`\n${result.error}\n\`\`\``
    : `## ${result.lane.name}\n\n${result.text}`);
}
const report = `# Parallel roadmap lanes

${new Date().toISOString().slice(0, 10)} · ${worktrees.length} lane(s) in parallel · ${minutes} minutes

Lanes: ${worktrees.map(lane => lane.name).join(', ')}
Base: ${base} · Model: the opencode CLI, agent \`${agent}\`, one session and one worktree per lane.

${sections.join('\n\n---\n\n')}
`;
await fs.mkdir(path.dirname(outFile), {recursive: true});
await fs.writeFile(outFile, report, 'utf8');
console.log(`Wrote ${path.relative(root, outFile)} (${worktrees.length} lane(s), ${minutes} minutes)`);

if (has('merge')) {
  // Merge the lanes one at a time, newest first, so a conflict is one lane's fault.
  // The merge happens in its own worktree: the main checkout keeps the owner's
  // uncommitted work untouched.
  const integration = path.join(worktreeRoot, '_integration');
  const hasIntegration = await git(['worktree', 'list']).then(list => list.includes(integration));
  if (!hasIntegration) await git(['worktree', 'add', '-q', integration, '-b', mergeInto, base]);
  for (const lane of worktrees) {
    const dirty = await git(['status', '--porcelain'], lane.directory).catch(() => '');
    if (dirty.trim()) console.warn(`${lane.name} has uncommitted changes; skipping it.`);
    try {
      await git(['merge', '--no-edit', lane.branch], integration);
      console.log(`merged ${lane.branch}`);
    } catch (error) {
      console.error(`conflict merging ${lane.branch}: ${error.message}`);
      console.error(`Resolve it in ${path.relative(root, integration)}, then run: git merge --continue  (or git merge --abort)`);
      process.exit(1);
    }
  }
  console.log(`\nIntegrated into ${mergeInto} at ${path.relative(root, integration)}. Run the full suite before you trust it.`);
}

const failed = results.filter(result => result.error).length;
if (failed) {
  console.error(`${failed} lane(s) did not finish; see the report.`);
  process.exit(1);
}
