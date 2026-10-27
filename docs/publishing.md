# Publishing Agent Relay to npm

The package name is `@wearer-haitch/agent-relay`; its executable is `agent-relay`.
The single bin entry also lets npm infer the command for `npx @wearer-haitch/agent-relay`.

Releases are automated. Pushing a tag `vX.Y.Z` that matches `package.json` runs
`.github/workflows/release.yml`, which verifies the tag, runs the release checks,
packs the archive once, publishes **that exact archive** to npm with provenance,
and creates the GitHub release with the same `.tgz` attached. The landing page
is published separately by `.github/workflows/pages.yml`. The manual path
further down remains available as a fallback.

## One-time setup

The repository owner configures these once; nothing in the repository can do it.

The site is published by two workflows and watched by a third:
`.github/workflows/cloudflare.yml` publishes `site/` to Cloudflare Workers (the
canonical copy), `.github/workflows/pages.yml` publishes the same directory to
GitHub Pages as a mirror, and `.github/workflows/surveillance.yml` checks the
live surfaces every six hours and after every Cloudflare deploy.

1. **npm trusted publisher** (preferred, no stored secret). On npmjs.com open the
   package `@wearer-haitch/agent-relay` > Settings > Trusted Publisher > GitHub
   Actions and enter: organization or user `Wearer-Lab`, repository
   `agent-relay`, workflow filename `release.yml`, environment `npm`. The
   package must already exist (it does: 0.1.0 and later are published) and the
   account must be able to publish under the `wearer-haitch` organization.
2. **GitHub environment.** In the repository, Settings > Environments > New
   environment named `npm`. Optionally require a reviewer to approve every
   release, and restrict deployment to tags matching `v*`.
