// Focused review reproductions. Only disposable projects, brokers and owned
// fixture processes are used. Run from a source checkout with dependencies:
// node docs/reviews/2026-10-11-probes.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createBroker, validateStore} from '../../lib/broker.mjs';
import {createMcpAdapter} from '../../lib/mcp.mjs';
import {AgentRelayPlugin} from '../../lib/opencode-plugin.mjs';
import {setupProject, diagnoseSetup} from '../../lib/setup.mjs';
import {runCodexBridge, reconcileCodexDelivery} from '../../lib/codex.mjs';
import {rpc as clientRpc} from '../../lib/client.mjs';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../bin/agent-relay.mjs', import.meta.url));
const outputs = [];
const record = (name, evidence) => {outputs.push({name, evidence}); console.log(JSON.stringify({name, evidence}));};
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => {for (let i=0;i<10;i++) await tick();};
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-relay-review-'));
const brokers = [];
async function fixture(name, seed) {
  const project = path.join(root, name, 'project'), dataDir = path.join(root, name, 'data');
  await fs.mkdir(project,{recursive:true}); await fs.mkdir(dataDir,{recursive:true});
  const realProject = await fs.realpath(project);
  if (seed) await fs.writeFile(path.join(dataDir,'state.json'),JSON.stringify(seed(realProject)));
  const broker = await createBroker({dataDir}); brokers.push(broker);
  const call = async fields => {
    const response = await fetch(broker.url+'/rpc', {method:'POST',headers:{authorization:'Bearer '+broker.token,'content-type':'application/json'},body:JSON.stringify({project:realProject,...fields})});
    return {status:response.status,...await response.json()};
  };
  const ok = async fields => {const row=await call(fields); assert.equal(row.ok,true,JSON.stringify(row)); return row;};
  const register = agentId => ok({op:'register',agentId,runner:'review'});
  return {project:realProject,dataDir,broker,call,ok,register};
}
async function mcp(f, sessionId, agentId) {
  const [a,b]=InMemoryTransport.createLinkedPair();
  const adapter=await createMcpAdapter({project:f.project,runner:'generic',sessionId,agentId,
    rpcImpl:(_project,fields)=>f.ok(fields),waitImpl:()=>{throw Error('no watcher');}});
  const client=new Client({name:'review',version:'1'});
  await adapter.start(a); await client.connect(b);
  return {adapter,client,tool:async(name,args={})=>JSON.parse((await client.callTool({name,arguments:args})).content[0].text),
    close:async()=>{await adapter.close();await client.close();}};
}
try {
  const f=await fixture('broker'); await f.register('a'); await f.register('b');
  await f.ok({op:'claim',agentId:'a',scope:'machine',resources:['build']});
  const made=await f.ok({op:'tasks',action:'upsert',agentId:'b',title:'machine blocked',blockedBy:['build']});
  const listed=await f.ok({op:'tasks',action:'list',state:'open'});
  const filtered=await f.ok({op:'tasks',action:'list',blocked:true});
  assert.equal(made.task.blocked,true); assert.equal(listed.tasks[0].blocked,false); assert.equal(filtered.tasks.length,0);
  record('machine-task-blocking',{upsert:made.task.blocking,list:listed.tasks[0].blocking,blockedFilterCount:filtered.tasks.length});
  await f.ok({op:'claim',agentId:'a',resources:['src']});
  const childTask=await f.ok({op:'tasks',action:'upsert',agentId:'b',title:'child blocked',blockedBy:['src/file.mjs']});
  const conflict=await f.call({op:'claim',agentId:'b',resources:['src/file.mjs']});
  assert.equal(childTask.task.blocked,false);assert.equal(conflict.error.code,'CLAIM_CONFLICT');
  record('parent-claim-not-in-task-blockers',{taskBlocked:childTask.task.blocked,claimError:conflict.error.code});

  await f.ok({op:'claim',agentId:'a',resources:['x']});
  const offer=await f.ok({op:'requestHandoff',agentId:'a',to:'b',resources:['x'],reason:'offer to b'});
  await f.ok({op:'release',agentId:'a',resources:['x']}); await f.ok({op:'claim',agentId:'b',resources:['x']});
  const transfer=await f.ok({op:'respondHandoff',agentId:'b',id:offer.handoff.id,accept:true});
  assert.equal(transfer.transferred[0].agentId,'a');
  record('handoff-direction-reverses',{offeredFrom:'a',offeredTo:'b',accepting:'b',resultOwner:transfer.transferred[0].agentId});

  const bulletin=await f.ok({op:'setBulletin',agentId:'a',title:'v1',body:'first',source:'POLICY.md'});
  await f.ok({op:'setBulletin',agentId:'a',title:'v2',body:'second',source:'POLICY.md'});
  const ack=await f.ok({op:'ackBulletin',agentId:'b',version:bulletin.version});
  assert.equal(ack.version,2);
  record('bulletin-ack-race',{readVersion:bulletin.version,submittedVersion:1,acknowledgedVersion:ack.version});

  const source=path.join(root,'attachment.txt'); await fs.writeFile(source,'correct payload');
  const sent=await f.ok({op:'send',from:'a',to:'b',body:'attachment',attachments:[source]});
  const exported=await f.ok({op:'export'});
  const digest=exported.state.rooms[0].messages.find(m=>m.messageId===sent.messageId).attachments[0].sha256;
  await fs.writeFile(path.join(f.dataDir,'attachments',digest),'CORRUPT');
  const dry=await f.ok({op:'restore',state:exported.state,dryRun:true});
  const fetched=await f.call({op:'fetch',agentId:'b',messageId:sent.messageId,out:path.join(root,'fetch')});
  assert.equal(dry.valid,true); assert.equal(dry.missingAttachments.length,0); assert.equal(fetched.ok,false);
  record('restore-does-not-verify-attachments',{valid:dry.valid,missingAttachments:dry.missingAttachments,fetchError:fetched.error});
  await f.ok({op:'notified',agentId:'b',messageId:sent.messageId,adapter:'codex-attempted'});
  await reconcileCodexDelivery((_project,fields)=>f.ok(fields),{project:f.project,agentId:'b',messageId:sent.messageId,arrived:false});
  const missingReceipt=await f.ok({op:'receipt',messageId:sent.messageId});
  assert.equal(missingReceipt.recipients[0].state,'notified');
  record('missing-reconciliation-counts-delivered',{arrived:false,receiptState:missingReceipt.recipients[0].state,pendingCount:missingReceipt.pending.length});
  await fs.writeFile(path.join(f.dataDir,'broker.json'),JSON.stringify({pid:process.pid,url:f.broker.url,token:f.broker.token}));
  const originalMask=process.umask(0o022),exportFile=path.join(root,'private-export.json');
  try {await exec(process.execPath,[cli,'export','--project',f.project,'--data-dir',f.dataDir,'--out',exportFile],{timeout:5000});}
  finally {process.umask(originalMask);}
  record('export-file-permissions',{umask:'022',mode:(await fs.stat(exportFile)).mode.toString(8).slice(-3)});

  await f.register('retiring'); await f.ok({op:'claim',agentId:'retiring',resources:['permanent']});
  await f.ok({op:'retire',agentId:'retiring'});
  const release=await f.call({op:'release',agentId:'retiring'}), rejoin=await f.call({op:'register',agentId:'retiring',runner:'review'});
  record('retirement-strands-claims',{releaseError:release.error.code,rejoinError:rejoin.error.code,stillHeld:(await f.ok({op:'agents'})).claims.some(c=>c.agentId==='retiring')});

  const p=await fixture('pages'); await p.register('peer'); const m=await mcp(p,'pages');
  try {
    for(let i=0;i<12;i++) await p.ok({op:'send',from:'peer',to:m.adapter.agentId,body:'x'.repeat(8000)});
    const pending=(await p.ok({op:'inbox',agentId:m.adapter.agentId})).messages;
    await p.ok({op:'ack',agentId:m.adapter.agentId,messageId:pending[0].messageId});
    const unread=await m.tool('relay_inbox',{unread:true,limit:1});
    assert.equal(unread.messages[0].acked,true);
    record('unread-filter-inverted',{unreadTrueIncludesAcknowledged:unread.messages[0].acked});
    const inbox=await m.tool('relay_inbox',{limit:50});
    const history=await m.tool('relay_history',{limit:50});
    for(let i=0;i<12;i++) await p.ok({op:'send',from:m.adapter.agentId,to:'peer',body:'x'.repeat(8000)});
    const outbox=await m.tool('relay_outbox',{limit:50});
    assert.ok(outbox.omitted); assert.equal(outbox.omitted.resumeCursor,0);
    record('byte-page-cursors',{inbox:{lastShown:inbox.messages.at(-1).cursor,cursor:inbox.cursor,omitted:inbox.omitted},
      history:{lastShown:history.messages.at(-1).cursor,nextCursor:history.nextCursor,done:history.done,omitted:history.omitted},
      outbox:{lastShownCursor:outbox.messages.at(-1).cursor??null,nextCursor:outbox.nextCursor,omitted:outbox.omitted}});
    const large=await p.ok({op:'export'});
    const size=Buffer.byteLength(JSON.stringify({project:p.project,op:'restore',state:large.state,dryRun:true}));
    const restored=await p.call({op:'restore',state:large.state,dryRun:true});
    assert.equal(restored.error.code,'REQUEST_TOO_LARGE');
    record('large-export-cannot-restore',{restoreRequestBytes:size,status:restored.status,error:restored.error.code});
  } finally {await m.close();}

  const s=await fixture('setup'); await setupProject(s.project,{runners:['codex']});
  const config=path.join(s.project,'.codex/config.toml');
  await fs.writeFile(config,'[mcp_servers.other]\ncommand = "/definitely/missing/other"\nargs = ["/missing/other"]\n'+await fs.readFile(config,'utf8'));
  const diagnosis=await diagnoseSetup(s.project);
  assert.equal(diagnosis.bindings.find(b=>b.runner==='codex').ok,false);
  record('setup-diagnoses-wrong-table',diagnosis.bindings.find(b=>b.runner==='codex'));

  const sid='ses_review',id='opencode:'+sid,calls=[];
  const rows=Array.from({length:30},(_,i)=>({messageId:'message-'+i,from:'peer',to:id,recipients:[id],body:'漢'.repeat(5300),cursor:i+1,notified:[]}));
  const plugin=await AgentRelayPlugin({directory:s.project,worktree:s.project,client:{
    tui:{showToast:async()=>({data:true})},session:{status:async()=>({data:{[sid]:{type:'busy'}}}),promptAsync:async()=>({})}
  }},{transport:{rpc:async(_project,fields)=>{calls.push(fields);return fields.op==='inbox'?{ok:true,messages:rows,cursor:30}:{ok:true};},
    wait:(_p,_a,_c,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))}});
  try {
    await plugin['chat.message']({sessionID:sid},{message:{agent:'build',model:{providerID:'fixture',modelID:'fixture'}}}); await flush();
    const output={messages:[{info:{id:'user-1',sessionID:sid,role:'user',path:{cwd:s.project}},parts:[]}]};
    await plugin['experimental.chat.messages.transform']({},output); await flush();
    const content=output.messages[0].parts[0].text, shown=content.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line).messageId);
    const markers=calls.filter(c=>c.adapter==='opencode-context');
    assert.ok(Buffer.byteLength(content)>32768); assert.equal(markers.length,30); assert.ok(shown.length<30);
    record('opencode-context-bounds-and-receipts',{bytes:Buffer.byteLength(content),advertisedBytes:32768,shown:shown.length,contextMarkers:markers.length,omittedButMarked:markers.filter(c=>!shown.includes(c.messageId)).length});
  } finally {await plugin.dispose();}

  const codexCalls=[],abort=new AbortController(); let threadReads=0,reconnections=0;
  const connection={call:async method=>{threadReads++;if(threadReads>1)throw Error('Codex connection closed');return {thread:{cwd:s.project,status:{type:'idle'}}};},close(){}};
  await runCodexBridge({project:s.project,threadId:'fixture-thread',agentId:'codex-fixture',connection,signal:abort.signal,
    rpcImpl:async(_p,fields)=>{codexCalls.push(fields);if(fields.op==='inbox')return {messages:[{messageId:'c1',from:'peer',body:'notice',cursor:1}],cursor:1};return {ok:true};},
    waitImpl:async()=>{abort.abort();return {messages:[],cursor:1};},connectImpl:async()=>{reconnections++;return connection;}});
  assert.equal(reconnections,0);
  record('codex-first-post-disconnect-message',{reconnections,status:codexCalls.find(c=>c.status==='delivery-needs-review')?.task,
    attempted:codexCalls.some(c=>c.adapter==='codex-attempted'),accepted:codexCalls.some(c=>c.adapter==='codex-accepted')});

  // Global counters are advertised against per-room bounds even with 2 rooms.
  const other=path.join(root,'second-room'); await fs.mkdir(other); const otherReal=await fs.realpath(other);
  await fetch(f.broker.url+'/rpc',{method:'POST',headers:{authorization:'Bearer '+f.broker.token,'content-type':'application/json'},body:JSON.stringify({project:otherReal,op:'register',agentId:'other',runner:'review'})});
  const usage=await f.ok({op:'usage'});
  record('usage-bound-scope',{agents:usage.agents,claims:usage.claims,rooms:usage.rooms});

  // The bulletin ack bound fails after legitimate session churn.
  const ts='2026-10-11T00:00:00.000Z';
  const agent=(agentId,left=false)=>({agentId,runner:'review',registeredAt:ts,updatedAt:ts,status:'idle',frozen:false,resources:[],task:null,...(left?{left:true}:{})});
  const boundary=await fixture('bulletin-bound',project=>{
    const title='policy',body='current',source='POLICY.md';
    return {version:1,nextCursor:1,rooms:[{project,cursor:0,messages:[],claims:[],agents:[...Array.from({length:4096},(_,i)=>agent('old-'+i,true)),agent('fresh')],
      bulletin:{versions:[{version:1,title,body,source,hash:createHash('sha256').update(JSON.stringify({title,body,source})).digest('hex'),ts,acks:Array.from({length:4096},(_,i)=>({agentId:'old-'+i,at:ts}))}]}}]};
  });
  const overflow=await boundary.call({op:'ackBulletin',agentId:'fresh'});
  assert.equal(overflow.ok,false);
  record('bulletin-ack-churn-bound',{activeAgents:1,retainedAgents:4097,status:overflow.status,error:overflow.error.code});

  const fanout=await fixture('notice-bound',project=>{
    const recipients=Array.from({length:512},(_,i)=>'receiver-'+i);
    return {version:1,nextCursor:2,rooms:[{project,cursor:1,claims:[],agents:[agent('sender'),...recipients.map(id=>agent(id))],
      messages:[{messageId:'broadcast',from:'sender',to:'*',body:'notice',createdAt:ts,cursor:1,recipients,ackedBy:[],
        notified:recipients.flatMap(agentId=>['opencode-toast-attempted','opencode-toast','opencode-wake-attempted'].map(adapter=>({agentId,adapter,at:ts})))}]}]};
  });
  const fourth=await fanout.call({op:'notified',agentId:'receiver-0',messageId:'broadcast',adapter:'opencode-context'});
  assert.equal(fourth.error.code,'NOTICE_LIMIT');
  record('opencode-notice-budget',{recipients:512,existingMarkers:1536,fourthStageStatus:fourth.status,error:fourth.error.code});
  const single=await mcp(fanout,'single','sender');
  try {
    const page=await single.tool('relay_outbox');
    assert.ok(page.byteSize>page.maxBytes);
    record('single-message-page-exceeds-budget',{messages:page.messages.length,byteSize:page.byteSize,maxBytes:page.maxBytes,omitted:page.omitted});
  } finally {await single.close();}

  const readyFixture=await fixture('readiness');
  const [sa,sb]=InMemoryTransport.createLinkedPair(); let entered;
  const waiting=new Promise(resolve=>{entered=resolve;});
  const readyAdapter=await createMcpAdapter({project:readyFixture.project,runner:'generic',sessionId:'channel',channel:true,
    rpcImpl:(_p,fields)=>readyFixture.ok(fields),waitImpl:(_p,_a,_c,{signal})=>{entered();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}});
  const readyClient=new Client({name:'review-channel',version:'1'});
  await readyAdapter.start(sa);await readyClient.connect(sb);await waiting;
  await readyAdapter.close();await readyClient.close();
  const readyAgents=await readyFixture.ok({op:'agents',transport:'connected'});
  assert.equal(readyAgents.agents.length,1);
  record('mcp-close-keeps-connected',{connectedAfterClose:readyAgents.agents.map(a=>({id:a.agentId,transport:a.transport}))});

  // Prove lifecycle verification with a harmless child owned by this harness.
  // Its PID is deliberately unrelated to the healthy fixture broker.
  const child=spawn(process.execPath,['-e','console.log("ready");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe']});
  const childExited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  try {
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
    const stopDir=path.join(root,'fake-discovery');await fs.mkdir(stopDir);
    await fs.writeFile(path.join(stopDir,'broker.json'),JSON.stringify({pid:child.pid,url:f.broker.url,token:'incorrect-token'}));
    const stopped=JSON.parse((await exec(process.execPath,[cli,'stop','--data-dir',stopDir],{timeout:8000})).stdout);
    const exit=await childExited;
    assert.equal(exit.signal,'SIGTERM');
    record('stop-trusts-unrelated-pid',{reportedStopped:stopped.stopped,ownedUnrelatedChildSignal:exit.signal,actualBrokerStillHealthy:(await fetch(f.broker.url+'/health')).ok});
  } finally {if(child.exitCode===null && child.signalCode===null)child.kill('SIGTERM');}

  const submitted=[];
  const partial=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/health'){res.end(JSON.stringify({ok:true}));return;}
    let body='';for await(const chunk of req)body+=chunk;
    const row=JSON.parse(body);
    if(row.op==='capabilities')res.end(JSON.stringify({ok:true,features:['attachments']}));
    else{submitted.push(row);res.end(JSON.stringify({ok:true}));}
  });
  await new Promise(resolve=>partial.listen(0,'127.0.0.1',resolve));
  try {
    const partialDir=path.join(root,'partial');await fs.mkdir(partialDir);
    await fs.writeFile(path.join(partialDir,'broker.json'),JSON.stringify({pid:process.pid,url:'http://127.0.0.1:'+partial.address().port,token:'fixture'}));
    await clientRpc(f.project,{op:'send',from:'a',to:'b',body:'body',attachments:[],summary:'unsupported summary'},{dataDir:partialDir});
    assert.equal(submitted.length,1);
    record('partial-capability-combination',{advertised:['attachments'],unadvertisedSummarySubmitted:submitted[0].summary});
  } finally {await new Promise(resolve=>partial.close(resolve));}

  // Timer exception from a removed room is captured only in this disposable
  // process; no normal broker or real runner is involved.
  const waiter=await fixture('restore-waiter');await waiter.register('waiting');
  let timerFailure;
  const caught=error=>{timerFailure={code:error.code,message:error.message};};
  process.once('uncaughtException',caught);
  const poll=waiter.call({op:'wait',agentId:'waiting',timeoutMs:100});
  await new Promise(resolve=>setTimeout(resolve,30));
  const replacement={version:1,nextCursor:1,rooms:[]};validateStore(replacement);
  const restored=await waiter.call({op:'restore',state:replacement});
  await new Promise(resolve=>setTimeout(resolve,150));
  const saved=JSON.parse(await fs.readFile(path.join(waiter.dataDir,'state.json'),'utf8'));
  record('restore-removes-waiter-room',{restoreStatus:restored.status,restoreError:restored.error?.code,durableRooms:saved.rooms.length,uncaughtTimerError:timerFailure});
  // Put the old room back solely to allow the fixture's waiter and lease to close.
  await waiter.ok({op:'restore',state:{version:1,nextCursor:1,rooms:[{project:waiter.project,cursor:0,messages:[],claims:[],agents:[agent('waiting')]}]}});
  await waiter.broker.close(); await poll; process.removeListener('uncaughtException',caught);
} finally {
  for (const broker of brokers) await broker.close();
  await fs.rm(root,{recursive:true,force:true});
}
