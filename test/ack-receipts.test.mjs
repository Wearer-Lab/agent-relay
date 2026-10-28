import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createBroker} from '../lib/broker.mjs';

// Delivered is a fetch of the body. Handled is an ack. A session nonce is optional
// and never an authentication check: a missing or mismatched nonce still counts as handled.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-receipts-'));
  const dataDir = path.join(root, 'data'), project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  let handler, broker;
  const serverFactory = callback => {
    handler = callback;
    const server = new EventEmitter();
    server.listen = (port, host, ready) => queueMicrotask(ready);
    server.address = () => ({ port: 0 });
    server.close = done => done?.();
    return server;
  };
  broker = await createBroker({ dataDir, serverFactory });
  t.after(async () => {
    await broker.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  });
  async function request(fields) {
    let status, result;
    const response = new EventEmitter();
    response.writeHead = code => { status = code; };
    response.end = body => { result = JSON.parse(body); };
    const incoming = {
      method: 'POST', url: '/rpc', headers: { authorization: 'Bearer ' + broker.token },
      destroyed: false,
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ project, ...fields })); }
    };
    await handler(incoming, response);
    return { status, ...result };
  }
  const rpc = async fields => {
    const result = await request(fields);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  return { rpc, request };
}

const row = (receipt, agentId) => receipt.recipients.find(candidate => candidate.agentId === agentId);

test('fetching the body is delivered, and an ack is handled, with the session unbound unless the nonce matches', async t => {
  const f = await fixture(t);
  await f.rpc({ op: 'register', agentId: 'a', runner: 'test' });
  await f.rpc({ op: 'register', agentId: 'b', runner: 'test' });
  await f.rpc({ op: 'register', agentId: 'c', runner: 'test' });
  const sent = await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'please read this', messageId: 'note' });
  await f.rpc({ op: 'send', from: 'a', to: 'c', body: 'for the poll', messageId: 'polled' });
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'acked blind', messageId: 'blind' });

  const before = await f.rpc({ op: 'receipt', messageId: 'note' });
  assert.equal(row(before, 'b').delivered, false);
  assert.equal(row(before, 'b').handled, false);
  assert.equal(row(before, 'b').session, 'unbound');
  assert.equal(before.counts.delivered, 0);
  assert.equal(before.counts.handled, 0);

  // A transport notification is not a fetch of the body.
  await f.rpc({ op: 'notified', agentId: 'b', messageId: 'note', adapter: 'opencode-toast' });
  const notified = await f.rpc({ op: 'receipt', messageId: 'note' });
  assert.equal(row(notified, 'b').state, 'notified');
  assert.equal(row(notified, 'b').delivered, false);
  assert.equal(row(notified, 'b').handled, false);

  const inbox = await f.rpc({ op: 'inbox', agentId: 'b', session: 'session-b' });
  assert.deepEqual(inbox.messages.map(message => message.messageId).sort(), ['blind', 'note']);
  assert.equal(inbox.messages[0].deliveries, undefined, 'the inbox row keeps its old shape');
  assert.equal('delivered' in inbox.messages[0], false);
  const fetched = await f.rpc({ op: 'receipt', messageId: 'note' });
  assert.equal(row(fetched, 'b').delivered, true);
  assert.equal(typeof row(fetched, 'b').deliveredAt, 'string');
  assert.equal(row(fetched, 'b').handled, false);
  assert.equal(row(fetched, 'b').acked, false);
  assert.equal(row(fetched, 'b').session, 'unbound', 'a fetch alone does not bind the session');
  assert.equal(fetched.counts.delivered, 1);
  assert.equal(fetched.counts.handled, 0);

  // A second fetch does not rewrite the session that first read the body.
  await f.rpc({ op: 'inbox', agentId: 'b', session: 'session-other' });
  const wrong = await f.rpc({ op: 'ack', agentId: 'b', messageId: 'note', session: 'session-other' });
  assert.equal(wrong.acked, true);
  const mismatched = await f.rpc({ op: 'receipt', messageId: 'note' });
  assert.equal(row(mismatched, 'b').handled, true);
  assert.equal(row(mismatched, 'b').acked, true);
  assert.equal(row(mismatched, 'b').delivered, true);
  assert.equal(row(mismatched, 'b').session, 'unbound', 'a nonce that did not fetch the body does not bind the receipt');

  // The fetching session can still present its nonce on a later ack.
  const bound = await f.rpc({ op: 'ack', agentId: 'b', messageId: 'note', session: 'session-b' });
  assert.equal(bound.duplicate, true);
  const proven = await f.rpc({ op: 'receipt', messageId: 'note' });
  assert.equal(row(proven, 'b').handled, true);
  assert.equal(row(proven, 'b').session, 'session-b');
  assert.equal(proven.counts.handled, 1);

  // An ack with no nonce is handled, and the receipt says the session is unbound.
  const blind = await f.rpc({ op: 'ack', agentId: 'b', messageId: 'blind' });
  assert.equal(blind.acked, true);
  const blindReceipt = await f.rpc({ op: 'receipt', messageId: 'blind' });
  assert.equal(row(blindReceipt, 'b').delivered, true, 'the earlier inbox fetched this body too');
  assert.equal(row(blindReceipt, 'b').handled, true);
  assert.equal(row(blindReceipt, 'b').session, 'unbound');

  // A poll that returns the body is a delivery, the same as an inbox fetch.
  const waited = await f.rpc({ op: 'wait', agentId: 'c', after: 0, timeoutMs: 0, session: 'session-c' });
  assert.deepEqual(waited.messages.map(message => message.messageId), ['polled']);
  const polled = await f.rpc({ op: 'receipt', messageId: 'polled' });
  assert.equal(row(polled, 'c').delivered, true);
  assert.equal(row(polled, 'c').handled, false);
  const acked = await f.rpc({ op: 'ack', agentId: 'c', messageId: 'polled', session: 'session-c' });
  assert.equal(acked.duplicate, false);
  const handled = await f.rpc({ op: 'receipt', messageId: 'polled' });
  assert.equal(row(handled, 'c').handled, true);
  assert.equal(row(handled, 'c').session, 'session-c');

  const features = await f.rpc({ op: 'capabilities' });
  assert.ok(features.features.includes('delivery-receipts'));
  assert.equal(features.runtime.schema, 1, 'new ledgers stay on schema 1');
});

test('an ack with no fetch is handled and unbound, and a nonce is not a credential', async t => {
  const f = await fixture(t);
  await f.rpc({ op: 'register', agentId: 'a', runner: 'test' });
  await f.rpc({ op: 'register', agentId: 'b', runner: 'test' });
  await f.rpc({ op: 'send', from: 'a', to: 'b', body: 'unread', messageId: 'unread' });
  const acked = await f.rpc({ op: 'ack', agentId: 'b', messageId: 'unread', session: 'guessed' });
  assert.equal(acked.acked, true, 'the ack is accepted without a matching fetch');
  const receipt = await f.rpc({ op: 'receipt', messageId: 'unread' });
  assert.equal(row(receipt, 'b').delivered, false);
  assert.equal(row(receipt, 'b').handled, true);
  assert.equal(row(receipt, 'b').session, 'unbound');
  const rejected = await f.request({ op: 'ack', agentId: 'b', messageId: 'unread', session: '' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'INVALID_INPUT');
});
