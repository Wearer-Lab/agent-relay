# Agent Relay website

A static, build-free marketing site for Agent Relay. It is served twice from the
same directory: **https://relay.next-notes.com** is canonical (Cloudflare
Workers static assets, `wrangler.jsonc`), and GitHub Pages publishes the same
files as a mirror.

There is no build step and no router. Each page is a committed HTML file, and
the navigation between them is ordinary relative links.

## Pages

| URL | File | What it covers |
| --- | --- | --- |
| `/` | `index.html` | The hero, the numbers, the three incidents the shared room prevents, the five capabilities, cloud agents through the gateway (pairing, tunnel providers, the remote dashboard, the always-on host plan), reliability at scale with the measured benchmark figures, the dashboard and the local-by-default promise. |
| `/product/` | `product/index.html` | The five jobs in depth: messages (stored, notified, delivered, handled), claims, branches, the roadmap and registry hygiene (liveness, delivery expiry, `pending --by`, stale sweeps), with the commands behind each. |
| `/dashboard/` | `dashboard/index.html` | The six dashboard views, the keyboard map, what the dashboard refuses to do, the cloud runner badge and the remote dashboard link. |
| `/architecture/` | `architecture/index.html` | Runners, adapters, the local broker and the read-only observer, the four ways in, and how an agent joins locally versus from the cloud. |
| `/security/` | `security/index.html` | Local by default and remote by choice: the four guarantees, what the gateway enforces, the honest limits from the trust and threat models, and the local and gateway endpoints. |
| `/start/` | `start/index.html` | The install command, the three local steps, the optional "bring a cloud agent" steps and what you need. |
| `/variants/` | `variants/index.html` | Three copy directions, drafted for review. `noindex`, and not linked from the navigation. |

## Files

| Path | Purpose |
| --- | --- |
| `styles.css` | The design system: tokens, layout, motion. One file for every page. |
| `app.js` | Progressive enhancement only: mobile menu, install tabs and copy, dashboard view tabs, reveal on scroll, stat counters, and the Team plan pop-up (shown once per browser, remembered in `localStorage`). No network access. |
| `favicon.svg`, `assets/logo.svg` | The Agent Relay mark: a white relay cross on black. |
| `assets/hero.mp4`, `assets/hero-poster.jpg` | The hero film behind the home page headline (self-hosted, muted, looping) and its still frame, which stands in for it under reduced motion. |
| `assets/fonts/` | Self-hosted fonts: Bubbledot (CC BY 4.0, credited in the footer), Geist Pixel Circle and Inter. Nothing is fetched from a third party. |
| `assets/dash-*.webp` | Dashboard screenshots, six views in dark and light. |
| `assets/og.png` | 1200x630 social preview card. |
| `robots.txt` | Allows crawling and points at the sitemap. The copy drafts are not listed there; they carry `noindex` in their own metadata. |
| `sitemap.xml` | The six public pages. The copy drafts are left out. |
| `404.html` | A styled not-found page. GitHub Pages serves it for any missing path at any depth, so every link in it is absolute. |
| `site.webmanifest` | Name, colours and icons, for a home-screen install. |

All asset paths are relative, so the pages work under the `/agent-relay/` subpath
and at the site root. The social metadata uses absolute URLs because crawlers
require them.

## Moving the site

One command rewrites every absolute URL — the canonical, Open Graph and Twitter
tags, the sitemap, the robots.txt sitemap line, the 404 page, the web manifest,
`package.json`'s homepage and the README:

```sh
node scripts/set-site-origin.mjs https://relay.example
```

Then point the domain at Cloudflare and set the custom domain in
`wrangler.jsonc`. GitHub Pages keeps serving the same files as a mirror.

`npm test` fails if the site files and the homepage origin disagree, so a
half-finished move cannot ship.

## Preview locally

```sh
npx --yes serve site
# or
python3 -m http.server 8080 -d site
```

Then open the printed address. Opening `index.html` directly from disk also
works.

## The Team plan waitlist

The home page's `#team` section posts a plain HTML form to
`https://relay.next-notes.com/api/waitlist`. That one path is the only server
code: `worker/index.mjs` at the repository root, routed by `run_worker_first`
in `wrangler.jsonc`. It stores each sign-up as one entry in the `WAITLIST` KV
namespace, keyed by email, and answers with a small thank-you page. Every page's header links to that section (**Team**), and `app.js` opens a pop-up with the same offer, an animated ASCII scene of local and cloud agents passing messages through the relay (a single still frame under reduced motion), and an email-only form once per browser, 2.5 seconds after the first visit. To see it again, run `localStorage.removeItem('agent-relay-team-pop')` in the console. The form
needs no JavaScript, and it works from the GitHub Pages mirror too, because it
posts to the canonical origin.

Read the list:

```sh
npx wrangler kv key list --binding WAITLIST --remote
npx wrangler kv key get --binding WAITLIST --remote "signup:you@company.com"
```

Test it locally with `npx wrangler dev`, which simulates the namespace; point
the form at `/api/waitlist` in the browser, or post with `curl -F`.

## Deploy

Merging to `main` publishes the site twice: the **Cloudflare** workflow deploys
it to Workers and then checks that the custom domain answers, and the **Pages**
workflow publishes the same directory to GitHub Pages. The **Surveillance**
workflow watches the live surfaces every six hours and after a deploy: every
public page, the crawler's files, the assets, the 404, the version the
structured data claims and the published npm version.

## Design notes

- One design language across the site and the dashboard: a black canvas,
  floating white pills, a dot-matrix display face for headings, a quiet sans for
  prose and a monospaced face for data. The site is dark only; the dashboard
  also offers Light and System.
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

Open the printed link, then capture each view (`/`, `/roadmap/`, `/branches/`,
`/agents/`, `/messages/`, `/claims/`) at 1440x1000 in both themes (the
dashboard stores its theme in the `agent-relay-theme` cookie), convert to WebP
(`cwebp -q 80`), and save as `assets/dash-<view>-<theme>.webp`. The claims view
is cropped to 1440x540. Stop the fixture with Ctrl+C. Keep `assets/` under
3 MB; `test/site.test.mjs` checks that.

## Checks

`npm test` includes `test/site.test.mjs`, which verifies that every relative
reference on every page resolves inside `site/`, that anchors and ARIA
references have targets, that no third-party scripts or trackers are loaded,
that the navigation is the same on every page, that every page carries its
title, description, canonical, Open Graph, Twitter and structured data with the
current version, and that the assets stay small.
