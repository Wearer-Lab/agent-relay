import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AgentRelayPlugin, default as defaultPlugin } from '../lib/opencode-plugin.mjs';
import { createBroker } from '../lib/broker.mjs';

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

test('twenty-two standard tools bind sender and resource owner to context session and refuse cross-project calls', async t => {
  const h = harness(), hooks = await plugin(h); t.after(() => hooks.dispose()); await busy(hooks);
  assert.equal(Object.keys(hooks.tool).length, 22);
  for (const definition of Object.values(hooks.tool)) assert.ok(z.object(definition.args));
  await hooks.tool.relay_send.execute({ to: 'codex:existing', body: 'Safe coordination', from: 'forged', op: 'forged' }, toolContext());
  await hooks.tool.relay_claim.execute({ resources: ['build'] }, toolContext());
  await hooks.tool.relay_release.execute({}, toolContext());
  await hooks.tool.relay_agents.execute({ active: true, transport: 'connected' }, toolContext());
  await hooks.tool.relay_status.execute({status: 'blocked', task: 'Awaiting owner handoff'}, toolContext());
  assert.equal(h.calls.find(x => x.op === 'status' && x.status === 'blocked').task, 'Awaiting owner handoff');
  await hooks.tool.relay_inbox.execute({ limit: 10 }, toolContext());
  await hooks.tool.relay_ack.execute({ through: 3 }, toolContext());
  await hooks.tool.relay_outbox.execute({}, toolContext());
  await hooks.tool.relay_receipt.execute({ messageId: 'm-1' }, toolContext());
  await hooks.tool.relay_history.execute({ acked: true }, toolContext());
  await hooks.tool.relay_fetch.execute({ messageId: 'm-1' }, toolContext());
  await hooks.tool.relay_leave.execute({}, toolContext());
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
test('watch recovers from broker disruption without another user turn and keeps its cursor', async t => {
  const h = harness(), hooks = await plugin(h); t.after(() => hooks.dispose());
  await busy(hooks); await flush();
  assert.equal(h.waiters.length, 1);
  h.waiters.shift().reject(new Error('connect ECONNREFUSED'));
  await new Promise(resolve => setTimeout(resolve, 300)); await flush();
  assert.equal(h.waiters.length, 1, 'watch re-arms after a wait error with no new user event');
  assert.ok(h.calls.some(x => x.op === 'status' && x.transport?.state === 'disconnected' && x.transport?.adapter === 'opencode-watch'));
  await h.deliver([message('recovered')]);
  await idle(hooks);
  assert.equal(h.prompts.length, 1);
  assert.ok(h.calls.some(x => x.op === 'status' && x.transport?.state === 'connected'));
  await h.deliver([]); await flush();
  assert.equal(h.prompts.length, 1, 'recovered cursor produces no duplicate wake');
  await hooks.dispose();
});
test('uncertain wake failure is recorded with structured detail and never retried', async t => {
  const h = harness({ failPrompt: true }), hooks = await plugin(h); t.after(() => hooks.dispose());
  await busy(hooks); await h.deliver([message('uncertain-wake')]); await idle(hooks);
  assert.equal(h.prompts.length, 1);
  assert.ok(h.toasts.some(toast => /uncertain/.test(toast.body.message)), 'warning carries the failure category');
  await idle(hooks); await flush();
  assert.equal(h.prompts.length, 1, 'uncertain submission is never retried automatically');
});
test('context transform bounds model input while every pending message stays discoverable', async t => {
  const rows = Array.from({ length: 25 }, (_, i) => message('bulk-' + i, { body: 'payload-' + i + '-' + 'x'.repeat(2000),
    cursor: i + 1, summary: 's' + i, attachments: [{ name: 'f.bin', size: 3, sha256: 'c'.repeat(64) }] }));
  const h = harness({ initial: rows }), hooks = await plugin(h); t.after(() => hooks.dispose());
  await busy(hooks);
  await hooks.tool.relay_inbox.execute({}, toolContext());
  const output = { messages: [user()] }; await hooks['experimental.chat.messages.transform']({}, output);
  const text = output.messages[0].parts[1].text;
  assert.ok(text.length <= 40 * 1024, `bounded context input, got ${text.length}`);
  assert.match(text, /more pending via relay_inbox/);
  assert.match(text, /"summary":"s0"/);
  assert.match(text, /"attachments":\[{"name":"f.bin"/);
  assert.match(text, /"cursor":1/);
  await hooks['experimental.chat.messages.transform']({}, output);
  assert.equal(output.messages[0].parts.length, 2, 'digest dedupe still applies');
  const inbox = JSON.parse(await hooks.tool.relay_inbox.execute({ limit: 100 }, toolContext()));
  assert.equal(inbox.messages.length, 25, 'nothing was dropped from the durable backlog');
});
test('bulk acknowledgement moves only handled pending rows to acknowledged', async t => {
  const rows = [message('k1', { body: 'first', cursor: 1 }), message('k2', { body: 'second', cursor: 2 }), message('k3', { body: 'third', cursor: 3 })];
  const h = harness({ initial: rows }), hooks = await plugin(h); t.after(() => hooks.dispose());
  await busy(hooks);
  await hooks.tool.relay_inbox.execute({}, toolContext());
  await hooks.tool.relay_ack.execute({ through: 2 }, toolContext());
  assert.ok(h.calls.some(x => x.op === 'ack' && x.through === 2));
  const output = { messages: [user()] }; await hooks['experimental.chat.messages.transform']({}, output);
  const text = output.messages[0].parts[1].text;
  assert.match(text, /third/); assert.ok(!text.includes('first') && !text.includes('second'));
});
test('r24 coordination tools forward exact broker fields with context identity and refuse cross-project calls', async t => {
  const h = harness(), hooks = await plugin(h); t.after(() => hooks.dispose()); await busy(hooks);
  assert.equal(Object.keys(hooks.tool).length, 22);
  for (const definition of Object.values(hooks.tool)) assert.ok(z.object(definition.args));
  const schemas = Object.fromEntries(Object.entries(hooks.tool).map(([name, definition]) => [name, z.object(definition.args)]));
  schemas.relay_bulletin_get.parse({});
  assert.throws(() => schemas.relay_bulletin_ack.parse({}));
  schemas.relay_bulletin_ack.parse({ version: 2 });
  schemas.relay_bulletin_ack.parse({ version: 2, hash: 'abc' });
  assert.throws(() => schemas.relay_bulletin_ack.parse({ version: 0 }));
  schemas.relay_handoffs.parse({});
  assert.throws(() => schemas.relay_handoff_request.parse({ reason: 'move' }));
  schemas.relay_handoff_request.parse({ resources: ['a.txt'], reason: 'move' });
  schemas.relay_handoff_request.parse({ to: 'opencode:other', resources: ['a.txt'], reason: 'move' });
  assert.throws(() => schemas.relay_handoff_respond.parse({}));
  schemas.relay_handoff_respond.parse({ id: 'h-1', accept: true });
  schemas.relay_handoff_respond.parse({ id: 'h-1', accept: false, resources: ['a.txt'] });
  assert.throws(() => schemas.relay_claim_narrow.parse({}));
  schemas.relay_claim_narrow.parse({ resource: 'src', resources: ['src/a.mjs'] });
  assert.throws(() => schemas.relay_tasks.parse({}));
  assert.throws(() => schemas.relay_tasks.parse({ action: 'bad' }));
  schemas.relay_tasks.parse({ action: 'upsert', title: 'Work' });
  schemas.relay_tasks.parse({ action: 'list', state: 'open', blocked: true });
  schemas.relay_tasks.parse({ action: 'complete', id: 't-1' });
  schemas.relay_processes_list.parse({});
  schemas.relay_processes_list.parse({ owner: 'opencode:other' });
  schemas.relay_group_agents.parse({});
  schemas.relay_group_agents.parse({ groupId: 'g-1' });
  await hooks.tool.relay_bulletin_get.execute({}, toolContext());
  await hooks.tool.relay_bulletin_ack.execute({ version: 2, hash: 'abc' }, toolContext());
  await hooks.tool.relay_handoff_request.execute({ to: 'opencode:other', resources: ['a.txt'], reason: 'move' }, toolContext());
  await hooks.tool.relay_handoff_request.execute({ resources: ['a.txt'], reason: 'open offer' }, toolContext());
  await hooks.tool.relay_handoff_respond.execute({ id: 'h-1', accept: true }, toolContext());
  await hooks.tool.relay_handoff_respond.execute({ id: 'h-2', accept: false, resources: ['a.txt'] }, toolContext());
  await hooks.tool.relay_handoffs.execute({}, toolContext());
  await hooks.tool.relay_claim_narrow.execute({ resource: 'src', resources: ['src/a.mjs'] }, toolContext());
  await hooks.tool.relay_tasks.execute({ action: 'upsert', id: 't-1', title: 'Work', owner: 'opencode:other',
    blockedBy: ['src/a.mjs'], resources: ['src/a.mjs'], sourceRevision: 'rev-1', verification: 'checked',
    expectedRecipient: 'opencode:other', handoffId: 'h-1' }, toolContext());
  await hooks.tool.relay_tasks.execute({ action: 'list', state: 'open', blocked: true, owner: 'opencode:other' }, toolContext());
  await hooks.tool.relay_tasks.execute({ action: 'complete', id: 't-1', verification: 'done' }, toolContext());
  await hooks.tool.relay_processes_list.execute({}, toolContext());
  await hooks.tool.relay_processes_list.execute({ owner: 'opencode:other' }, toolContext());
  await hooks.tool.relay_group_agents.execute({}, toolContext());
  await hooks.tool.relay_group_agents.execute({ groupId: 'g-1' }, toolContext());
  const bulletinGet = h.calls.find(x => x.op === 'getBulletin');
  assert.equal(bulletinGet.project, directory);
  assert.equal('agentId' in bulletinGet, false);
  const bulletinAck = h.calls.find(x => x.op === 'ackBulletin');
  assert.equal(bulletinAck.agentId, id);
  assert.equal(bulletinAck.version, 2);
  assert.equal(bulletinAck.hash, 'abc');
  const handoffRequest = h.calls.find(x => x.op === 'requestHandoff' && x.to === 'opencode:other');
  assert.equal(handoffRequest.agentId, id);
  assert.deepEqual(handoffRequest.resources, ['a.txt']);
  assert.equal(handoffRequest.reason, 'move');
  const openRequest = h.calls.find(x => x.op === 'requestHandoff' && x.reason === 'open offer');
  assert.equal(openRequest.agentId, id);
  assert.equal('to' in openRequest, false);
  const respondAccept = h.calls.find(x => x.op === 'respondHandoff' && x.id === 'h-1');
  assert.equal(respondAccept.agentId, id);
  assert.equal(respondAccept.accept, true);
  assert.equal('resources' in respondAccept, false);
  const respondDecline = h.calls.find(x => x.op === 'respondHandoff' && x.id === 'h-2');
  assert.equal(respondDecline.accept, false);
  assert.deepEqual(respondDecline.resources, ['a.txt']);
  const handoffs = h.calls.find(x => x.op === 'handoffs');
  assert.equal(handoffs.project, directory);
  assert.equal('agentId' in handoffs, false);
  const narrow = h.calls.find(x => x.op === 'claimNarrow');
  assert.equal(narrow.agentId, id);
  assert.equal(narrow.resource, 'src');
  assert.deepEqual(narrow.resources, ['src/a.mjs']);
  const upsert = h.calls.find(x => x.op === 'tasks' && x.action === 'upsert');
  assert.equal(upsert.agentId, id);
  assert.equal(upsert.id, 't-1');
  assert.equal(upsert.title, 'Work');
  assert.equal(upsert.owner, 'opencode:other');
  assert.deepEqual(upsert.blockedBy, ['src/a.mjs']);
  assert.deepEqual(upsert.resources, ['src/a.mjs']);
  assert.equal(upsert.sourceRevision, 'rev-1');
  assert.equal(upsert.verification, 'checked');
  assert.equal(upsert.expectedRecipient, 'opencode:other');
  assert.equal(upsert.handoffId, 'h-1');
  const listed = h.calls.find(x => x.op === 'tasks' && x.action === 'list');
  assert.equal(listed.state, 'open');
  assert.equal(listed.blocked, true);
  assert.equal(listed.owner, 'opencode:other');
  const completed = h.calls.find(x => x.op === 'tasks' && x.action === 'complete');
  assert.equal(completed.agentId, id);
  assert.equal(completed.id, 't-1');
  assert.equal(completed.verification, 'done');
  const processesOpen = h.calls.filter(x => x.op === 'processes');
  assert.equal(processesOpen.length, 2);
  assert.equal(processesOpen[0].action, 'list');
  assert.equal('agentId' in processesOpen[0], false);
  assert.equal(processesOpen[1].agentId, 'opencode:other');
  const groupOpen = h.calls.filter(x => x.op === 'groupAgents');
  assert.equal(groupOpen.length, 2);
  assert.equal('groupId' in groupOpen[0], false);
  assert.equal(groupOpen[1].groupId, 'g-1');
  assert.equal(h.calls.filter(x => x.op !== 'runner-prompt').every(x => x.project === directory), true);
  const count = h.calls.length;
  await assert.rejects(hooks.tool.relay_bulletin_get.execute({}, toolContext({ directory: '/tmp/foreign' })), /different project/);
  await assert.rejects(hooks.tool.relay_handoff_request.execute({ resources: ['a'], reason: 'r' }, toolContext({ directory: '/tmp/foreign' })), /different project/);
  await assert.rejects(hooks.tool.relay_handoff_respond.execute({ id: 'h-1', accept: true }, toolContext({ directory: '/tmp/foreign' })), /different project/);
  await assert.rejects(hooks.tool.relay_handoffs.execute({}, toolContext({ directory: '/tmp/foreign' })), /different project/);
  await assert.rejects(hooks.tool.relay_claim_narrow.execute({ resource: 'a', resources: ['a/b'] }, toolContext({ directory: '/tmp/foreign' })), /different project/);
  await assert.rejects(hooks.tool.relay_tasks.execute({ action: 'list' }, toolContext({ directory: '/tmp/foreign' })), /different project/);
  await assert.rejects(hooks.tool.relay_processes_list.execute({}, toolContext({ directory: '/tmp/foreign' })), /different project/);
  await assert.rejects(hooks.tool.relay_group_agents.execute({}, toolContext({ directory: '/tmp/foreign' })), /different project/);
  await assert.rejects(hooks.tool.relay_bulletin_ack.execute({ version: 1 }, toolContext({ directory: '/tmp/foreign' })), /different project/);
  assert.equal(h.calls.length, count);
});
test('r24 gap fills pass claim meta, rich status and history time filters through only when provided', async t => {
  const h = harness(), hooks = await plugin(h); t.after(() => hooks.dispose()); await busy(hooks);
  const schemas = Object.fromEntries(Object.entries(hooks.tool).map(([name, definition]) => [name, z.object(definition.args)]));
  schemas.relay_claim.parse({ resources: ['build'] });
  schemas.relay_claim.parse({ resources: ['build'], meta: { baseCommit: 'abc' } });
  assert.throws(() => schemas.relay_claim.parse({ resources: ['build'], meta: { baseCommit: '' } }));
  schemas.relay_status.parse({ status: 'busy' });
  schemas.relay_status.parse({ status: 'busy', frozen: true, resources: ['a'], task: 'detail',
    transport: { adapter: 'opencode-watch', state: 'connected' } });
  schemas.relay_status.parse({ status: 'busy', task: null });
  schemas.relay_status.parse({ status: 'busy', task: { summary: 'detail' } });
  schemas.relay_status.parse({ status: 'busy', transport: { adapter: 'opencode-watch', state: 'disconnected', push: true } });
  assert.throws(() => schemas.relay_status.parse({ status: 'busy', transport: { adapter: 'x', state: 'bad' } }));
  schemas.relay_history.parse({ afterTs: '2026-01-01T00:00:00.000Z', beforeTs: '2026-02-01T00:00:00.000Z', before: 5 });
  await hooks.tool.relay_claim.execute({ resources: ['build'], meta: { baseCommit: 'abc' } }, toolContext());
  await hooks.tool.relay_claim.execute({ resources: ['build'] }, toolContext());
  await hooks.tool.relay_status.execute({ status: 'busy', frozen: true, resources: ['a.txt'],
    task: 'Working', transport: { adapter: 'opencode-watch', state: 'connected', push: true } }, toolContext());
  await hooks.tool.relay_status.execute({ status: 'idle', task: null }, toolContext());
  await hooks.tool.relay_status.execute({ status: 'blocked', task: { summary: 'detail' } }, toolContext());
  await hooks.tool.relay_status.execute({ status: 'busy' }, toolContext());
  await hooks.tool.relay_history.execute({ afterTs: '2026-01-01T00:00:00.000Z', beforeTs: '2026-02-01T00:00:00.000Z', before: 5 }, toolContext());
  const claims = h.calls.filter(x => x.op === 'claim');
  assert.deepEqual(claims[0].meta, { baseCommit: 'abc' });
  assert.equal(claims[0].agentId, id);
  assert.equal('meta' in claims[1], false);
  const statuses = h.calls.filter(x => x.op === 'status' && ['busy', 'idle', 'blocked'].includes(x.status));
  const rich = statuses.find(x => x.status === 'busy' && x.frozen === true);
  assert.equal(rich.agentId, id);
  assert.equal(rich.frozen, true);
  assert.deepEqual(rich.resources, ['a.txt']);
  assert.equal(rich.task, 'Working');
  assert.deepEqual(rich.transport, { adapter: 'opencode-watch', state: 'connected', push: true });
  const nullTask = statuses.find(x => x.status === 'idle');
  assert.equal(nullTask.task, null);
  assert.equal('frozen' in nullTask, false);
  assert.equal('resources' in nullTask, false);
  assert.equal('transport' in nullTask, false);
  const objectTask = statuses.find(x => x.status === 'blocked');
  assert.deepEqual(objectTask.task, { summary: 'detail' });
  const plain = statuses.find(x => x.status === 'busy' && !('frozen' in x));
  assert.equal('frozen' in plain, false);
  assert.equal('resources' in plain, false);
  assert.equal('task' in plain, false);
  assert.equal('transport' in plain, false);
  const history = h.calls.find(x => x.op === 'history' && x.before === 5);
  assert.equal(history.agentId, id);
  assert.equal(history.afterTs, '2026-01-01T00:00:00.000Z');
  assert.equal(history.beforeTs, '2026-02-01T00:00:00.000Z');
  assert.equal(history.before, 5);
});
test('handoff request and respond round-trip through a real broker', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-opencode-handoff-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir, { recursive: true })));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function brokerRpc(target, fields) {
    const response = await fetch(broker.url + '/rpc', { method: 'POST',
      headers: { authorization: 'Bearer ' + broker.token, 'content-type': 'application/json' },
      body: JSON.stringify({ project: target, ...fields }) });
    return response.json();
  }
  function realTransport() {
    return {
      async rpc(target, fields) { return brokerRpc(target, fields); },
      wait(target, agentId, after, { signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    };
  }
  const sessionA = 'ses_handoff_a';
  const sessionB = 'ses_handoff_b';
  const agentA = `opencode:${sessionA}`;
  const agentB = `opencode:${sessionB}`;
  const contextA = { client: harness().client, directory: project, worktree: project };
  const contextB = { client: harness().client, directory: project, worktree: project };
  const hooksA = await AgentRelayPlugin(contextA, { transport: realTransport() });
  const hooksB = await AgentRelayPlugin(contextB, { transport: realTransport() });
  t.after(async () => { await hooksA.dispose(); await hooksB.dispose(); });
  const toolA = extra => ({ sessionID: sessionA, directory: project, worktree: project, abort: new AbortController().signal, ...extra });
  const toolB = extra => ({ sessionID: sessionB, directory: project, worktree: project, abort: new AbortController().signal, ...extra });
  await hooksB.tool.relay_agents.execute({}, toolB());
  await hooksA.tool.relay_claim.execute({ resources: ['handoff.txt'] }, toolA());
  const requested = JSON.parse(await hooksA.tool.relay_handoff_request.execute({ to: agentB, resources: ['handoff.txt'], reason: 'transfer work' }, toolA()));
  assert.equal(requested.handoff.from, agentA);
  assert.equal(requested.handoff.to, agentB);
  const listed = JSON.parse(await hooksA.tool.relay_handoffs.execute({}, toolA()));
  assert.equal(listed.handoffs.length, 1);
  assert.equal(listed.handoffs[0].id, requested.handoff.id);
  const responded = JSON.parse(await hooksB.tool.relay_handoff_respond.execute({ id: requested.handoff.id, accept: true }, toolB()));
  assert.equal(responded.handoff.state, 'accepted');
  const agents = await brokerRpc(project, { op: 'agents' });
  assert.equal(agents.ok, true);
  const held = agents.claims.filter(claim => claim.resource.endsWith('handoff.txt'));
  assert.equal(held.length, 1);
  assert.equal(held[0].agentId, agentB);
});
test('byte-limited pages rewrite continuation from the kept rows', async t => {
  const rows = Array.from({ length: 12 }, (_, i) => message('page-' + i, { body: 'x'.repeat(8000), cursor: i + 1 }));
  const client = harness().client;
  const transport = {
    async rpc(project, fields) {
      if (fields.op === 'register') return { ok: true };
      if (fields.op === 'inbox') return { ok: true, messages: structuredClone(rows), cursor: 12, roomCursor: 12 };
      if (fields.op === 'history') return { ok: true, messages: structuredClone(rows), nextCursor: 12, done: true, scope: { totalMatching: 12 } };
      if (fields.op === 'outbox') return { ok: true, messages: structuredClone(rows), nextCursor: 24, done: true };
      return { ok: true, ...fields };
    },
    wait(project, agentId, after, { signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
  };
  const hooks = await AgentRelayPlugin({ client, directory, worktree: directory }, { transport, dataDir: '/tmp/relay-isolated' });
  t.after(() => hooks.dispose());
  const started = user();
  await hooks['chat.message']({ sessionID }, { message: started.info });
  await flush();
  const inbox = JSON.parse(await hooks.tool.relay_inbox.execute({ limit: 50 }, toolContext()));
  assert.ok(inbox.omitted);
  assert.ok(inbox.messages.length < 12);
  assert.equal(inbox.cursor, inbox.messages.at(-1).cursor);
  assert.equal(inbox.omitted.resumeCursor, inbox.messages.at(-1).cursor);
  assert.equal(inbox.roomCursor, 12);
  assert.ok(inbox.byteSize <= 64 * 1024);
  const history = JSON.parse(await hooks.tool.relay_history.execute({ limit: 50 }, toolContext()));
  assert.ok(history.omitted);
  assert.equal(history.nextCursor, history.messages.at(-1).cursor);
  assert.equal(history.done, false);
  assert.equal(history.omitted.resumeCursor, history.messages.at(-1).cursor);
  const outbox = JSON.parse(await hooks.tool.relay_outbox.execute({ limit: 50 }, toolContext()));
  assert.ok(outbox.omitted);
  assert.equal(outbox.nextCursor, outbox.messages.at(-1).cursor);
  assert.equal(outbox.done, false);
  assert.equal(outbox.omitted.resumeCursor, outbox.messages.at(-1).cursor);
});
test('unread forwards directly for true false and omitted', async t => {
  const h = harness(), hooks = await plugin(h);
  t.after(() => hooks.dispose());
  await busy(hooks);
  await flush();
  const before = h.calls.filter(x => x.op === 'inbox').length;
  await hooks.tool.relay_inbox.execute({}, toolContext());
  await hooks.tool.relay_inbox.execute({ unread: true }, toolContext());
  await hooks.tool.relay_inbox.execute({ unread: false }, toolContext());
  const inboxCalls = h.calls.filter(x => x.op === 'inbox').slice(before);
  assert.equal(inboxCalls.length, 3);
  assert.equal('unacked' in inboxCalls[0], false);
  assert.equal(inboxCalls[1].unacked, true);
  assert.equal(inboxCalls[2].unacked, false);
});
test('unread matches broker acknowledgement state through a real broker', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-opencode-unread-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir, { recursive: true })));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function brokerRpc(target, fields) {
    const response = await fetch(broker.url + '/rpc', { method: 'POST',
      headers: { authorization: 'Bearer ' + broker.token, 'content-type': 'application/json' },
      body: JSON.stringify({ project: target, ...fields }) });
    return response.json();
  }
  function realTransport() {
    return {
      async rpc(target, fields) { return brokerRpc(target, fields); },
      wait(target, agentId, after, { signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
    };
  }
  const session = 'ses_unread_check';
  const me = `opencode:${session}`;
  const peer = 'unread-peer';
  await brokerRpc(project, { op: 'register', agentId: peer, runner: 'review' });
  await brokerRpc(project, { op: 'register', agentId: me, runner: 'opencode', sessionId: session });
  await brokerRpc(project, { op: 'send', from: peer, to: me, body: 'first' });
  await brokerRpc(project, { op: 'send', from: peer, to: me, body: 'second' });
  const context = { client: harness().client, directory: project, worktree: project };
  const hooks = await AgentRelayPlugin(context, { transport: realTransport() });
  t.after(async () => { await hooks.dispose(); });
  const toolCtx = extra => ({ sessionID: session, directory: project, worktree: project, abort: new AbortController().signal, ...extra });
  const first = JSON.parse(await hooks.tool.relay_inbox.execute({ limit: 50 }, toolCtx()));
  assert.equal(first.messages.length, 2);
  await hooks.tool.relay_ack.execute({ messageId: first.messages[0].messageId }, toolCtx());
  const onlyUnread = JSON.parse(await hooks.tool.relay_inbox.execute({ unread: true, limit: 50 }, toolCtx()));
  assert.equal(onlyUnread.messages.length, 1);
  assert.equal(onlyUnread.messages[0].acked, false);
  const withRead = JSON.parse(await hooks.tool.relay_inbox.execute({ unread: false, limit: 50 }, toolCtx()));
  assert.equal(withRead.messages.length, 2);
  const omitted = JSON.parse(await hooks.tool.relay_inbox.execute({ limit: 50 }, toolCtx()));
  assert.equal(omitted.messages.length, 1);
  assert.equal(omitted.messages[0].messageId, onlyUnread.messages[0].messageId);
});
test('context hook marks only inserted message ids', async t => {
  const rows = Array.from({ length: 30 }, (_, i) => message('ctx-' + i, { body: 'payload-' + i + '-' + 'x'.repeat(2000), cursor: i + 1 }));
  const h = harness({ initial: rows }), hooks = await plugin(h);
  t.after(() => hooks.dispose());
  await busy(hooks);
  await hooks.tool.relay_inbox.execute({}, toolContext());
  const output = { messages: [user()] };
  await hooks['experimental.chat.messages.transform']({}, output);
  const text = output.messages[0].parts[1].text;
  const shown = text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line).messageId);
  const marked = h.calls.filter(x => x.op === 'notified' && x.adapter === 'opencode-context').map(x => x.messageId);
  assert.ok(shown.length < 30);
  assert.deepEqual(new Set(marked), new Set(shown));
  const omittedId = rows.map(row => row.messageId).find(value => !shown.includes(value));
  assert.ok(omittedId);
  assert.ok(!marked.includes(omittedId));
  const byId = new Map(rows.map(row => [row.messageId, row]));
  const maxShown = Math.max(...shown.map(value => byId.get(value).cursor));
  await hooks.tool.relay_ack.execute({ through: maxShown }, toolContext());
  const second = { messages: [user()] };
  await hooks['experimental.chat.messages.transform']({}, second);
  const secondText = second.messages[0].parts[1].text;
  assert.ok(secondText.includes(omittedId));
});
test('context byte budget measures UTF-8 envelope including wrapper', async t => {
  const rows = Array.from({ length: 30 }, (_, i) => message('cjk-' + i, { body: '漢'.repeat(5300), cursor: i + 1 }));
  const h = harness({ initial: rows }), hooks = await plugin(h);
  t.after(() => hooks.dispose());
  await busy(hooks);
  await hooks.tool.relay_inbox.execute({}, toolContext());
  const output = { messages: [user()] };
  await hooks['experimental.chat.messages.transform']({}, output);
  const text = output.messages[0].parts[1].text;
  assert.ok(Buffer.byteLength(text) <= 32 * 1024);
  const shown = text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line).messageId);
  assert.ok(shown.length < 6);
  const marked = h.calls.filter(x => x.op === 'notified' && x.adapter === 'opencode-context').map(x => x.messageId);
  assert.deepEqual(new Set(marked), new Set(shown));
});
test('oversized single row uses compact envelope without truncating body', async t => {
  const bigBody = 'A'.repeat(40000);
  const row = message('big-1', { body: bigBody, cursor: 1, summary: 'big summary', attachments: [{ name: 'f.bin', size: 3, sha256: 'c'.repeat(64) }] });
  const h = harness({ initial: [row] }), hooks = await plugin(h);
  t.after(() => hooks.dispose());
  await busy(hooks);
  await hooks.tool.relay_inbox.execute({}, toolContext());
  const output = { messages: [user()] };
  await hooks['experimental.chat.messages.transform']({}, output);
  const text = output.messages[0].parts[1].text;
  assert.match(text, /big-1/);
  assert.match(text, /big summary/);
  assert.match(text, /f\.bin/);
  assert.match(text, /"cursor":1/);
  assert.match(text, /\[body 40000 bytes; read via relay_inbox\]/);
  assert.ok(!text.includes('A'.repeat(1000)));
  assert.ok(Buffer.byteLength(text) <= 32 * 1024);
});
test('attachment-heavy rows stay within UTF-8 budget with descriptors', async t => {
  const rows = Array.from({ length: 10 }, (_, i) => message('att-' + i, { body: 'ok-' + i, cursor: i + 1, summary: 's' + i,
    attachments: Array.from({ length: 20 }, (_, j) => ({ name: 'file-' + j + '-' + 'n'.repeat(80) + '.bin', size: 3, sha256: 'd'.repeat(64) })) }));
  const h = harness({ initial: rows }), hooks = await plugin(h);
  t.after(() => hooks.dispose());
  await busy(hooks);
  await hooks.tool.relay_inbox.execute({}, toolContext());
  const output = { messages: [user()] };
  await hooks['experimental.chat.messages.transform']({}, output);
  const text = output.messages[0].parts[1].text;
  assert.ok(Buffer.byteLength(text) <= 32 * 1024);
  const shown = text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line).messageId);
  assert.ok(shown.length < 10);
  assert.match(text, /file-0-/);
  const marked = h.calls.filter(x => x.op === 'notified' && x.adapter === 'opencode-context').map(x => x.messageId);
  assert.deepEqual(new Set(marked), new Set(shown));
});
test('receipt and agents paginate with bounded defaults and continuation', async t => {
  const fullRecipients = Array.from({ length: 150 }, (_, i) => ({ agentId: 'receiver-' + i, stored: true, notified: [], accepted: [], missing: [], acked: false, state: 'stored', cursor: 1 }));
  const fullAgents = Array.from({ length: 150 }, (_, i) => ({ agentId: 'agent-' + i, runner: 'review', status: 'idle' }));
  const rpcCalls = [];
  const client = harness().client;
  const transport = {
    async rpc(project, fields) {
      rpcCalls.push(fields);
      if (fields.op === 'register') return { ok: true };
      if (fields.op === 'receipt') {
        const limit = fields.recipientsLimit ?? 150;
        const offset = fields.recipientsOffset ?? 0;
        const page = fullRecipients.slice(offset, offset + limit);
        return { ok: true, id: fields.messageId, recipients: page, recipientsTotal: 150, recipientsLimit: limit, recipientsOffset: offset,
          counts: { recipients: 150, acked: 0, accepted: 0, notified: 0, pending: 150, missing: 0 }, pending: [] };
      }
      if (fields.op === 'agents') {
        const limit = fields.limit ?? 150;
        const offset = fields.offset ?? 0;
        return { ok: true, agents: fullAgents.slice(offset, offset + limit), total: 150, claims: [], cursor: 0 };
      }
      return { ok: true, ...fields };
    },
    wait(project, agentId, after, { signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
  };
  const hooks = await AgentRelayPlugin({ client, directory, worktree: directory }, { transport, dataDir: '/tmp/relay-isolated' });
  t.after(() => hooks.dispose());
  const started = user();
  await hooks['chat.message']({ sessionID }, { message: started.info });
  await flush();
  const receiptDefault = JSON.parse(await hooks.tool.relay_receipt.execute({ messageId: 'm-1' }, toolContext()));
  assert.equal(rpcCalls.find(x => x.op === 'receipt').recipientsLimit, 100);
  assert.equal(receiptDefault.recipients.length, 100);
  assert.equal(receiptDefault.recipientsTotal, 150);
  assert.equal(receiptDefault.nextRecipientsOffset, 100);
  assert.equal(receiptDefault.hasMoreRecipients, true);
  const receiptExplicit = JSON.parse(await hooks.tool.relay_receipt.execute({ messageId: 'm-1', recipientsLimit: 10, recipientsOffset: 5 }, toolContext()));
  assert.equal(rpcCalls.filter(x => x.op === 'receipt').at(-1).recipientsLimit, 10);
  assert.equal(rpcCalls.filter(x => x.op === 'receipt').at(-1).recipientsOffset, 5);
  assert.equal(receiptExplicit.nextRecipientsOffset, 15);
  assert.equal(receiptExplicit.hasMoreRecipients, true);
  const agentsDefault = JSON.parse(await hooks.tool.relay_agents.execute({}, toolContext()));
  assert.equal(rpcCalls.find(x => x.op === 'agents').limit, 100);
  assert.equal(agentsDefault.agents.length, 100);
  assert.equal(agentsDefault.nextOffset, 100);
  assert.equal(agentsDefault.hasMore, true);
  const agentsExplicit = JSON.parse(await hooks.tool.relay_agents.execute({ limit: 10, offset: 5 }, toolContext()));
  assert.equal(agentsExplicit.nextOffset, 15);
  assert.equal(agentsExplicit.hasMore, true);
});
test('close folds disconnected into offline and dispose emits no new calls', async t => {
  const h = harness(), hooks = await plugin(h);
  t.after(() => hooks.dispose());
  await busy(hooks);
  await h.deliver([message('r11-1')]);
  await flush();
  assert.ok(h.calls.some(x => x.op === 'status' && x.transport?.state === 'connected'));
  await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: sessionID, directory } } } });
  await flush();
  const offline = h.calls.filter(x => x.op === 'status' && x.status === 'offline');
  assert.equal(offline.length, 1);
  assert.deepEqual(offline[0].transport, { adapter: 'opencode-watch', state: 'disconnected' });
  const count = h.calls.length;
  await hooks.dispose();
  await flush();
  assert.equal(h.calls.length, count);
  await hooks.dispose();
  assert.equal(h.calls.length, count);
});
test('legacy broker rejecting transport keeps working without loops', async t => {
  const calls = [];
  const waiters = [];
  const client = harness().client;
  const transport = {
    async rpc(project, fields) {
      calls.push(fields);
      if (fields.op === 'register') return { ok: true };
      if (fields.op === 'inbox') return { ok: true, messages: [], cursor: 0 };
      if (fields.op === 'status' && fields.transport) {
        const error = new Error('unsupported transport');
        error.code = 'UNSUPPORTED_FEATURE';
        throw error;
      }
      return { ok: true, ...fields };
    },
    wait(project, agentId, after, { signal }) {
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
  };
  const hooks = await AgentRelayPlugin({ client, directory, worktree: directory }, { transport, dataDir: '/tmp/relay-isolated' });
  t.after(() => hooks.dispose());
  const started = user();
  await hooks['chat.message']({ sessionID }, { message: started.info });
  await flush();
  assert.equal(waiters.length, 1);
  waiters.shift().resolve({ ok: true, messages: [], cursor: 0 });
  await flush();
  await flush();
  const transportReports = calls.filter(x => x.op === 'status' && x.transport);
  assert.equal(transportReports.length, 1);
  assert.equal(waiters.length, 1);
  waiters.shift().resolve({ ok: true, messages: [], cursor: 0 });
  await flush();
  await flush();
  assert.equal(calls.filter(x => x.op === 'status' && x.transport).length, 1);
  const inbox = JSON.parse(await hooks.tool.relay_inbox.execute({}, toolContext()));
  assert.equal(inbox.messages.length, 0);
  await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: sessionID, directory } } } });
  await flush();
  const offline = calls.filter(x => x.op === 'status' && x.status === 'offline');
  assert.equal(offline.length, 1);
  assert.equal('transport' in offline[0], false);
});

