# Agent Relay landing page

A static, build-free marketing page for Agent Relay. It is deployed as-is by `.github/workflows/pages.yml` to <https://wearer-lab.github.io/agent-relay/> on every push to `main` that touches `site/`. The npm package does not ship this directory.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | The whole page: semantic HTML, inline SVG diagram, Open Graph and Twitter metadata. |
| `styles.css` | Design tokens for the night tower (dark) and day tower (light) themes, layout, motion. |
| `app.js` | Progressive enhancement only: theme toggle, install tabs and copy button, dashboard view tabs, reveal on scroll. No network access. |
| `favicon.svg` | Radar mark; follows `prefers-color-scheme`. |
| `assets/dash-*.webp` | Dashboard screenshots, six views in dark and light (about 750 KB together). |
| `assets/og.png` | 1200x630 social preview card. |

All asset paths are relative, so the page works under the `/agent-relay/` subpath and from any local server. The social metadata in `index.html` uses absolute `https://wearer-lab.github.io/agent-relay/` URLs because crawlers require them; change them if the site moves.

## Preview locally

```sh
npx --yes serve site
# or
python3 -m http.server 8080 -d site
```

Then open the printed address. Opening `index.html` directly from disk also works.

## Deploy

Merge to `main`. The Pages workflow uploads `site/` unchanged. The repository needs GitHub Pages set to "GitHub Actions" as its source (Settings, Pages); that setting is the only manual step. There is no build, bundler or package install.

## Design notes

- The page reuses the dashboard's air traffic control language: flight strips, runways, radio log, tower. The color tokens match `lib/dashboard/dashboard.css`.
- Fonts (Big Shoulders Display, JetBrains Mono, Newsreader) load from Google Fonts with `display=swap`. If they fail, the local fallback stacks mirror the dashboard's, and layout stays intact.
- Light and dark follow `prefers-color-scheme` until the visitor uses the toggle; the choice is stored in `localStorage` (guarded, so blocked storage is harmless). No cookies, no analytics.
- `prefers-reduced-motion` disables the radar sweep, runway animation, reveal transitions and dashed-line animation.
- Without JavaScript the page is fully readable: all three install commands show, all six dashboard views stack.

## Refreshing the screenshots

The screenshots come from the repository's seeded fixture, not from a real project:

```sh
node scripts/dashboard-fixture.mjs --mock --port 47951   # prints the dashboard URL with its access token in the hash
```

Capture each view (`?view=tower|plan|runways|strips|log|claims`) at 1440x1000 in both themes (the dashboard stores its theme in the `agent-relay-theme` cookie), convert to WebP (`cwebp -q 80`), and save as `assets/dash-<view>-<theme>.webp`, where the radio log view is named `radio`. The claims view is cropped to 1440x540. Stop the fixture with Ctrl+C. Keep `assets/` under 3 MB; `test/site.test.mjs` checks that.

## Checks

`npm test` includes `test/site.test.mjs`, which verifies that every relative reference in `index.html` and `styles.css` resolves, anchors and ARIA references have targets, no third-party scripts are loaded, and the assets stay small.
