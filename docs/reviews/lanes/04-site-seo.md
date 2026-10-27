You are an adversarial reviewer of a static website. Repo: /Users/sergekadjo/Tools/agent-relay.

CONTEXT: The marketing site lives in site/ and is served by GitHub Pages (mirror) and Cloudflare Workers static assets at https://relay.next-notes.com (canonical). It was rebuilt as six pages:
  site/index.html, site/product/index.html, site/dashboard/index.html, site/architecture/index.html, site/security/index.html, site/start/index.html
  site/variants/{index,a,b,c}/index.html (copy drafts, noindex)
  site/styles.css, site/app.js, site/robots.txt, site/sitemap.xml, site/404.html, site/site.webmanifest, site/favicon.svg, site/assets/*
There is no build step: the committed HTML is the source of truth.
scripts/set-site-origin.mjs rewrites every absolute URL to move the site to another domain. test/site.test.mjs enforces the metadata contract.

A later wave added public documents: docs/large-rooms.md, docs/runbook-backlog.md, docs/trust-model.md, docs/threat-model.md, docs/roadmaps/**.

YOUR LANE: site/ only, plus scripts/set-site-origin.mjs, scripts/surveillance.mjs, test/site.test.mjs, and the new public docs (do they claim anything untrue, and are they linked from anywhere reachable?). Do not review lib/.

HUNT FOR (be specific, cite file:line):
1. SEO defects: a missing or duplicated tag, a title or description over the limit, a canonical that disagrees with the real URL, an og:url or og:image on the wrong origin, invalid JSON-LD or structured data that claims something false, a missing twitter tag, a missing lang or viewport, a broken heading order, more than one h1, a link with no accessible name.
2. Broken references: a href/src/srcset that does not resolve, a link to a page that does not exist, a relative path that breaks under the /agent-relay/ subpath or at the site root (the pages sit at different depths).
3. The 404 page: GitHub Pages serves it for ANY missing path at ANY depth, so relative links break. Check every link in it.
4. robots.txt and sitemap.xml: are the URLs right, does the sitemap list exactly the public pages, does robots contradict the noindex on the variants?
5. site.webmanifest: are the icon paths right relative to the manifest's own location, and are scope and start_url right for a site served at both /agent-relay/ and a custom domain?
6. scripts/set-site-origin.mjs: does it really rewrite EVERY absolute URL (sitemap, robots, 404, manifest, JSON-LD, package.json homepage, README)? Does it leave the site broken if run twice, or with a trailing slash, or with a different path prefix?
7. scripts/surveillance.mjs: are its checks meaningful, or do they pass trivially? Does it fail when a page breaks?
8. Accessibility and semantics in the committed HTML: form labels, button types, aria attributes pointing at the wrong ids, duplicated ids, landmarks.

DO NOT MODIFY ANY FILE. Report findings only, ordered by severity, each with file:line, what is wrong, why it matters to a crawler or a visitor, and a concrete fix. Prefer a few real defects over a long list of style opinions.
