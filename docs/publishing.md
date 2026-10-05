# Publishing Agent Relay to npm

The package name is `@wearer-haitch/agent-relay`; its executable is `agent-relay`.
The single bin entry also lets npm infer the command for `npx @wearer-haitch/agent-relay`.

## Prepare and validate

From this package directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run release:check
npm publish --dry-run
```

`release:check` runs the test suite, packs an archive in a temporary directory,
checks the published file list, and runs help/version from the extracted package.
It uses the checkout's installed dependencies; it does not prove fresh dependency
installation. Runtime source, Markdown documentation, license, and dependency
shrinkwrap are included. Local proof JSON, release history, tests, and scripts
are excluded.

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

## Check a clean npx installation before publishing

```sh
npm pack --pack-destination /tmp
npx --yes --package /tmp/wearer-haitch-agent-relay-0.2.0.tgz agent-relay --version
npx --yes --package /tmp/wearer-haitch-agent-relay-0.2.0.tgz agent-relay --help
```

In a disposable project, try `setup` and then `launch codex` using the same
`--package` form. The runner must already be installed. Setup writes project
configuration and starts a broker. Use `--data-dir /tmp/relay-smoke-data` to
keep broker history separate from your normal installation.

## Publish the reviewed archive

```sh
npm pack --pack-destination /tmp
npm publish /tmp/wearer-haitch-agent-relay-0.2.0.tgz --access public --registry=https://registry.npmjs.org/
```

Publishing the archive sends the exact packed artifact. Archive publication
does not run this checkout's `prepublishOnly`; run `release:check` first.
Publishing the directory with `npm publish` runs `prepublishOnly` automatically.
Complete npm's account/2FA flow when prompted. Never put a token in this project.
A published name/version cannot be reused; increment the version for subsequent
releases (`npm version patch --no-git-tag-version`) and synchronize the shrinkwrap
and package-lock before validation. Update archive names in these examples.

## Verify the public installation

From a directory outside this source checkout:

```sh
npm view @wearer-haitch/agent-relay version dist.integrity
npx --yes @wearer-haitch/agent-relay@0.2.0 --version
npx --yes @wearer-haitch/agent-relay@0.2.0 --help
# From a real project:
npx --yes @wearer-haitch/agent-relay@0.2.0 launch codex
```

Launch performs setup automatically. Global installation is optional:
`npm install --global @wearer-haitch/agent-relay`.

Reference: https://docs.npmjs.com/cli/commands/npm-publish/