test('wake admits only bounded rows and defers omitted rows to a later idle', async t => {
  const rows = Array.from({ length: 30 }, (_, i) => message('wake-' + i, { body: 'payload-' + i + '-' + 'x'.repeat(2000), cursor: i + 1 }));
  const h = harness({ initial: rows }), hooks = await plugin(h); t.after(() => hooks.dispose());
  await busy(hooks);
  await idle(hooks);
  await flush();
  assert.equal(h.prompts.length, 1);
  const text = h.prompts[0].body.parts[0].text;
  const shown = text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line).messageId);
  assert.ok(shown.length > 0);
  assert.ok(shown.length < 30);
  const markers = h.calls.filter(x => x.op === 'notified' && x.adapter === 'opencode-wake-attempted').map(x => x.messageId);
  assert.deepEqual(new Set(markers), new Set(shown));
  const omitted = rows.map(row => row.messageId).filter(value => !shown.includes(value));
  assert.ok(omitted.length > 0);
  for (const value of omitted) assert.ok(!markers.includes(value));
  for (const value of shown) await hooks.tool.relay_ack.execute({ messageId: value }, toolContext());
  await idle(hooks);
  await flush();
  assert.equal(h.prompts.length, 2);
  const secondText = h.prompts[1].body.parts[0].text;
  const shownSecond = secondText.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line).messageId);
  assert.ok(shownSecond.length > 0);
  assert.ok(shownSecond.some(value => omitted.includes(value)));
  const markersAfter = h.calls.filter(x => x.op === 'notified' && x.adapter === 'opencode-wake-attempted').map(x => x.messageId);
  for (const value of shownSecond) assert.ok(markersAfter.includes(value));
  assert.deepEqual(new Set(markersAfter), new Set([...shown, ...shownSecond]));
});

