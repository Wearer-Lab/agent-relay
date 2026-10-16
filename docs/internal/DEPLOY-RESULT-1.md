# Agent Relay 0.2.0 deployment result

Date: 2026-10-05
Status: STOPPED at step 2 after a command failed, as instructed.

## Completed and partial work

- Step 1 succeeded: `git merge --ff-only relay-improvements` fast-forwarded main from `5ca76cf2904c9630fa773fb159d975b9accea880` to `fb8d7e0f3f6bda4641f588530ce6e55d9c68b213`. All six improvement commits are merged locally.
- Step 2 partially completed: package.json, package-lock.json, and npm-shrinkwrap.json now state 0.2.0. README.md and docs/publishing.md archive/version examples were updated to 0.2.0. These five files are staged but uncommitted.
- Release notes were written to `releases/0.2.0.md`, which is ignored and untracked.
- `git diff --check` passed before staging.

## Failure

The command `git add package.json package-lock.json npm-shrinkwrap.json README.md docs/publishing.md releases/0.2.0.md` exited 1:

```text
The following paths are ignored by one of your .gitignore files:
releases
hint: Use -f if you really want to add them.
```

The subsequent `git commit -m 'Release 0.2.0'` was not executed. No recovery or later deployment step was attempted.

## Commit, tag, and GitHub release

- Current main commit: `fb8d7e0f3f6bda4641f588530ce6e55d9c68b213`.
- Release commit SHA: not created.
- v0.2.0 tag SHA: not created by this deployment.
- GitHub push: not attempted.
- GitHub release URL: none created by this deployment.

## Validation

- `npm test`: not run during this deployment.
- `npm run release:check`: not run during this deployment.
- `node scripts/smoke-improvements.mjs`: not run during this deployment.
- `npm publish --dry-run`: not run during this deployment.
- The brief reported earlier passing checks; those are not fresh deployment validation.

## Live broker

- Old PID: 3640, as stated in the brief; not independently verified during this deployment.
- New PID: none; replacement not attempted.
- Running broker version: not checked. Local package files now state 0.2.0, but the existing broker was not restarted.
- Message count before/after: not measured because step 5 was not reached.
- Restart notification: not sent.
- Data-directory backup: not created by this deployment.
- Live broker process and data were not operated on.

## npm and cleanup

- npm authentication polling: not started.
- npm publish: not attempted.
- npm credentials and ~/.npmrc were not accessed or modified.
- Worktree and relay-improvements branch: retained; cleanup was not reached.

## Pending for the owner

Resolve the ignored release-note path (for example, explicitly track the intended release notes with `git add -f releases/0.2.0.md`, or put them in a tracked changelog), then create the `Release 0.2.0` commit. Resume at step 3 and complete all required validation before pushing or publishing. Steps 3–7 remain pending, including the broker backup/replacement and npm login-dependent publication.

This result file is intentionally not committed.
