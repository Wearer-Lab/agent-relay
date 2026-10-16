// Regression verification of the third review fixes: disposable broker/CLI/SDK and recording runner probes only.
// node docs/reviews/2026-10-12-fix-probes.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createBroker,offlineRestore} from '../../lib/broker.mjs';
import {createMcpAdapter} from '../../lib/mcp.mjs';
import {AgentRelayPlugin} from '../../lib/opencode-plugin.mjs';
import {diagnoseSetup} from '../../lib/setup.mjs';
import {roomSnapshot} from '../../lib/observability.mjs';
import {createDashboardHandler} from '../../lib/dashboard.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
const exec=promisify(execFile),cli=fileURLToPath(new URL('../../bin/agent-relay.mjs',import.meta.url));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-review-three-')),brokers=[];
const record=(name,outcome,evidence)=>console.log(JSON.stringify({name,outcome,evidence}));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const flush=async()=>{for(let i=0;i<20;i++)await tick();};
const ts=new Date().toISOString();
const agent=agentId=>({agentId,runner:'review',registeredAt:ts,updatedAt:ts,status:'idle',frozen:false,resources:[],task:null});
const empty={version:1,nextCursor:1,rooms:[]};
async function fixture(name,seed){
 const project=path.join(root,name,'project'),dataDir=path.join(root,name,'data');
 await fs.mkdir(project,{recursive:true});await fs.mkdir(dataDir,{recursive:true});const real=await fs.realpath(project);
 if(seed)await fs.writeFile(path.join(dataDir,'state.json'),JSON.stringify(seed(real)));
 const broker=await createBroker({dataDir});brokers.push(broker);
 const call=async fields=>{const response=await fetch(broker.url+'/rpc',{method:'POST',headers:{authorization:'Bearer '+broker.token,'content-type':'application/json'},body:JSON.stringify({project:real,...fields}),signal:AbortSignal.timeout(5000)});return {httpStatus:response.status,...await response.json()};};
 const ok=async fields=>{const row=await call(fields);assert.equal(row.ok,true,JSON.stringify(row));return row;};
 const register=agentId=>ok({op:'register',agentId,runner:'review'});
 const run=async(args,dir=dataDir)=>JSON.parse((await exec(process.execPath,[cli,...args,'--project',real,'--data-dir',dir],{timeout:10000,maxBuffer:2*1024*1024})).stdout);
 const discovery=()=>fs.writeFile(path.join(dataDir,'broker.json'),JSON.stringify({pid:process.pid,url:broker.url,token:broker.token}));
 return {project:real,dataDir,broker,call,ok,register,run,discovery};
}
async function mcp(f,session,options={}){
 const [a,b]=InMemoryTransport.createLinkedPair();
 const adapter=await createMcpAdapter({project:f.project,runner:'generic',sessionId:session,rpcImpl:(_p,fields)=>f.ok(fields),waitImpl:()=>{throw Error('unexpected watcher');},...options});
 const client=new Client({name:'third-review',version:'1'});await adapter.start(a);await client.connect(b);
 const tool=async(name,args={})=>JSON.parse((await client.callTool({name,arguments:args})).content[0].text);
 return {adapter,client,tool,close:async()=>{await adapter.close();await client.close();}};
}
async function fullSnapshot(tool, page){
 assert.ok(page.continuation,'oversized response must offer lossless retrieval');
 const {token}=page.continuation;let offset=0,text='';
 for(let i=0;i<1000;i++){
  const chunk=await tool('relay_read_page',{token,offset});
  assert.ok(Buffer.byteLength(JSON.stringify(chunk))<=65536);
  assert.equal(chunk.byteSize,Buffer.byteLength(JSON.stringify(chunk)));
  assert.equal(chunk.offset,offset);text+=chunk.text;
  if(chunk.done)return JSON.parse(text);
  assert.ok(chunk.nextOffset>offset);offset=chunk.nextOffset;
 }
 throw Error('continuation did not finish');
}
try{
 const offline=await fixture('offline');await offline.register('old-agent');
 const incoming=path.join(root,'empty.json');await fs.writeFile(incoming,JSON.stringify({schemaVersion:1,state:empty}));
 const before=await fs.readFile(path.join(offline.dataDir,'state.json'),'utf8');
 let refused;try{await offline.run(['restore','--offline','--in',incoming]);}catch(error){refused=error.stderr;}
 assert.match(refused,/live|owns|ownership/i);assert.equal(await fs.readFile(path.join(offline.dataDir,'state.json'),'utf8'),before);
 record('offline-live-lease','resolved',{refused:true,ledgerUnchanged:true});
 await offline.broker.close();
 const offlineFiles=await fs.readdir(offline.dataDir),savedToken=await fs.readFile(path.join(offline.dataDir,'token'),'utf8');
 const dry=await offline.run(['restore','--offline','--dry-run','--in',incoming]);
 const afterDry=JSON.parse(await fs.readFile(path.join(offline.dataDir,'state.json'),'utf8'));
 assert.equal(dry.dryRun,true);assert.equal(dry.valid,true);assert.equal(dry.restored,undefined);
 assert.deepEqual(await fs.readdir(offline.dataDir),offlineFiles);
 assert.equal(await fs.readFile(path.join(offline.dataDir,'token'),'utf8'),savedToken);
 assert.equal(await fs.readFile(path.join(offline.dataDir,'state.json'),'utf8'),before);
 assert.ok(!(await fs.readdir(offline.dataDir)).some(name=>name.includes('backup')||name.endsWith('.tmp')));
 record('offline-dry-run-mutates','resolved',{dryRun:true,ledgerUnchanged:true,noBackup:true});
 await fs.writeFile(path.join(root,'schema999.json'),JSON.stringify({schemaVersion:999,state:empty}));
 await assert.rejects(offline.run(['restore','--offline','--in',path.join(root,'schema999.json')]),/schema 999/);
 assert.equal(await fs.readFile(path.join(offline.dataDir,'state.json'),'utf8'),before);
 record('offline-wrapper-schema-ignored','resolved',{unsupportedSchemaRejected:true,ledgerUnchanged:true});
 const fresh=path.join(root,'fresh','data');
 assert.equal((await offline.run(['restore','--offline','--dry-run','--in',incoming],fresh)).valid,true);
 await assert.rejects(fs.stat(fresh),{code:'ENOENT'});
 const created=await offline.run(['restore','--offline','--in',incoming],fresh);
 assert.equal(created.restored,true);assert.deepEqual(JSON.parse(await fs.readFile(path.join(fresh,'state.json'),'utf8')),empty);
 if(process.platform!=='win32'){
  if(process.platform!=='win32')assert.equal((await fs.stat(fresh)).mode&0o777,0o700);
  if(process.platform!=='win32')assert.equal((await fs.stat(path.join(fresh,'state.json'))).mode&0o777,0o600);
 }
 record('offline-fresh-directory-regression','resolved',{restored:true,directoryMode:'0700',stateMode:'0600',dryRunDoesNotCreateDirectory:true});

 const f=await fixture('coordination');await f.register('a');await f.register('b');
 await fs.mkdir(path.join(f.project,'target'));await fs.symlink(path.join(f.project,'target'),path.join(f.project,'alias'),process.platform==='win32'?'junction':'dir');
 await f.ok({op:'claim',agentId:'a',resources:['alias/file']});
 const blocked=await f.ok({op:'tasks',action:'upsert',agentId:'b',title:'alias task',blockedBy:['alias/file']});assert.equal(blocked.task.blocked,true);
 const state=(await f.ok({op:'export'})).state;
 state.rooms[0].handoffs=[{id:'legacy',from:'a',to:'b',resources:[path.join(f.project,'target/file')],reason:'old',state:'pending',requestedAt:ts}];
 await f.ok({op:'restore',state});
 const legacy=await f.call({op:'respondHandoff',agentId:'b',id:'legacy',accept:true});assert.equal(legacy.error.code,'HANDOFF_STALE');
 record('canonical-blockers-and-legacy-handoffs','resolved',{aliasBlocked:true,legacyError:legacy.error.code});
 await f.discovery();const exportFile=path.join(root,'permissive.json');await fs.writeFile(exportFile,'old',{mode:0o644});await fs.chmod(exportFile,0o644);
 const exported=await f.run(['export','--out',exportFile]);if(process.platform!=='win32')assert.equal((await fs.stat(exportFile)).mode&0o777,0o600);
 record('export-overwrite-permissions','resolved',{mode:exported.mode});

 const tasks=await fixture('task-pages',project=>({version:1,nextCursor:1,rooms:[{project,agents:[agent('owner')],messages:[],claims:[],cursor:0,
  tasks:Array.from({length:64},(_,i)=>({id:'task-'+i,creator:'owner',owner:'owner',title:'task '+i,state:'open',createdAt:ts,updatedAt:ts,verification:'v'.repeat(4096)}))}]}));
 const taskTools=await mcp(tasks,'tasks');
 try{
  const page=await taskTools.tool('relay_tasks',{action:'list'});
  assert.equal(page.hasMore,true);assert.ok(page.tasks.length<64);assert.ok(page.continuation);
  const recovered=await fullSnapshot(taskTools.tool,page);
  assert.equal(recovered.tasks.length,64);assert.equal(recovered.tasks.at(-1).id,'task-63');
  record('collection-trimming-no-continuation','resolved',{total:page.total,shown:page.tasks.length,recovered:recovered.tasks.length});
  const created=await taskTools.tool('relay_tasks',{action:'upsert',title:'clear',blockedBy:['old'],resources:['old']});
  const cleared=await taskTools.tool('relay_tasks',{action:'upsert',id:created.task.id,blockedBy:[],resources:[]});assert.deepEqual(cleared.task.blockedBy,[]);assert.deepEqual(cleared.task.resources,[]);
  record('task-array-clearing','resolved',{blockedBy:cleared.task.blockedBy,resources:cleared.task.resources});
 }finally{await taskTools.close();}

 const transport=await fixture('one-large-row',project=>({version:1,nextCursor:2,rooms:[{project,agents:[agent('sender'),agent('reader')],claims:[],cursor:1,messages:[{
  messageId:'large',from:'sender',to:'reader',body:'x'.repeat(16384),createdAt:ts,cursor:1,recipients:['reader'],ackedBy:[],
  notified:Array.from({length:1024},(_,i)=>({agentId:'reader',adapter:'stage-'+i+'-'+'x'.repeat(60),at:ts}))}]}]}));
 const rowTools=await mcp(transport,'large',{agentId:'reader'});
 try{
  const inbox=await rowTools.tool('relay_inbox');const receipt=await rowTools.tool('relay_receipt',{messageId:'large',recipientsLimit:1,pendingLimit:1});
  assert.ok(Buffer.byteLength(JSON.stringify(inbox))<=65536);assert.ok(Buffer.byteLength(JSON.stringify(receipt))<=65536);
  const fullInbox=await fullSnapshot(rowTools.tool,inbox),fullReceipt=await fullSnapshot(rowTools.tool,receipt);
  assert.equal(fullInbox.messages[0].body.length,16384);assert.equal(fullInbox.messages[0].notified.length,1024);
  assert.deepEqual(fullReceipt,(await transport.ok({op:'receipt',messageId:'large',recipientsLimit:1,pendingLimit:1})));
  record('single-row-response-still-unbounded','resolved',{inboxBytes:inbox.byteSize,receiptBytes:receipt.byteSize,budget:65536,recoveredNotices:fullInbox.messages[0].notified.length});

 }finally{await rowTools.close();}

 const cfg=await fixture('toml');const config=path.join(cfg.project,'.codex/config.toml');await fs.mkdir(path.dirname(config));
 const rootInline=`mcp_servers = { "agent-relay" = { command = ${JSON.stringify(process.execPath)}, args = [${JSON.stringify(cli)}] } }\n`;
 await fs.writeFile(config,rootInline);
 const diagnosis=(await diagnoseSetup(cfg.project)).bindings.find(b=>b.runner==='codex');assert.equal(diagnosis.ok,true);
 const multiline=`[mcp_servers.agent-relay]\ncommand = """${process.execPath}"""\nargs = [${JSON.stringify(cli)}]\n`;
 await fs.writeFile(config,multiline);
 const triple=(await diagnoseSetup(cfg.project)).bindings.find(b=>b.runner==='codex');assert.equal(triple.ok,true);
 record('valid-toml-forms-rejected','resolved',{rootInline:diagnosis,tripleQuotedCommand:triple,validTOMLFixtures:true,pathsExist:true});

 const channel=await fixture('close-race');let committedResolve,release;
 const committed=new Promise(resolve=>{committedResolve=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const ch=await mcp(channel,'race',{channel:true,rpcImpl:async(_p,fields)=>{const result=await channel.ok(fields);if(fields.status==='channel-ready'){committedResolve();await gate;}return result;},
  waitImpl:(_p,_a,_c,{signal})=>new Promise((_resolve,reject)=>{if(signal.aborted)return reject(Error('aborted'));signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});})});
 await committed;await ch.client.close();release();await flush();
 const still=(await channel.ok({op:'agents',transport:'connected'})).agents;assert.equal(still.length,0);
 record('close-during-readiness-report','resolved',{connectedAfterPeerClose:still.length,connectedWriteCommittedBeforeClose:true,writeResponseReleasedAfterClose:true});await ch.adapter.close();

 let base;const token='disposable-review-token';const snapState=(await f.ok({op:'export'})).state;
 snapState.rooms[0].agents[0].transport={adapter:'fixture',state:'connected',ts};
 const dashboard=http.createServer(createDashboardHandler({project:f.project,secret:token,origin:()=>base,assets:new Map(),getRooms:async()=>({rooms:[{project:f.project}]}),getSnapshot:async()=>roomSnapshot(f.project,snapState.rooms[0],100,snapState)}));
 await new Promise(resolve=>dashboard.listen(0,'127.0.0.1',()=>{base='http://127.0.0.1:'+dashboard.address().port;resolve();}));
 try{
  const first=await fetch(base+'/api/snapshot',{headers:{authorization:'Bearer '+token}});const tag=first.headers.get('etag');const a=await first.json();
  await new Promise(resolve=>setTimeout(resolve,20));
  const second=await fetch(base+'/api/snapshot',{headers:{authorization:'Bearer '+token,'if-none-match':tag}});
  assert.equal(second.status,304);assert.equal(second.headers.get('etag'),tag);assert.equal(a.agents[0].readiness.transport.ageMs,undefined);
  record('transport-age-invalidates-snapshot-etag','resolved',{statusWithMatchingPreviousTag:second.status,etagUnchanged:true});

 }finally{dashboard.closeAllConnections();await new Promise(resolve=>dashboard.close(resolve));}

 const sid='ses_round3',id='opencode:'+sid,calls=[],prompts=[];
 const rows=Array.from({length:30},(_,i)=>({messageId:'m'+i,from:'peer',to:id,recipients:[id],body:'漢'.repeat(5300),cursor:i+1,notified:[]}));
 const plugin=await AgentRelayPlugin({directory:f.project,worktree:f.project,client:{tui:{showToast:async()=>({data:true})},session:{status:async()=>({data:{[sid]:{type:'idle'}}}),promptAsync:async value=>{prompts.push(value);return {data:{}};}}}},
  {transport:{rpc:async(_p,fields)=>{calls.push(fields);return fields.op==='inbox'?{ok:true,messages:rows,cursor:30}:{ok:true};},wait:(_p,_a,_c,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))}});
 try{
  await plugin['chat.message']({sessionID:sid},{message:{agent:'build',model:{providerID:'fixture',modelID:'fixture'}}});await flush();
  await plugin.event({event:{type:'session.idle',properties:{sessionID:sid}}});await flush();assert.equal(prompts.length,1);
  const shown=prompts[0].body.parts[0].text.split('\n').filter(l=>l.startsWith('{')).map(l=>JSON.parse(l).messageId),attempts=calls.filter(c=>c.adapter==='opencode-wake-attempted');
  assert.deepEqual(attempts.map(x=>x.messageId),shown);
  record('bounded-wake-admission','resolved',{promptMessages:shown.length,attemptMarkers:attempts.length,omittedMessagesUnfenced:30-attempts.length});
 }finally{await plugin.dispose();}
}finally{for(const broker of brokers)await broker.close();await fs.rm(root,{recursive:true,force:true,maxRetries:15,retryDelay:200});}
