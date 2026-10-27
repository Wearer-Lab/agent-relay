You are an adversarial reviewer of a published npm package. Repo: /Users/sergekadjo/Tools/agent-relay.

CONTEXT: The package was released as 0.7.3, and a later wave (unreleased) bumped it to 0.8.0 with an acknowledgement/backlog redesign. The wave is committed locally but NOT pushed: main is ahead of origin/main, so nothing of it is published yet. Check that the release path for 0.8.0 is coherent: the changelog section, the version in package.json and the lockfiles, the docs allowlist, and what the workflow does when it runs.

The 0.7.3 release added: a new remote gateway feature, a redesigned dashboard (files moved to lib/dashboard/assets/), a redesigned six-page website, new workflows (.github/workflows/cloudflare.yml and surveillance.yml), wrangler.jsonc, and scripts/set-site-origin.mjs plus scripts/surveillance.mjs.

YOUR LANE: the release and packaging surface. Do not review lib/gateway.mjs, lib/dashboard*, site/* or lib/remote.mjs; other reviewers own those.
  package.json, npm-shrinkwrap.json, package-lock.json, scripts/release-check.mjs, .github/workflows/*.yml, .github/dependabot.yml, docs/ci-workflow.yml, docs/ci-workflow.md, bin/agent-relay.mjs (the CLI surface only), README.md, CHANGELOG.md

HUNT FOR (be specific, cite file:line):
1. Publishing correctness: does the packed tarball contain everything needed at runtime? Are the new files (lib/gateway.mjs, lib/remote.mjs, lib/remote-rooms.mjs, lib/tunnels/*, lib/dashboard/assets/*, the fonts, the logo) included? Is anything included that should not ship (the whole site/ directory, wrangler.jsonc, the workflows)? Does the release check assert the new files?
2. The release checks themselves: can they pass while the package is broken? Are they still meaningful after the rename (the homepage assertion, the changelog assertion, the published-file allowlist, the docs/ci-workflow.yml byte-match)?
3. The CI workflows: are cloudflare.yml and surveillance.yml correct (the `if: ${{ env.X != '' }}` condition, the skip path, the timeout, the permissions)? Do the action versions exist and work? The repository requires 8 status checks; count what CI actually runs.
4. The CLI surface: does `agent-relay help` list every command exactly once? Are the new `remote` subcommands documented in the help and the README? Can the argument parser express every flag the remote commands accept (--yes, --always-on, --url-in-env, --revoke-all, --persist, --access, --provider, --hostname, --ttl-hours, --prefix, --code, --port, --data-dir, --project)?
5. The README and CHANGELOG: do they claim anything untrue? Are the links right (the site moved to relay.next-notes.com; is anything still pointing at wearer-lab.github.io)? Are the version numbers consistent with package.json?
6. Cross-platform: anything in the new code or workflows that only works on macOS?
7. The unreleased 0.8.0: does `release:check` pass right now? Is the changelog ready? Are the new docs (docs/large-rooms.md, docs/runbook-backlog.md, docs/trust-model.md, docs/threat-model.md, docs/roadmaps/**) in the published set, and do the docs/roadmaps/lanes/** files belong in an npm package at all?
8. The wave's own scripts/parallel-work.mjs and scripts/parallel-review.mjs: are they safe to ship, and do they need to be in the package at all?

DO NOT MODIFY ANY FILE. Report findings only, ordered by severity, each with file:line, what breaks, who it breaks for, and a concrete fix. Prefer a few real defects over a long list of style opinions.