test('task empty lists clear through broker while empty claim stays rejected', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-opencode-tasks-clear-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir, { recursive: true })));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function brokerRpc(target, fields) {
    const response = await fetch(broker.url + '/rpc', { method: 'POST',
      headers: { authorization: 'Bearer ' + broker.token, 'content-type': 'application/json' },
      body: JSON.stringify({ project: target, ...fields }) });
    return response.json();
  }
  function realTransport() {
    return {
      async rpc(target, fields) { return brokerRpc(target, fields); },
      wait(target, agentId, after, { signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    };
  }
  const session = 'ses_tasks_clear';
  const context = { client: harness().client, directory: project, worktree: project };
  const hooks = await AgentRelayPlugin(context, { transport: realTransport() });
  t.after(async () => { await hooks.dispose(); });
  const toolCtx = extra => ({ sessionID: session, directory: project, worktree: project, abort: new AbortController().signal, ...extra });
  const schemas = Object.fromEntries(Object.entries(hooks.tool).map(([name, definition]) => [name, z.object(definition.args)]));
  schemas.relay_tasks.parse({ action: 'upsert', title: 'Work', blockedBy: [], resources: [] });
  assert.throws(() => schemas.relay_claim.parse({ resources: [] }));
  assert.throws(() => schemas.relay_handoff_request.parse({ resources: [], reason: 'move' }));
  await hooks.tool.relay_claim.execute({ resources: ['clear-block.txt'] }, toolCtx());
  const created = JSON.parse(await hooks.tool.relay_tasks.execute({ action: 'upsert', id: 't-clear', title: 'Clearable',
    blockedBy: ['clear-block.txt'], resources: ['clear-res.txt'] }, toolCtx()));
  assert.deepEqual(created.task.blockedBy, ['clear-block.txt']);
  assert.deepEqual(created.task.resources, ['clear-res.txt']);
  assert.equal(created.task.blocked, true);
  const cleared = JSON.parse(await hooks.tool.relay_tasks.execute({ action: 'upsert', id: 't-clear', blockedBy: [], resources: [] }, toolCtx()));
  assert.deepEqual(cleared.task.blockedBy, []);
  assert.deepEqual(cleared.task.resources, []);
  assert.equal(cleared.task.blocked, false);
  const listed = JSON.parse(await hooks.tool.relay_tasks.execute({ action: 'list' }, toolCtx()));
  const row = listed.tasks.find(entry => entry.id === 't-clear');
  assert.deepEqual(row.blockedBy, []);
  assert.deepEqual(row.resources, []);
  assert.equal(row.blocked, false);
});

