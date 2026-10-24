# Agent Relay website

A static, build-free marketing site for Agent Relay. It is deployed as-is by
`.github/workflows/pages.yml` to <https://wearer-lab.github.io/agent-relay/> on
every push to `main` that touches `site/`. The npm package does not ship this
directory.

## Pages

Every page is a real URL. There is no router and no build step: each page is a
static HTML file in its own directory, and the navigation between them is
ordinary relative links.

| URL | File | What it covers |
| --- | --- | --- |
| `/` | `index.html` | The hero, the numbers, the three incidents the tower prevents, the five capabilities, a look at the tower and the local-first promise. |
| `/product/` | `product/index.html` | The five jobs in depth: radio, ground, runways, flight plan and registry, with the commands behind each. |
| `/dashboard/` | `dashboard/index.html` | The six tower views, the keyboard map and what the dashboard refuses to do. |
| `/architecture/` | `architecture/index.html` | Runners, adapters, the local broker and the read-only observer, plus the three surfaces agents use. |
| `/security/` | `security/index.html` | The four guarantees, the honest limits and the local endpoints. |
| `/start/` | `start/index.html` | The install command, the three steps and what you need. |

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | The home page. The other five pages follow the same structure. |
| `styles.css` | The design system: tokens, layout, motion. One file for every page. |
| `app.js` | Progressive enhancement only: mobile menu, install tabs and copy, dashboard view tabs, reveal on scroll, stat counters. No network access. |
| `favicon.svg` | The Agent Relay mark; the same drawing as `assets/logo.svg`. |
| `assets/logo.svg` | The mark: a white relay cross on black. |
| `assets/fonts/` | Self-hosted fonts: Bubbledot (CC BY 4.0, credited in the footer), Geist Pixel Circle and Inter. Nothing is fetched from a third party. |
| `assets/dash-*.webp` | Dashboard screenshots, six views in dark and light. |
| `assets/og.png` | 1200x630 social preview card. |
| `assets/favicon-32.png`, `assets/apple-touch-icon.png`, `assets/icon-512.png` | Raster icons next to the SVG mark, for browsers and home screens that want one. |
| `robots.txt` | Allows crawling and points at the sitemap. The copy drafts are not listed there; they carry `noindex` in their own metadata. |
| `sitemap.xml` | The six public pages, with the drafts left out. |
| `404.html` | A styled not-found page. It uses absolute links, because it is served for any missing path. |
| `site.webmanifest` | Name, colours and icons, for a home-screen install. |

All asset paths are relative, so the page works under the `/agent-relay/`
subpath and from any local server. The social metadata in each page uses
absolute `https://wearer-lab.github.io/agent-relay/` URLs because crawlers
require them; change them if the site moves.

## Preview locally

```sh
npx --yes serve site
# or
python3 -m http.server 8080 -d site
```

Then open the printed address. Opening `index.html` directly from disk also
works.

## Deploy

Merge to `main`. The Pages workflow uploads `site/` unchanged. The repository
needs GitHub Pages set to "GitHub Actions" as its source (Settings, Pages);
that setting is the only manual step. There is no build, bundler or package
install.

## Design notes

- One design language across the site and the tower: a black canvas, floating
  white pills, a dot-matrix display face for headings, a quiet sans for prose
  and a monospaced face for data. The site is dark only; the dashboard also
  offers Light and System.
- The mark is an SVG, so it stays sharp at every size and needs no icon font.
- The site sets no cookies, runs no analytics and loads nothing from a third
  party: the fonts are self-hosted and the only script is `app.js`.
- `prefers-reduced-motion` disables the reveal transitions and the count-up.
- Without JavaScript the page is fully readable: every install command shows
  and all six dashboard views stack.

## Refreshing the screenshots

The screenshots come from the repository's seeded fixture, not from a real
project:

```sh
node scripts/dashboard-fixture.mjs --mock --port 47951   # prints the dashboard URL with its access token in the hash
```

Open the printed link, then capture each view (`/`, `/roadmap/`,
`/branches/`, `/agents/`, `/messages/`, `/claims/`) at 1440x1000 in both themes
(the dashboard stores its theme in the `agent-relay-theme` cookie), convert to
WebP (`cwebp -q 80`), and save as `assets/dash-<view>-<theme>.webp`, where the
radio log view is named `radio`. The claims view is cropped to 1440x540. Stop
the fixture with Ctrl+C. Keep `assets/` under 3 MB; `test/site.test.mjs` checks
that.

## SEO

Every page carries a title of at most 60 characters, a description of at most 160,
an absolute canonical URL, the Open Graph and Twitter card tags, an SVG icon with
raster fallbacks, an apple-touch icon, a web manifest link and JSON-LD
structured data. The home page describes the software and the site; every other
page describes itself and its place in the breadcrumb.

The absolute URLs all come from one constant in the page generator. Moving the
site to a domain of its own is one edit there plus the same constant in
`robots.txt`, `sitemap.xml` and `404.html`.

`npm test` includes `test/site.test.mjs`, which enforces all of the above, so a
page that loses a tag or grows a long description fails the build.

## Checks

`npm test` includes `test/site.test.mjs`, which verifies that every relative
reference on every page resolves inside `site/`, that anchors and ARIA
references have targets, that no third-party scripts or trackers are loaded,
that the navigation is identical on every page and that the assets stay small.
