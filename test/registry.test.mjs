import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createBroker,validateStore} from '../lib/broker.mjs';
import {createMcpAdapter} from '../lib/mcp.mjs';
import {AgentRelayPlugin} from '../lib/opencode-plugin.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {roomSnapshot} from '../lib/observability.mjs';
import {isLive,isDormant,pendingByAgent,planPrune,PRUNE_CANDIDATE_LIMIT} from '../lib/registry.mjs';

const MIN=60000;
const ago=minutes=>new Date(Date.now()-minutes*MIN).toISOString();
// Real HTTP handler, serial writer and durable ledger without binding TCP. `age` rewrites stored agents between restarts.
async function fixture(t,brokerOptions={pruneAfterMinutes:0}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-registry-'));
 const dataDir=path.join(root,'data'),project=path.join(root,'project');
 await Promise.all([dataDir,project].map(p=>fs.mkdir(p)));
 let handler,broker,options=brokerOptions;
 const serverFactory=callback=>{handler=callback;const server=new EventEmitter();server.listen=(port,host,ready)=>queueMicrotask(ready);server.address=()=>({port:0});server.close=done=>done?.();return server;};
 const open=()=>createBroker({dataDir,serverFactory,...options});
 broker=await open();
 t.after(async()=>{await broker.close();await fs.rm(root,{recursive:true,force:true});});
 async function request(fields,room=project){
  let status,result;const response=new EventEmitter();response.writeHead=code=>{status=code;};response.end=body=>{result=JSON.parse(body);};
  const incoming={method:'POST',url:'/rpc',headers:{authorization:'Bearer '+broker.token},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({project:room,...fields}));}};
  await handler(incoming,response);return {status,...result};
 }
 const rpc=async(fields,room)=>{const result=await request(fields,room);assert.equal(result.ok,true,JSON.stringify(result));return result;};
 const stateFile=path.join(dataDir,'state.json');
 return {root,dataDir,project,stateFile,request,rpc,
  register:(agentId,extra={})=>rpc({op:'register',agentId,runner:'test',...extra}),
  readState:async()=>JSON.parse(await fs.readFile(stateFile,'utf8')),
  // Close, edit the persisted ledger, reopen (optionally with new broker options).
  async restart(mutate,nextOptions){
   await broker.close();
   if(mutate){const state=JSON.parse(await fs.readFile(stateFile,'utf8'));mutate(state);await fs.writeFile(stateFile,JSON.stringify(state));}
   if(nextOptions)options=nextOptions;
   broker=await open();
  }};
}
const agentRow=(state,id)=>state.rooms[0].agents.find(a=>a.agentId===id);
function setAge(id,minutes,patch={}){return state=>{const a=agentRow(state,id);a.updatedAt=ago(minutes);Object.assign(a,patch);};}
function age(...changes){return state=>changes.forEach(change=>change(state));}

test('liveness: not left and (connected transport or seen within the window)',()=>{
 const now=Date.now();const fresh={agentId:'a',updatedAt:new Date(now-5*MIN).toISOString()};
 assert.equal(isLive(fresh,{now,withinMinutes:10}),true);
 assert.equal(isLive(fresh,{now,withinMinutes:1}),false);
 const connectedOld={agentId:'b',updatedAt:new Date(now-9999*MIN).toISOString(),transport:{adapter:'x',state:'connected',ts:new Date(now).toISOString()}};
 assert.equal(isLive(connectedOld,{now,withinMinutes:1}),true);
 assert.equal(isLive({...connectedOld,left:true},{now}),false);
 assert.equal(isLive({...connectedOld,transport:{...connectedOld.transport,state:'disconnected'}},{now,withinMinutes:1}),false);
 assert.equal(isDormant({left:true}),true);assert.equal(isDormant({left:true,retired:true}),false);assert.equal(isDormant({}),false);
});

