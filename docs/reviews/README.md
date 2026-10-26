# Reviews

Adversarial reviews of this repository, one document per review.

## The parallel review

`scripts/parallel-review.mjs` runs several review lanes at the same time, each in
its own agent session, and collects the findings into one report:

```sh
node scripts/parallel-review.mjs                     # every lane
node scripts/parallel-review.mjs --lanes 02,04       # only these lanes
node scripts/parallel-review.mjs --out review.md     # write somewhere else
```

It needs the `opencode` CLI on the path. The report lands in
`docs/reviews/YYYY-MM-DD-parallel-review.md`.

## Lanes

A lane is a file under `docs/reviews/lanes/`. It tells a fresh agent what to
attack, which files it owns, and what to report. Lanes never overlap, and an
agent is told to report findings rather than to change files, so the fixes stay
one decision in one place.

| Lane | Owns | Looks for |
| --- | --- | --- |
| `01-dashboard-routing` | `lib/dashboard*` and its tests | The view rename and the new URL routing: leftover ids, broken routes, dead CSS, secret leaks |
| `02-gateway-security` | `lib/gateway.mjs`, `lib/remote-rooms.mjs` | The public endpoint as an attacker sees it: auth bypasses, path escapes, rate limits, token leaks |
| `03-remote-lifecycle` | `lib/remote.mjs`, `lib/client.mjs`, `lib/tunnels/*`, the CLI | The lifecycle: start, stop, approve, persist, and what happens when a step fails |
| `04-site-seo` | `site/*`, `scripts/set-site-origin.mjs`, `scripts/surveillance.mjs` | The metadata contract, broken references, the 404 at any depth, and the domain move |
| `05-packaging-cli` | `package.json`, the release checks, the workflows, the CLI | What actually ships, whether the release checks can pass a broken package, and the help text |
| `06-test-coverage` | `test/*` | Tests that cannot fail, tests the rename quietly broke, and the risky new behaviour with no test at all |

## Adding a lane

Write a new file under `docs/reviews/lanes/`, name the files it owns, and say
what a finding looks like. The script picks it up on the next run. Keep the
lanes disjoint: two agents editing the same file is how a review turns into a
merge conflict.
