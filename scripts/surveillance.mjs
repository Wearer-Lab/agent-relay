// Surveillance: watch the deployed surfaces and say what is broken, in one line each.
//
//   node scripts/surveillance.mjs                       # watch the package homepage
//   node scripts/surveillance.mjs https://example.com   # watch another origin
//
// It is dependency-free on purpose: the workflow that runs it needs nothing but Node.
import {promises as fs} from 'node:fs';

// A published version that is older than the repository is a release still in
// flight, not a failure. A published version that is NEWER is a failure: it
// means the site and the repository disagree about what is current.
const isOlder = (published, here) => {
  const a = String(published ?? '0.0.0').split('.').map(Number);
  const b = String(here ?? '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) < (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) > (b[i] ?? 0)) return false;
  }
  return false;
};

import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const origin = (process.env.ORIGIN || process.argv[2] || pkg.homepage || '').replace(/\/+$/, '');
const REPO = process.env.AGENT_RELAY_REPO || 'Wearer-Lab/agent-relay';
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
  const ld = text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? '';
  check(`${page} has structured data`, ld.length > 0);
  let parsed = null;
  try { parsed = JSON.parse(ld); } catch { /* reported below */ }
  check(`${page} has parseable structured data`, parsed !== null);
  if (parsed) {
    const graph = parsed['@graph'] ?? [parsed];
    for (const node of graph) {
      if (node['@type'] === 'SoftwareApplication') {
        // A deploy in flight shows the old version for a moment. A version
        // that is newer than the repository is a real disagreement.
        if (node.softwareVersion === pkg.version) notes.push(`ok   ${page} states the current version`);
        else if (isOlder(node.softwareVersion, pkg.version)) notes.push(`skip ${page} still states ${node.softwareVersion}, the repository is ${pkg.version}`);
        else check(`${page} states the current version`, false, `says ${node.softwareVersion}, the repository is ${pkg.version}`);
      }
    }
  }
}

// The crawler's files.
const robots = await get('/robots.txt');
check('robots.txt answers 200', robots.status === 200, `got ${robots.status}`);
const sitemap = await get('/sitemap.xml');
check('sitemap.xml answers 200', sitemap.status === 200, `got ${sitemap.status}`);
for (const page of PAGES) {
  check(`the sitemap lists ${page}`, sitemap.text.includes(`<loc>${origin}${page === '/' ? '/' : page}</loc>`));
}
// The assets a broken deploy loses: the stylesheet and the script of every page,
// the social card, the mark and the dashboard screenshots.
const ASSETS = ['/styles.css', '/app.js', '/favicon.svg', '/assets/favicon-32.png', '/assets/apple-touch-icon.png',
  '/assets/icon-512.png', '/assets/logo.svg', '/assets/og.png', '/site.webmanifest',
  ...['overview', 'roadmap', 'branches', 'agents', 'messages', 'claims'].flatMap(view => [`/assets/dash-${view}-dark.webp`, `/assets/dash-${view}-light.webp`])];
for (const asset of ASSETS) {
  const {status} = await get(asset);
  check(`${asset} answers 200`, status === 200, `got ${status}`);
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
  else if (isOlder(latest, pkg.version)) notes.push(`skip the npm package is still catching up: npm has ${latest}, this has ${pkg.version}`);
  else check('the npm package matches this repository', false, `npm has ${latest}, this has ${pkg.version}`);
} catch (error) {
  notes.push(`skip  npm registry check — ${error.message}`);
}
try {
  const release = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {headers: {accept: 'application/vnd.github+json', 'user-agent': 'agent-relay-surveillance'}});
  if (release.ok) {
    const tag = (await release.json()).tag_name?.replace(/^v/u, '') ?? '';
    if (tag === pkg.version) notes.push('ok   the GitHub release matches this repository');
    else if (isOlder(tag, pkg.version)) notes.push(`skip the GitHub release is still catching up: the release is ${tag || 'unknown'}, this is ${pkg.version}`);
    else check('the GitHub release matches this repository', false, `the release is ${tag || 'unknown'}`);
  } else {
    notes.push(`skip  GitHub release check — ${release.status}`);
  }
} catch (error) {
  notes.push(`skip  GitHub release check — ${error.message}`);
}

for (const line of notes) console.log(line);
for (const line of failures) console.error(line);
console.log(`\n${notes.length} checks passed, ${failures.length} failed, watching ${origin}`);
process.exit(failures.length ? 1 : 0);