test("broadcast '*' reaches live agents only, keeps connected-but-old agents, reports excluded; '*all' keeps old semantics",async t=>{
 const f=await fixture(t);
 for(const id of ['sender','fresh','old','connected-old','left'])await f.register(id);
 await f.rpc({op:'leave',agentId:'left'});
 await f.restart(age(setAge('old',600),setAge('connected-old',600,{transport:{adapter:'mcp-watch',state:'connected',ts:ago(600)}}),setAge('sender',1),setAge('fresh',2)));
 const live=await f.rpc({op:'send',from:'sender',to:'*',body:'hi',messageId:'b1'});
 assert.deepEqual(live.recipients.sort(),['connected-old','fresh']);
 assert.deepEqual(live.audience,{mode:'live',within:120,excluded:1});
 assert.equal((await f.readState()).rooms[0].messages[0].to,'*');
 const wide=await f.rpc({op:'send',from:'sender',to:'*',body:'hi',messageId:'b2',within:1000});
 assert.deepEqual(wide.recipients.sort(),['connected-old','fresh','old']);assert.equal(wide.audience.excluded,0);assert.equal(wide.audience.within,1000);
 const narrow=await f.rpc({op:'send',from:'sender',to:'*',body:'hi',messageId:'b3',within:0});
 assert.deepEqual(narrow.recipients,['connected-old']);assert.equal(narrow.audience.excluded,2);
 const all=await f.rpc({op:'send',from:'sender',to:'*all',body:'hi',messageId:'b4'});
 assert.deepEqual(all.recipients.sort(),['connected-old','fresh','old']);
 assert.deepEqual(all.audience,{mode:'all',within:null,excluded:0});
 assert.equal((await f.readState()).rooms[0].messages.at(-1).to,'*all');
 const history=await f.rpc({op:'history',to:'old'});assert.deepEqual(history.messages.map(m=>m.messageId),['b2','b4']);
 // Idempotent retry of a broadcast returns the stored audience.
 const again=await f.rpc({op:'send',from:'sender',to:'*',body:'hi',messageId:'b1'});assert.equal(again.duplicate,true);assert.deepEqual(again.recipients.sort(),['connected-old','fresh']);
 assert.equal((await f.request({op:'send',from:'sender',to:'*',body:'hi',messageId:'x',within:-1})).ok,false);
 assert.equal((await f.request({op:'send',from:'sender',to:'*',body:'hi',messageId:'x',within:'soon'})).ok,false);
 // Restarted ledger still validates with '*' and '*all' messages.
 await f.restart();assert.equal((await f.rpc({op:'inbox',agentId:'old'})).messages.length,2);
});

test('NO_RECIPIENTS reports the excluded count so the sender can retry with *all',async t=>{
 const f=await fixture(t);
 for(const id of ['sender','x','y'])await f.register(id);
 await f.restart(age(setAge('x',600),setAge('y',600)));
 const failure=await f.request({op:'send',from:'sender',to:'*',body:'anyone?',messageId:'none'});
 assert.equal(failure.ok,false);assert.equal(failure.error.code,'NO_RECIPIENTS');assert.equal(failure.error.excluded,2);assert.equal(failure.error.within,120);assert.match(failure.error.message,/\*all/);
 assert.equal((await f.rpc({op:'send',from:'sender',to:'*all',body:'anyone?',messageId:'none'})).recipients.length,2);
 const lone=await fixture(t);await lone.register('solo');
 assert.equal((await lone.request({op:'send',from:'solo',to:'*all',body:'x'})).error.code,'NO_RECIPIENTS');
});

test('direct sends reach dormant recipients, fail for retired ones, and re-registering reactivates',async t=>{
 const f=await fixture(t);
 for(const id of ['a','b','gone'])await f.register(id);
 await f.rpc({op:'leave',agentId:'b'});
 const sent=await f.rpc({op:'send',from:'a',to:'b',body:'for later',messageId:'dm'});
 assert.deepEqual(sent.recipients,['b']);assert.equal(sent.recipientDormant,true);assert.deepEqual(sent.audience,{mode:'direct',within:null,excluded:0});
 assert.equal((await f.rpc({op:'send',from:'a',to:'gone',body:'live one',messageId:'dm2'})).recipientDormant,undefined);
 await f.rpc({op:'retire',agentId:'gone'});
 const retired=await f.request({op:'send',from:'a',to:'gone',body:'nope',messageId:'dm3'});assert.equal(retired.ok,false);assert.equal(retired.error.code,'UNKNOWN_AGENT');
 assert.equal((await f.request({op:'send',from:'a',to:'nobody',body:'nope',messageId:'dm4'})).ok,false);
 await f.restart();
 await f.register('b');
 assert.deepEqual((await f.rpc({op:'inbox',agentId:'b'})).messages.map(m=>m.messageId),['dm']);
 assert.equal(agentRow(await f.readState(),'b').left,undefined);
 // Broadcast never reaches dormant or retired identities, even with *all.
 await f.rpc({op:'leave',agentId:'b'});
 assert.equal((await f.request({op:'send',from:'a',to:'*all',body:'x',messageId:'bc'})).error.code,'NO_RECIPIENTS');
});

test('reserved broadcast names cannot be registered; ephemeral flag is stored and validated',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request({op:'register',agentId:'*',runner:'t'})).ok,false);
 assert.equal((await f.request({op:'register',agentId:'*all',runner:'t'})).ok,false);
 assert.equal((await f.request({op:'register',agentId:'e',runner:'t',ephemeral:'yes'})).ok,false);
 const row=(await f.register('e',{ephemeral:true})).agent;assert.equal(row.ephemeral,true);
 await f.register('plain');assert.equal(agentRow(await f.readState(),'plain').ephemeral,undefined);
 await f.restart();assert.equal(agentRow(await f.readState(),'e').ephemeral,true);
});