test('800-recipient broadcast receipt stays bounded with full counts and resumable offsets', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-opencode-receipt-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir, { recursive: true })));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function brokerRpc(target, fields) {
    const response = await fetch(broker.url + '/rpc', { method: 'POST',
      headers: { authorization: 'Bearer ' + broker.token, 'content-type': 'application/json' },
      body: JSON.stringify({ project: target, ...fields }) });
    return response.json();
  }
  const rpcCalls = [];
  function realTransport() {
    return {
      async rpc(target, fields) { rpcCalls.push({ ...fields }); return brokerRpc(target, fields); },
      wait(target, agentId, after, { signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    };
  }
  const session = 'ses_receipt_bound';
  const context = { client: harness().client, directory: project, worktree: project };
  const hooks = await AgentRelayPlugin(context, { transport: realTransport() });
  t.after(async () => { await hooks.dispose(); });
  const toolCtx = extra => ({ sessionID: session, directory: project, worktree: project, abort: new AbortController().signal, ...extra });
  for (let i = 0; i < 800; i++)
    assert.equal((await brokerRpc(project, { op: 'register', agentId: `fanout-${i}`, runner: 'test', sessionId: `s-${i}` })).ok, true);
  const sent = JSON.parse(await hooks.tool.relay_send.execute({ to: '*', body: 'broadcast', messageId: 'fanout-1' }, toolCtx()));
  assert.equal(sent.ok, true);
  const firstRaw = await hooks.tool.relay_receipt.execute({ messageId: 'fanout-1' }, toolCtx());
  assert.ok(Buffer.byteLength(firstRaw) <= 64 * 1024, `receipt default bounded, got ${Buffer.byteLength(firstRaw)}`);
  const first = JSON.parse(firstRaw);
  const receiptCall = rpcCalls.find(x => x.op === 'receipt' && x.messageId === 'fanout-1');
  assert.equal(receiptCall.recipientsLimit, 100);
  assert.equal(receiptCall.pendingLimit, 100);
  assert.equal(first.counts.recipients, 800);
  assert.equal(first.recipientsTotal, 800);
  assert.equal(first.recipients.length, 100);
  assert.equal(first.recipientsOffset, 0);
  assert.equal(first.nextRecipientsOffset, 100);
  assert.equal(first.hasMoreRecipients, true);
  assert.equal(first.pendingTotal, 800);
  assert.equal(first.pending.length, 100);
  assert.equal(first.pendingOffset, 0);
  assert.equal(first.nextPendingOffset, 100);
  assert.equal(first.hasMorePending, true);
  assert.ok(first.counts.pending + first.counts.missing + first.counts.acked + first.counts.accepted + first.counts.notified <= 800);
  const explicitRaw = await hooks.tool.relay_receipt.execute({ messageId: 'fanout-1', recipientsLimit: 10, recipientsOffset: 5 }, toolCtx());
  assert.ok(Buffer.byteLength(explicitRaw) <= 64 * 1024);
  const explicit = JSON.parse(explicitRaw);
  assert.equal(explicit.recipients.length, 10);
  assert.equal(explicit.recipientsOffset, 5);
  assert.equal(explicit.recipientsTotal, 800);
  assert.equal(explicit.counts.recipients, 800);
  assert.equal(explicit.pendingTotal, 800);
  const lastReceipt = rpcCalls.filter(x => x.op === 'receipt').at(-1);
  assert.equal(lastReceipt.recipientsLimit, 10);
  assert.equal(lastReceipt.recipientsOffset, 5);
  const pendingExplicitRaw = await hooks.tool.relay_receipt.execute({ messageId: 'fanout-1', pendingLimit: 10, pendingOffset: 5 }, toolCtx());
  assert.ok(Buffer.byteLength(pendingExplicitRaw) <= 64 * 1024);
  const pendingExplicit = JSON.parse(pendingExplicitRaw);
  assert.equal(pendingExplicit.pending.length, 10);
  assert.equal(pendingExplicit.pendingOffset, 5);
  assert.equal(pendingExplicit.pendingTotal, 800);
  assert.equal(pendingExplicit.nextPendingOffset, 15);
  assert.equal(pendingExplicit.hasMorePending, true);
  const secondRaw = await hooks.tool.relay_receipt.execute(
    { messageId: 'fanout-1', recipientsLimit: 100, recipientsOffset: 100, pendingLimit: 100, pendingOffset: 100 }, toolCtx());
  assert.ok(Buffer.byteLength(secondRaw) <= 64 * 1024);
  const second = JSON.parse(secondRaw);
  assert.equal(second.recipients.length, 100);
  assert.equal(second.recipientsOffset, 100);
  assert.equal(second.recipientsTotal, 800);
  assert.equal(second.nextRecipientsOffset, 200);
  assert.equal(second.hasMoreRecipients, true);
  assert.equal(second.pending.length, 100);
  assert.equal(second.pendingOffset, 100);
  assert.equal(second.pendingTotal, 800);
  assert.equal(second.nextPendingOffset, 200);
  assert.equal(second.hasMorePending, true);
  assert.notDeepEqual(second.recipients.map(r => r.agentId).sort(), first.recipients.map(r => r.agentId).sort());
  const seen = [];
  let offset = 0;
  for (let guard = 0; guard < 12; guard++) {
    const pageRaw = await hooks.tool.relay_receipt.execute({ messageId: 'fanout-1', recipientsLimit: 100, recipientsOffset: offset }, toolCtx());
    assert.ok(Buffer.byteLength(pageRaw) <= 64 * 1024);
    const page = JSON.parse(pageRaw);
    assert.equal(page.counts.recipients, 800);
    assert.equal(page.recipientsTotal, 800);
    for (const r of page.recipients) seen.push(r.agentId);
    if (!page.hasMoreRecipients) break;
    offset = page.nextRecipientsOffset;
  }
  assert.equal(seen.length, 800);
  assert.equal(new Set(seen).size, 800);
  const pendingSeen = [];
  let pendingOffset = 0;
  for (let guard = 0; guard < 12; guard++) {
    const pageRaw = await hooks.tool.relay_receipt.execute({ messageId: 'fanout-1', pendingLimit: 100, pendingOffset }, toolCtx());
    assert.ok(Buffer.byteLength(pageRaw) <= 64 * 1024);
    const page = JSON.parse(pageRaw);
    assert.equal(page.pendingTotal, 800);
    for (const r of page.pending) pendingSeen.push(r.agentId);
    if (!page.hasMorePending) break;
    pendingOffset = page.nextPendingOffset;
  }
  assert.equal(pendingSeen.length, 800);
  assert.equal(new Set(pendingSeen).size, 800);
  const outboxRaw = await hooks.tool.relay_outbox.execute({}, toolCtx());
  assert.ok(Buffer.byteLength(outboxRaw) <= 64 * 1024, `outbox bounded, got ${Buffer.byteLength(outboxRaw)}`);
  const outbox = JSON.parse(outboxRaw);
  assert.equal(outbox.messages.length, 1);
  assert.equal(outbox.messages[0].recipients.length, 25);
  assert.equal(outbox.messages[0].recipientsTotal, 800);
  assert.equal(outbox.messages[0].pending.length, 25);
  assert.equal(outbox.messages[0].pendingTotal, 800);
  assert.equal(outbox.messages[0].counts.recipients, 800);
  assert.equal(outbox.done, true);
  const outboxCall = rpcCalls.find(x => x.op === 'outbox');
  assert.equal(outboxCall.recipientsLimit, 25);
  assert.equal(outboxCall.pendingLimit, 25);
  const outboxExplicitRaw = await hooks.tool.relay_outbox.execute({ recipientsLimit: 10, pendingLimit: 10 }, toolCtx());
  assert.ok(Buffer.byteLength(outboxExplicitRaw) <= 64 * 1024);
  const outboxExplicit = JSON.parse(outboxExplicitRaw);
  assert.equal(outboxExplicit.messages.length, 1);
  assert.equal(outboxExplicit.messages[0].recipients.length, 10);
  assert.equal(outboxExplicit.messages[0].recipientsTotal, 800);
  assert.equal(outboxExplicit.messages[0].pending.length, 10);
  assert.equal(outboxExplicit.messages[0].pendingTotal, 800);
  const lastOutbox = rpcCalls.filter(x => x.op === 'outbox').at(-1);
  assert.equal(lastOutbox.recipientsLimit, 10);
  assert.equal(lastOutbox.pendingLimit, 10);
});

