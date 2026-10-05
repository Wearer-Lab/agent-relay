# OpenCode adapter

The plugin talks through the client OpenCode gives it, inside that same runtime. It works with
OpenCode's internal-fetch TUI as well as its HTTP-backed TUI. It never starts another OpenCode
server, creates/forks a conversation, aborts work or changes model permissions.

Load `lib/opencode-plugin.mjs` as a standard OpenCode plugin, using the relay's setup command or
a file URL in OpenCode's plugin configuration. Load it at a coordinated idle handoff. An already
running TUI that has no adapter cannot be hot-attached through a nonexistent HTTP listener.
Do not send SIGUSR2 to enable it during work: OpenCode reload disposes runtime instances.

Each observed existing session registers as `opencode:<sessionID>` in the setup loader's explicit
project room, with the exact session ID. Without that explicit binding the plugin uses the supplied
worktree, falling back to the runtime directory when OpenCode's non-git worktree is `/`. It never
uses `/` as a shared room for unrelated projects. Its background broker wait receives notifications while
the agent works. Chat and model hooks never await registration or broker transport. The seven
standard tools are `relay_send`, `relay_ack`, `relay_inbox`, `relay_agents`, `relay_claim`,
`relay_release` and `relay_status`; sender and resource owner come from the tool's session context,
not its arguments. Status can carry a task summary through the broker's existing `task` field.
Cross-project tool calls are refused. Claims are cooperative ownership, not OS locks or approval.

When busy, a TUI toast announces arrival; the next `experimental.chat.messages.transform` hook
includes pending messages in the existing model request, with sender/message IDs and explicit
coordination provenance. This cannot change a model request that is already streaming. Pending
content may appear again at later model boundaries until the agent explicitly calls `relay_ack`.
Stable parts prevent duplicate insertion at the same boundary; duplicate wait rows do not create
duplicate toasts. Before touching the runner, the plugin persists `opencode-toast-attempted` in the
broker's recipient-specific `notified` array; successful toast transport additionally records
`opencode-toast`. A restart hydrates those facts and does not repeat an uncertain toast. Context
insertion records `opencode-context`. None of these facts is an `ack`.
`relay_send` can return an explicit reply using `replyTo`.

A known-idle session with observed agent/model choices may receive one `promptAsync` submission
per notification. The durable `opencode-wake-attempted` fact is admitted in the broker before
`promptAsync` is called. A rejected admission calls no runner; duplicate admission calls no runner.
The initial inbox hydrates these recipient-specific facts after plugin restart, so an uncertain
submission is not tried again just because the plugin was reloaded. It targets the existing
session and retains agent, model and variant. It checks the same runtime's status first and never overrides tools or permissions. Self-sent notifications
do not wake their own session. Unknown session choices are not guessed.

OpenCode 1.18.34's busy runner can accept an asynchronous prompt without scheduling a successor.
The status check cannot eliminate that race. Therefore a 204 response is not an acknowledgement,
and an uncertain prompt submission is never automatically retried. Messages remain in the broker
until explicit acknowledgement, available through `relay_inbox` and later model boundaries. Broker
wait errors stop the watch with a warning; a later session/tool hook may reconnect. No recurring
model wake, copied mailbox or second inference loop exists. This favors retaining an unacknowledged
message over risking a duplicate wake: a crash after recording an attempt but before calling the
runner can leave that message pending for the next real model boundary or `relay_inbox`.

The standard plugin client in OpenCode 1.18.34 uses the legacy SDK request shape (`path`, `query`,
`body`), not the SDK v2 flattened parameter shape. Named/default exports refer to the same function,
which OpenCode's plugin loader deduplicates. `@opencode-ai/plugin` is pinned to 1.18.34.

Session deletion fences stale hooks, aborts that session's wait and reports offline in background.
A sessionless `server.instance.disposed` event is handled before session-ID filtering; the plugin's
`dispose()` finalizer closes all watchers and prevents late status responses from waking anything.
Neither path releases file/build/native ownership automatically.

Fifteen focused recording-client tests exercise the exported real hooks and standard Zod tool definitions:
busy arrival, next model boundary, acknowledgements, deduplication, idle preservation, uncertain
submission, durable admission order/rejection, recipient-specific restart deduplication, concurrent
duplicate admission, explicit/non-git project binding, seven tools, session deletion, cross-project
refusal and sessionless disposal. They use no model, account, live OpenCode session
or owner mailbox. These tests do not prove that an agent understood a message.

Primary contracts: [plugins](https://opencode.ai/docs/plugins/),
[same-runtime plugin client](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/plugin/index.ts),
[prompt producer](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/prompt.ts),
[busy runner](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/effect/runner.ts).

## Actual runtime check

An isolated OpenCode 1.18.34 runtime loaded the real plugin, registered its existing
fixture session, received a broker message, admitted one idle wake and inserted
that message into actual provider context. A scripted local provider returned
real relay tool calls; OpenCode executed the acknowledgement and correctly joined
reply through the plugin and broker. This verifies the runtime/adapter path without
owner credentials, production sessions or external model inference. Busy-runtime
and cloud-model semantic coverage remain unverified.