test('prune: dry run by default, apply marks dormant, obligations and connected transports protect',async t=>{
 const f=await fixture(t);
 for(const id of ['idle','recent','claimer','machine','handoff-from','handoff-to','proc','tasker','connected','retired','requester'])await f.register(id);
 await f.rpc({op:'claim',agentId:'claimer',resources:['build']});
 await f.rpc({op:'claim',agentId:'machine',scope:'machine',resources:['native']});
 await f.rpc({op:'claim',agentId:'handoff-from',resources:['install']});
 await f.rpc({op:'requestHandoff',agentId:'handoff-from',to:'handoff-to',resources:['install'],reason:'take it'});
 await f.rpc({op:'processes',action:'register',agentId:'proc',pid:process.pid,command:'x'});
 await f.rpc({op:'tasks',action:'upsert',agentId:'tasker',title:'work',owner:'tasker',id:'t1'});
 await f.rpc({op:'tasks',action:'upsert',agentId:'requester',title:'done',owner:'requester',id:'t2'});
 await f.rpc({op:'tasks',action:'complete',agentId:'requester',id:'t2'});
 await f.rpc({op:'retire',agentId:'retired'});
 const stale=['idle','claimer','machine','handoff-from','handoff-to','proc','tasker','connected','requester'];
 await f.restart(age(...stale.map(id=>setAge(id,2000)),setAge('connected',2000,{transport:{adapter:'mcp-watch',state:'connected',ts:ago(2000)}}),setAge('recent',5)));
 const dry=await f.rpc({op:'prune'});
 assert.equal(dry.dryRun,true);assert.equal(dry.pruned,0);
 assert.deepEqual(dry.candidates.map(c=>c.agentId).sort(),['idle','requester']);
 assert.deepEqual(Object.keys(dry.candidates[0]).sort(),['agentId','ephemeral','lastSeenAt','runner']);
 assert.deepEqual(dry.kept,{withObligations:6,live:2});assert.equal(dry.total,2);
 assert.equal(agentRow(await f.readState(),'idle').left,undefined);
 const applied=await f.rpc({op:'prune',dryRun:false});
 assert.equal(applied.dryRun,false);assert.equal(applied.pruned,2);
 const state=await f.readState();
 for(const id of ['idle','requester']){const a=agentRow(state,id);assert.equal(a.left,true);assert.equal(a.retired,undefined);}
 for(const id of ['claimer','machine','handoff-from','handoff-to','proc','tasker','connected','recent'])assert.equal(agentRow(state,id).left,undefined,id);
 assert.equal(agentRow(state,'retired').retired,true);
 // A pruned identity is dormant: it can be written to and reactivates by registering.
 assert.equal((await f.rpc({op:'send',from:'recent',to:'idle',body:'still durable'})).recipientDormant,true);
 await f.register('idle');assert.equal(agentRow(await f.readState(),'idle').left,undefined);
 assert.equal((await f.rpc({op:'prune',dryRun:false})).pruned,0);
 assert.equal((await f.request({op:'prune',idleMinutes:-1})).ok,false);
 assert.equal((await f.request({op:'prune',dryRun:'no'})).ok,false);
});

test('prune: ephemeral agents use the shorter threshold, test agents need includeTest, idleMinutes is honored',async t=>{
 const f=await fixture(t);
 await f.register('eph',{ephemeral:true});await f.register('norm');await f.register('tester',{test:true});await f.register('mid');
 await f.restart(age(setAge('eph',30),setAge('norm',30),setAge('tester',3000),setAge('mid',500)));
 const first=await f.rpc({op:'prune'});
 assert.deepEqual(first.candidates.map(c=>c.agentId),['eph']);assert.equal(first.candidates[0].ephemeral,true);assert.equal(first.skippedTest,1);
 const custom=await f.rpc({op:'prune',idleMinutes:20,ephemeralIdleMinutes:0});
 assert.deepEqual(custom.candidates.map(c=>c.agentId).sort(),['eph','mid','norm']);
 const withTests=await f.rpc({op:'prune',idleMinutes:1440,includeTest:true});
 assert.deepEqual(withTests.candidates.map(c=>c.agentId).sort(),['eph','tester']);
 assert.equal(withTests.kept.live,2);
});

test('prune response bounds its candidate list but reports totals',async t=>{
 const f=await fixture(t);
 const total=PRUNE_CANDIDATE_LIMIT+25;
 await f.register('seed');
 await f.restart(state=>{
  const room=state.rooms[0],template=room.agents[0];
  for(let i=0;i<total;i++)room.agents.push({...template,agentId:`bulk-${i}`,updatedAt:ago(5000),registeredAt:ago(5000)});
  room.agents[0].updatedAt=ago(0);
 });
 const dry=await f.rpc({op:'prune'});
 assert.equal(dry.candidates.length,PRUNE_CANDIDATE_LIMIT);assert.equal(dry.total,total);
 const applied=await f.rpc({op:'prune',dryRun:false});assert.equal(applied.pruned,total);assert.equal(applied.candidates.length,PRUNE_CANDIDATE_LIMIT);
});

