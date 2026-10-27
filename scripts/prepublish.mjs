// The gate that runs before a publish.
//
// In a source checkout it runs the full release check: the suite, the packed
// archive and the CLI inside it. In an installed copy of the package there is
// no checkout to check, and the publish is not ours to gate, so it says so and
// lets the publish happen.
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const checker = path.join(root, 'scripts', 'release-check.mjs');

if (!existsSync(checker) || !existsSync(path.join(root, 'test'))) {
  console.log('Not a source checkout: nothing to check before publishing.');
  process.exit(0);
}

const run = args => {
  const result = spawnSync(process.execPath, args, {cwd: root, stdio: 'inherit'});
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(['--test', '--test-timeout=300000']);
run([checker]);
