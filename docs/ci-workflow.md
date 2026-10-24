# CI workflow

GitHub Actions CI is enabled in the source repository
(https://github.com/Wearer-Lab/agent-relay) by `.github/workflows/ci.yml`. It runs on
pushes to `main`, pull requests and manual dispatch, with read-only repository
permissions, and cancels superseded pull request runs. This page is a copy for
reference and for reuse in other repositories; the file in `.github/workflows/` is
the one that runs, and `release:check` fails if the copy in
`docs/ci-workflow.yml` drifts from it.

```yaml
name: CI
# Tests the package on macOS, Linux and Windows with Node 20 and 22, then
# installs the packed archive into an empty project (shrinkwrap included).
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
jobs:
  test:
    name: test (${{ matrix.os }}, node ${{ matrix.node }})
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, ubuntu-latest, windows-latest]
        node: [20, 22]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci --ignore-scripts --no-audit --no-fund
      - run: npm run release:check
      - run: npm publish --dry-run --ignore-scripts --provenance=false
  package:
    name: packed install (${{ matrix.os }})
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 10
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - name: Pack and install into an empty project
        run: |
          mkdir pack-out consumer
          npm pack --ignore-scripts --pack-destination pack-out
          cd consumer
          npm init -y >/dev/null
          npm install --ignore-scripts --no-audit --no-fund ../pack-out/*.tgz
          expected="$(node -p "require('../package.json').version")"
          actual="$(npx --no-install agent-relay --version)"
          test "$actual" = "$expected" || { echo "::error::agent-relay reports $actual, expected $expected"; exit 1; }
          npx --no-install agent-relay --help | grep -q 'npx --yes @wearer-haitch/agent-relay launch'
```

Jobs:

- **test** runs `npm run release:check` (the automated suite, then lockfile,
  version, changelog and published-file checks on a packed archive, with help and
  version run from the extracted package) on macOS, Linux and Windows with
  Node.js 20 and 22, followed by `npm publish --dry-run`. The dry run takes no
  archive path, so it repacks the checkout: it validates that the checkout packs
  and would publish, not the exact archive `release:check` examined. It passes
  `--provenance=false` because provenance is generated only by the release
  workflow, which has the `id-token` permission.
- **package** packs once, installs that `.tgz` into an empty project on Linux and
  Windows (so the shipped shrinkwrap and dependency resolution are exercised),
  and checks `agent-relay --version` and `--help`.

Publishing is a separate workflow (`.github/workflows/release.yml`, triggered by a
`vX.Y.Z` tag) and the landing page has its own (`.github/workflows/pages.yml`);
see [publishing](./publishing.md). Dependabot proposes weekly npm and GitHub
Actions updates (`.github/dependabot.yml`); a dependency bump that changes only
one of `package-lock.json` and `npm-shrinkwrap.json` fails `release:check`.

The `test/` and `scripts/` directories the workflow runs live in the source
repository, not in the npm package.

The workflow exercises the automated suite only. It does not establish live
runner attachment, context insertion, acknowledgement, or reply on each
platform; see [validation](./validation.md) for the current validation matrix
and release-gate policy.
