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

test('old optional-field-free ledger opens byte-for-byte unchanged and accepts old send fields',async t=>{
 const f=await fixture(t);await f.register('a');await f.register('b');await f.rpc({op:'send',from:'a',to:'b',body:'old CLI',messageId:'old'});
 const file=path.join(f.dataDir,'state.json'),before=await fs.readFile(file,'utf8');await f.restart();assert.equal(await fs.readFile(file,'utf8'),before);
 assert.equal((await f.rpc({op:'inbox',agentId:'b'})).messages[0].body,'old CLI');
});
