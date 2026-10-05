import test from 'node:test';import assert from 'node:assert/strict';import {preview,watchMessages} from '../lib/watch.mjs';
test('JSON preview is compact, Unicode-safe and puts summary before body',()=>{
 const row=preview({messageId:'id',from:'a',createdAt:'today',body:'😀long',summary:'preview'},1);assert.equal(row.body,'😀');assert.equal(row.truncated,true);assert.equal(row.replyTo,null);assert.ok(JSON.stringify(row).indexOf('summary')<JSON.stringify(row).indexOf('body'));
});
test('watch recovers broker faults with backoff and keeps last emitted cursor without duplicates',async()=>{
 const controller=new AbortController(),seen=[],delays=[];let attempts=0;
 await watchMessages({project:'/tmp',agentId:'b',dataDir:'/tmp/unused-watch',signal:controller.signal,unread:true,
  call:async(p,fields)=>{assert.equal(fields.unacked,true);if(++attempts<=2)throw Error('restart');if(fields.since===0)return {messages:[{messageId:'one',cursor:1}]};return {messages:[{messageId:'two',cursor:2}]};},
  poll:async(p,id,cursor)=>{if(cursor===1)throw Error('restart');controller.abort();throw Error('aborted');},pause:async ms=>delays.push(ms),onMessage:m=>seen.push(m.messageId)});
 assert.deepEqual(seen,['one','two']);assert.deepEqual(delays,[100,200,400]);
});
