// Move the site to a different domain. One command, every absolute URL on the site.
//
//   node scripts/set-site-origin.mjs https://agent-relay.example
//   node scripts/set-site-origin.mjs            # print the current origin
//
// It rewrites the canonical, Open Graph and Twitter URLs, the sitemap, the
// robots.txt sitemap line, the 404 page, the web manifest, package.json's
// homepage and the README links. Relative links are left alone: they keep the
// site working under any path.
//
// The current origin is read from package.json, so the command works in both
// directions and can be run more than once.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [
  'site/robots.txt',
  'site/sitemap.xml',
  'site/404.html',
  'site/site.webmanifest',
  'site/index.html',
  'site/product/index.html',
  'site/dashboard/index.html',
  'site/architecture/index.html',
  'site/security/index.html',
  'site/start/index.html',
  'site/variants/index.html',
  'site/variants/a/index.html',
  'site/variants/b/index.html',
  'site/variants/c/index.html',
  'site/README.md',
];

const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
const current = (pkg.homepage ?? '').replace(/\/+$/, '');
const target = process.argv[2];

if (!target) {
  console.log(current);
  process.exit(0);
}

let origin;
try {
  const url = new URL(target);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol');
  origin = url.origin + url.pathname.replace(/\/+$/, '');
} catch {
  console.error(`Not a usable origin: ${target}`);
  process.exit(1);
}

if (!current) {
  console.error('package.json has no homepage to move from.');
  process.exit(1);
}
if (current === origin) {
  console.log(`Already on ${origin}.`);
  process.exit(0);
}

let changed = 0;
for (const file of files) {
  const full = path.join(root, file);
  const before = await fs.readFile(full, 'utf8');
  const after = before.split(current).join(origin);
  if (after !== before) {
    await fs.writeFile(full, after);
    changed++;
  }
}

pkg.homepage = `${origin}/`;
await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const readmePath = path.join(root, 'README.md');
const readme = await fs.readFile(readmePath, 'utf8');
await fs.writeFile(readmePath, readme.split(current).join(origin));

console.log(`${current} -> ${origin}`);
console.log(`${changed} of ${files.length} site files rewritten, plus package.json and README.md.`);
console.log('Now point the domain at Cloudflare and set the custom domain in wrangler.jsonc; GitHub Pages keeps serving the same files as a mirror.');
