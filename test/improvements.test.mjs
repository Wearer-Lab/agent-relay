import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createBroker} from '../lib/broker.mjs';
// Exercise the real HTTP handler, serial writer and durable ledger without binding TCP.
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-improvements-'));
 const dataDir=path.join(root,'data'),project=path.join(root,'project'),other=path.join(root,'other');
 await Promise.all([dataDir,project,other].map(p=>fs.mkdir(p)));
 let handler,broker;
 const serverFactory=callback=>{handler=callback;const server=new EventEmitter();server.listen=(port,host,ready)=>queueMicrotask(ready);server.address=()=>({port:0});server.close=done=>done?.();return server;};
 const open=()=>createBroker({dataDir,serverFactory});broker=await open();
 t.after(async()=>{await broker.close();await fs.rm(root,{recursive:true,force:true});});
 async function request(fields,room=project){
  let status,result;const response=new EventEmitter();response.writeHead=code=>{status=code;};response.end=body=>{result=JSON.parse(body);};
  const request={method:'POST',url:'/rpc',headers:{authorization:'Bearer '+broker.token},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({project:room,...fields}));}};
  await handler(request,response);return {status,...result};
 }
 const rpc=async(fields,room)=>{const result=await request(fields,room);assert.equal(result.ok,true,JSON.stringify(result));return result;};
 return {root,dataDir,project,other,request,rpc,register:(agentId,room)=>rpc({op:'register',agentId,runner:'test'},room),async restart(){await broker.close();broker=await open();}};
}

test('poll filters and cursor pagination retain unacked work; bulk ack affects only caller', async t => {
 const f=await fixture(t);await f.register('a');await f.register('b');await f.register('c');
 for(let i=0;i<3;i++)await f.rpc({op:'send',from:'a',to:'*',body:'poll',messageId:`poll-${i}`});
 const page=await f.rpc({op:'inbox',agentId:'b',from:'a',limit:1});assert.equal(page.messages.length,1);
 const rest=await f.rpc({op:'inbox',agentId:'b',since:page.cursor});assert.equal(rest.messages.length,2);
 await f.rpc({op:'ack',agentId:'b',through:page.cursor});assert.equal((await f.rpc({op:'inbox',agentId:'b'})).messages.length,2);
 await f.rpc({op:'ack',agentId:'b',all:true});assert.equal((await f.rpc({op:'inbox',agentId:'b'})).messages.length,0);
 assert.equal((await f.rpc({op:'inbox',agentId:'c'})).messages.length,3);
 assert.equal((await f.request({op:'inbox',agentId:'b',since:-1})).ok,false);
});

test('machine claims cross rooms, persist and require explicit logged forced release',async t=>{
 const f=await fixture(t);await f.register('a');await f.register('b',f.other);
 await f.rpc({op:'claim',agentId:'a',scope:'machine',resources:['native','build']});
 assert.equal((await f.request({op:'claim',agentId:'b',scope:'machine',resources:['native','install']},f.other)).ok,false);
 let view=await f.rpc({op:'agents',staleMinutes:0},f.other);assert.equal(view.claims.length,2);assert.equal(view.claims[0].stale,true);assert.equal(view.claims[0].project,await fs.realpath(f.project));
 await f.rpc({op:'release',agentId:'b',scope:'machine'},f.other);await f.restart();
 assert.equal((await f.rpc({op:'agents'},f.other)).claims.length,2);
 await f.rpc({op:'release',agentId:'owner',scope:'machine',force:true,resources:['native']},f.other);
 const state=JSON.parse(await fs.readFile(path.join(f.dataDir,'state.json')));assert.equal(state.releaseLog[0].as,'owner');assert.equal(state.machineClaims.length,1);
});

test('leave removes presence while retaining history and cooperative claims',async t=>{
 const f=await fixture(t);await f.register('a');await f.register('b');await f.rpc({op:'send',from:'a',to:'b',body:'history'});
 await f.rpc({op:'claim',agentId:'a',resources:['build']});await f.rpc({op:'leave',agentId:'a'});
 assert.equal((await f.rpc({op:'agents'})).agents.length,1);assert.equal((await f.rpc({op:'agents'})).claims.length,1);
 await f.restart();assert.equal((await f.rpc({op:'inbox',agentId:'b'})).messages.length,1);
 await f.register('a');assert.equal((await f.rpc({op:'agents'})).agents.length,2);
 assert.equal((await f.rpc({op:'agents',active:true,within:0})).agents.length,0);
});

test('attachments are recipient/sender only and survive restart without scratch files',async t=>{
 const f=await fixture(t);for(const id of ['a','b','c'])await f.register(id);const source=path.join(f.root,'packet');await fs.writeFile(source,'durable packet');
 await f.rpc({op:'send',from:'a',to:'b',body:'read packet',messageId:'packet',attachments:[source]});await fs.unlink(source);await f.restart();
 assert.equal((await f.request({op:'fetch',agentId:'c',messageId:'packet',out:path.join(f.root,'denied')})).ok,false);
 const result=await f.rpc({op:'fetch',agentId:'b',messageId:'packet',out:path.join(f.root,'fetched')});assert.equal(await fs.readFile(result.files[0].path,'utf8'),'durable packet');
});

test('summary is optional, bounded, durable and part of send idempotency',async t=>{
 const f=await fixture(t);await f.register('a');await f.register('b');const input={op:'send',from:'a',to:'b',messageId:'summary',body:'details',summary:'preview'};
 await f.rpc(input);assert.equal((await f.rpc(input)).duplicate,true);assert.equal((await f.request({...input,summary:'changed'})).ok,false);
 assert.equal((await f.request({...input,messageId:'long',summary:'x'.repeat(121)})).ok,false);
 await f.restart();assert.equal((await f.rpc({op:'inbox',agentId:'b'})).messages[0].summary,'preview');
});

test('old optional-field-free ledger opens byte-for-byte unchanged and accepts old send fields',async t=>{
 const f=await fixture(t);await f.register('a');await f.register('b');await f.rpc({op:'send',from:'a',to:'b',body:'old CLI',messageId:'old'});
 const file=path.join(f.dataDir,'state.json'),before=await fs.readFile(file,'utf8');await f.restart();assert.equal(await fs.readFile(file,'utf8'),before);
 assert.equal((await f.rpc({op:'inbox',agentId:'b'})).messages[0].body,'old CLI');
});