test('leave with ifIdle keeps agents that hold obligations',async t=>{
 const f=await fixture(t);
 for(const id of ['idle','busy','owner'])await f.register(id);
 await f.rpc({op:'claim',agentId:'busy',resources:['build']});
 await f.rpc({op:'tasks',action:'upsert',agentId:'owner',title:'x',owner:'owner'});
 const kept=await f.rpc({op:'leave',agentId:'busy',ifIdle:true});
 assert.equal(kept.left,false);assert.deepEqual(kept.obligations.claims.length,1);
 assert.equal((await f.rpc({op:'leave',agentId:'owner',ifIdle:true})).left,false);
 assert.deepEqual(await f.rpc({op:'leave',agentId:'idle',ifIdle:true}).then(r=>({left:r.left})),{left:'idle'});
 assert.equal((await f.request({op:'leave',agentId:'busy',ifIdle:'yes'})).ok,false);
 const state=await f.readState();assert.equal(agentRow(state,'busy').left,undefined);assert.equal(agentRow(state,'idle').left,true);
 // Plain leave still leaves unconditionally.
 assert.equal((await f.rpc({op:'leave',agentId:'busy'})).left,'busy');
});

test('registry counts and snapshot rows: live flag, counts, single-pass pendingByAgent',async t=>{
 const f=await fixture(t);
 for(const id of ['a','b','c','d','e'])await f.register(id,id==='e'?{ephemeral:true}:{});
 await f.rpc({op:'retire',agentId:'d'});await f.rpc({op:'leave',agentId:'c'});
 await f.rpc({op:'send',from:'a',to:'*all',body:'1',messageId:'m1'});
 await f.rpc({op:'send',from:'a',to:'c',body:'2',messageId:'m2'});
 await f.rpc({op:'send',from:'b',to:'a',body:'3',messageId:'m3'});
 await f.rpc({op:'ack',agentId:'b',messageId:'m1'});
 await f.restart(setAge('e',60));
 const view=await f.rpc({op:'agents'});
 assert.deepEqual({live:view.counts.live,dormant:view.counts.dormant,retired:view.counts.retired,ephemeral:view.counts.ephemeral,prunable:view.counts.prunable,stored:view.counts.stored},
  {live:3,dormant:1,retired:1,ephemeral:1,prunable:1,stored:5});
 const snapshot=await f.rpc({op:'snapshot'});
 assert.deepEqual(snapshot.registry,{stored:5,live:3,dormant:1,retired:1,ephemeral:1,prunable:1});
 assert.ok(snapshot.agents.length>0&&snapshot.agents.every(row=>typeof row.live==='boolean'));
 assert.equal(snapshot.agents.find(row=>row.agentId==='a').live,true);
 // Equivalence with the original per-agent scan over every message.
 const room=(await f.readState()).rooms[0];
 const naive=Object.fromEntries(room.agents.map(a=>[a.agentId,room.messages.filter(m=>m.recipients.includes(a.agentId)&&!m.ackedBy.includes(a.agentId)).length]));
 assert.deepEqual(pendingByAgent(room),naive);assert.deepEqual(snapshot.pendingByAgent,naive);
 assert.deepEqual(Object.keys(pendingByAgent(room)),Object.keys(naive));
 assert.deepEqual(roomSnapshot(room.project,room,100,{rooms:[room]}).pendingByAgent,naive);
 assert.equal(roomSnapshot('/nowhere',undefined).registry.stored,0);
});

test('validateStore accepts old state without new fields and new state with them, rejects malformed ones',async t=>{
 const f=await fixture(t);
 await f.register('a');await f.register('b');await f.rpc({op:'send',from:'a',to:'b',body:'old',messageId:'old'});
 const old=await f.readState();validateStore(structuredClone(old));
 const next=structuredClone(old);
 next.rooms[0].agents[0].ephemeral=true;
 next.rooms[0].messages.push({...old.rooms[0].messages[0],messageId:'wide',to:'*all',cursor:2,recipients:['b'],ackedBy:[],notified:[]});
 next.rooms[0].messages.push({...old.rooms[0].messages[0],messageId:'live',to:'*',cursor:3,recipients:['b'],ackedBy:[],notified:[]});
 next.rooms[0].cursor=3;next.nextCursor=4;
 validateStore(structuredClone(next));
 const badEphemeral=structuredClone(next);badEphemeral.rooms[0].agents[0].ephemeral='yes';assert.throws(()=>validateStore(badEphemeral));
 const selfBroadcast=structuredClone(next);selfBroadcast.rooms[0].messages[1].recipients=['a'];assert.throws(()=>validateStore(selfBroadcast));
 const badTo=structuredClone(next);badTo.rooms[0].messages[1].to='*everyone';assert.throws(()=>validateStore(badTo));
 await f.restart(state=>Object.assign(state,next));assert.equal((await f.rpc({op:'inbox',agentId:'b'})).messages.length,3);
});

