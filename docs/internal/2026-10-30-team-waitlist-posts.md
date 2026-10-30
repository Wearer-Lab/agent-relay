# Team plan waitlist: launch posts (drafts)

Drafted 2026-10-30. Nothing here has been posted. Post only after the waitlist
form is live at https://relay.next-notes.com/#team.

Why these places: the people who would pay for a Team plan are the ones already
running two or more coding agents on one repository, or a cloud agent next to a
local one. Each post leads with the free tool and mentions the waitlist second;
asking for money first reads as spam in every one of these communities.

Read each community's self-promotion rules before posting. Post from a personal
account, answer every reply for the first few hours, and do not post the same
text everywhere on the same day.

## 1. Hacker News (Show HN)

**Title:** Show HN: Agent Relay – a shared room for Claude Code, Codex and OpenCode in one repo

**Body:**

> When I run Claude Code and Codex on the same repository, they step on each
> other: both edit the same file, both create a branch, and I end up copying
> messages between two terminals.
>
> Agent Relay gives each project one local room. Agents send each other
> messages with delivery and handled receipts, claim files, branches and build
> slots, hand work over, and share a small roadmap. It runs on 127.0.0.1, has
> no account, and is MIT licensed. One command sets it up:
>
>     npx --yes @wearer-haitch/agent-relay launch claude
>
> Cloud agents (Claude Code cloud, Codex cloud tasks) can join the same room
> through a small gateway you turn on yourself, with a pairing code you approve.
>
> I'm also trying to find out whether teams want a hosted version: an
> always-on room that keeps working when your laptop sleeps and is shared by
> everyone's agents. There's a waitlist on the site if that's you, but the
> local tool stays free either way.
>
> Code: https://github.com/Wearer-Lab/agent-relay
> Threat model: https://github.com/Wearer-Lab/agent-relay/blob/main/docs/threat-model.md

## 2. r/ClaudeAI and r/ChatGPTCoding

**Title:** I made Claude Code and Codex share one room so they stop editing the same files

**Body:**

> If you run more than one coding agent on a repo, you've probably seen two of
> them touch the same file or both make a branch. I built Agent Relay to fix
> that: a local room per project where agents message each other, claim files
> and branches, and hand work over. Free, local, MIT.
>
> `npx --yes @wearer-haitch/agent-relay launch claude` (or `codex`, `opencode`)
>
> Question for people running agents across a team: would a hosted, always-on
> room shared by teammates be useful to you? I'm collecting interest here before
> building anything: https://relay.next-notes.com/#team
>
> Happy to answer questions about how claims and receipts work.

## 3. OpenCode and Claude Code Discords (or GitHub Discussions)

Short, in the showcase or projects channel only:

> Built a small MCP-based tool that lets OpenCode, Claude Code and Codex share
> one room per repo: messages with receipts, file and branch claims, handovers.
> Local and MIT. https://relay.next-notes.com — feedback welcome, especially
> from anyone running several agents at once.

## 4. X / Bluesky / LinkedIn

> Running Claude Code and Codex on the same repo? Agent Relay gives them one
> shared room: messages with receipts, file and branch claims, handovers. Local,
> free, MIT.
>
> Thinking about a hosted Team version (always-on, shared by teammates). If you'd
> use it: https://relay.next-notes.com/#team

Attach the dashboard screenshot (`site/assets/dash-overview-dark.webp`) or the
hero film.

## What to measure afterwards

- Waitlist sign-ups over time. The site has no analytics by design, so the
  form cannot tell which post sent someone; space the posts a few days apart
  and compare the `joined` dates in KV against when each one went up.
- Team size distribution: sign-ups at "6 to 20" or "21 or more" are the signal
  for a Team plan; "Just me" is a signal for Pro.
- What people type in "What would you need from it?" — the list of features
  for the first paid version should come from there.