test('large agent listing is bounded with continuation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-opencode-agents-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir, { recursive: true })));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function brokerRpc(target, fields) {
    const response = await fetch(broker.url + '/rpc', { method: 'POST',
      headers: { authorization: 'Bearer ' + broker.token, 'content-type': 'application/json' },
      body: JSON.stringify({ project: target, ...fields }) });
    return response.json();
  }
  function realTransport() {
    return {
      async rpc(target, fields) { return brokerRpc(target, fields); },
      wait(target, agentId, after, { signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    };
  }
  const session = 'ses_agents_bound';
  const context = { client: harness().client, directory: project, worktree: project };
  const hooks = await AgentRelayPlugin(context, { transport: realTransport() });
  t.after(async () => { await hooks.dispose(); });
  const toolCtx = extra => ({ sessionID: session, directory: project, worktree: project, abort: new AbortController().signal, ...extra });
  for (let i = 0; i < 150; i++)
    assert.equal((await brokerRpc(project, { op: 'register', agentId: `listed-${i}`, runner: 'test', sessionId: `s-${i}` })).ok, true);
  const firstRaw = await hooks.tool.relay_agents.execute({}, toolCtx());
  assert.ok(Buffer.byteLength(firstRaw) <= 64 * 1024, `agents default bounded, got ${Buffer.byteLength(firstRaw)}`);
  const first = JSON.parse(firstRaw);
  assert.equal(first.total, 151);
  assert.equal(first.agents.length, 100);
  assert.equal(first.nextOffset, 100);
  assert.equal(first.hasMore, true);
  const restRaw = await hooks.tool.relay_agents.execute({ offset: 100 }, toolCtx());
  assert.ok(Buffer.byteLength(restRaw) <= 64 * 1024);
  const rest = JSON.parse(restRaw);
  assert.equal(rest.total, 151);
  assert.equal(rest.agents.length, 51);
  const explicitRaw = await hooks.tool.relay_agents.execute({ limit: 10 }, toolCtx());
  assert.ok(Buffer.byteLength(explicitRaw) <= 64 * 1024);
  const explicit = JSON.parse(explicitRaw);
  assert.equal(explicit.agents.length, 10);
  assert.equal(explicit.total, 151);
});

