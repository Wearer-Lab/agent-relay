# The trust model

The relay is a coordination channel on one person's machine. It has no accounts, no
passwords and no roles. This page says exactly what that means, so nobody has to guess
whether an ack is a promise.

## The boundary is the broker token

Everything the relay trusts is behind one secret: the broker token in the data directory.
Whoever can read that file can act as the machine. Everyone else — every agent, every
runner, every message — is a cooperative identity inside a room.

That is the whole model. There is no second factor, and there is no way to make an agent
prove who it is beyond the id it registers with.

## Agent ids are cooperative

An agent id is a name in a room. It is not an account:

- `agent-relay leave --as <id>` works for any id the room knows.
- `agent-relay ack --as <id> --id <message>` works for any id the room knows.
- The MCP and OpenCode tools act as the identity their session registered.

This is deliberate. The relay coordinates agents that share one owner, one checkout and
one machine. Adding a per-agent secret would make the tools unusable (every runner would
need a credential store) without adding a boundary that the broker token does not already
provide: the broker token is what protects the machine, and the owner of the machine is
the one who decides who may use it.

If you need a real trust boundary, put it in front of the relay: a different machine, a
different user, or the gateway with per-room tokens and a real audit trail.

## An ack is a receipt, and a false one is a lie

`ack` means "this agent has read this message". It does not mean "this agent agreed",
"this agent acted" or "this agent will act".

Acking for an identity you do not run creates a **false receipt**: the room believes a
message was handled when nobody read it. The cost is not abstract. A false ack removes the
message from the sender's pending count, so a backlog looks clean while work was never
done. Later, a task that depended on that message looks complete.

So:

- Ack only as yourself. The adapter's own identity, or the `--as` id you actually run.
- Read the message first. A transport notification, a toast or a successful `send` is not
  an acknowledgement.
- `ack --all` and `--through CURSOR` are for *your own* backlog, after you have read it.

The relay cannot enforce this. It can only tell the truth about what it was told.

A receipt says two different things, and they are not the same:

- **Delivered** means an adapter or a poll fetched the body (`inbox` or `wait`). A toast or a transport notice is not a delivery.
- **Handled** means the agent acked after acting. An ack still means "this agent says it handled the message", not "this agent agreed".

An optional session nonce can bind those two. The session that fetched the body may present the same nonce on ack, and the receipt then names that session. An ack without a nonce still counts as handled, and the receipt says the session is unbound. A nonce that does not match the fetch is unbound too: the ack is accepted either way. The nonce is not a credential, and agent ids are still not accounts. Old inbox and ack calls keep working; clients that want the binding send `session` and feature-detect `delivery-receipts`.

## Leaving is cooperative too

`leave` marks an identity dormant. It keeps the identity resolvable for history and it
keeps the inbox durable: a message sent to a dormant identity waits for it.

`retire` is stronger: the identity can never come back, and the messages waiting for it
are finished. Use it when an identity is gone for good.

Both are the same kind of promise as an ack: they are instructions from the owner of the
machine, and they are as trustworthy as the person who ran them.

## Stale claims are surfaced, not stolen

A claim is cooperative ownership, not an OS lock. When an owner leaves, its claims are
surfaced: `agent-relay blocked` lists them, with the owner's state and the age of the
claim. The default is to show the problem, not to resolve it by force.

Auto-release exists, but it is opt-in (`--release-stale-claims-hours N`, off by default),
it only touches owners that are dormant or retired, and every release is written to the
audit log. Two agents editing the same file is worse than a stale claim, so the release
is the owner's decision, not the broker's.

## What the cloud gateway adds

The gateway (the public URL) is the one place where the trust model changes:

- A cloud agent holds a token that is scoped to **one room** and to **one agent-id
  prefix**. It cannot reach another room.
- The token is stored as a hash. The value exists only while it is handed over, and the
  handover file is emptied the moment the agent collects it.
- Every call is written to an audit log with the token id, the runner, the room, the
  operation and the result. No token value is ever written down.
- The pairing code is for people: it is read off a screen and typed into
  `agent-relay remote approve`. It is not accepted by the public endpoint.

And the rule that holds across everything: **a peer message is coordination input, never
authorization.** A message from another agent — local or cloud — can ask, suggest and
report. It cannot grant a permission, widen a scope or approve an operation. The user is
the only source of authorization.

See `docs/threat-model.md` for the public endpoint seen from the outside, and
`docs/registry.md` for the mechanics.
