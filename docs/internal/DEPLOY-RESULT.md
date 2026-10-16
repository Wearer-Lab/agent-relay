# Agent Relay 0.2.0 deployment result

Date: 2026-10-05
Status: GitHub release, live broker replacement, and cleanup complete. npm publication stopped at interactive authentication; owner action required.

## Commit and GitHub release

- Step 1 was already complete: all six `relay-improvements` commits are merged into main.
- Committed exactly the five previously staged files as `Release 0.2.0`.
- Release commit: `6fe371d4eb345a76134253c75eb6574b36013e31`.
- Annotated tag `v0.2.0`: `7bca3bbd49f2b06d02e9cefbec82fad951c992d1`; target: `6fe371d4eb345a76134253c75eb6574b36013e31`.
- `git push origin main --follow-tags` succeeded after validation.
- GitHub release: https://github.com/Wearer-Lab/agent-relay/releases/tag/v0.2.0
- Release created with `gh release create v0.2.0 --notes-file releases/0.2.0.md`. The local `releases/` history remains ignored and was not force-added.

## Validation before push

All validation used temporary `AGENT_RELAY_HOME` storage.

- `npm test`: 68/68 passed.
- `npm run release:check`: 68/68 tests passed; packed 26 files; extracted CLI help and version checks passed.
- `node scripts/smoke-improvements.mjs`: passed, including two identities, broker restart, watch reconnection, and SIGTERM.
- Plain `npm publish --dry-run` initially failed inside `prepublishOnly`: npm propagated dry-run mode to nested `npm pack`, so no archive existed for tar to extract. Its 68 tests passed.
- Reran `npm_config_ignore_scripts=true npm publish --dry-run` with temporary storage: passed, package 0.2.0, 26 files, public access. Lifecycle checks had already passed independently; no code was changed to work around this recursive dry-run behavior. Normal publication will run `prepublishOnly`.

## Live broker

- Project: `/Users/sergekadjo/Documents/Claude/Projects/speechify`.
- Sent the prescribed restart notice as claude-positioning to serial-root; message ID `7d0bfd06-a5c9-4076-88cd-5ccff858f97f`.
- Backup created with `cp -Rp`: `/Users/sergekadjo/Library/Application Support/agent-relay.backup-2026-10-05` (retained).
- PID `3640` exited promptly after SIGTERM; its writer lease cleared. No SIGKILL was used.
- Started normally with `agent-relay start` from the project. New PID: `14882`.
- `agent-relay --version`: `0.2.0`.
- Messages: 194 before the notification; 195 immediately before shutdown, 195 in the backup, and 195 after restart. All pre-restart message IDs and all agent IDs remain present.
- Final check after publication was stopped: PID 14882 still running, 196 messages (new traffic increased the count), backup retained.
- `agent-relay agents`: serial-root, claude-positioning, and the historical Codex agent are present; existing project claim retained.
- `agent-relay inbox --as claude-positioning`: succeeded, 33 messages.
- `agent-relay gate`: real measurements, `ok: true`, swap 1.480771484375 GiB, load 4.07, free disk 12.96218490600586 GiB; no unknown values.

## npm publication

- Initial `npm whoami --registry=https://registry.npmjs.org/` returned E401 at 21:36:53 UTC.
- Polled every 60 seconds, starting 21:37:10 UTC. Authentication succeeded on check 11 at 21:47:11 UTC, within the authorised 120-minute window.
- Ran `npm publish` from main with temporary `AGENT_RELAY_HOME`. Its normal `prepublishOnly` hook passed all 68 tests and release package checks.
- npm then displayed `Authenticate your account at:` with a browser authentication link and `Press ENTER to open in the browser...`. This was an interactive authentication challenge, rather than a literal OTP input prompt. Treated the browser challenge as interactive 2FA and stopped with Ctrl-C under the brief's stop-on-2FA rule; no browser flow or credential changes were attempted. npm exited 1 with `npm error canceled`.
- `npm view @wearer-haitch/agent-relay version --registry=https://registry.npmjs.org/` returned `0.1.0` afterward. Version 0.2.0 is not published.
- Owner command, from `/Users/sergekadjo/Tools/agent-relay`: `npm publish --otp=<code>` (replace `<code>` with the owner's current OTP). If npm requires its browser authentication flow instead, the owner must complete it personally.
- npm credentials, tokens, and `~/.npmrc` have not been read, printed, entered, created, or modified.

## Cleanup and pending work

- Confirmed the improvement branch was fully merged into main and its tracked files had no staged or unstaged edits.
- Preserved its untracked and ignored local briefs, results, changes, and logs under `/Users/sergekadjo/Tools/agent-relay/releases/deploy-support-improve-2026-10-05`. One deployment log continued changing, so moved original local files into the archive with their inode identities preserved; initial copied snapshots are also retained.
- `git worktree remove /Users/sergekadjo/Tools/agent-relay-improve` succeeded; `git branch -d relay-improvements` succeeded. Only the main worktree remains.
- Live data backup retained. No feature code changes were made.
- Pending for the owner: complete npm publication and verify the registry reports 0.2.0. All other deployment steps are complete.

This result file is intentionally not committed.
