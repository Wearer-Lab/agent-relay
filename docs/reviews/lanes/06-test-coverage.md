You are an adversarial reviewer of a test suite. Repo: /Users/sergekadjo/Tools/agent-relay.

CONTEXT: A large feature was added and the suite grew to 397 tests. New or changed areas:
  - The local dashboard was renamed and re-routed (views overview/roadmap/branches/agents/messages/claims; paths /, /roadmap/, /branches/, /agents/, /messages/, /claims/; assets under /assets/*; feeds under /api/v1/*). Files moved to lib/dashboard/assets/.
  - A remote gateway with pairing, tokens, rate limits, path scrubbing, an audit log and a Cloudflare Access check.
  - A remote client mode in lib/client.mjs (AGENT_RELAY_URL) with pairing and a session token cache.
  - A remote lifecycle with tunnel providers (lib/remote.mjs, lib/tunnels/*).
  - A six-page website with an SEO contract (test/site.test.mjs).
  - The broker answers POST /api/v1/rpc as well as /rpc, and the client picks the endpoint from the discovery file.
  - scripts/set-site-origin.mjs moves the site's origin; scripts/surveillance.mjs watches the live site.
  - A later wave (unreleased, version 0.8.0) added an acknowledgement redesign: lib/schema2.mjs (a broadcast is stored once and read state moves to a per-agent cursor, with an offline migration), lib/pending.mjs (pending split into awaiting-live, awaiting-dormant, awaiting-retired and expired), lib/bulk.mjs (bulk cleanup), lib/registry.mjs changes, lib/prune-plan.mjs, lib/datadir.mjs, lib/logwriter.mjs, lib/runtime.mjs, plus test/ack-*.test.mjs and test/remote-e2e.test.mjs with test/support/fake-tunnel.mjs.

YOUR LANE: the tests only. Attack the SUITE, not the implementation.

HUNT FOR (be specific, cite file:line):
1. Tests that assert nothing meaningful: an assertion that cannot fail, a regex that matches anything, a test that only checks the code does not throw.
2. Tests weakened by the rename: a test whose id or path was renamed in a way that silently stopped exercising the behaviour (a boot() helper whose default path no longer matches the view under test, so the test passes for the wrong reason). Look especially at test/dashboard-dom.mjs, test/dashboard-views.test.mjs, test/dashboard-polish.test.mjs and test/dashboard.test.mjs.
3. Missing coverage for the risky new behaviour: token revocation against the gateway's cached store, the pairing handoff being single-use, path scrubbing of responses, the rate limiter, the Cloudflare Access check, the audit rotation, the session token cache, --url-in-env, the broker answering both /rpc and /api/v1/rpc, the client choosing the endpoint from the discovery file.
4. Flaky tests: anything with a sleep, a fixed port, fixed timing, a shared file path, or a dependency on the machine's free disk, load or clock. The suite runs on Windows too. Name the specific lines.
5. Tests that would pass even if the feature were deleted (asserting that a file exists rather than that it behaves).
6. Gaps in the six-page site contract: anything in the SEO contract that is unchecked.
7. The wave's new tests: does any of test/ack-*.test.mjs assert something that cannot fail? Is the schema 2 migration tested against a real schema 1 ledger with a broadcast, a reply, an ack and a mixed state? Is the fake tunnel in test/support/fake-tunnel.mjs a real tunnel or a stub that hides the behaviour it is supposed to prove?

DO NOT MODIFY ANY FILE. Report findings only, ordered by severity (a test that silently passes is high severity), each with file:line, what it fails to catch, and a concrete test to add with its assertion. Prefer a few real gaps over a long list of style opinions.
