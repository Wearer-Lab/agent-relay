// Delete the hidden files macOS writes next to real ones: `._name` AppleDouble
// files (on external and network drives) and `.DS_Store`. They break the site
// tests, end up in Cloudflare uploads, and the ones inside .git/objects/pack
// make every git command print "non-monotonic index" errors.
//
//   node scripts/clean-macos-files.mjs            # delete them under the repository
//   node scripts/clean-macos-files.mjs --dry-run  # list them, delete nothing
//   node scripts/clean-macos-files.mjs <dir>      # clean another directory
//
// Only files are removed, never directories, and symbolic links are not followed.
// macOS writes them again when it touches the files, so rerun this before tests
// or a deploy from a drive that is not APFS.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const root = path.resolve(args.find(arg => !arg.startsWith('--')) ?? fileURLToPath(new URL('../', import.meta.url)));

export const isMacJunk = name => name === '.DS_Store' || name.startsWith('._');

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, {withFileTypes: true});
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && isMacJunk(entry.name)) yield full;
  }
}

let count = 0;
for await (const file of walk(root)) {
  if (dryRun) console.log(path.relative(root, file));
  else await fs.rm(file, {force: true});
  count++;
}
console.log(`${dryRun ? 'Would delete' : 'Deleted'} ${count} macOS hidden file${count === 1 ? '' : 's'} under ${root}`);