test('startup sweep prunes stale agents through the writer; fresh ledgers are untouched byte for byte',async t=>{
 const f=await fixture(t);
 await f.register('stale');await f.register('fresh');await f.register('holder');await f.rpc({op:'claim',agentId:'holder',resources:['build']});
 await f.restart(age(setAge('stale',2000),setAge('holder',2000)),{pruneAfterMinutes:60});
 const state=await f.readState();
 assert.equal(agentRow(state,'stale').left,true);assert.equal(agentRow(state,'fresh').left,undefined);assert.equal(agentRow(state,'holder').left,undefined);
 // A second startup with nothing to prune must not rewrite the ledger.
 const before=await fs.readFile(f.stateFile,'utf8');
 await f.restart();assert.equal(await fs.readFile(f.stateFile,'utf8'),before);
 // pruneAfterMinutes 0 disables the sweep entirely.
 await f.restart(setAge('fresh',9000),{pruneAfterMinutes:0});assert.equal(agentRow(await f.readState(),'fresh').left,undefined);
 await assert.rejects(createBroker({dataDir:f.dataDir,pruneAfterMinutes:-1}),/Invalid prune/);
});

test('sweep runs on an unref\'d interval and close() clears the timer',async t=>{
 const created=[],cleared=[];
 const realSet=globalThis.setInterval,realClear=globalThis.clearInterval;
 let unrefCalled=false;
 globalThis.setInterval=(fn,ms,...rest)=>{const timer=realSet(fn,ms,...rest);const unref=timer.unref.bind(timer);timer.unref=()=>{unrefCalled=true;return unref();};created.push({timer,ms});return timer;};
 globalThis.clearInterval=timer=>{cleared.push(timer);return realClear(timer);};
 t.after(()=>{globalThis.setInterval=realSet;globalThis.clearInterval=realClear;});
 const f=await fixture(t,{pruneAfterMinutes:60,ephemeralPruneMinutes:0.0005,pruneIntervalMs:20});
 const mine=created.filter(row=>row.ms===20);assert.equal(mine.length,1);assert.equal(unrefCalled,true);
 await f.register('worker',{ephemeral:true});await f.register('other');
 const deadline=Date.now()+3000;
 while(Date.now()<deadline&&agentRow(await f.readState(),'worker').left!==true)await new Promise(r=>setTimeout(r,25));
 const state=await f.readState();
 assert.equal(agentRow(state,'worker').left,true,'ephemeral agent swept by the timer');assert.equal(agentRow(state,'other').left,undefined);
 await f.restart(undefined,{pruneAfterMinutes:60,ephemeralPruneMinutes:0.0005,pruneIntervalMs:20});
 assert.ok(cleared.includes(mine[0].timer),'close() cleared the interval');
 // No sweeps after close: the retired timer never fires again.
 const sweepsAfter=created.filter(row=>row.ms===20);assert.equal(sweepsAfter.length,2);
 const disabled=await fixture(t,{pruneAfterMinutes:0,compactAfterDays:0,pruneIntervalMs:20});
 assert.equal(created.filter(row=>row.ms===20).length,2,'disabled maintenance (no prune, no compaction) creates no timer');
 await disabled.restart();
});