test('max-size task metadata stays bounded', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-opencode-task-bound-'));
  const dataDir = path.join(root, 'data');
  const project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir, { recursive: true })));
  const broker = await createBroker({ dataDir });
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function brokerRpc(target, fields) {
    const response = await fetch(broker.url + '/rpc', { method: 'POST',
      headers: { authorization: 'Bearer ' + broker.token, 'content-type': 'application/json' },
      body: JSON.stringify({ project: target, ...fields }) });
    return response.json();
  }
  function realTransport() {
    return {
      async rpc(target, fields) { return brokerRpc(target, fields); },
      wait(target, agentId, after, { signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    };
  }
  const session = 'ses_task_bound';
  const context = { client: harness().client, directory: project, worktree: project };
  const hooks = await AgentRelayPlugin(context, { transport: realTransport() });
  t.after(async () => { await hooks.dispose(); });
  const toolCtx = extra => ({ sessionID: session, directory: project, worktree: project, abort: new AbortController().signal, ...extra });
  const bigVerification = 'v'.repeat(4096);
  const bigResources = Array.from({ length: 10 }, (_, i) => `resource-${i}-` + 'r'.repeat(100));
  const bigBlockedBy = Array.from({ length: 10 }, (_, i) => `blocker-${i}-` + 'b'.repeat(100));
  const createdRaw = await hooks.tool.relay_tasks.execute({ action: 'upsert', title: 'Max metadata',
    verification: bigVerification, resources: bigResources, blockedBy: bigBlockedBy }, toolCtx());
  assert.ok(Buffer.byteLength(createdRaw) <= 64 * 1024, `task upsert bounded, got ${Buffer.byteLength(createdRaw)}`);
  const created = JSON.parse(createdRaw);
  assert.equal(created.task.verification, bigVerification);
  const listedRaw = await hooks.tool.relay_tasks.execute({ action: 'list' }, toolCtx());
  assert.ok(Buffer.byteLength(listedRaw) <= 64 * 1024, `task list bounded, got ${Buffer.byteLength(listedRaw)}`);
  const listed = JSON.parse(listedRaw);
  assert.ok(listed.tasks.some(row => row.id === created.task.id));
  const bulletinRaw = await hooks.tool.relay_bulletin_get.execute({}, toolCtx());
  assert.ok(Buffer.byteLength(bulletinRaw) <= 64 * 1024);
  const handoffsRaw = await hooks.tool.relay_handoffs.execute({}, toolCtx());
  assert.ok(Buffer.byteLength(handoffsRaw) <= 64 * 1024);
  const processesRaw = await hooks.tool.relay_processes_list.execute({}, toolCtx());
  assert.ok(Buffer.byteLength(processesRaw) <= 64 * 1024);
  const groupRaw = await hooks.tool.relay_group_agents.execute({ groupId: 'g-task-bound' }, toolCtx());
  assert.ok(Buffer.byteLength(groupRaw) <= 64 * 1024);
});

