// Follow-up review of 9646712. Uses disposable brokers and owned fixtures only.
// Successful exit means the recorded assertions reproduced, not that all
// product behavior is correct. Run: node docs/reviews/2026-10-11-followup-probes.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createBroker,validateStore,noticeAllowance} from '../../lib/broker.mjs';
import {createMcpAdapter} from '../../lib/mcp.mjs';
import {AgentRelayPlugin} from '../../lib/opencode-plugin.mjs';
import {setupProject,diagnoseSetup} from '../../lib/setup.mjs';
import {runCodexBridge} from '../../lib/codex.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
const exec=promisify(execFile),cli=fileURLToPath(new URL('../../bin/agent-relay.mjs',import.meta.url));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-followup-review-'));
const brokers=[],records=[];
const record=(name,outcome,evidence)=>{const row={name,outcome,evidence};records.push(row);console.log(JSON.stringify(row));};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const flush=async()=>{for(let i=0;i<12;i++)await tick();};
const ts='2026-10-11T00:00:00.000Z';
const agent=agentId=>({agentId,runner:'review',registeredAt:ts,updatedAt:ts,status:'idle',frozen:false,resources:[],task:null});
const stateFor=(project,agents,messages=[],extras={})=>({version:1,nextCursor:messages.length+1,rooms:[{project,agents,claims:[],messages,cursor:messages.length,...extras}]});
async function fixture(name,seed){
 const base=path.join(root,name),project=path.join(base,'project'),dataDir=path.join(base,'data');
 await fs.mkdir(project,{recursive:true});await fs.mkdir(dataDir,{recursive:true});
 const real=await fs.realpath(project);
 if(seed)await fs.writeFile(path.join(dataDir,'state.json'),JSON.stringify(seed(real)));
 const broker=await createBroker({dataDir});brokers.push(broker);
 const call=async(fields)=>{const response=await fetch(broker.url+'/rpc',{method:'POST',headers:{authorization:'Bearer '+broker.token,'content-type':'application/json'},body:JSON.stringify({project:real,...fields}),signal:AbortSignal.timeout(5000)});return {httpStatus:response.status,...await response.json()};};
 const ok=async(fields)=>{const result=await call(fields);assert.equal(result.ok,true,JSON.stringify(result));return result;};
 const register=agentId=>ok({op:'register',agentId,runner:'review'});
 const run=async(args)=>{const result=await exec(process.execPath,[cli,...args,'--project',real,'--data-dir',dataDir],{timeout:10000,maxBuffer:4*1024*1024});return JSON.parse(result.stdout);};
 const discovery=()=>fs.writeFile(path.join(dataDir,'broker.json'),JSON.stringify({pid:process.pid,url:broker.url,token:broker.token}));
 return {project:real,dataDir,broker,call,ok,register,run,discovery};
}
async function mcp(f,session,opts={}){
 const [a,b]=InMemoryTransport.createLinkedPair();
 const adapter=await createMcpAdapter({project:f.project,runner:'generic',sessionId:session,rpcImpl:(_p,fields)=>f.ok(fields),waitImpl:()=>{throw Error('watch unexpected');},...opts});
 const client=new Client({name:'followup-review',version:'1'});
 await adapter.start(a);await client.connect(b);
 const tool=async(name,args={})=>JSON.parse((await client.callTool({name,arguments:args})).content[0].text);
 return {adapter,client,tool,close:async()=>{await adapter.close();await client.close();}};
}
try{
 const f=await fixture('coordination');await f.register('a');await f.register('b');
 await f.ok({op:'claim',agentId:'a',scope:'machine',resources:['build']});
 await f.ok({op:'tasks',action:'upsert',agentId:'b',id:'machine',title:'machine task',blockedBy:['build']});
 assert.equal((await f.ok({op:'tasks',action:'list',blocked:true})).tasks.length,1);
 await f.ok({op:'claim',agentId:'a',resources:['src']});
 assert.equal((await f.ok({op:'tasks',action:'upsert',agentId:'b',title:'child',blockedBy:['src/file']})).task.blocked,true);
 record('machine-and-parent-blockers','resolved',{machineListed:true,parentBlocked:true});
 await fs.mkdir(path.join(f.project,'target'));await fs.symlink(path.join(f.project,'target'),path.join(f.project,'alias'),'dir');
 await f.ok({op:'claim',agentId:'a',resources:['alias/file']});
 const aliasTask=await f.ok({op:'tasks',action:'upsert',agentId:'b',title:'alias',blockedBy:['alias/file']});
 const aliasClaim=await f.call({op:'claim',agentId:'b',resources:['alias/file']});
 assert.equal(aliasTask.task.blocked,false);assert.equal(aliasClaim.error.code,'CLAIM_CONFLICT');
 record('symlink-task-blocker','open',{taskBlocked:aliasTask.task.blocked,claimError:aliasClaim.error.code});
 await f.ok({op:'claim',agentId:'a',resources:['handoff-file']});
 const handoff=await f.ok({op:'requestHandoff',agentId:'a',to:'b',resources:['handoff-file'],reason:'offer'});
 await f.ok({op:'release',agentId:'a',resources:['handoff-file']});await f.ok({op:'claim',agentId:'b',resources:['handoff-file']});
 const stale=await f.call({op:'respondHandoff',agentId:'b',id:handoff.handoff.id,accept:true});assert.equal(stale.error.code,'HANDOFF_STALE');
 const legacy=(await f.ok({op:'export'})).state;
 const old=legacy.rooms[0].handoffs[0];delete old.offeredBy;delete old.offeredTo;delete old.generations;
 await f.ok({op:'restore',state:legacy});
 const accepted=await f.ok({op:'respondHandoff',agentId:'b',id:old.id,accept:true});assert.equal(accepted.transferred[0].agentId,'a');
 record('legacy-handoff-reversal','open',{freshOfferError:stale.error.code,legacyOfferResultOwner:accepted.transferred[0].agentId});
 const first=await f.ok({op:'setBulletin',agentId:'a',title:'v1',body:'old',source:'POLICY.md'});
 await f.ok({op:'setBulletin',agentId:'a',title:'v2',body:'new',source:'POLICY.md'});
 const ack=await f.ok({op:'ackBulletin',agentId:'b',version:first.version,hash:first.hash});assert.equal(ack.version,1);assert.equal(ack.stale,true);
 const missingVersion=await f.call({op:'ackBulletin',agentId:'a'});assert.equal(missingVersion.error.code,'INVALID_INPUT');
 const retired=await f.call({op:'retire',agentId:'a'});assert.equal(retired.error.code,'RETIRE_BLOCKED');
 record('bulletin-binding-and-retire-preflight','resolved',{ackedVersion:ack.version,current:ack.current,retireError:retired.error.code});

 const waiter=await fixture('waiter');await waiter.register('waiting');
 const poll=waiter.call({op:'wait',agentId:'waiting',timeoutMs:500});
 await new Promise(resolve=>setTimeout(resolve,30));
 const restored=await waiter.ok({op:'restore',state:{version:1,nextCursor:1,rooms:[]}});await poll;
 await waiter.register('after');
 record('restore-active-waiter','resolved',{restored:restored.restored,laterRegister:true});

 const offline=await fixture('offline-writer');await offline.register('live-agent');
 const importFile=path.join(root,'offline-empty.json');await fs.writeFile(importFile,JSON.stringify({version:1,nextCursor:1,rooms:[]}));
 // createBroker intentionally leaves discovery to its caller. A live writer
 // lease, including this public API path, must still fence offline import.
 const result=await offline.run(['restore','--offline','--in',importFile]);
 const disk=JSON.parse(await fs.readFile(path.join(offline.dataDir,'state.json'),'utf8'));
 const memory=(await offline.ok({op:'agents'})).agents.length;
 await offline.register('after-import');
 const later=JSON.parse(await fs.readFile(path.join(offline.dataDir,'state.json'),'utf8')).rooms.length;
 assert.equal(result.restored,true);assert.equal(disk.rooms.length,0);assert.equal(memory,1);assert.equal(later,1);
 record('offline-restore-bypasses-live-lease','open',{reportedRestored:result.restored,liveLeasePresent:true,diskRoomsImmediately:disk.rooms.length,liveAgentsStillInMemory:memory,roomsAfterNextBrokerWrite:later});

 const sizeFixture=await fixture('offline-size');await sizeFixture.broker.close();
 const medium={version:1,nextCursor:25,rooms:[{project:sizeFixture.project,agents:[agent('sender'),agent('reader')],claims:[],cursor:24,
  messages:Array.from({length:24},(_,i)=>({messageId:'medium-'+i,from:'sender',to:'reader',body:'x'.repeat(8000),createdAt:ts,cursor:i+1,recipients:['reader'],ackedBy:[],notified:[]}))}]};
 const mediumFile=path.join(root,'medium.json');await fs.writeFile(mediumFile,JSON.stringify(medium));
 const mediumResult=await sizeFixture.run(['restore','--offline','--in',mediumFile]);
 const reopened=await createBroker({dataDir:sizeFixture.dataDir});await reopened.close();
 assert.equal(mediumResult.messages,24);
 record('large-offline-import','resolved',{bytes:(await fs.stat(mediumFile)).size,restoredMessages:mediumResult.messages,coldStartAccepted:true});
 const oversized={version:1,nextCursor:1,rooms:[],extra:'x'.repeat(64*1024*1024)};
 validateStore(oversized);
 const bigFile=path.join(root,'oversize.json');await fs.writeFile(bigFile,JSON.stringify(oversized));
 const bigResult=await sizeFixture.run(['restore','--offline','--in',bigFile]);
 let startupError;try{const broker=await createBroker({dataDir:sizeFixture.dataDir});await broker.close();}catch(error){startupError=error.message;}
 assert.equal(bigResult.restored,true);assert.match(startupError,/storage bound/);
 record('offline-restore-exceeds-store-bound','open',{reportedRestored:bigResult.restored,writtenBytes:(await fs.stat(path.join(sizeFixture.dataDir,'state.json'))).size,startupError});

 const pages=await fixture('pages');await pages.register('peer');const tools=await mcp(pages,'pages');
 try{
  for(let i=0;i<12;i++)await pages.ok({op:'send',from:'peer',to:tools.adapter.agentId,body:'x'.repeat(8000)});
  const firstMessage=(await pages.ok({op:'inbox',agentId:tools.adapter.agentId})).messages[0];await pages.ok({op:'ack',agentId:tools.adapter.agentId,messageId:firstMessage.messageId});
  const unread=await tools.tool('relay_inbox',{unread:true,limit:1});assert.equal(unread.messages[0].acked,false);
  const history=await tools.tool('relay_history',{limit:50});assert.equal(history.nextCursor,history.messages.at(-1).cursor);assert.equal(history.done,false);
  for(let i=0;i<12;i++)await pages.ok({op:'send',from:tools.adapter.agentId,to:'peer',body:'x'.repeat(8000)});
  const outbox=await tools.tool('relay_outbox');assert.equal(outbox.nextCursor,outbox.messages.at(-1).cursor);assert.ok(outbox.omitted.resumeCursor>0);
  record('unread-and-byte-cursors','resolved',{unreadIncludesAcked:false,historyNextCursor:history.nextCursor,historyDone:history.done,outboxResume:outbox.omitted.resumeCursor});
  const task=await tools.tool('relay_tasks',{action:'upsert',title:'clear dependencies',blockedBy:['machine']});
  const clear=await tools.tool('relay_tasks',{action:'upsert',id:task.task.id,blockedBy:[]});assert.equal(clear.ok,false);
  await pages.ok({op:'tasks',action:'upsert',agentId:tools.adapter.agentId,id:task.task.id,blockedBy:[]});
  record('task-tool-cannot-clear-arrays','open',{toolError:clear.error,directBrokerClearSucceeded:true});
  await pages.discovery();const output=path.join(root,'export-existing.json');await fs.writeFile(output,'old',{mode:0o644});await fs.chmod(output,0o644);
  const exported=await pages.run(['export','--out',output]);
  assert.equal((await fs.stat(output)).mode&0o777,0o644);
  record('existing-export-permissions','open',{resultMode:exported.mode,actualMode:((await fs.stat(output)).mode&0o777).toString(8)});
 }finally{await tools.close();}

 const receipts=await fixture('receipt-budget',project=>{
  const ids=Array.from({length:800},(_,i)=>`r${i}-`+'x'.repeat(100));
  return stateFor(project,[agent('sender'),...ids.map(agent)],[{messageId:'wide',from:'sender',to:'*',body:'wide',createdAt:ts,cursor:1,recipients:ids,ackedBy:[],notified:[]}]);
 });
 const receiptTools=await mcp(receipts,'receipt',{agentId:'sender'});
 try{
  const receipt=await receiptTools.tool('relay_receipt',{messageId:'wide',recipientsLimit:1});
  const outbox=await receiptTools.tool('relay_outbox');
  assert.equal(receipt.recipients.length,1);assert.equal(receipt.pending.length,800);assert.ok(Buffer.byteLength(JSON.stringify(receipt))>65536);assert.ok(outbox.byteSize>65536);
  record('remaining-tool-byte-overruns','open',{receiptBytes:Buffer.byteLength(JSON.stringify(receipt)),receiptRecipients:receipt.recipients.length,unpagedPending:receipt.pending.length,outboxMessages:outbox.messages.length,outboxBytes:outbox.byteSize,budget:65536});
 }finally{await receiptTools.close();}

 const setup=await fixture('setup');await setupProject(setup.project,{runners:['codex']});
 const config=path.join(setup.project,'.codex/config.toml');
 await fs.writeFile(config,`[mcp_servers]\nagent-relay = { command = ${JSON.stringify(process.execPath)}, args = ["/missing/relay-cli"] }\n`);
 const inline=(await diagnoseSetup(setup.project)).bindings.find(b=>b.runner==='codex');assert.equal(inline.ok,true);
 await fs.writeFile(config,`[mcp_servers]\nagent-relay = { args = [${JSON.stringify(process.execPath)}], command = "/missing/relay-node" }\n`);
 const reversed=(await diagnoseSetup(setup.project)).bindings.find(b=>b.runner==='codex');assert.equal(reversed.ok,true);
 record('inline-toml-diagnostics-fail-open','open',{validCommandMissingCLI:inline,missingCommandArgsFirst:reversed});

 const channel=await fixture('channel');let entered;
 const waiting=new Promise(resolve=>{entered=resolve;});
 const ch=await mcp(channel,'channel',{channel:true,waitImpl:(_p,_a,_c,{signal})=>{entered();return new Promise((_resolve,reject)=>{if(signal.aborted)return reject(Error('aborted'));signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});}});
 await waiting;await ch.client.close();await flush();
 const connected=await channel.ok({op:'agents',transport:'connected'});assert.equal(connected.agents.length,1);
 record('mcp-peer-close-keeps-connected','open',{connectedAfterPeerClose:connected.agents.length});await ch.adapter.close();

 const codexController=new AbortController(),codexCalls=[];let reads=0,reconnects=0;
 const healthy={call:async method=>method==='thread/read'?{thread:{cwd:setup.project,status:{type:'idle'}}}:{accepted:true},close(){}};
 const initial={call:async()=>{reads++;if(reads===1)return {thread:{cwd:setup.project,status:{type:'idle'}}};throw Error('Codex connection closed');},close(){}};
 await runCodexBridge({project:setup.project,threadId:'fixture',connection:initial,signal:codexController.signal,
  connectImpl:async()=>{reconnects++;return healthy;},rpcImpl:async(_p,fields)=>{codexCalls.push(fields);return fields.op==='inbox'?{messages:[{messageId:'c1',from:'peer',body:'notice',cursor:1}],cursor:1}:{ok:true};},
  waitImpl:async()=>{codexController.abort();return {messages:[],cursor:1};}});
 assert.equal(reconnects,1);assert.ok(codexCalls.some(c=>c.adapter==='codex-accepted'));
 record('codex-first-reconnect','resolved',{reconnects,accepted:true});

 const sid='ses_review',oid='opencode:'+sid,pluginCalls=[],prompts=[];
 const rows=Array.from({length:30},(_,i)=>({messageId:'o'+i,from:'peer',to:oid,recipients:[oid],body:'漢'.repeat(5300),cursor:i+1,notified:[]}));
 const plugin=await AgentRelayPlugin({directory:setup.project,worktree:setup.project,client:{
  tui:{showToast:async()=>({data:true})},session:{status:async()=>({data:{[sid]:{type:'idle'}}}),promptAsync:async value=>{prompts.push(value);return {data:{}};}}
 }},{transport:{rpc:async(_p,fields)=>{pluginCalls.push(fields);return fields.op==='inbox'?{ok:true,messages:rows,cursor:30}:{ok:true};},wait:(_p,_a,_c,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))}});
 try{
  const info={id:'user',sessionID:sid,role:'user',agent:'build',model:{providerID:'fixture',modelID:'fixture'}};
  await plugin['chat.message']({sessionID:sid},{message:info});await flush();
  const output={messages:[{info,parts:[]}]};await plugin['experimental.chat.messages.transform']({},output);await flush();
  const text=output.messages[0].parts[0].text;
  const shown=text.split('\n').filter(l=>l.startsWith('{')).map(l=>JSON.parse(l).messageId);
  const marked=pluginCalls.filter(c=>c.adapter==='opencode-context');
  assert.ok(Buffer.byteLength(text)<=32768);assert.equal(marked.length,shown.length);
  record('opencode-context-fixes','resolved',{bytes:Buffer.byteLength(text),shown:shown.length,contextMarkers:marked.length});
  await plugin.event({event:{type:'session.idle',properties:{sessionID:sid}}});await flush();
  assert.equal(prompts.length,1);
  const wakeText=prompts[0].body.parts[0].text,wakeShown=wakeText.split('\n').filter(l=>l.startsWith('{')).map(l=>JSON.parse(l).messageId);
  const attempts=pluginCalls.filter(c=>c.adapter==='opencode-wake-attempted');assert.equal(attempts.length,30);assert.ok(wakeShown.length<30);
  record('omitted-wake-messages-fenced','open',{includedInPrompt:wakeShown.length,wakeAttemptMarkers:attempts.length,omittedButFenced:attempts.filter(c=>!wakeShown.includes(c.messageId)).length});
 }finally{await plugin.dispose();}

 const notice=await fixture('notice-headroom',project=>{
  const ids=Array.from({length:300},(_,i)=>'r'+i);
  return stateFor(project,[agent('sender'),...ids.map(agent)],[
   {messageId:'big',from:'sender',to:'*',body:'big',createdAt:ts,cursor:1,recipients:ids,ackedBy:[],notified:ids.flatMap(agentId=>Array.from({length:5},(_,i)=>({agentId,adapter:'stage-'+i,at:ts})))},
   {messageId:'full-small',from:'sender',to:ids[0],body:'small',createdAt:ts,cursor:2,recipients:[ids[0]],ackedBy:[],notified:Array.from({length:1024},(_,i)=>({agentId:ids[0],adapter:'stage-'+i,at:ts}))}
  ]);
 });
 const usage=await notice.ok({op:'usage'});const denied=await notice.call({op:'notified',agentId:'r0',messageId:'full-small',adapter:'one-more'});
 assert.equal(usage.headroom.notices,300);assert.equal(usage.nearLimit.includes('notices'),false);assert.equal(denied.error.code,'NOTICE_LIMIT');
 record('notice-headroom-chooses-wrong-message','open',{reportedHeadroom:usage.headroom.notices,warned:usage.nearLimit.includes('notices'),fullMessageError:denied.error.code,derivedAllowance512:noticeAllowance(512)});
}finally{
 for(const broker of brokers)await broker.close();
 await fs.rm(root,{recursive:true,force:true});
}
