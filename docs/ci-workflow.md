# CI workflow template

An optional GitHub Actions workflow that runs the release checks on macOS, Linux
and Windows with Node.js 20 and 22. Copy the template below into the source
repository as `.github/workflows/test.yml` to enable it. Pushing workflow files
requires a GitHub credential with workflow permission. Automatic GitHub Actions
is not enabled in this repository.

The source repository also keeps this template as `docs/ci-workflow.yml` for a
direct copy; the Markdown version is the one shipped in the npm package.

```yaml
name: Portable relay
on: [push, pull_request, workflow_dispatch]
jobs:
  test:
    strategy:
      matrix:
        os: [macos-latest, ubuntu-latest, windows-latest]
        node: [20, 22]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci --ignore-scripts --no-audit --no-fund
      - run: npm run release:check
      - run: npm publish --dry-run --ignore-scripts
```

`release:check` runs the automated test suite, packs an archive in a temporary
directory, checks the published file list, and runs help/version from the
extracted package. The final step dry-runs publication of that same packed
artifact. The `test/` and `scripts/` directories the workflow runs live in the
source repository (https://github.com/Wearer-Lab/agent-relay), not in the npm
package.

The workflow exercises the automated suite only. It does not establish live
runner attachment, context insertion, acknowledgement, or reply on each
platform; see [validation](./validation.md) for the current validation matrix
and release-gate policy.
