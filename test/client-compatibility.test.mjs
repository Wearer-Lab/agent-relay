import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {rpc} from '../lib/client.mjs';
test('extended CLI fields never reach a legacy broker that would ignore them',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-capability-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'broker.json'),JSON.stringify({pid:process.pid,url:'http://127.0.0.1:12345',token:'fixture'}));
 const previous=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=previous;});
 globalThis.fetch=async(url,opts)=>{
  if(url.endsWith('/health'))return {ok:true};const input=JSON.parse(opts.body);calls.push(input.op);
  if(input.op==='capabilities')return {ok:false,json:async()=>({ok:false,error:{code:'UNKNOWN_OPERATION'}})};
  return {ok:true,json:async()=>({ok:true})};
 };
 await assert.rejects(rpc('/tmp',{op:'inbox',agentId:'a',since:1},{dataDir:dir}),/restart/);assert.deepEqual(calls,['capabilities']);
 await rpc('/tmp',{op:'claim',agentId:'a',resources:['native']},{dataDir:dir});assert.deepEqual(calls,['capabilities','claim']);
});