test('OpenCode continuation retrieves all trimmed task rows and oversized marker details with session isolation', async t => {
  const h = harness(), rpc = h.transport.rpc.bind(h.transport);
  const rows = Array.from({length: 64}, (_, i) => ({id: 'large-task-' + i, verification: '漢😀'.repeat(1200)}));
  const huge = {ok: true, messages: [message('large-marker', {body: '\u0000'.repeat(16384),
    notified: Array.from({length: 1024}, (_, i) => ({agentId: id, adapter: 'stage-' + i, at: 'x'.repeat(80)}))})]};
  h.transport.rpc = async (project, fields) => fields.op === 'tasks' ? {ok: true, tasks: structuredClone(rows)}
    : fields.op === 'inbox' ? structuredClone(huge) : rpc(project, fields);
  const hooks = await plugin(h); t.after(() => hooks.dispose());
  for (const [name, args, expected] of [['relay_tasks', {action: 'list'}, {ok: true, tasks: rows}],
    ['relay_inbox', {}, huge]]) {
    const raw = await hooks.tool[name].execute(args, toolContext()), first = JSON.parse(raw);
    assert.ok(Buffer.byteLength(raw) <= 65536);
    assert.ok(first.continuation);
    assert.throws(() => hooks.tool.relay_read_page.execute({token: first.continuation.token}, toolContext({sessionID: 'ses_foreign'})), /Unknown or expired/);
    assert.throws(() => hooks.tool.relay_read_page.execute({token: first.continuation.token}, toolContext({directory: '/different'})), /different project/);
    let text = '', offset = 0;
    for (;;) {
      const chunkRaw = await hooks.tool.relay_read_page.execute({token: first.continuation.token, offset}, toolContext());
      assert.ok(Buffer.byteLength(chunkRaw) <= 65536);
      const chunk = JSON.parse(chunkRaw); text += chunk.text;
      if (chunk.done) break;
      assert.ok(chunk.nextOffset > offset); offset = chunk.nextOffset;
    }
    assert.deepEqual(JSON.parse(text), expected);
  }
  assert.ok(!h.calls.some(row => row.op === 'ack'), 'continuation does not acknowledge unread details');
});
