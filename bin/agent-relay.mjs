#!/usr/bin/env node
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import spawn from 'cross-spawn';
import {rpc,wait,ensureBroker,defaultDataDir} from '../lib/client.mjs';
import {renameWithRetry} from '../lib/runtime.mjs';
import {sessionIdentity} from '../lib/registration.mjs';

const raw=process.argv.slice(2);
let command=raw.shift()||'help';
if(['--help','-h'].includes(command))command='help';
if(['--version','-v'].includes(command))command='version';
if(raw.includes('--help')||raw.includes('-h')){command='help';raw.length=0;}
const opts={},positional=[];let tail=[];
for(let i=0;i<raw.length;i++){
 if(raw[i]==='--'){tail=raw.slice(i+1);break;}
  if(raw[i].startsWith('--')){const key=raw[i].slice(2);if(['channel','json','no-open','unread','json-lines','all','force','gate','active','detail','dry-run','accept','decline','arrived','missing','gate-strict','blocked','set','ack','register','remove','check','refresh','offline','allow-incomplete','relinquish','ephemeral','apply','include-test','drop-identities','cascade','pretty','hide-done','if-idle','yes','always-on','url-in-env','revoke-all','revoke','persist','quick','keep','stale'].includes(key))opts[key]=true;else {if(!raw[i+1]||raw[i+1].startsWith('--'))throw new Error(`Missing value for --${key}`);if(key==='attach')(opts.attach??=[]).push(raw[++i]);else opts[key]=raw[++i];}}
 else positional.push(raw[i]);
}
const project=path.resolve(opts.project||process.cwd()),dataDir=opts['data-dir']||defaultDataDir(),options={dataDir,project};
const print=x=>process.stdout.write(JSON.stringify(x,null,2)+'\n');
const requireAs=()=>{if(!opts.as)throw new Error('Use --as with your registered agent ID');return opts.as;};
async function checkGate(){
 const {machineGate}=await import('../lib/gate.mjs');
 return machineGate({maxSwapGb:opts['max-swap-gb']===undefined?8:Number(opts['max-swap-gb']),maxLoad:opts['max-load']===undefined?40:Number(opts['max-load']),minFreeGb:opts['min-free-gb']===undefined?10:Number(opts['min-free-gb']),path:opts.path||'/',mode:opts['gate-strict']?'strict':undefined});
}
function gateReport(result){
 if(result.unknown.length)console.error(`Gate unknown: ${result.unknown.join(', ')}`);
 if(result.ok&&result.assessed&&result.assessed!=='pass')console.error(`Gate is not a measured pass: ${result.assessed} (coverage ${JSON.stringify(result.coverage)}).`);
 return result;
}
const question=async prompt=>{
  const rl=await import('node:readline/promises');
  const input=rl.createInterface({input:process.stdin,output:process.stdout});
  try{return (await input.question(prompt)).trim();}finally{input.close();}
};
const flagBool=(name)=>opts[name]===undefined?undefined:opts[name]==='true'?true:opts[name]==='false'?false:(()=>{throw new Error(`Use --${name} true|false`)})();
const splitList=(value)=>value===undefined?undefined:value.split(',').map(s=>s.trim()).filter(Boolean);
// A number from a flag or an environment variable. An empty value is no value at all.
const numOpt=(value)=>{if(value===undefined||value===null)return undefined;const text=String(value).trim();if(!text)return undefined;const number=Number(text);return Number.isFinite(number)?number:undefined;};
// The scope of a bulk cleanup. The scope fields alone select the bulk form; `--apply` never does.
const bulkScope=()=>{
 const scope={};
 if(opts.stale!==undefined)scope.stale=true;
 if(opts['idle-hours']!==undefined){const hours=numOpt(opts['idle-hours']);if(hours===undefined||hours<0)throw new Error('--idle-hours must be a nonnegative number of hours');scope.idleHours=hours;}
 if(opts.prefix!==undefined)scope.prefix=opts.prefix;
 if(opts.runner!==undefined)scope.runner=opts.runner;
 return Object.keys(scope).length?scope:null;
};
const ageText=(ms)=>{if(!Number.isFinite(ms))return 'unknown';const seconds=Math.round(ms/1000);if(seconds<60)return `${seconds}s`;const minutes=Math.round(seconds/60);if(minutes<60)return `${minutes}m`;const hours=Math.round(minutes/60);if(hours<48)return `${hours}h`;return `${Math.round(hours/24)}d`;};
// The pending breakdown, read out loud. `--json` prints the broker's own report instead.
function printPending(result){
 const counts=result.counts??{};
 console.log(`Pending deliveries: ${result.total??0}`);
 console.log(`  awaiting live agents: ${counts.live??0}`);
 console.log(`  awaiting dormant identities: ${counts.dormant??0}`);
 console.log(`  awaiting retired identities: ${counts.retired??0}`);
 console.log(`  expired (waiting for the archive): ${counts.expired??0}`);
 if(result.groups?.length){
  console.log(`\nBy ${result.by??'state'}:`);
  for(const group of result.groups)console.log(`  ${String(group.key).padEnd(24)}${group.count}`);
 }
 const rows=result.rows??[];
 console.log(`\nDeliveries (offset ${result.offset??0}, limit ${result.limit??rows.length}):`);
 if(!rows.length)console.log('  none');
 for(const row of rows)console.log(`  ${row.messageId}  ${row.from} -> ${row.to}  ${row.kind}  ${row.state}  ${ageText(row.ageMs)} old`);
 if((result.total??0)>rows.length)console.log(`  ... ${(result.total??0)-rows.length} more; use --limit and --offset, or --json for the whole report.`);
}
// The bulk cleanup report: what would change, what was kept, and why.
function printBulk(result){
 const mode=result.mode??'leave';
 console.log(`Bulk ${mode}${result.dryRun?' (dry run)':''}: ${result.total?.candidates??result.candidates?.length??0} candidate(s), ${result.total?.kept??result.kept?.length??0} kept, ${result.total?.skippedLive??result.skippedLive?.length??0} skipped as live.`);
 for(const row of result.candidates??[])console.log(`  candidate  ${row.agentId}  (${row.runner??'unknown runner'}, last seen ${ageText(row.lastSeenAgeMs)} ago)`);
 for(const row of result.kept??[]){
  const owed=row.obligations??{};
  const held=[...(owed.claims??[]).map(v=>`claim ${v}`),...(owed.machineClaims??[]).map(v=>`machine claim ${v}`),...(owed.branchClaims??[]).map(v=>`branch claim ${v}`),...(owed.handoffs??[]).map(v=>`handoff ${v}`),...(owed.processes??[]).map(v=>`process ${v}`),...(owed.tasks??[]).map(v=>`task ${v}`)];
  console.log(`  kept       ${row.agentId}  still holds ${held.length?held.join(', '):'something'}: it stays active.`);
 }
 for(const id of result.skippedLive??[])console.log(`  skipped    ${id}  is live: it is never touched.`);
 console.log(result.dryRun?'Nothing was changed. Re-run with --apply to change it.':`Changed ${result.changed??0} identity(ies).`);
}
// The clipboard is a convenience, never a requirement: the text is always printed too.
function copyToClipboard(text){
 try{
  const [command,...args]=process.platform==='darwin'?['pbcopy']:process.platform==='win32'?['clip']:['xclip','-selection','clipboard'];
  const child=spawn(command,args,{stdio:['pipe','ignore','ignore'],detached:true});
  child.on('error',()=>{});
  child.stdin.on('error',()=>{});
  child.stdin.end(text);
  child.unref();
  return true;
 }catch{return false;}
}
const daemonAlive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
async function readDiscovery(){
 try{
  const info=JSON.parse(await fs.readFile(path.join(dataDir,'broker.json'),'utf8'));
  if(!info||typeof info.pid!=='number'||typeof info.url!=='string')return null;
  return info;
 }catch{return null;}
}
async function verifiedBroker(){
 const info=await readDiscovery();
 if(!info)return null;
 if(!Number.isSafeInteger(info.pid)||info.pid<1)return null;
 let origin;
 try{
  const parsed=new URL(info.url);
  if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1')return null;
  const port=Number(parsed.port);
  if(!Number.isInteger(port)||port<1||port>65535)return null;
  origin=parsed.origin;
 }catch{return null;}
 if(typeof info.token!=='string'||!info.token)return null;
 if(!daemonAlive(info.pid))return null;
 try{
  const health=await fetch(`${origin}/health`,{signal:AbortSignal.timeout(2000)});
  if(!health.ok)return null;
  const body=await health.json();
  if(!body||body.ok!==true)return null;
 }catch{return null;}
 try{
  const probe=await fetch(`${origin}/rpc`,{method:'POST',headers:{authorization:`Bearer ${info.token}`,'content-type':'application/json'},body:JSON.stringify({op:'capabilities'}),signal:AbortSignal.timeout(2000)});
  const result=await probe.json().catch(()=>null);
  if(!probe.ok||!result||result.ok!==true)return null;
 }catch{return null;}
 try{
  const lease=JSON.parse(await fs.readFile(path.join(dataDir,'writer.lock'),'utf8'));
  if(!lease||lease.pid!==info.pid)return null;
 }catch{return null;}
 return info;
}
async function stopBroker(){
 const info=await verifiedBroker();
 if(!info)throw new Error('No live broker owns this data directory; nothing was signaled.');
 process.kill(info.pid,'SIGTERM');
 const end=Date.now()+5000;
 while(Date.now()<end){
  if(!daemonAlive(info.pid))return {stopped:true,pid:info.pid};
  await new Promise(r=>setTimeout(r,100));
 }
 throw new Error(`Broker process ${info.pid} did not stop; it was left running for manual inspection.`);
}
async function main(){
 switch(command){
  case 'version':{
   const pkg=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));
   if(!opts.detail){console.log(pkg.version);break;}
   const {SCHEMA_VERSION}=await import('../lib/broker.mjs');
   const live=await verifiedBroker();
   let protocol=null,brokerPackage=null;
   if(live){try{protocol=(await (await fetch(`${live.url}/health`,{signal:AbortSignal.timeout(2000)})).json()).version??null;}catch{}}
   if(live){try{
    const info=JSON.parse(await fs.readFile(path.join(dataDir,'broker.json'),'utf8'));
    const capabilities=await (await fetch(`${live.url}/rpc`,{method:'POST',headers:{authorization:`Bearer ${info.token}`,'content-type':'application/json'},body:JSON.stringify({op:'capabilities'}),signal:AbortSignal.timeout(5000)})).json();
    brokerPackage=capabilities.runtime?.package??null;
   }catch{}}
   print({package:pkg.version,protocol,schema:SCHEMA_VERSION,build:{node:process.version,cli:fileURLToPath(new URL(import.meta.url))},broker:live?{running:true,url:live.url,pid:live.pid,package:brokerPackage}:{running:false},dataDir});break;
  }
 case 'help':
 console.log(`Agent Relay — local communication between coding agents\n\n  npx --yes @wearer-haitch/agent-relay launch codex|claude|opencode\n  agent-relay --version\n  agent-relay dashboard [--no-open] [--port PORT]\n  agent-relay remote on [--provider tailscale|cloudflare|ngrok] [--hostname HOST] | off [--revoke-all] | status | doctor | approve <code> | deny <code> | revoke <id|all> | add claude|codex [--always-on] | test claude|codex | room add <alias> [path] | dashboard | host [--out DIR] | access [--access-client-id ID --access-client-secret SECRET]\n\n  agent-relay setup [--project PATH] [--runners codex,claude,opencode] [--check|--refresh]\n  agent-relay launch claude|codex|opencode [-- runner arguments]\n  agent-relay join --as ID --runner NAME [--session ID] [--group ID] [--ephemeral]\n  agent-relay mcp [--runner NAME] [--session ID] [--as ID] [--channel] [--ephemeral]\n  agent-relay agents [--active --within MIN] [--stale-minutes MIN] [--transport STATE] [--test true|false]\n  agent-relay leave --as ID [--if-idle] | --stale [--idle-hours N] [--prefix PREFIX] [--runner RUNNER] [--apply]\n  agent-relay retire --as ID [--relinquish] | --stale [--idle-hours N] [--prefix PREFIX] [--runner RUNNER] [--apply]\n  agent-relay send --as ID --to ID|*|*all --message TEXT [--within MIN] [--reply-to ID] [--id ID] [--summary TEXT] [--attach PATH ...]\n  agent-relay inbox --as ID [--unread] [--since CURSOR] [--from ID] [--limit N]\n  agent-relay fetch --as ID --id MESSAGE_ID [--out DIR]\n  agent-relay ack --as ID --id MESSAGE_ID|--all|--through CURSOR\n  agent-relay watch --as ID [--json-lines --max-chars N] [--unread]\n  agent-relay claim --as ID [--scope machine] [--gate] [--meta JSON] RESOURCE...\n  agent-relay release --as ID [--scope machine] [RESOURCE...] [--force]\n  agent-relay status [--as ID --state TEXT --task TEXT]\n  agent-relay attach codex --thread ID [--as ID] [--socket PATH|--url ws://loopback]\n  agent-relay diagnose-codex [--socket PATH] [--url ws://loopback] [--thread ID]\n  agent-relay outbox --as FROM [--id MESSAGE_ID] [--since CURSOR] [--limit N]\n  agent-relay receipt --id MESSAGE_ID\n  agent-relay history [--as ID] [--since CURSOR] [--before CURSOR] [--limit N] [--acked true|false] [--from ID] [--to ID] [--thread MESSAGE_ID]\n  agent-relay followup --as ID --id MESSAGE_ID [--note TEXT]\n  agent-relay bulletin [--set --title TEXT --body TEXT|--body - --source TEXT [--version N] --as ID] [--ack --as ID [--version N] [--hash H]]\n  agent-relay claim-narrow --as ID --resource PATH [--meta JSON] CHILD...\n  agent-relay handoffs\n  agent-relay handoff-request --as ID [--to ID] --reason TEXT [--meta JSON] RESOURCE...\n  agent-relay handoff-respond --as ID --id HANDOFF_ID [--accept|--decline] [--resources a,b]\n  agent-relay blocked\n  agent-relay tasks [--state open|complete] [--blocked] [--owner ID]\n  agent-relay task-upsert --as ID --title TEXT [--id ID] [--owner ID] [--blocked-by a,b] [--resources a,b] [--source-rev REV] [--verification TEXT] [--to ID] [--handoff ID]\n  agent-relay task-complete --as ID --id TASK_ID [--verification TEXT]\n  agent-relay processes [--owner ID] | --register --pid N --as ID [--command C] [--cwd D] [--port P] [--deployment D] [--note N] | --remove [--id ID] [--pid N] [--owner ID]\n  agent-relay usage\n  agent-relay pending [--by recipient|state|age|sender|kind] [--limit N] [--offset N] [--json]\n  agent-relay export [--out FILE]\n  agent-relay restore --in FILE [--dry-run] [--offline --allow-incomplete]\n  agent-relay audit-attachments\n  agent-relay group-agents [--group ID]\n  agent-relay detect-group\n  agent-relay work tree [--root ID] [--kind K] [--hide-done] [--pretty]\n  agent-relay work list [--kind K] [--status S] [--parent ID|root] [--branch B] [--label L] [--owner ID]\n  agent-relay work add --as ID --kind roadmap|phase|epic|task|todo --title T [--id ID] [--parent ID] [--owner A] [--branch B] [--priority p0-p3] [--label x,y] [--status S] [--desc TEXT] [--order N] [--artifacts a,b] [--due ISO] [--blocked-by a,b]\n  agent-relay work set --as ID --id ID [--status in-progress] [--title T] [...same fields]\n  agent-relay work move --as ID --id ID --parent ID|root [--order N]\n  agent-relay work rm --as ID --id ID [--cascade]\n  agent-relay work import --file ROADMAP.md [--as ID] [--parent ID] [--dry-run]\n  agent-relay branches [--stale-minutes MIN]\n  agent-relay branch claim NAME --as ID [--note TEXT] [--meta JSON] | release [NAME] --as ID | list | force-release NAME --as HUMAN --reason TEXT\n  agent-relay compact [--older-than-days N] [--broadcast-ttl-days N] [--direct-ttl-days N] [--drop-identities] [--apply]\n  agent-relay prune [--idle-minutes N] [--ephemeral-idle-minutes N] [--include-test] [--apply]\n  agent-relay reconcile --as ID --id MESSAGE_ID [--arrived|--missing]\n  agent-relay gate [--gate-strict] [--max-swap-gb 8] [--max-load 40] [--min-free-gb 10] [--path /]\n  agent-relay migrate --to 2 [--dry-run]        (offline: stop the broker first)\n  agent-relay doctor\n  agent-relay stop\n  agent-relay restart\n  agent-relay version [--detail]\n  agent-relay start\n  agent-relay daemon [--prune-after-minutes N] [--ephemeral-prune-minutes N] [--compact-after-days N]\n\nCommands use the current project; --project PATH and --data-dir PATH override it.\nMessages persist locally. Setup does not publish anything or change permissions.`);break;
 case 'daemon':{
  const {createBroker}=await import('../lib/broker.mjs');
  const pruneAfter=opts['prune-after-minutes']??process.env.AGENT_RELAY_PRUNE_AFTER_MINUTES,ephemeralPrune=opts['ephemeral-prune-minutes']??process.env.AGENT_RELAY_EPHEMERAL_PRUNE_MINUTES,compactAfter=opts['compact-after-days']??process.env.AGENT_RELAY_COMPACT_AFTER_DAYS;
  const broadcastTtl=numOpt(opts['broadcast-ttl-days']??process.env.AGENT_RELAY_BROADCAST_TTL_DAYS),directTtl=numOpt(opts['direct-ttl-days']??process.env.AGENT_RELAY_DIRECT_TTL_DAYS),releaseStale=numOpt(opts['release-stale-claims-hours']??process.env.AGENT_RELAY_RELEASE_STALE_CLAIMS_HOURS);
  const broker=await createBroker({dataDir,staleMinutes:opts['stale-minutes']===undefined?Number(process.env.AGENT_RELAY_STALE_MINUTES??30):Number(opts['stale-minutes']),...(pruneAfter===undefined?{}:{pruneAfterMinutes:Number(pruneAfter)}),...(ephemeralPrune===undefined?{}:{ephemeralPruneMinutes:Number(ephemeralPrune)}),...(compactAfter===undefined?{}:{compactAfterDays:Number(compactAfter)}),...(broadcastTtl===undefined?{}:{broadcastTtlDays:broadcastTtl}),...(directTtl===undefined?{}:{directTtlDays:directTtl}),...(releaseStale===undefined?{}:{releaseStaleClaimsHours:releaseStale})});
  const discovery=path.join(dataDir,'broker.json'),tmp=discovery+`.${process.pid}.tmp`;
  // The rename retries the Windows sharing failures, so a dashboard may read the file meanwhile.
  await fs.writeFile(tmp,JSON.stringify({pid:process.pid,url:broker.url,token:broker.token,api:'/api/v1/rpc'}),{mode:0o600});await renameWithRetry(tmp,discovery);
  if(opts['startup-lock'])await fs.rm(opts['startup-lock'],{recursive:true,force:true});
  const stop=async()=>{await broker.close();try{const current=JSON.parse(await fs.readFile(discovery,'utf8'));if(current.pid===process.pid)await fs.unlink(discovery);}catch{}process.exit(0);};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);break;
 }
 case 'remote':{
  const [action='status',argument]=positional;
  if(action==='gateway'){
   // The gateway runs in the foreground; `remote on` starts it in the background.
   const {startGateway,DEFAULT_GATEWAY_PORT}=await import('../lib/gateway.mjs');
   const {dashboardFor,readState,readAccess}=await import('../lib/remote.mjs');
   const local=`http://127.0.0.1:${opts.port===undefined?DEFAULT_GATEWAY_PORT:Number(opts.port)}`;
   // The public URL is only known once the tunnel is up, so the origin is resolved
   // per request: the loopback address and, once it exists, the public one.
   const origin=async()=>{const state=await readState(dataDir);return state.url?[local,state.url]:[local];};
   const dashboard=await dashboardFor({dataDir,project,origin});
   const access=await readAccess(dataDir);
   const gateway=await startGateway({dataDir,port:opts.port===undefined?DEFAULT_GATEWAY_PORT:Number(opts.port),dashboard,access});
   console.log(`Agent Relay gateway: ${gateway.url}`);
   const stop=async()=>{await gateway.close();};
   process.once('SIGINT',stop);process.once('SIGTERM',stop);break;
  }
  const remote=await import('../lib/remote.mjs');
  if(action==='on'){
   if(opts.access){
    const access=await remote.remoteAccess({dataDir,clientId:opts['access-client-id'],clientSecret:opts['access-client-secret']});
    if(!access.ok){console.error(access.message);process.exitCode=1;break;}
    console.log(access.message);
   }
   const result=await remote.remoteOn({dataDir,provider:opts.provider,port:opts.port===undefined?undefined:Number(opts.port),hostname:opts.hostname,project});
   if(!result.ok){console.error(result.message);process.exitCode=1;break;}
   console.log(`${result.message}\nPublic URL: ${result.url}`);
   if(result.next)console.log(result.next);
   if(opts.persist){
    const kept=await remote.remotePersist({dataDir,enable:true,port:result.gatewayPort});
    console.log(kept.ok?kept.message:kept.message);
   }
   break;
  }
  if(action==='off'){
   if(opts.persist){const stopped=await remote.remotePersist({dataDir,enable:false});console.log(stopped.message);}
   const result=await remote.remoteOff({dataDir,revokeAll:Boolean(opts['revoke-all']||opts.revoke)});
   console.log(result.message);break;
  }
  if(action==='access'){
   const result=await remote.remoteAccess({dataDir,clientId:opts['access-client-id'],clientSecret:opts['access-client-secret'],remove:Boolean(opts.remove)});
   if(!result.ok){console.error(result.message);process.exitCode=1;break;}
   console.log(result.message);break;
  }
  if(action==='status'){print(await remote.remoteStatus({dataDir}));break;}
  if(action==='doctor'){
   const result=await remote.remoteDoctor({dataDir,project});
   for(const check of result.checks)console.log(`${check.ok?'ok  ':'FAIL'} ${check.name}${check.detail?` — ${check.detail}`:''}`);
   if(!result.ok)process.exitCode=1;
   break;
  }
  if(action==='approve'){
   const code=argument??(opts.code??'');
   if(!code){
    // No code: list what is waiting and ask about each one.
    const {TokenStore}=await import('../lib/gateway.mjs');
    const store=await new TokenStore(dataDir).load();
    const pending=store.pendingPairings();
    if(!pending.length){console.log('Nothing is waiting for approval.');break;}
    let rooms=[];
    try{rooms=(await (await import('../lib/client.mjs')).rpc(project,{op:'rooms'})).rooms??[];}catch{}
    for(const row of pending){
     const resolved=await remote.resolveRoomFor({dataDir,repo:row.repo,branch:row.branch,rooms});
     console.log(`${row.code}  ${row.runner}  ${row.repo}${row.branch?` (${row.branch})`:''}  →  ${resolved.room??'no matching room'}`);
     if(opts.yes){
     // `--yes` means "approve the one I named". Without a code it would approve
     // every waiting request, including one an attacker queued.
     console.log('Name one code to approve with --yes: agent-relay remote approve <code> --yes');
     continue;
    }
     const answer=await question(`Approve ${row.code} for ${row.repo}? [y/N] `);
     if(!/^y(es)?$/i.test(answer)){const denied=await remote.remoteDeny({dataDir,code:row.code});console.log(denied.message);continue;}
     const result=await remote.remoteApprove({dataDir,code:row.code,alwaysOn:Boolean(opts['always-on']),ttlMs:opts['ttl-hours']?Number(opts['ttl-hours'])*3600000:undefined,agentPrefix:opts.prefix??'',project});
     console.log(result.ok?result.message:result.message);
    }
    break;
   }
   const result=await remote.remoteApprove({dataDir,code,alwaysOn:Boolean(opts['always-on']),ttlMs:opts['ttl-hours']?Number(opts['ttl-hours'])*3600000:undefined,agentPrefix:opts.prefix??'',project});
   if(!result.ok){console.error(result.message);process.exitCode=1;break;}
   console.log(result.message);break;
  }
  if(action==='deny'){
   const code=argument??(opts.code??'');
   if(!code){console.error('Usage: agent-relay remote deny <code>');process.exitCode=1;break;}
   const result=await remote.remoteDeny({dataDir,code});
   if(!result.ok){console.error(result.message);process.exitCode=1;break;}
   console.log(result.message);break;
  }
  if(action==='revoke'){
   const result=await remote.remoteRevoke({dataDir,id:argument,all:Boolean(opts.all||opts['revoke-all'])});
   if(!result.ok){console.error(result.message);process.exitCode=1;break;}
   console.log(result.message);break;
  }
  if(action==='room'){
   if(positional[1]!=='add'){console.error('Usage: agent-relay remote room add <alias> [path]');process.exitCode=1;break;}
   const result=await remote.remoteRoomAdd({dataDir,alias:positional[2]??'',project:positional[3]??project});
   console.log(result.message);break;
  }
  if(action==='add'){
   const result=await remote.remoteAdd({dataDir,project,runner:argument??'claude',alwaysOn:Boolean(opts['always-on']),urlInEnv:Boolean(opts['url-in-env'])});
   console.log(result.message);
   if(result.clipboard)console.log(result.clipboard);
   break;
  }
  if(action==='dashboard'){
   const result=await remote.remoteDashboard({dataDir,project,revoke:Boolean(opts.revoke)});
   if(!result.ok){console.error(result.message);process.exitCode=1;break;}
   console.log(`${result.message}\n${result.url}`);
   break;
  }
  if(action==='test'){
   const result=await remote.remoteTest({dataDir,runner:argument??'claude',project});
   if(!result.ok){console.error(result.message);process.exitCode=1;break;}
   console.log(result.message);break;
  }
  if(action==='host'){
   // The always-on host: the artifacts and the steps. Nothing is deployed from here.
   const {planRemoteHost,remoteHostInstructions,writeRemoteHostArtifacts}=await import('../lib/remote-host.mjs');
   const {originOf,branchOf}=await import('../lib/remote-rooms.mjs');
   const repo=await originOf(project).catch(()=>null);
   const rooms=repo?[{name:path.basename(project),repo,branch:await branchOf(project).catch(()=>'main')}]:[];
   const plan=planRemoteHost({provider:opts.provider,port:opts.port===undefined?undefined:Number(opts.port),hostname:opts.hostname,rooms});
   if(!plan.ok){console.error(plan.message);process.exitCode=1;break;}
   console.log(remoteHostInstructions(plan));
   if(opts.out){
    const written=await writeRemoteHostArtifacts({dir:opts.out,provider:opts.provider,port:opts.port===undefined?undefined:Number(opts.port),hostname:opts.hostname,rooms});
    if(!written.ok){console.error(written.message);process.exitCode=1;break;}
    console.log(`\nThe artifacts are written to ${written.dir}:`);
    for(const file of written.written)console.log(`  ${file.path}`);
   }
   const clipboard=[...plan.steps,'','On this machine:',...plan.local.steps].join('\n');
   console.log('\nCopy this (the deployment steps and the local wiring):');
   console.log(clipboard);
   console.log(copyToClipboard(clipboard)?'(copied to the clipboard)':'(the clipboard was not available; copy the text above)');
   break;
  }
  console.error(`Unknown remote action: ${action}. Use on, off, status, doctor, approve, deny, revoke, add, test, host, room or gateway.`);
  process.exitCode=1;break;
 }
 case 'dashboard':{
  const {startDashboard}=await import('../lib/dashboard.mjs');
  const dashboard=await startDashboard({project,dataDir,port:opts.port===undefined?0:Number(opts.port)});
  console.log(`Agent Relay dashboard: ${dashboard.url}\nRead-only view; press Ctrl+C to stop the dashboard.`);
  if(!opts['no-open']){const {openDashboard}=await import('../lib/dashboard.mjs');await openDashboard(dashboard.url);}
  const stop=async()=>{await dashboard.close();};process.once('SIGINT',stop);process.once('SIGTERM',stop);break;
 }
 case 'start':{const info=await ensureBroker(options);print({running:true,url:info.url,dataDir});break;}
  case 'setup':{
   const {setupProject,diagnoseSetup,refreshSetup}=await import('../lib/setup.mjs');
   if(opts.check){print(await diagnoseSetup(project));break;}
   if(opts.refresh)print(await refreshSetup(project,{runners:opts.runners?.split(',')}));
   else print(await setupProject(project,{runners:opts.runners?.split(',')}));await ensureBroker(options);break;
  }
  case 'join': print(await rpc(project,{op:'register',agentId:requireAs(),runner:opts.runner||'generic',sessionId:opts.session,groupId:opts.group,ephemeral:opts.ephemeral||undefined},options));break;
 case 'leave':case 'retire':{
  // The scope fields alone select the bulk form: `--apply` never turns one identity into a sweep.
  const scope=bulkScope();
  if(scope){
   const result=await rpc(project,{op:command,...scope,actor:opts.actor,apply:opts.apply===true?true:undefined},options);
   if(opts.json)print(result);else printBulk(result);
   break;
  }
  if(command==='leave')print(await rpc(project,{op:'leave',agentId:requireAs(),ifIdle:opts['if-idle']||undefined},options));
  else print(await rpc(project,{op:'retire',agentId:requireAs(),relinquish:opts.relinquish||undefined},options));
  break;
 }
 case 'pending':{
  const by=opts.by;
  if(by!==undefined&&!['recipient','state','age','sender','kind'].includes(by))throw new Error('Use --by recipient|state|age|sender|kind.');
  const limit=opts.limit===undefined?undefined:Number(opts.limit);
  if(limit!==undefined&&(!Number.isInteger(limit)||limit<1))throw new Error('--limit must be a positive integer.');
  const offset=opts.offset===undefined?undefined:Number(opts.offset);
  if(offset!==undefined&&(!Number.isSafeInteger(offset)||offset<0))throw new Error('--offset must be a nonnegative integer.');
  const result=await rpc(project,{op:'pending',...(by===undefined?{}:{by}),...(limit===undefined?{}:{limit}),...(offset===undefined?{}:{offset})},options);
  if(opts.json)print(result);else printPending(result);
  break;
 }
  case 'agents': print(await rpc(project,{op:'agents',active:opts.active,within:opts.within===undefined?undefined:Number(opts.within),staleMinutes:opts['stale-minutes']===undefined?undefined:Number(opts['stale-minutes']),transport:opts.transport,test:flagBool('test')},options));break;
 case 'send':{
  let body=opts.message;if(body==='-'){body='';for await(const chunk of process.stdin)body+=chunk;}
  if(!body||!opts.to)throw new Error('Use --to and --message (or --message - for stdin)');
  print(await rpc(project,{op:'send',from:requireAs(),to:opts.to,body,within:opts.within===undefined?undefined:Number(opts.within),summary:opts.summary,attachments:opts.attach?.map(f=>path.resolve(f)),replyTo:opts['reply-to'],messageId:opts.id||randomUUID()},options));break;
 }
 case 'fetch':if(!opts.id)throw new Error('Use --id MESSAGE_ID');print(await rpc(project,{op:'fetch',agentId:requireAs(),messageId:opts.id,out:path.resolve(opts.out||process.cwd())},options));break;
 case 'inbox':print(await rpc(project,{op:'inbox',agentId:requireAs(),unacked:opts.unread?true:undefined,since:opts.since===undefined?undefined:Number(opts.since),from:opts.from,limit:opts.limit===undefined?undefined:Number(opts.limit)},options));break;
 case 'ack':if(!opts.id&&!opts.all&&opts.through===undefined)throw new Error('Use --id, --all or --through');print(await rpc(project,{op:'ack',agentId:requireAs(),messageId:opts.id,all:opts.all,through:opts.through===undefined?undefined:Number(opts.through)},options));break;
  case 'gate':{const result=gateReport(await checkGate());print(result);if(!result.ok)process.exitCode=1;break;}
  case 'claim':if(opts.gate){const result=gateReport(await checkGate());if(!result.ok)throw new Error(result.reasons.join('; '));}if(!positional.length)throw new Error('Specify one or more file/resource claims');print(await rpc(project,{op:'claim',agentId:requireAs(),resources:positional,scope:opts.scope,meta:opts.meta===undefined?undefined:JSON.parse(opts.meta)},options));break;
 case 'release':print(await rpc(project,{op:'release',agentId:requireAs(),resources:positional.length?positional:undefined,scope:opts.scope,force:opts.force},options));break;
  case 'status':print(await rpc(project,opts.as?{op:'status',agentId:opts.as,status:opts.state,task:opts.task,frozen:opts.frozen===undefined?undefined:opts.frozen==='true'}:{op:'agents',active:opts.active,within:opts.within===undefined?undefined:Number(opts.within),staleMinutes:opts['stale-minutes']===undefined?undefined:Number(opts['stale-minutes']),transport:opts.transport},options));break;
  case 'outbox':print(await rpc(project,{op:'outbox',from:requireAs(),messageId:opts.id,since:opts.since===undefined?undefined:Number(opts.since),limit:opts.limit===undefined?undefined:Number(opts.limit)},options));break;
  case 'receipt':if(!opts.id)throw new Error('Use --id MESSAGE_ID');print(await rpc(project,{op:'receipt',messageId:opts.id},options));break;
  case 'history':print(await rpc(project,{op:'history',agentId:opts.as,since:opts.since===undefined?undefined:Number(opts.since),before:opts.before===undefined?undefined:Number(opts.before),limit:opts.limit===undefined?undefined:Number(opts.limit),acked:flagBool('acked'),from:opts.from,to:opts.to,threadOf:opts.thread},options));break;
  case 'followup':if(!opts.id)throw new Error('Use --id MESSAGE_ID');print(await rpc(project,{op:'requestFollowup',agentId:requireAs(),messageId:opts.id,note:opts.note},options));break;
  case 'bulletin':{
   if(opts.set){if(!opts.title||!opts.source)throw new Error('Use --title, --body and --source with --set');let body=opts.body;if(body==='-'){body='';for await(const chunk of process.stdin)body+=chunk;}if(!body)throw new Error('Use --title, --body and --source with --set');print(await rpc(project,{op:'setBulletin',agentId:requireAs(),title:opts.title,body,source:opts.source,version:opts.version===undefined?undefined:Number(opts.version)},options));}
    else if(opts.ack)print(await rpc(project,{op:'ackBulletin',agentId:requireAs(),version:opts.version===undefined?undefined:Number(opts.version),hash:opts.hash},options));
   else print(await rpc(project,{op:'getBulletin'},options));break;
  }
  case 'claim-narrow':if(!opts.resource||!positional.length)throw new Error('Use --resource PATH and child paths');print(await rpc(project,{op:'claimNarrow',agentId:requireAs(),resource:opts.resource,resources:positional,meta:opts.meta===undefined?undefined:JSON.parse(opts.meta)},options));break;
  case 'handoffs':print(await rpc(project,{op:'handoffs'},options));break;
  case 'handoff-request':if(!opts.reason||!positional.length)throw new Error('Use --reason and resource paths');print(await rpc(project,{op:'requestHandoff',agentId:requireAs(),to:opts.to,resources:positional,reason:opts.reason,meta:opts.meta===undefined?undefined:JSON.parse(opts.meta)},options));break;
  case 'handoff-respond':if(!opts.id||(!opts.accept&&!opts.decline))throw new Error('Use --id and --accept or --decline');print(await rpc(project,{op:'respondHandoff',agentId:requireAs(),id:opts.id,accept:!!opts.accept,resources:splitList(opts.resources)},options));break;
  case 'blocked':print(await rpc(project,{op:'blocked'},options));break;
  case 'tasks':print(await rpc(project,{op:'tasks',action:'list',state:opts.state,blocked:opts.blocked,owner:opts.owner},options));break;
  case 'task-upsert':if(!opts.title&&!opts.id)throw new Error('Use --title for a new task or --id to update one');print(await rpc(project,{op:'tasks',action:'upsert',agentId:requireAs(),id:opts.id,title:opts.title,owner:opts.owner,blockedBy:splitList(opts['blocked-by']),resources:splitList(opts.resources),sourceRevision:opts['source-rev'],verification:opts.verification,expectedRecipient:opts.to,handoffId:opts.handoff},options));break;
  case 'work':{
   const sub=positional[0]||'tree',asInt=(name)=>{if(opts[name]===undefined)return undefined;const n=Number(opts[name]);if(!Number.isSafeInteger(n))throw new Error(`--${name} must be an integer`);return n;};
   const parentArg=(v)=>v===undefined?undefined:v==='root'?null:v;
   const fields=()=>({kind:opts.kind,parentId:parentArg(opts.parent),status:opts.status,description:opts.desc,priority:opts.priority,labels:splitList(opts.label),order:asInt('order'),branch:opts.branch,artifacts:splitList(opts.artifacts),dueAt:opts.due,owner:opts.owner,blockedBy:splitList(opts['blocked-by']),resources:splitList(opts.resources),expectedRecipient:opts.to});
   if(sub==='tree'){const result=await rpc(project,{op:'tasks',action:'tree',rootId:opts.root,kind:opts.kind,includeDone:opts['hide-done']?false:undefined},options);if(opts.pretty)console.log((await import('../lib/workitems.mjs')).renderTree(result));else print(result);}
   else if(sub==='list')print(await rpc(project,{op:'tasks',action:'list',kind:opts.kind,status:opts.status,parentId:parentArg(opts.parent),branch:opts.branch,label:opts.label,owner:opts.owner,state:opts.state,blocked:opts.blocked},options));
   else if(sub==='add'){if(!opts.title)throw new Error('Use --title (and --kind) for a new work item');print(await rpc(project,{op:'tasks',action:'upsert',agentId:requireAs(),id:opts.id,title:opts.title,...fields()},options));}
   else if(sub==='set'){if(!opts.id)throw new Error('Use --id ITEM_ID');print(await rpc(project,{op:'tasks',action:'upsert',agentId:requireAs(),id:opts.id,title:opts.title,...fields()},options));}
   else if(sub==='move'){if(!opts.id||opts.parent===undefined)throw new Error('Use --id ITEM_ID --parent ID|root');print(await rpc(project,{op:'tasks',action:'move',agentId:requireAs(),id:opts.id,parentId:parentArg(opts.parent),order:asInt('order')},options));}
   else if(sub==='rm'||sub==='remove'){if(!opts.id)throw new Error('Use --id ITEM_ID');print(await rpc(project,{op:'tasks',action:'remove',agentId:requireAs(),id:opts.id,cascade:opts.cascade?true:undefined},options));}
   else if(sub==='import'){if(!opts.file)throw new Error('Use --file ROADMAP.md');const markdown=await fs.readFile(path.resolve(opts.file),'utf8');print(await rpc(project,{op:'tasks',action:'import',agentId:opts['dry-run']?opts.as:requireAs(),markdown,parentId:parentArg(opts.parent),dryRun:opts['dry-run']?true:undefined},options));}
   else throw new Error('Use work tree|list|add|set|move|rm|import');
   break;
  }
  case 'task-complete':if(!opts.id)throw new Error('Use --id TASK_ID');print(await rpc(project,{op:'tasks',action:'complete',agentId:requireAs(),id:opts.id,verification:opts.verification},options));break;
  case 'processes':{
   if(opts.register){if(opts.pid===undefined)throw new Error('Use --pid with --register');print(await rpc(project,{op:'processes',action:'register',agentId:requireAs(),pid:Number(opts.pid),command:opts.command,cwd:opts.cwd,port:opts.port===undefined?undefined:Number(opts.port),deployment:opts.deployment,note:opts.note},options));}
   else if(opts.remove)print(await rpc(project,{op:'processes',action:'remove',agentId:opts.owner,id:opts.id,pid:opts.pid===undefined?undefined:Number(opts.pid)},options));
   else print(await rpc(project,{op:'processes',action:'list',agentId:opts.owner},options));break;
  }
  case 'usage':print(await rpc(project,{op:'usage'},options));break;
  case 'export':{
   const result=await rpc(project,{op:'export'},options);
   if(!opts.out)print(result);
   else{
    const dest=path.resolve(opts.out);
    let overwrote=false;
    try{
     const seen=await fs.lstat(dest);
     if(seen.isSymbolicLink())throw new Error(`Refusing to export to symlink destination ${dest}; choose a regular file.`);
     if(seen.isDirectory())throw new Error(`Export destination ${dest} is a directory; choose a regular file.`);
     overwrote=true;
    }catch(e){
     if(e.code!=='ENOENT')throw e;
    }
    const mode=0o600;
    const tmp=`${dest}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp,JSON.stringify(result),{mode});
    await fs.chmod(tmp,mode);
    await fs.rename(tmp,dest);
    print({exported:dest,schemaVersion:result.schemaVersion,rooms:result.state.rooms.length,mode:mode.toString(8),overwrote});
   }
   break;
  }
  case 'restore':{
   if(!opts.in)throw new Error('Use --in FILE');
   if(opts.offline){
    const live=await verifiedBroker();
    if(live)throw new Error(`A live broker owns this data directory (${live.url} pid ${live.pid}); stop it first, then retry offline restore.`);
    const payload=JSON.parse(await fs.readFile(path.resolve(opts.in),'utf8'));
    const {offlineRestore}=await import('../lib/broker.mjs');
    print(await offlineRestore(dataDir,payload.state??payload,{allowIncomplete:opts['allow-incomplete'],dryRun:opts['dry-run'],schemaVersion:payload.schemaVersion}));
    break;
   }
   const payload=JSON.parse(await fs.readFile(path.resolve(opts.in),'utf8'));
   print(await rpc(project,{op:'restore',state:payload.state??payload,schemaVersion:payload.schemaVersion,dryRun:opts['dry-run'],allowIncomplete:opts['allow-incomplete']},options));break;
  }
  case 'audit-attachments':print(await rpc(project,{op:'auditAttachments',dryRun:true},options));break;
  case 'migrate':{
   // The migration is offline: the broker must not own the data directory while it runs.
   const live=await verifiedBroker();
   if(live)throw new Error('A live broker owns this data directory (pid '+live.pid+'); stop it with `agent-relay stop` before migrating.');
   const {planMigration,migrateState,isSchema2,backupStateFile,writeStateFile}=await import('../lib/schema2.mjs');
   const {validateStore}=await import('../lib/broker.mjs');
   const to=Number(opts.to??2);
   if(to!==2)throw new Error('Use --to 2.');
   const file=path.join(dataDir,'state.json');
   const state=JSON.parse(await fs.readFile(file,'utf8'));
   if(isSchema2(state)){print({ok:true,already:true,message:'This ledger is already on schema 2.'});break;}
   const plan=planMigration(state,{to});
   if(opts['dry-run']){print({ok:true,dryRun:true,...plan});break;}
   const backup=await backupStateFile(file);
   const {state:next,report}=migrateState(state,{to});
   validateStore(next);
   const written=await writeStateFile(file,next);
   print({ok:true,backup:backup.path,written:written.path,...report});
   break;
  }
  case 'group-agents':print(await rpc(project,{op:'groupAgents',groupId:opts.group},options));break;
  case 'detect-group':print(await rpc(project,{op:'detectGroup'},options));break;
  case 'compact':print(await rpc(project,{op:'compact',olderThanDays:opts['older-than-days']===undefined?undefined:Number(opts['older-than-days']),broadcastTtlDays:numOpt(opts['broadcast-ttl-days']),directTtlDays:numOpt(opts['direct-ttl-days']),dropIdentities:opts['drop-identities']?true:undefined,dryRun:!opts.apply},options));break;
  case 'prune':print(await rpc(project,{op:'prune',idleMinutes:opts['idle-minutes']===undefined?undefined:Number(opts['idle-minutes']),ephemeralIdleMinutes:opts['ephemeral-idle-minutes']===undefined?undefined:Number(opts['ephemeral-idle-minutes']),includeTest:opts['include-test']||undefined,dryRun:!opts.apply},options));break;
  case 'branches':print(await rpc(project,{op:'ownership',staleMinutes:opts['stale-minutes']===undefined?undefined:Number(opts['stale-minutes'])},options));break;
  case 'branch':{
   const [action,name]=positional;
   if(action==='claim'){if(!name)throw new Error('Use branch claim NAME --as ID');print(await rpc(project,{op:'branches',action:'claim',agentId:requireAs(),branch:name,note:opts.note,meta:opts.meta===undefined?undefined:JSON.parse(opts.meta)},options));}
   else if(action==='release')print(await rpc(project,{op:'branches',action:'release',agentId:requireAs(),branch:name},options));
   else if(action==='force-release'){if(!name||!opts.reason)throw new Error('Use branch force-release NAME --as HUMAN --reason TEXT');print(await rpc(project,{op:'branches',action:'forceRelease',agentId:requireAs(),branch:name,reason:opts.reason},options));}
   else if(action==='list'||action===undefined)print(await rpc(project,{op:'branches',action:'list',staleMinutes:opts['stale-minutes']===undefined?undefined:Number(opts['stale-minutes'])},options));
   else throw new Error('Use branch claim|release|list|force-release');
   break;
  }
  case 'reconcile':{
   if(!opts.id||(!opts.arrived&&!opts.missing))throw new Error('Use --id MESSAGE_ID with --arrived or --missing');
   const {reconcileCodexDelivery}=await import('../lib/codex.mjs');
   print(await reconcileCodexDelivery((target,fields)=>rpc(target,fields,options),{project,agentId:requireAs(),messageId:opts.id,arrived:!!opts.arrived}));break;
  }
  case 'diagnose-codex':{
   const {diagnoseCodexAttachment}=await import('../lib/codex.mjs');
   print(await diagnoseCodexAttachment({socket:opts.socket,url:opts.url,threadId:opts.thread,project}));break;
  }
  case 'doctor':{
   const live=await verifiedBroker();
   const {validateStore}=await import('../lib/broker.mjs');
   let store=null;
   try{
    const bytes=await fs.readFile(path.join(dataDir,'state.json'),'utf8');
    const parsed=JSON.parse(bytes);validateStore(parsed);
    store={valid:true,bytes:bytes.length,rooms:parsed.rooms.length,messages:parsed.rooms.reduce((n,r)=>n+r.messages.length,0)};
   }catch(e){store={valid:false,error:e.message};}
   let usage=null;
   if(live){try{const full=await rpc(project,{op:'usage'},options);usage={messages:full.messages,store:full.store,nearLimit:full.nearLimit,pending:full.pending,warnings:full.warnings,blockers:full.blockers};}catch(e){usage={error:e.message};}}
   print({dataDir,broker:live?{running:true,pid:live.pid,url:live.url}:{running:false},store,usage,tokenPresent:await fs.access(path.join(dataDir,'token')).then(()=>true).catch(()=>false)});break;
  }
  case 'stop':print(await stopBroker());break;
  case 'restart':{
   const before=await rpc(project,{op:'usage'},options).catch(()=>null);
   const stopped=await stopBroker().catch(error=>{if(before)throw error;return null;});
   const {ensureBroker:ensure}=await import('../lib/client.mjs');
   const info=await ensure({dataDir});
   const after=await rpc(project,{op:'usage'},options);
   const preserved=before?{rooms:before.rooms.count,messages:before.messages.used,agents:before.agents.stored}:null;
   const current={rooms:after.rooms.count,messages:after.messages.used,agents:after.agents.stored};
   print({restarted:true,stoppedPid:stopped?.pid??null,startedUrl:info.url,preserved,current,matches:preserved?JSON.stringify(preserved)===JSON.stringify(current):null});break;
  }
 case 'watch':{
  const agentId=requireAs(),controller=new AbortController();
  process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
  const max=opts['max-chars']===undefined?16384:Number(opts['max-chars']);
  if(!Number.isInteger(max)||max<0)throw new Error('--max-chars must be a nonnegative integer');
  const {watchMessages,preview}=await import('../lib/watch.mjs');
  await watchMessages({project,agentId,dataDir,signal:controller.signal,unread:!!opts.unread,onMessage:message=>{
   if(opts['json-lines'])process.stdout.write(JSON.stringify(preview(message,max))+'\n');else print(message);
  }});break;
 }
 case 'attach':{
  if(positional[0]!=='codex')throw new Error('Manual attachment currently supports codex; Claude uses launch, OpenCode uses its project plugin');
  const {runCodexBridge}=await import('../lib/codex.mjs');const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
   try{await runCodexBridge({project,threadId:opts.thread,agentId:opts.as,dataDir,socket:opts.socket,url:opts.url,signal:controller.signal});}catch(e){if(controller.signal.aborted)break;try{const {diagnoseCodexAttachment}=await import('../lib/codex.mjs');console.error(JSON.stringify(await diagnoseCodexAttachment({socket:opts.socket,url:opts.url,threadId:opts.thread,project})));}catch{}throw e;}break;
 }
 case 'mcp':{
  const {runMcp}=await import('../lib/mcp.mjs');
  const runner=opts.runner||'generic',sessionId=opts.session||(runner==='codex'?process.env.CODEX_THREAD_ID:runner==='claude'?process.env.CLAUDE_SESSION_ID:undefined),agentId=opts.as||process.env.AGENT_RELAY_AGENT_ID||(sessionId?sessionIdentity(runner,sessionId):undefined);
  const lifetime=new AbortController();let attachment,adapter;
  process.stdin.once('end',()=>{lifetime.abort();adapter?.close().catch(()=>{});});
  const attachCodex=runner==='codex'?async ({threadId,agentId:boundAgentId})=>{
   if(attachment){if(attachment.threadId!==threadId)throw new Error('This relay connection already targets another thread');return attachment.ready;}
   let resolve,reject;const ready=new Promise((yes,no)=>{resolve=yes;reject=no;});
   attachment={threadId,ready};
   const {runCodexBridge}=await import('../lib/codex.mjs');
   runCodexBridge({project,threadId,agentId:boundAgentId,dataDir,signal:lifetime.signal,
    onAttached:info=>resolve({attached:true,...info})}).catch(e=>{
     reject(e);attachment=undefined;
     if(!lifetime.signal.aborted)process.stderr.write(`Relay push attachment unavailable: ${e.message}\n`);
    });
   return ready;
  }:undefined;
  adapter=await runMcp({project,runner,agentId,sessionId,dataDir,channel:!!opts.channel,attachCodex,ephemeral:opts.ephemeral?true:undefined});
  const previousClose=adapter.server.onclose;
  adapter.server.onclose=()=>{lifetime.abort();previousClose?.();};
  if(attachCodex&&sessionId)attachCodex({threadId:sessionId,agentId:adapter.agentId}).catch(()=>{});
  break;
 }
 case 'launch':{
  const runner=positional[0];if(!['claude','codex','opencode'].includes(runner))throw new Error('Choose claude, codex or opencode');
  const {setupProject}=await import('../lib/setup.mjs');await setupProject(project,{runners:[runner]});await ensureBroker(options);
  const args=runner==='claude'?['--dangerously-load-development-channels','server:agent-relay',...tail]:tail;
  const child=spawn(runner,args,{cwd:project,stdio:'inherit',env:{...process.env,AGENT_RELAY_HOME:dataDir}});
  child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('exit',(code)=>{process.exitCode=code||0;});break;
 }
 default:throw new Error(`Unknown command ${command}; run agent-relay help`);
 }
}
main().catch(e=>{console.error(`agent-relay: ${e.message}`);process.exitCode=1;});
