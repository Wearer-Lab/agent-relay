import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AgentRelayPlugin, default as defaultPlugin } from '../lib/opencode-plugin.mjs';

const directory = '/tmp/relay-project';
const sessionID = 'ses_existing';
const id = `opencode:${sessionID}`;
const message = (messageId, extra = {}) => ({ messageId, from: 'codex:existing', to: id, body: 'Build slot released.',
  recipients: [id], cursor: 1, acked: false, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function flush() { for (let i = 0; i < 5; i++) await tick(); }
function harness({ initial = [], failPrompt = false, blockedRegister = false, sdkStatus = {}, failWakeMarker = false, blockedStatus = false, duplicateAdmission = false } = {}) {
  const calls = [], toasts = [], prompts = [], waiters = [];
  let registerRelease;
  const registration = blockedRegister ? new Promise(resolve => { registerRelease = resolve; }) : Promise.resolve();
  let failAck = false;
  let statusRelease;
  const statusGate = blockedStatus ? new Promise(resolve => { statusRelease = resolve; }) : Promise.resolve();
  const transport = {
    async rpc(project, fields) {
      calls.push({ project, ...fields });
      if (fields.op === 'register') await registration;
      if (fields.op === 'inbox') return { ok: true, messages: initial, cursor: 0 };
      if (fields.op === 'notified' && fields.adapter === 'opencode-wake-attempted' && failWakeMarker) throw new Error('durable admission rejected');
      if (fields.op === 'notified' && duplicateAdmission) return {ok: true, duplicate: true};
      if (fields.op === 'notified') {
        const row = initial.find(row => row.messageId === fields.messageId);
        if (row) (row.notified ||= []).push({agentId: fields.agentId, adapter: fields.adapter, at: 'recorded'});
      }
      if (fields.op === 'ack' && failAck) throw new Error('primary acknowledgement rejected');
      return { ok: true, ...fields };
    },
    wait(project, agentId, after, { signal }) {
      return new Promise((resolve, reject) => {
        const waiter = { project, agentId, after, resolve, reject };
        waiters.push(waiter);
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };
  const client = {
    tui: { async showToast(value) { toasts.push(value); return { data: true }; } },
    session: {
      async status() { await statusGate; return { data: sdkStatus }; },
      async promptAsync(value) { calls.push({op: 'runner-prompt'}); prompts.push(value); if (failPrompt) throw new Error('uncertain transport'); return { data: undefined }; },
      create() { throw new Error('forbidden session creation'); }, fork() { throw new Error('forbidden fork'); },
    },
  };
  return { calls, toasts, prompts, waiters, client, transport, releaseRegister: () => registerRelease?.(), releaseStatus: () => statusRelease?.(),
    rejectAcknowledgement: value => { failAck = value; },
    async deliver(rows, cursor = 1) {
      await flush(); const waiting = waiters.shift(); assert.ok(waiting, 'actual plugin must have a pending wait');
      waiting.resolve({ ok: true, messages: rows, cursor }); await flush();
    },
  };
}
const user = (extra = {}) => ({ info: { id: 'msg_existing', sessionID, role: 'user', agent: 'build',
  model: { providerID: 'existing-provider', modelID: 'existing-model' }, variant: 'high', ...extra },
  parts: [{ id: 'prt_existing', type: 'text', text: 'Continue the authorized work.' }] });
const toolContext = (extra = {}) => ({ sessionID, directory, worktree: directory, agent: 'build',
  abort: new AbortController().signal, ...extra });
async function plugin(h) { return AgentRelayPlugin({ client: h.client, directory, worktree: directory }, { transport: h.transport, dataDir: '/tmp/relay-isolated' }); }
async function busy(hooks) { const message = user(); await hooks['chat.message']({ sessionID }, { message: message.info, parts: message.parts }); await flush(); }
async function idle(hooks) { await hooks.event({ event: { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } } }); await flush(); }

test('standard named/default exports are the same loader-deduplicated plugin', () => {
  assert.equal(defaultPlugin, AgentRelayPlugin);
});

test('busy arrival notifies without a new inference; next real hook includes stable provenance until explicit ack', async t => {
  const h = harness(), hooks = await plugin(h); t.after(() => hooks.dispose()); await busy(hooks);
  await h.deliver([message('notice-1'), message('notice-1')]);
  assert.equal(h.toasts.length, 1); assert.equal(h.prompts.length, 0);
  assert.equal(h.calls.filter(x => x.op === 'ack').length, 0);
  const original = user(), output = { messages: [original] };
  await hooks['experimental.chat.messages.transform']({}, output);
  assert.equal(original.parts.length, 1, 'no mutation of stored source objects');
  assert.equal(output.messages[0].parts.length, 2);
  assert.match(output.messages[0].parts[1].text, /notice-1/);
  assert.match(output.messages[0].parts[1].text, /not user approval/);
  assert.equal(output.messages[0].parts[1].messageID, 'msg_existing');
  await hooks['experimental.chat.messages.transform']({}, output);
  assert.equal(output.messages[0].parts.length, 2, 'same boundary has no duplicate injected part');
  const next = { messages: [user()] }; await hooks['experimental.chat.messages.transform']({}, next);
  assert.equal(next.messages[0].parts[1].id, output.messages[0].parts[1].id);
  assert.equal(h.calls.filter(x => x.op === 'ack').length, 0);
  await hooks.tool.relay_ack.execute({ messageId: 'notice-1' }, toolContext());
  await h.deliver([message('notice-1')], 2); // Late stale wait response cannot resurrect an accepted ack.
  const after = { messages: [user()] }; await hooks['experimental.chat.messages.transform']({}, after);
  assert.equal(after.messages[0].parts.length, 1); assert.equal(h.toasts.length, 1);
});

test('idle wakes exact existing session once, preserving inherited choices and permissions', async t => {
  const h = harness(), hooks = await plugin(h); t.after(() => hooks.dispose()); await busy(hooks);
  await h.deliver([message('idle-1')]); await idle(hooks);
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(h.prompts[0].path, { id: sessionID });
  assert.deepEqual(h.prompts[0].query, { directory });
  assert.deepEqual(h.prompts[0].body.model, { providerID: 'existing-provider', modelID: 'existing-model' });
  assert.equal(h.prompts[0].body.agent, 'build'); assert.equal(h.prompts[0].body.variant, 'high');
  assert.equal('tools' in h.prompts[0].body, false); assert.equal('permissions' in h.prompts[0].body, false);
  await idle(hooks); await h.deliver([message('idle-1')], 2); await idle(hooks);
  assert.equal(h.prompts.length, 1); assert.equal(h.calls.filter(x => x.op === 'ack').length, 0);
});

test('uncertain prompt submission never retries and never acknowledges', async t => {
  const h = harness({ failPrompt: true }), hooks = await plugin(h); t.after(() => hooks.dispose()); await busy(hooks);
  await h.deliver([message('uncertain')]); await idle(hooks); await idle(hooks);
  assert.equal(h.prompts.length, 1); assert.equal(h.calls.filter(x => x.op === 'ack').length, 0);
  const output = { messages: [user()] }; await hooks['experimental.chat.messages.transform']({}, output);
  assert.match(output.messages[0].parts[1].text, /uncertain/);
});

test('observed busy runner refuses wake despite idle event; unknown choices never guessed', async t => {
  const h = harness({ sdkStatus: { [sessionID]: { type: 'busy' } } }), hooks = await plugin(h);
  t.after(() => hooks.dispose()); await busy(hooks); await h.deliver([message('race')]); await idle(hooks);
  assert.equal(h.prompts.length, 0);
  const h2 = harness({ initial: [message('unknown')] }), hooks2 = await plugin(h2); t.after(() => hooks2.dispose());
  await idle(hooks2); assert.equal(h2.prompts.length, 0);
});

test('off-path registration cannot block chat/model hooks', async t => {
  const h = harness({ blockedRegister: true }), hooks = await plugin(h); t.after(() => hooks.dispose());
  await hooks['chat.message']({ sessionID }, { message: user().info });
  const output = { messages: [user()] }; await hooks['experimental.chat.messages.transform']({}, output);
  assert.equal(output.messages[0].parts.length, 1);
  h.releaseRegister(); await flush(); assert.equal(h.calls.some(x => x.op === 'register'), true);
});

test('existing inbox is recovered; failed acknowledgement retains context; self notifications never self-wake', async t => {
  const h = harness({ initial: [message('recovered')] }), hooks = await plugin(h); t.after(() => hooks.dispose()); await busy(hooks);
  h.rejectAcknowledgement(true);
  await assert.rejects(hooks.tool.relay_ack.execute({ messageId: 'recovered' }, toolContext()));
  const output = { messages: [user()] }; await hooks['experimental.chat.messages.transform']({}, output);
  assert.match(output.messages[0].parts[1].text, /recovered/);
  h.rejectAcknowledgement(false); await hooks.tool.relay_ack.execute({ messageId: 'recovered' }, toolContext());
  await h.deliver([message('self', { from: id })]); await idle(hooks);
  assert.equal(h.prompts.length, 0);
});

test('seven standard tools bind sender and resource owner to context session and refuse cross-project calls', async t => {
  const h = harness(), hooks = await plugin(h); t.after(() => hooks.dispose()); await busy(hooks);
  assert.equal(Object.keys(hooks.tool).length, 7);
  for (const definition of Object.values(hooks.tool)) assert.ok(z.object(definition.args));
  await hooks.tool.relay_send.execute({ to: 'codex:existing', body: 'Safe coordination', from: 'forged', op: 'forged' }, toolContext());
  await hooks.tool.relay_claim.execute({ resources: ['build'] }, toolContext());
  await hooks.tool.relay_release.execute({}, toolContext());
  await hooks.tool.relay_agents.execute({}, toolContext());
  await hooks.tool.relay_status.execute({status: 'blocked', task: 'Awaiting owner handoff'}, toolContext());
  assert.equal(h.calls.find(x => x.op === 'status' && x.status === 'blocked').task, 'Awaiting owner handoff');
  await hooks.tool.relay_inbox.execute({}, toolContext());
  const send = h.calls.find(x => x.op === 'send'); assert.equal(send.from, id);
  assert.equal(h.calls.find(x => x.op === 'claim').agentId, id);
  assert.equal(h.calls.find(x => x.op === 'release').agentId, id);
  assert.equal(h.calls.filter(x => x.op !== 'runner-prompt').every(x => x.project === directory), true);
  const count = h.calls.length;
  await assert.rejects(hooks.tool.relay_send.execute({ to: 'foreign', body: 'no' }, toolContext({ directory: '/tmp/foreign' })), /different project/);
  assert.equal(h.calls.length, count);
  await h.deliver([message('foreign-notice', { recipients: ['opencode:other'], to: 'opencode:other' })]);
  const output = { messages: [user()] }; await hooks['experimental.chat.messages.transform']({}, output);
  assert.equal(output.messages[0].parts.length, 1);
});

test('mixed histories refuse attribution and disposal aborts pending longpoll', async () => {
  const h = harness(), hooks = await plugin(hooksSafe(h)); await busy(hooks);
  await h.deliver([message('mixed')]);
  const output = { messages: [user(), user({ sessionID: 'ses_other' })] };
  await hooks['experimental.chat.messages.transform']({}, output);
  assert.equal(output.messages[0].parts.length, 1); assert.equal(output.messages[1].parts.length, 1);
  await hooks.dispose();
  const calls = h.calls.length; await hooks.event({ event: { type: 'session.idle', properties: { sessionID } } });
  assert.equal(h.calls.length, calls);
});
function hooksSafe(value) { return value; }


test('durable wake admission precedes runner call; rejected admission never submits a prompt', async t => {
  const h = harness(), hooks = await plugin(h); t.after(() => hooks.dispose());
  await busy(hooks); await h.deliver([message('ordering')]); await idle(hooks);
  const marker = h.calls.findIndex(x => x.op === 'notified' && x.adapter === 'opencode-wake-attempted');
  const prompt = h.calls.findIndex(x => x.op === 'runner-prompt');
  assert.ok(marker >= 0 && prompt > marker);
  const failed = harness({failWakeMarker: true}), failedHooks = await plugin(failed); t.after(() => failedHooks.dispose());
  await busy(failedHooks); await failed.deliver([message('rejected')]); await idle(failedHooks);
  assert.equal(failed.prompts.length, 0);
  assert.equal(failed.calls.some(x => x.op === 'ack'), false);
});

test('restart hydrates recipient-specific durable wake/toast attempts; unacked content remains visible', async () => {
  const retained = message('restart');
  const first = harness({initial: [retained], failPrompt: true}), hooks = await plugin(first);
  await busy(hooks); await idle(hooks); await hooks.dispose();
  assert.equal(first.prompts.length, 1);
  assert.ok(retained.notified.some(n => n.agentId === id && n.adapter === 'opencode-wake-attempted'));
  const restarted = harness({initial: [retained]}), hooks2 = await plugin(restarted);
  await busy(hooks2); await idle(hooks2);
  assert.equal(restarted.prompts.length, 0); assert.equal(restarted.toasts.length, 0);
  const output = {messages: [user()]}; await hooks2['experimental.chat.messages.transform']({}, output);
  assert.match(output.messages[0].parts[1].text, /restart/);
  assert.equal(restarted.calls.some(x => x.op === 'ack'), false);
  await hooks2.dispose();
  const foreign = harness({initial: [message('foreign-receipt', {notified: [{agentId: 'other', adapter: 'opencode-wake-attempted'}]})]});
  const foreignHooks = await plugin(foreign); await busy(foreignHooks); await idle(foreignHooks);
  assert.equal(foreign.prompts.length, 1, 'another recipient cannot suppress this recipient');
  await foreignHooks.dispose();
});

test('explicit setup project binds room, non-git root sentinel uses directory, tools validate runtime context', async t => {
  const h = harness();
  const hooks = await AgentRelayPlugin({client: h.client, directory, worktree: '/'}, {transport: h.transport, project: '/tmp/setup-room'});
  t.after(() => hooks.dispose()); await busy(hooks);
  await hooks.tool.relay_agents.execute({}, toolContext({worktree: '/'}));
  assert.ok(h.calls.every(x => x.project === '/tmp/setup-room'));
  await assert.rejects(hooks.tool.relay_agents.execute({}, toolContext({worktree: '/tmp/another-room'})), /different project/);
  const fallback = harness();
  const fallbackHooks = await AgentRelayPlugin({client: fallback.client, directory, worktree: '/'}, {transport: fallback.transport});
  t.after(() => fallbackHooks.dispose()); await busy(fallbackHooks);
  assert.ok(fallback.calls.every(x => x.project === directory));
});

test('session deletion fences pending status check and stale hooks, retains ownership and reports offline', async () => {
  const h = harness({blockedStatus: true}), hooks = await plugin(hooksSafe(h));
  await busy(hooks); await h.deliver([message('deleted')]); await idle(hooks);
  await hooks.event({event: {type: 'session.deleted', properties: {info: {id: sessionID, directory}}}});
  h.releaseStatus(); await flush();
  await busy(hooks); await idle(hooks);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.calls.filter(x => x.op === 'register').length, 1);
  assert.ok(h.calls.some(x => x.op === 'status' && x.status === 'offline'));
  assert.equal(h.calls.some(x => x.op === 'release'), false);
  await assert.rejects(hooks.tool.relay_inbox.execute({}, toolContext()), /live existing/);
  await hooks.dispose();
});

test('sessionless instance disposal closes watchers and prevents late prompt or hook resurrection', async () => {
  const h = harness({blockedStatus: true}), hooks = await plugin(h);
  await busy(hooks); await h.deliver([message('disposing')]); await idle(hooks);
  await hooks.event({event: {type: 'server.instance.disposed', properties: {directory: '/tmp/foreign'}}});
  assert.equal(h.calls.some(x => x.op === 'status' && x.status === 'offline'), false);
  await hooks.event({event: {type: 'server.instance.disposed', properties: {directory}}});
  h.releaseStatus(); await flush();
  await hooks['chat.message']({sessionID}, {message: user().info});
  await hooks['tool.execute.before']({sessionID}); await idle(hooks);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.calls.filter(x => x.op === 'register').length, 1);
  assert.ok(h.calls.some(x => x.op === 'status' && x.status === 'offline'));
  await hooks.dispose();
});


test('concurrent duplicate durable admissions suppress runner calls even with stale inbox rows', async () => {
  const h = harness({initial: [message('concurrent')], duplicateAdmission: true}), hooks = await plugin(h);
  await busy(hooks); await idle(hooks);
  assert.equal(h.toasts.length, 0); assert.equal(h.prompts.length, 0);
  const output = {messages: [user()]}; await hooks['experimental.chat.messages.transform']({}, output);
  assert.match(output.messages[0].parts[1].text, /concurrent/);
  assert.equal(h.calls.some(x => x.op === 'ack'), false);
  await hooks.dispose();
});