// --- MCP adapter ---------------------------------------------------------------------------
const envKeys=['AGENT_RELAY_AGENT_ID','AGENT_RELAY_EPHEMERAL','AGENT_RELAY_TEST_ROOM','AGENT_RELAY_DATA_DIR','CODEX_THREAD_ID','CLAUDE_SESSION_ID'];
function isolateEnv(t,env={}){
 const prior=new Map(envKeys.map(key=>[key,process.env[key]]));
 for(const key of envKeys)delete process.env[key];
 Object.assign(process.env,env);
 t.after(()=>{for(const [key,value] of prior){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
}
async function stubAdapter(t,{env,options={},rpcFor=()=>undefined}={}){
 isolateEnv(t,env);
 const calls=[];
 const rpcImpl=async(project,fields)=>{calls.push(fields);const custom=rpcFor(fields);if(custom instanceof Error)throw custom;return custom??{ok:true,...fields};};
 const waitImpl=async(project,agentId,after,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
 const [serverTransport,clientTransport]=InMemoryTransport.createLinkedPair();
 const adapter=await createMcpAdapter({project:'/fixture/project',runner:'codex',rpcImpl,waitImpl,onError(){},onWarning(){},...options});
 const client=new Client({name:'c',version:'1'});
 await adapter.start(serverTransport);await client.connect(clientTransport);
 t.after(async()=>{await adapter.close();await client.close();});
 return {adapter,client,calls};
}

test('AGENT_RELAY_AGENT_ID sets a stable worker name while the session is still recorded',async t=>{
 const f=await stubAdapter(t,{env:{AGENT_RELAY_AGENT_ID:'codex-worker-3',CODEX_THREAD_ID:'thread-9'}});
 assert.equal(f.adapter.agentId,'codex-worker-3');assert.equal(f.adapter.sessionId,'thread-9');
 assert.deepEqual(f.calls.find(c=>c.op==='register'),{op:'register',agentId:'codex-worker-3',runner:'codex',sessionId:'thread-9'});
 const explicit=await stubAdapter(t,{env:{AGENT_RELAY_AGENT_ID:'ignored',CODEX_THREAD_ID:'thread-9'},options:{agentId:'explicit'}});
 assert.equal(explicit.adapter.agentId,'explicit');
 const derived=await stubAdapter(t,{env:{CODEX_THREAD_ID:'thread-9'}});
 assert.equal(derived.adapter.agentId,'codex-thread-9');assert.equal(derived.adapter.ephemeral,false);
 assert.equal(derived.calls.find(c=>c.op==='register').ephemeral,undefined);
});

test('ephemeral adapters register the flag and leave idle on close; tmp- fallback and env imply ephemeral',async t=>{
 const byEnv=await stubAdapter(t,{env:{AGENT_RELAY_EPHEMERAL:'1',CODEX_THREAD_ID:'thread-e'}});
 assert.equal(byEnv.adapter.ephemeral,true);assert.equal(byEnv.calls.find(c=>c.op==='register').ephemeral,true);
 await byEnv.adapter.close();
 const leave=byEnv.calls.filter(c=>c.op==='leave');assert.deepEqual(leave,[{op:'leave',agentId:'codex-thread-e',ifIdle:true}]);
 assert.equal(byEnv.calls.some(c=>c.op==='status'&&c.transport?.state==='disconnected'),false,'left agents need no disconnect report');
 const fallback=await stubAdapter(t,{});
 assert.equal(fallback.adapter.ephemeral,true);assert.match(fallback.adapter.sessionId,/^tmp-/);
 const flagged=await stubAdapter(t,{env:{CODEX_THREAD_ID:'thread-f'},options:{ephemeral:true}});
 assert.equal(flagged.adapter.ephemeral,true);
 const optedOut=await stubAdapter(t,{env:{AGENT_RELAY_EPHEMERAL:'1',CODEX_THREAD_ID:'thread-g'},options:{ephemeral:false}});
 assert.equal(optedOut.adapter.ephemeral,false);await optedOut.adapter.close();assert.equal(optedOut.calls.some(c=>c.op==='leave'),false);
});

test('ephemeral adapters degrade gracefully on old brokers and when the agent is busy',async t=>{
 const unsupported=Object.assign(new Error('This broker does not advertise ephemeral'),{code:'UNSUPPORTED_FEATURE'});
 const old=await stubAdapter(t,{env:{AGENT_RELAY_EPHEMERAL:'1',CODEX_THREAD_ID:'old-broker'},
  rpcFor:fields=>(fields.op==='register'&&fields.ephemeral!==undefined)||fields.op==='leave'?unsupported:undefined});
 assert.deepEqual(old.calls.filter(c=>c.op==='register').map(c=>c.ephemeral),[true,undefined],'retries registration without the flag');
 await old.adapter.close();
 const busy=await stubAdapter(t,{env:{AGENT_RELAY_EPHEMERAL:'1',CODEX_THREAD_ID:'busy'},options:{channel:true},
  rpcFor:fields=>fields.op==='leave'?{ok:true,left:false,kept:true}:undefined});
 await new Promise(r=>setTimeout(r,50));
 await busy.adapter.close();
 assert.ok(busy.calls.some(c=>c.op==='leave'&&c.ifIdle===true));
 assert.ok(busy.calls.some(c=>c.op==='status'&&c.transport?.state==='disconnected'),'busy ephemeral agents still report disconnect');
});

test('ephemeral adapter against a real broker leaves when idle and stays when it holds a claim',async t=>{
 isolateEnv(t);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-registry-mcp-'));
 const dataDir=path.join(root,'data'),project=path.join(root,'project');await fs.mkdir(dataDir);await fs.mkdir(project);
 const broker=await createBroker({dataDir,pruneAfterMinutes:0});
 t.after(async()=>{await broker.close();await fs.rm(root,{recursive:true,force:true});});
 const rpcImpl=async(room,fields,{signal}={})=>{
  const response=await fetch(broker.url+'/rpc',{method:'POST',headers:{authorization:'Bearer '+broker.token,'content-type':'application/json'},body:JSON.stringify({project:room,...fields}),signal});
  const body=await response.json();if(!body.ok){const e=new Error(body.error?.message);e.code=body.error?.code;throw e;}return body;
 };
 const waitImpl=async(room,agentId,after,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
 const start=async(sessionId,claim)=>{
  const adapter=await createMcpAdapter({project,runner:'codex',sessionId,ephemeral:true,rpcImpl,waitImpl,onError(){},onWarning(){}});
  const [s,c]=InMemoryTransport.createLinkedPair();const client=new Client({name:'c',version:'1'});
  await adapter.start(s);await client.connect(c);
  if(claim)await rpcImpl(project,{op:'claim',agentId:adapter.agentId,resources:['build']});
  return {adapter,client};
 };
 const idle=await start('idle'),holder=await start('holder',true);
 const listed=async()=>(await rpcImpl(project,{op:'agents',limit:50})).agents;
 assert.equal((await listed()).length,2);
 await idle.client.close();await new Promise(r=>setTimeout(r,200));
 await holder.client.close();await new Promise(r=>setTimeout(r,200));
 const remaining=await listed();
 assert.deepEqual(remaining.map(a=>a.agentId),['codex-holder']);
 assert.equal(remaining[0].ephemeral,true);
 const peer=await rpcImpl(project,{op:'register',agentId:'peer',runner:'x'});assert.ok(peer.ok);
 assert.equal((await rpcImpl(project,{op:'send',from:'peer',to:'codex-idle',body:'wake later',messageId:'late'})).recipientDormant,true);
});

test('MCP tools relay_send(within, *all) and relay_prune (dry run unless apply) forward exact broker fields',async t=>{
 const f=await stubAdapter(t,{env:{CODEX_THREAD_ID:'tools'}});
 const unpack=r=>JSON.parse(r.content[0].text);
 const names=(await f.client.listTools()).tools.map(tool=>tool.name);assert.ok(names.includes('relay_prune'));
 const send=(await f.client.listTools()).tools.find(tool=>tool.name==='relay_send');assert.match(send.description,/\*all/);assert.ok(send.inputSchema.properties.within);
 await f.client.callTool({name:'relay_send',arguments:{to:'*all',body:'x',within:30}});
 assert.deepEqual(f.calls.findLast(c=>c.op==='send'),{op:'send',from:'codex-tools',to:'*all',body:'x',within:30});
 await f.client.callTool({name:'relay_prune',arguments:{}});
 assert.deepEqual(f.calls.findLast(c=>c.op==='prune'),{op:'prune',dryRun:true});
 await f.client.callTool({name:'relay_prune',arguments:{apply:true,idleMinutes:60,ephemeralIdleMinutes:5,includeTest:true}});
 assert.deepEqual(f.calls.findLast(c=>c.op==='prune'),{op:'prune',idleMinutes:60,ephemeralIdleMinutes:5,dryRun:false,includeTest:true});
 const bad=await f.client.callTool({name:'relay_prune',arguments:{apply:'yes'}});assert.equal(bad.isError,true);
 assert.equal(unpack(await f.client.callTool({name:'relay_send',arguments:{to:'x',body:'y',within:-1}})).ok,false);
});

test('OpenCode tools relay_send(within) and relay_prune mirror the MCP surface',async t=>{
 const calls=[];
 const transport={async rpc(project,fields){calls.push(fields);return {ok:true,...fields};},wait(project,agentId,after,{signal}){return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}};
 const directory='/tmp/relay-registry-project',sessionID='ses_registry';
 const hooks=await AgentRelayPlugin({client:{tui:{async showToast(){return {data:true};}},session:{async status(){return {data:{}};}}},directory,worktree:directory},{transport,dataDir:'/tmp/relay-registry-isolated'});
 t.after(()=>hooks.dispose());
 const ctx={sessionID,directory,worktree:directory,agent:'build',abort:new AbortController().signal};
 await hooks.tool.relay_send.execute({to:'*all',body:'hello',within:15},ctx);
 const send=calls.findLast(c=>c.op==='send');assert.equal(send.to,'*all');assert.equal(send.within,15);
 await hooks.tool.relay_prune.execute({},ctx);
 assert.deepEqual(calls.findLast(c=>c.op==='prune'),{op:'prune',dryRun:true,agentId:'opencode:'+sessionID});
 await hooks.tool.relay_prune.execute({apply:true,idleMinutes:90},ctx);
 const applied=calls.findLast(c=>c.op==='prune');assert.equal(applied.dryRun,false);assert.equal(applied.idleMinutes,90);
});

test('real CLI: prune is a dry run unless --apply; send accepts *all and --within; join --ephemeral',async t=>{
 const exec=promisify(execFile),cli=fileURLToPath(new URL('../bin/agent-relay.mjs',import.meta.url));
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-registry-cli-')),project=path.join(root,'project'),dataDir=path.join(root,'data');await fs.mkdir(project);
 t.after(async()=>{try{const {pid}=JSON.parse(await fs.readFile(path.join(dataDir,'broker.json'),'utf8'));process.kill(pid,'SIGTERM');for(let i=0;i<50;i++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,20));}catch{break;}}}catch{}await fs.rm(root,{recursive:true,force:true});});
 const run=async(...args)=>JSON.parse((await exec(process.execPath,[cli,...args,'--project',project,'--data-dir',dataDir],{timeout:20000,env:{...process.env,AGENT_RELAY_PRUNE_AFTER_MINUTES:'0'}})).stdout);
 await run('join','--as','a','--runner','codex');
 const eph=await run('join','--as','b','--runner','codex','--ephemeral');assert.equal(eph.agent.ephemeral,true);
 const sent=await run('send','--as','a','--to','*all','--within','5','--message','everyone','--id','cli-all');
 assert.deepEqual(sent.recipients,['b']);assert.equal(sent.audience.mode,'all');
 const live=await run('send','--as','a','--to','*','--within','5','--message','live ones','--id','cli-live');
 assert.equal(live.audience.mode,'live');assert.equal(live.audience.within,5);
 const dry=await run('prune','--idle-minutes','0','--ephemeral-idle-minutes','0');
 assert.equal(dry.dryRun,true);assert.deepEqual(dry.candidates.map(c=>c.agentId).sort(),['a','b']);assert.equal(dry.pruned,0);
 assert.equal((await run('agents')).agents.length,2);
 const applied=await run('prune','--idle-minutes','0','--ephemeral-idle-minutes','0','--apply');
 assert.equal(applied.pruned,2);assert.equal((await run('agents')).agents.length,0);
 await run('join','--as','a','--runner','codex');
 assert.equal((await run('send','--as','a','--to','b','--message','dormant ok','--id','cli-dormant')).recipientDormant,true);
});

test('real CLI mcp: AGENT_RELAY_AGENT_ID names the worker, --ephemeral leaves on stdin end, pooled names are reused',async t=>{
 const {spawn}=await import('node:child_process');
 const exec=promisify(execFile),cli=fileURLToPath(new URL('../bin/agent-relay.mjs',import.meta.url));
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-registry-mcpcli-')),project=path.join(root,'project'),dataDir=path.join(root,'data');await fs.mkdir(project);
 t.after(async()=>{try{const {pid}=JSON.parse(await fs.readFile(path.join(dataDir,'broker.json'),'utf8'));process.kill(pid,'SIGTERM');for(let i=0;i<50;i++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,20));}catch{break;}}}catch{}await fs.rm(root,{recursive:true,force:true});});
 const base={...process.env,AGENT_RELAY_PRUNE_AFTER_MINUTES:'0'};
 for(const key of envKeys)delete base[key];
 const run=async(...args)=>JSON.parse((await exec(process.execPath,[cli,...args,'--project',project,'--data-dir',dataDir],{timeout:20000,env:base})).stdout);
 const agents=async()=>(await run('agents')).agents.map(a=>a.agentId);
 async function session(args,env){
  const child=spawn(process.execPath,[cli,'mcp',...args,'--project',project,'--data-dir',dataDir],{env:{...base,...env},stdio:['pipe','pipe','pipe']});
  const exited=new Promise(resolve=>child.on('exit',resolve));
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'t',version:'1'}}})+'\n');
  const deadline=Date.now()+15000;
  return {child,exited,async untilListed(id){while(Date.now()<deadline){if((await agents()).includes(id))return;await new Promise(r=>setTimeout(r,50));}throw new Error('agent never registered');},
   async close(){child.stdin.end();await Promise.race([exited,new Promise(r=>setTimeout(r,8000))]);if(child.exitCode===null)child.kill();}};
 }
 await run('join','--as','seed','--runner','codex');
 const worker=await session(['--runner','codex','--ephemeral'],{AGENT_RELAY_AGENT_ID:'codex-worker-3',CODEX_THREAD_ID:'thread-cli'});
 await worker.untilListed('codex-worker-3');
 const row=(await run('agents')).agents.find(a=>a.agentId==='codex-worker-3');assert.equal(row.sessionId,'thread-cli');assert.equal(row.ephemeral,true);
 await worker.close();
 assert.equal((await agents()).includes('codex-worker-3'),false,'ephemeral worker left when stdin ended');
 const again=await session(['--runner','codex'],{AGENT_RELAY_AGENT_ID:'codex-worker-3',CODEX_THREAD_ID:'thread-cli-2'});
 await again.untilListed('codex-worker-3');
 assert.equal((await run('agents')).agents.find(a=>a.agentId==='codex-worker-3').sessionId,'thread-cli-2','pooled name is reused');
 await again.close();
});
