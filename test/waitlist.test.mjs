import test from 'node:test';
import assert from 'node:assert/strict';
import {waitlist} from '../worker/index.mjs';

// The KV namespace, in memory.
const kv = () => {
 const store = new Map();
 return {store, async get(key, type) {const value = store.get(key); return value == null ? null : type === 'json' ? JSON.parse(value) : value;}, async put(key, value) {store.set(key, value);}};
};
const post = fields => {
 const body = new FormData();
 for (const [name, value] of fields) body.append(name, value);
 return new Request('https://relay.next-notes.com/api/waitlist', {method: 'POST', body});
};

test('a sign-up is stored once per email, with only the known choices', async () => {
 const env = {WAITLIST: kv()};
 const first = await waitlist(post([['email', ' Ada@Example.com '], ['team_size', '6-20'], ['agents', 'claude'], ['agents', 'codex'], ['agents', 'rm -rf'], ['need', 'shared rooms']]), env, new Date('2026-10-30T10:00:00Z'));
 assert.equal(first.status, 200);
 assert.match(await first.text(), /You are on the list/);
 assert.deepEqual(JSON.parse(env.WAITLIST.store.get('signup:ada@example.com')), {email: 'ada@example.com', team_size: '6-20', agents: ['claude', 'codex'], need: 'shared rooms', joined: '2026-10-30T10:00:00.000Z'});

 await waitlist(post([['email', 'ada@example.com'], ['team_size', 'lots']]), env, new Date('2026-10-31T10:00:00Z'));
 assert.equal(env.WAITLIST.store.size, 1);
 const again = JSON.parse(env.WAITLIST.store.get('signup:ada@example.com'));
 assert.equal(again.joined, '2026-10-30T10:00:00.000Z', 'the first sign-up date is kept');
 assert.equal(again.updated, '2026-10-31T10:00:00.000Z');
 assert.equal(again.team_size, null, 'an unknown team size is dropped');
});

test('a bad email, a bot and a GET store nothing', async () => {
 const env = {WAITLIST: kv()};
 assert.equal((await waitlist(post([['email', 'not-an-email']]), env)).status, 400);
 const bot = await waitlist(post([['email', 'bot@example.com'], ['website', 'http://spam']]), env);
 assert.equal(bot.status, 200, 'the honeypot answers as if it worked');
 const get = await waitlist(new Request('https://relay.next-notes.com/api/waitlist'), env);
 assert.equal(get.status, 405);
 assert.equal(get.headers.get('allow'), 'POST');
 assert.equal(env.WAITLIST.store.size, 0);
});

test('what people type is escaped, never echoed as HTML', async () => {
 const env = {WAITLIST: kv()};
 const response = await waitlist(post([['email', '<script>@x.y']]), env);
 assert.ok(!(await response.text()).includes('<script>'));
});
