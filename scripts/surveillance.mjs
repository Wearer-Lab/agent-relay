// Surveillance: watch the deployed surfaces and say what is broken, in one line each.
//
//   node scripts/surveillance.mjs                       # watch the package homepage
//   node scripts/surveillance.mjs https://example.com   # watch another origin
//
// It is dependency-free on purpose: the workflow that runs it needs nothing but Node.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const origin = (process.env.ORIGIN || process.argv[2] || pkg.homepage || '').replace(/\/+$/, '');
if (!origin) {
  console.error('No origin to watch: pass one or set a homepage in package.json.');
  process.exit(1);
}

const PAGES = ['/', '/product/', '/dashboard/', '/architecture/', '/security/', '/start/'];
const failures = [];
const notes = [];

const check = (label, ok, detail = '') => {
  (ok ? notes : failures).push(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const get = async (path, options = {}) => {
  const response = await fetch(origin + path, {redirect: 'follow', ...options});
  const type = response.headers.get('content-type') ?? '';
  const text = /text\/|xml|json/.test(type) ? await response.text() : '';
  return {status: response.status, type, text};
};

// Every public page: 200, one h1, a canonical URL on this origin, and the tags a
// link preview needs.
for (const page of PAGES) {
  const {status, text} = await get(page);
  check(`${page} answers 200`, status === 200, `got ${status}`);
  if (status !== 200 || !text) continue;
  const title = text.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '';
  check(`${page} has a title`, title.length > 0 && title.length <= 60, `${title.length} characters`);
  const description = text.match(/<meta name="description" content="([^"]*)"/i)?.[1] ?? '';
  check(`${page} has a description under 160 characters`, description.length > 0 && description.length <= 160, `${description.length} characters`);
  const canonical = text.match(/<link rel="canonical" href="([^"]*)"/i)?.[1] ?? '';
  check(`${page} points its canonical at this origin`, canonical.startsWith(`${origin}/`), canonical);
  check(`${page} has exactly one h1`, (text.match(/<h1[\s>]/gi) ?? []).length === 1);
  for (const tag of ['og:title', 'og:url', 'og:image', 'twitter:card', 'twitter:image']) {
    check(`${page} has ${tag}`, new RegExp(`<meta (?:property|name)="${tag}"`).test(text));
  }
  check(`${page} has structured data`, /<script type="application\/ld\+json">/.test(text));
}

// The crawler's files.
const robots = await get('/robots.txt');
check('robots.txt answers 200', robots.status === 200, `got ${robots.status}`);
const sitemap = await get('/sitemap.xml');
check('sitemap.xml answers 200', sitemap.status === 200, `got ${sitemap.status}`);
for (const page of PAGES) {
  check(`the sitemap lists ${page}`, sitemap.text.includes(`<loc>${origin}${page === '/' ? '/' : page}</loc>`));
}
for (const icon of ['/favicon.svg', '/assets/favicon-32.png', '/assets/apple-touch-icon.png', '/assets/icon-512.png', '/site.webmanifest']) {
  const {status} = await get(icon);
  check(`${icon} answers 200`, status === 200, `got ${status}`);
}

// A missing path is a styled 404, not a server error.
const missing = await get('/surveillance-probe-that-should-not-exist');
check('a missing path answers 404', missing.status === 404, `got ${missing.status}`);
check('a missing path shows the styled page', /Agent Relay/.test(missing.text));

// The published package and the release are the same version as the repository.
try {
  const registry = await fetch('https://registry.npmjs.org/@wearer-haitch/agent-relay/latest', {headers: {accept: 'application/json'}});
  const latest = registry.ok ? (await registry.json()).version : null;
  check('the npm package is published', Boolean(latest), `got ${latest}`);
  if (latest === pkg.version) notes.push('ok   the npm package matches this repository');
  else {
    // A release that is still publishing is normal right after a tag.
    const published = latest ? latest.split('.').map(Number) : [0, 0, 0];
    const here = pkg.version.split('.').map(Number);
    const older = published[0] < here[0] || (published[0] === here[0] && (published[1] < here[1] || (published[1] === here[1] && published[2] < here[2])));
    if (older) notes.push(`skip the npm package is still catching up: npm has ${latest}, this has ${pkg.version}`);
    else check('the npm package matches this repository', false, `npm has ${latest}, this has ${pkg.version}`);
  }
} catch (error) {
  notes.push(`skip  npm registry check — ${error.message}`);
}

for (const line of notes) console.log(line);
for (const line of failures) console.error(line);
console.log(`\n${notes.length} checks passed, ${failures.length} failed, watching ${origin}`);
process.exit(failures.length ? 1 : 0);
