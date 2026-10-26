You are an adversarial code reviewer. Repo: /Users/sergekadjo/Tools/agent-relay (Node 20+, ESM, no build step).

CONTEXT: The local dashboard was renamed and re-routed.
Views: tower→overview, plan→roadmap, runways→branches, strips→agents, log→messages, claims→claims.
View URLs are real paths: `/`, `/roadmap/`, `/branches/`, `/agents/`, `/messages/`, `/claims/`.
The server serves the same shell for each path and the client routes with the History API.
Assets moved to `/assets/*`, read-only feeds to `/api/v1/*`.
Files moved: `lib/dashboard/{dashboard.css,dashboard.js,model.js,theme.js}` → `lib/dashboard/assets/*`.
Element ids were renamed to match (view-overview, nav-roadmap, count-agents, roadmap-tree, branch-chips, agent-q, ...).

YOUR LANE: the dashboard rewrite and the rename.
  lib/dashboard.mjs, lib/dashboard/index.html, lib/dashboard/assets/{dashboard.js,model.js,dashboard.css,theme.js}
  test/dashboard.test.mjs, test/dashboard-views.test.mjs, test/dashboard-polish.test.mjs, test/dashboard-dom.mjs, test/theme.test.mjs

HUNT FOR (be specific, cite file:line):
1. Renaming mistakes: a leftover old id, name or path in JS, HTML, CSS or tests that no longer matches. A view key in `model.js` attentionItems that does not match the `VIEWS` array in `dashboard.js`. Behaviour that silently broke because an id changed.
2. Routing bugs: the URL parser, the trailing-slash redirect, readView()/go(), pushState with relative paths, popstate, deep links, unknown paths, `/api/v1` auth, the secret in the URL fragment.
3. The ETag and conditional-request logic, and any cache bug after the rename.
4. CSS: a selector that no longer matches after the rename (dead rule, or an element left unstyled). A missing focus ring, a contrast regression, a reduced-motion regression.
5. Anything that could leak the dashboard secret or the broker token.

DO NOT MODIFY ANY FILE. Report findings only, ordered by severity, each with file:line, what is wrong, why it matters, and a concrete fix. If a lane is clean, say so. Prefer a few real defects over a long list of style opinions.
