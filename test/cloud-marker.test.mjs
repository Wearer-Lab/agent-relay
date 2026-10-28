import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createBroker} from '../lib/broker.mjs';

// A cloud write carries the gateway's marker on the row it writes. A local write,
// which sends no cloud field, stays unmarked. The marker is not an identity check.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-cloud-'));
  const dataDir = path.join(root, 'data'), project = path.join(root, 'project');
  await Promise.all([dataDir, project].map(dir => fs.mkdir(dir)));
  let handler;
  const broker = await createBroker({
    dataDir,
    serverFactory: callback => {
      handler = callback;
      const server = new EventEmitter();
      server.listen = (_port, _host, ready) => queueMicrotask(ready);
      server.address = () => ({port: 0});
      server.close = done => done?.();
      return server;
    },
  });
  t.after(async () => {
    await broker.close();
    await fs.rm(root, {recursive: true, force: true, maxRetries: 15, retryDelay: 200});
  });
  const rpc = async fields => {
    let result;
    const response = new EventEmitter();
    response.writeHead = () => {};
    response.end = body => { result = JSON.parse(body); };
    const incoming = {
      method: 'POST', url: '/rpc', headers: {authorization: 'Bearer ' + broker.token},
      destroyed: false,
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({project, ...fields})); },
    };
    await handler(incoming, response);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  return {rpc, project, dataDir};
}

const cloud = {runner: 'claude', prefix: 'cloud-'};

test('a cloud claim, task, handoff and ack carry the marker, and a local write does not', async t => {
  const {rpc, project, dataDir} = await fixture(t);
  await rpc({op: 'register', agentId: 'cloud-1', runner: 'claude', cloud});
  await rpc({op: 'register', agentId: 'local-1', runner: 'test'});
  const file = path.join(project, 'src.txt');
  await fs.writeFile(file, 'x');

  const claimed = await rpc({op: 'claim', agentId: 'cloud-1', resources: [file], cloud});
  const cloudClaim = claimed.claims.find(row => row.agentId === 'cloud-1');
  assert.ok(cloudClaim, 'the cloud agent holds the claim');
  assert.deepEqual(cloudClaim.cloud, cloud);
  const localClaim = path.join(project, 'local.txt');
  await fs.writeFile(localClaim, 'y');
  const unmarked = await rpc({op: 'claim', agentId: 'local-1', resources: [localClaim]});
  assert.equal(unmarked.claims.find(row => row.agentId === 'local-1').cloud, undefined);

  await rpc({op: 'tasks', action: 'upsert', agentId: 'cloud-1', id: 'job', title: 'Do the job', cloud});
  await rpc({op: 'send', from: 'local-1', to: 'cloud-1', body: 'please', messageId: 'note'});
  await rpc({op: 'ack', agentId: 'cloud-1', messageId: 'note', cloud});
  const handoff = await rpc({op: 'requestHandoff', agentId: 'cloud-1', to: 'local-1', resources: [file], reason: 'yours', cloud});
  assert.deepEqual(handoff.handoff.cloud, cloud);

  const state = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  const room = state.rooms.find(row => row.agents?.some(agent => agent.agentId === 'cloud-1'));
  assert.ok(room, 'the room was written');
  assert.deepEqual(room.tasks.find(row => row.id === 'job').cloud, cloud);
  const note = room.messages.find(row => row.messageId === 'note');
  assert.deepEqual(note.acks.find(row => row.agentId === 'cloud-1').cloud, cloud);
  assert.equal(room.agents.find(row => row.agentId === 'local-1').cloud, undefined);
});
