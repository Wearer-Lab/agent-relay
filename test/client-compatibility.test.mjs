import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {rpc} from '../lib/client.mjs';
test('extended CLI fields never reach a legacy broker that would ignore them',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-capability-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:200}));
 await fs.writeFile(path.join(dir,'broker.json'),JSON.stringify({pid:process.pid,url:'http://127.0.0.1:12345',token:'fixture'}));
 const previous=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=previous;});
 globalThis.fetch=async(url,opts)=>{
  if(url.endsWith('/health'))return {ok:true};const input=JSON.parse(opts.body);calls.push(input.op);
  if(input.op==='capabilities')return {ok:false,json:async()=>({ok:false,error:{code:'UNKNOWN_OPERATION'}})};
  return {ok:true,json:async()=>({ok:true})};
 };
 await assert.rejects(rpc('/tmp',{op:'claim',agentId:'a',scope:'machine',resources:['native']},{dataDir:dir}),/restart/);assert.deepEqual(calls,['capabilities']);
 await rpc('/tmp',{op:'claim',agentId:'a',resources:['native']},{dataDir:dir});assert.deepEqual(calls,['capabilities','claim']);
});
test('combined options require every feature before submission',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-capability-matrix-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:200}));
 await fs.writeFile(path.join(dir,'broker.json'),JSON.stringify({pid:process.pid,url:'http://127.0.0.1:12346',token:'fixture'}));
 const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});
 const cases=[
  {fields:{op:'send',from:'a',to:'b',body:'x',attachments:[],summary:'s'},advertised:['attachments'],missing:['summary']},
  {fields:{op:'send',from:'a',to:'b',body:'x',attachments:[],summary:'s'},advertised:['summary'],missing:['attachments']},
  {fields:{op:'send',from:'a',to:'b',body:'x',attachments:[],summary:'s'},advertised:['attachments','summary'],missing:[]},
  {fields:{op:'send',from:'a',to:'b',body:'x',attachments:[]},advertised:['attachments'],missing:[]},
  {fields:{op:'send',from:'a',to:'b',body:'x',summary:'s'},advertised:['summary'],missing:[]},
  {fields:{op:'send',from:'a',to:'b',body:'x',attachments:[],summary:'s'},advertised:[],missing:['attachments','summary']},
  {fields:{op:'claim',agentId:'a',resources:['r'],scope:'machine',meta:{note:'m'}},advertised:['machine-claims'],missing:['claim-provenance']},
  {fields:{op:'claim',agentId:'a',resources:['r'],scope:'machine',meta:{note:'m'}},advertised:['claim-provenance'],missing:['machine-claims']},
  {fields:{op:'claim',agentId:'a',resources:['r'],scope:'machine',meta:{note:'m'}},advertised:['machine-claims','claim-provenance'],missing:[]},
  {fields:{op:'claim',agentId:'a',resources:['r'],scope:'machine'},advertised:['machine-claims'],missing:[]},
  {fields:{op:'claim',agentId:'a',resources:['r'],meta:{note:'m'}},advertised:['claim-provenance'],missing:[]},
  {fields:{op:'release',agentId:'a',resources:['r'],force:true,meta:{note:'m'}},advertised:['machine-claims'],missing:['claim-provenance']},
  {fields:{op:'release',agentId:'a',resources:['r'],force:true,meta:{note:'m'}},advertised:['machine-claims','claim-provenance'],missing:[]},
  {fields:{op:'agents',transport:'connected',active:true},advertised:['readiness'],missing:['presence']},
  {fields:{op:'agents',transport:'connected',active:true},advertised:['presence'],missing:['readiness']},
  {fields:{op:'agents',transport:'connected',active:true},advertised:['readiness','presence'],missing:[]},
  {fields:{op:'inbox',agentId:'a',limit:5},advertised:[],missing:['inbox-filters']},
  {fields:{op:'inbox',agentId:'a',limit:5},advertised:['inbox-filters'],missing:[]},
  {fields:{op:'ack',agentId:'a',through:5},advertised:[],missing:['bulk-ack']},
  {fields:{op:'ack',agentId:'a',through:5},advertised:['bulk-ack'],missing:[]},
  {fields:{op:'inbox',agentId:'a',session:'nonce-1'},advertised:[],missing:['delivery-receipts']},
  {fields:{op:'inbox',agentId:'a',session:'nonce-1'},advertised:['delivery-receipts'],missing:[]},
  {fields:{op:'ack',agentId:'a',messageId:'m',session:'nonce-1'},advertised:[],missing:['delivery-receipts']},
  {fields:{op:'wait',agentId:'a',session:'nonce-1'},advertised:[],missing:['delivery-receipts']},
  {fields:{op:'history',agentId:'a'},advertised:[],missing:['history']},
  {fields:{op:'history',agentId:'a'},advertised:['history'],missing:[]},
  {fields:{op:'tasks',action:'list'},advertised:[],missing:['tasks']},
  {fields:{op:'tasks',action:'list'},advertised:['tasks'],missing:[]},
  {fields:{op:'receipt',messageId:'m'},advertised:[],missing:['receipts']},
  {fields:{op:'receipt',messageId:'m'},advertised:['receipts'],missing:[]},
  {fields:{op:'claimNarrow',agentId:'a',resources:['r']},advertised:[],missing:['claim-narrow']},
  {fields:{op:'claimNarrow',agentId:'a',resources:['r']},advertised:['claim-narrow'],missing:[]},
 ];
 for(const c of cases){
  const calls=[];
  globalThis.fetch=async(url,opts)=>{
   if(url.endsWith('/health'))return {ok:true};
   const input=JSON.parse(opts.body);calls.push(input.op);
   if(input.op==='capabilities')return {ok:true,json:async()=>({ok:true,features:c.advertised})};
   return {ok:true,json:async()=>({ok:true})};
  };
  if(c.missing.length){
   const error=await rpc('/tmp',c.fields,{dataDir:dir}).then(()=>null,error=>error);
   assert.ok(error,JSON.stringify(c));
   assert.equal(error.code,'UNSUPPORTED_FEATURE');
   for(const name of c.missing)assert.ok(error.message.includes(name),error.message);
   assert.deepEqual(calls,['capabilities']);
   assert.match(error.message,/restart/);
   assert.match(error.message,/No operation was submitted/);
  }else{
   await rpc('/tmp',c.fields,{dataDir:dir});
   assert.deepEqual(calls,['capabilities',c.fields.op],JSON.stringify(c));
  }
 }
});
test('legacy broker without capabilities refuses combined send',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-capability-legacy-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:200}));
 await fs.writeFile(path.join(dir,'broker.json'),JSON.stringify({pid:process.pid,url:'http://127.0.0.1:12347',token:'fixture'}));
 const previous=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=previous;});
 globalThis.fetch=async(url,opts)=>{
  if(url.endsWith('/health'))return {ok:true};const input=JSON.parse(opts.body);calls.push(input.op);
  if(input.op==='capabilities')return {ok:false,json:async()=>({ok:false,error:{code:'UNKNOWN_OPERATION'}})};
  return {ok:true,json:async()=>({ok:true})};
 };
 const error=await rpc('/tmp',{op:'send',from:'a',to:'b',body:'x',attachments:[],summary:'s'},{dataDir:dir}).then(()=>null,error=>error);
 assert.ok(error);
 assert.equal(error.code,'UNSUPPORTED_FEATURE');
 assert.match(error.message,/restart/);
 assert.ok(error.message.includes('attachments'));
 assert.ok(error.message.includes('summary'));
 assert.deepEqual(calls,['capabilities']);
});
