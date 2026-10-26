// Run several adversarial review lanes in parallel and collect their findings.
//
//   node scripts/parallel-review.mjs                          # every lane in docs/reviews/lanes
//   node scripts/parallel-review.mjs --lanes 02,04           # only these lanes
//   node scripts/parallel-review.mjs --out my-review.md      # write somewhere else
//
// Each lane is a markdown file under docs/reviews/lanes/ that tells a fresh agent
// what to attack and what to report. The lanes run at the same time, each in its
// own session, and never touch a file: they report, a human (or the caller)
// decides what to change.
//
// It needs the opencode CLI on the path, which is how this project is reviewed
// between releases.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const laneDir = path.join(root, 'docs', 'reviews', 'lanes');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const wanted = flag('lanes', '')?.split(',').map(v => v.trim()).filter(Boolean) ?? [];
const outFile = path.join(root, flag('out', path.join('docs', 'reviews', `${new Date().toISOString().slice(0, 10)}-parallel-review.md`)));
const agent = flag('agent', 'general');

const run = (file) => new Promise(resolve => {
  const child = spawn('opencode', ['run', '--format', 'json', '--agent', agent, '--title', `review ${path.basename(file, '.md')}`, '--auto', path.join(laneDir, file)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => resolve({file, text: '', error: error.message}));
  child.on('close', code => {
    if (code !== 0) return resolve({file, text: '', error: stderr.trim().split('\n').slice(-3).join('\n') || `exited ${code}`});
    resolve({file, text: extract(stdout), error: ''});
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

const all = (await fs.readdir(laneDir)).filter(file => file.endsWith('.md')).sort();
const lanes = wanted.length ? all.filter(file => wanted.some(w => file.startsWith(w))) : all;
if (!lanes.length) {
  console.error(`No lanes found in ${laneDir}`);
  process.exit(1);
}

console.log(`Running ${lanes.length} review lane(s) in parallel: ${lanes.join(', ')}`);
const started = Date.now();
const results = await Promise.all(lanes.map(run));
const minutes = ((Date.now() - started) / 60000).toFixed(1);

const sections = [];
for (const result of results) {
  const name = result.file.replace(/\.md$/, '');
  sections.push(result.error
    ? `## ${name}\n\n**The lane did not finish.**\n\n\`\`\`\n${result.error}\n\`\`\``
    : `## ${name}\n\n${result.text}`);
}
const report = `# Parallel adversarial review

${new Date().toISOString().slice(0, 10)} · ${lanes.length} lane(s) in parallel · ${minutes} minutes

Lanes: ${lanes.map(l => l.replace(/\.md$/, '')).join(', ')}
Model: the opencode CLI, agent \`${agent}\`, one session per lane.

Each lane was told to report findings only and not to change a file.

${sections.join('\n\n---\n\n')}
`;
await fs.mkdir(path.dirname(outFile), {recursive: true});
await fs.writeFile(outFile, report, 'utf8');
console.log(`Wrote ${path.relative(root, outFile)} (${lanes.length} lane(s), ${minutes} minutes)`);
const failed = results.filter(result => result.error).length;
if (failed) {
  console.error(`${failed} lane(s) did not finish; see the report.`);
  process.exit(1);
}