3. **The site.** The canonical site is **https://relay.next-notes.com**, served
   by Cloudflare Workers static assets (`wrangler.jsonc` holds the custom
   domain route). The **Cloudflare** workflow deploys it on `main` and then
   checks that the domain answers. The **Pages** workflow publishes the same
   `site/` directory to GitHub Pages as a mirror
   (https://wearer-lab.github.io/agent-relay/), so the site is still reachable
   if Cloudflare is down. To move the site to another domain, run
   `node scripts/set-site-origin.mjs <origin>` and update the route in
   `wrangler.jsonc`.
4. **Optional fallback token.** If trusted publishing is not configured, add a
   repository (or `npm` environment) secret named `NPM_TOKEN` holding an npm
   automation token with publish permission on the package. The release workflow
   uses it only when the secret exists. Remove it once trusted publishing works.

The release job needs npm 11.5.1 or later for trusted publishing; the workflow
installs it. Provenance (`--provenance`, also set by `publishConfig.provenance`)
requires the public repository and the GitHub-hosted runner the workflow uses.

## Release steps

From an up-to-date `main` checkout:

```sh
npm version 0.4.1 --no-git-tag-version        # updates package.json, package-lock.json and npm-shrinkwrap.json
# edit CHANGELOG.md: move Unreleased entries under "## [0.4.1] - YYYY-MM-DD"
npm run release:check                         # tests, lock/version/changelog checks, packed-archive checks
git add -A
git commit -m "Release 0.4.1"
git push origin main                          # merge through a pull request if main is protected
git tag v0.4.1
git push origin v0.4.1
```

`npm version --no-git-tag-version` updates both lockfiles. `release:check` fails
if they differ or disagree with `package.json`; if that happens, copy
`package-lock.json` over `npm-shrinkwrap.json`. The tag must point to a
commit that is reachable from `main`.

Pushing the tag starts the Release workflow, which:

1. Checks the tag format, that it equals `v` plus the `package.json` version, and
   that its commit is on `main`.
2. Runs `npm ci` and `npm run release:check` (tests plus archive inspection).
3. Packs one archive with `npm pack`.
4. Skips publication if that version is already on npm (a registry error other
   than "not found" fails the job rather than guessing), otherwise runs
   `npm publish <archive> --access public --provenance`. Versions with a
   pre-release suffix (for example `0.5.0-rc.1`) publish under the `next`
   dist-tag and create a GitHub pre-release.
5. Waits for the registry to list the version, then creates the GitHub release
   with generated notes (grouped by `.github/release.yml`) and the `.tgz`
   attached, or uploads the archive to the existing release.

Re-running a failed workflow is safe. If npm succeeded but the release step
failed, the re-run skips publishing and finishes the release. A published
name/version can never be reused; fix forward with a new version. To release an
existing tag by hand, run the workflow from the Actions tab with the `tag` input.

CI (`.github/workflows/ci.yml`) runs on pull requests and `main` and should be
green before tagging; the release workflow does not wait for it.

## Verify the public installation

From a directory outside this source checkout:

```sh
npm view @wearer-haitch/agent-relay version dist.integrity
npm audit signatures    # in a project that installed it; checks registry signatures and provenance
npx --yes @wearer-haitch/agent-relay@<version> --version
npx --yes @wearer-haitch/agent-relay@<version> --help
# From a real project:
npx --yes @wearer-haitch/agent-relay@<version> launch codex
```

The package page on npmjs.com shows the provenance statement linking the
version to the workflow run. Launch performs setup automatically. Global
installation is optional: `npm install --global @wearer-haitch/agent-relay`.

## Manual path (fallback)

Use this when the workflow cannot run. It publishes from your machine with your
own npm session, so it carries no provenance.

### Prepare and validate

From this package directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run release:check
npm publish --dry-run --ignore-scripts
```

`release:check` runs the test suite, checks that `package.json`, both lockfiles
and `CHANGELOG.md` agree on the version, packs an archive in a temporary
directory, checks the published file list, and runs help/version from the
extracted package. It uses the checkout's installed dependencies; it does not
prove fresh dependency installation (CI's packed-install job does). Runtime
source, Markdown documentation, the changelog, license, and dependency
shrinkwrap are included. Local proof JSON, release history, tests, and scripts
are excluded. Machine-specific operational reports live under `docs/internal/`, which is never published (`docs/*.md` matches top-level files only).

Because `publishConfig.provenance` is on, a real publish from a laptop needs
`--provenance=false` (provenance can only be generated inside a supported CI
provider, which is why the manual publish command below passes it).

Check the name and authenticate separately:

```sh
npm view @wearer-haitch/agent-relay name version --registry=https://registry.npmjs.org/
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

The package is scoped to the `wearer-haitch` npm organization. Your publishing account must belong to that organization and have permission to publish this package.

A registry E404 means the name is currently unpublished, not reserved for you.
If it exists, verify your account has ownership before publishing. For a taken
name, choose an owned scope and update package.json, both lockfiles, and the
installation examples. Network or authentication failures do not establish
name availability.

### Check a clean npx installation before publishing

Release validation must run the same packed artifact users install (see
[validation](./validation.md)):

```sh
npm pack --pack-destination /tmp
npx --yes --package /tmp/wearer-haitch-agent-relay-<version>.tgz agent-relay --version
npx --yes --package /tmp/wearer-haitch-agent-relay-<version>.tgz agent-relay --help
```

In a disposable project, try `setup` and then `launch codex` using the same
`--package` form. The runner must already be installed. Setup writes project
configuration and starts a broker. Use `--data-dir /tmp/relay-smoke-data` to
keep broker history separate from your normal installation.

### Publish the reviewed archive

```sh
npm pack --pack-destination /tmp
npm publish /tmp/wearer-haitch-agent-relay-<version>.tgz --access public --provenance=false --registry=https://registry.npmjs.org/
```

Publishing the archive sends the exact packed artifact. Archive publication
does not run this checkout's `prepublishOnly`; run `release:check` first.
Publishing the directory with `npm publish` runs `prepublishOnly` automatically.
Complete npm's account/2FA flow when prompted. Never put a token in this project.
Then create the GitHub release yourself (`gh release create v<version> /tmp/wearer-haitch-agent-relay-<version>.tgz --generate-notes --verify-tag`)
and update archive names in these examples for later versions.

Reference: https://docs.npmjs.com/trusted-publishers and https://docs.npmjs.com/cli/commands/npm-publish/
