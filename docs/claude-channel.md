# Claude channel adapter

The standalone relay's MCP adapter uses the same project broker, inbox, message
IDs and cooperative resource claims as the CLI. It starts no model and reads no
Claude credentials or transcript. The CLI launcher supplies `project`, `runner`,
an optional stable `agentId`/`sessionId`, and `dataDir` to `runMcp`.

Ordinary MCP mode exposes `relay_agents`, `relay_send`, `relay_inbox`, `relay_ack`,
`relay_status`, `relay_claim` and `relay_release`. It reports
`awaiting-attachment` at registration. Generic MCP does not promise to wake a
Codex or another vendor's already-running agent: that client must call the tools
or provide its own supported input bridge.

When the launcher supplies the optional `attachCodex` callback, the adapter exposes
an eighth tool, `relay_attach_codex`, taking only `threadId`. The agent reads its
current `CODEX_THREAD_ID` from its own command environment and attaches that exact
existing thread. The adapter pins the project and registered agent identity; tool
arguments cannot change either. The launcher owns thread/project validation and
bridge lifetime. The tool reports success only when the callback confirms
`attached: true`; exceptions and unconfirmed results are tool errors. It adds no
Claude channel capability, model runtime, automatic acknowledgement or broker
notification of its own. Without the callback, the original seven tools remain.

Claude channel mode additionally advertises
`capabilities.experimental['claude/channel'] = {}`. After MCP initialization it
reports `channel-ready` and long-polls the existing broker without blocking tool
requests. This status means the transport initialized; it does not prove Claude
enabled or processed channel events. It emits `notifications/claude/channel`
with `content` and routing metadata including `message_id`, `sender` and
`recipient`. It never advertises a permission-relay capability or approves tools.

During Claude's research preview, a custom server must be opted in at launch,
for example `--dangerously-load-development-channels server:agent-relay`, after
configuring that named MCP server to use the relay CLI's channel launch mode.
The development flag skips the channel plugin allowlist only; ordinary tool
permissions and organization channel policy remain in force. Being in MCP
configuration alone is not enough. Existing sessions launched without this
opt-in require the supported next-launch bridge; do not start a concurrent
`--resume` process or write into their terminal/stdin.

Claude documents channel support with non-interactive `-p`; interactive questions
and plan approval tools are disabled in that mode. A bounded live smoke must keep
the opted-in process open long enough to receive the event and verify an actual
`relay_ack` and reply. Existing tool permissions can still reject a call; protocol
initialization or a notification write alone does not establish live delivery.
Do not bypass permissions or restart another active session to make a smoke pass.

`notified` means the SDK wrote the notification to its transport. Claude provides
no notification receipt and can silently drop events when the channel is not
enabled. Actual receipt is `relay_ack` called by the agent after reading and
handling a message. The adapter never acknowledges automatically. Busy-session
events queue for a later turn; transport duplex does not mean simultaneous model
turns in one session. A reconnect or interrupted notification can repeat the same
message ID; inspect the existing inbox/ack state rather than automatically
repeating a tool effect. Inbox reads recover older unacknowledged messages.

Claims are cooperative. Use `relay_claim` with `resources: ["path", "build"]`
and inspect the result before edits or native work; release when frozen. An
inbound coordination message does not grant ownership or replace user approval.
Only authenticated local participants accepted by the broker should reach this
adapter. This channel inherits the broker's project and identity boundaries.

Closing the MCP connection aborts the outstanding long poll. Background transport
errors retry with the same message cursor; they do not retry product actions.
Errors go to stderr, leaving stdout exclusively for MCP. SDK in-memory tests
exercise actual tool requests and notifications without launching a vendor model.
They are protocol evidence, not proof a live Claude session received a message.

Primary references: [Claude channel contract](https://code.claude.com/docs/en/channels-reference)
and [channel activation](https://code.claude.com/docs/en/channels).

## Live check on this Mac

An isolated live channel initialized, registered and wrote a real notification on
2026-10-02. Claude then reported rate-limit status `rejected` before any tool call.
The test therefore proves transport activation, with acknowledgement/reply still
unverified. No account, credentials, model or channel policy was changed to obtain
a pass.
