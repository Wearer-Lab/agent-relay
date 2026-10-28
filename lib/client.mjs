import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveNodeRuntime, recordNodeRuntime } from './runtime.mjs';

// The daemon is a Node program. A host that is not Node (Bun, an OpenCode
// binary) must resolve a real Node runtime instead of spawning process.execPath.
export { resolveNodeRuntime, recordNodeRuntime };

export function defaultDataDir() {
  if (process.env.AGENT_RELAY_HOME) return path.resolve(process.env.AGENT_RELAY_HOME);
  const base = process.platform === 'win32' ? (process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local'))
    : process.platform === 'darwin' ? path.join(os.homedir(),'Library','Application Support')
    : (process.env.XDG_DATA_HOME || path.join(os.homedir(),'.local','share'));
  return path.join(base,'agent-relay');
}
const cli = fileURLToPath(new URL('../bin/agent-relay.mjs',import.meta.url));
const alive = pid => { try { process.kill(pid,0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function discovery(dataDir) {
  try {
    const info = JSON.parse(await fs.readFile(path.join(dataDir,'broker.json'),'utf8'));
    const u = new URL(info.url);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !info.token || !alive(info.pid)) return null;
    const response = await fetch(`${u.origin}/health`,{signal:AbortSignal.timeout(1000)});
    return response.ok ? info : null;
  } catch { return null; }
}
// The writer lease is ownership of the durable ledger. A live holder owns the
// directory even when its discovery file cannot be read (yet).
async function liveOwner(dataDir) {
  try {
    const lease = JSON.parse(await fs.readFile(path.join(dataDir,'writer.lock'),'utf8'));
    if (!lease || !Number.isSafeInteger(lease.pid) || lease.pid < 1) return null;
    return alive(lease.pid) ? { pid: lease.pid } : null;
  } catch { return null; }
}
// One refusal per owning process: a client that starts again and again must
// not fill the directory with the same complaint.
export async function recordOwnerRefusal(dataDir, pid, { now = Date.now(), logFile } = {}) {
  const file = logFile ?? path.join(dataDir, 'owner-refusal.log');
  let existing = '';
  try { existing = await fs.readFile(file,'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const marker = `pid=${pid} `;
  if (existing.split('\n').some(line => line.includes(marker))) return { recorded: false, file };
  await fs.appendFile(file, `${new Date(now).toISOString()} ${marker}another-live-broker\n`, { mode: 0o600 });
  return { recorded: true, file };
}
export async function ensureBroker({dataDir=defaultDataDir(), project='', startupTimeoutMs=15000}={}) {
  dataDir = path.resolve(dataDir);
  const live = await discovery(dataDir); if(live) return live;
  await fs.mkdir(dataDir,{recursive:true,mode:0o700});
  const lock = path.join(dataDir,'startup.lock');
  const end=Date.now()+startupTimeoutMs;
  let owner=null;
  while(Date.now()<end) {
    const found=await discovery(dataDir); if(found) return found;
    const holder=await liveOwner(dataDir);
    if(holder){ owner=holder; await new Promise(r=>setTimeout(r,75)); continue; }
    let own=false;
    try { await fs.mkdir(lock,{mode:0o700}); own=true; await fs.writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,at:Date.now()}),{mode:0o600}); }
    catch(e) {
      if(e.code!=='EEXIST') throw e;
      try { const lockOwner=JSON.parse(await fs.readFile(path.join(lock,'owner.json'),'utf8')); if(!alive(lockOwner.pid)) await fs.rm(lock,{recursive:true,force:true}); } catch { /* Never steal an unidentifiable lock. */ }
    }
    if(own) {
      try {
        const runtime=await resolveNodeRuntime({project,dataDir});
        await recordNodeRuntime(dataDir,runtime);
        const log=await fs.open(path.join(dataDir,'broker.log'),'a',0o600);
        const child=spawn(runtime.command,[cli,'daemon','--data-dir',dataDir,'--startup-lock',lock],{detached:true,stdio:['ignore',log.fd,log.fd],windowsHide:true,env:{...process.env,AGENT_RELAY_DAEMON:'1'}});
        let error; child.on('error',e=>{error=e;}); child.unref(); await log.close();
        while(Date.now()<end) {
          if(error) throw new Error(`Agent relay could not start its broker with ${runtime.command}: ${error.message}`);
          const ready=await discovery(dataDir); if(ready) return ready;
          await new Promise(r=>setTimeout(r,75));
        }
      } finally { await fs.rm(lock,{recursive:true,force:true}); }
      throw new Error(`Agent relay failed to start; see ${path.join(dataDir,'broker.log')}`);
    }
    await new Promise(r=>setTimeout(r,75));
  }
  if(owner){
    await recordOwnerRefusal(dataDir,owner.pid);
    throw new Error(`Another live broker owns this data directory (pid ${owner.pid}); it is not answering. Stop it with \`agent-relay stop --data-dir ${dataDir}\`, or wait for it to finish starting.`);
  }
  throw new Error(`Agent relay startup is locked; inspect ${lock}`);
}
const workKeys=['kind','parentId','status','description','priority','labels','order','branch','artifacts','dueAt','label'];
function workFeatures(fields){
  if(fields.action==='tree')return ['work-items','work-tree'];
  if(fields.action==='import')return ['work-items','work-import'];
  return fields.action==='move'||fields.action==='remove'||workKeys.some(key=>fields[key]!==undefined)?['work-items']:[];
}
function requiredFeatures(fields){
  switch(fields.op){
    case 'claimNarrow': return ['claim-narrow'];
    case 'retire': return ['retire'];
    case 'requestHandoff': case 'respondHandoff': case 'handoffs': case 'blocked': return ['handoffs'];
    case 'outbox': case 'receipt': return ['receipts'];
    case 'requestFollowup': return ['followups'];
    case 'history': return ['history'];
    case 'setBulletin': case 'getBulletin': case 'ackBulletin': return ['bulletins'];
    case 'processes': return ['process-records'];
    case 'tasks': return ['tasks',...workFeatures(fields)];
    case 'usage': case 'export': case 'restore': case 'auditAttachments': return ['storage-maintenance'];
    case 'groupAgents': case 'detectGroup': return ['groups'];
    case 'claim': case 'release': {
      const out = [];
      if(fields.scope!==undefined||fields.force!==undefined) out.push('machine-claims');
      if(fields.meta!==undefined) out.push('claim-provenance');
      return out;
    }
    case 'register': return [...(fields.groupId!==undefined?['groups']:[]),...(fields.ephemeral!==undefined?['ephemeral']:[])];
    case 'prune': return ['prune'];
    case 'pending': return ['pending'];
    case 'staleClaims': return ['stale-claims'];
    case 'compact': return [...(fields.broadcastTtlDays!==undefined||fields.directTtlDays!==undefined?['delivery-ttl']:[]),'compaction'];
    case 'leave': case 'retire': {
      const bulk = fields.stale!==undefined||fields.idleHours!==undefined||fields.prefix!==undefined||fields.runner!==undefined;
      return [...(bulk?['bulk-cleanup']:[]),...(fields.ifIdle!==undefined?['ephemeral']:[])];
    }
    case 'agents': {
      const out = [];
      if(fields.transport!==undefined) out.push('readiness');
      if(fields.active!==undefined||fields.within!==undefined||fields.staleMinutes!==undefined) out.push('presence');
      return out;
    }
    case 'status': {
      const out = [];
      if(fields.transport!==undefined) out.push('readiness');
      if(fields.git!==undefined) out.push('git-context');
      return out;
    }
    case 'branches': return ['branch-claims'];
    case 'ownership': return ['ownership'];
    case 'inbox':
      return [...((fields.since!==undefined||fields.from!==undefined||fields.limit!==undefined||fields.unacked!==undefined)?['inbox-filters']:[]),
        ...(fields.session!==undefined?['delivery-receipts']:[])];
    case 'wait': return fields.session!==undefined?['delivery-receipts']:[];
    case 'ack': return [...((fields.all!==undefined||fields.through!==undefined)?['bulk-ack']:[]),
      ...(fields.session!==undefined?['delivery-receipts']:[])];
    case 'send': {
      const out = [];
      if(fields.attachments!==undefined) out.push('attachments');
      if(fields.summary!==undefined) out.push('summary');
      if(fields.to==='*all'||fields.within!==undefined) out.push('live-broadcast');
      return out;
    }
    case 'fetch': return ['attachments'];
    default: return [];
  }
}
// Remote mode: when AGENT_RELAY_URL is set the relay lives somewhere else. The
// gateway decides which room the request belongs to from the token, so no local
// path and no broker discovery happens here.
// A cloud agent without a token asks to join and waits for a person to approve it.
export async function pairForAccess({url,repo,branch='',runner='remote',waitMs=10*60*1000,pollMs=3000,sessionId='',onCode=()=>{},signal}={}){
  const response=await fetch(`${url.replace(/\/+$/,'')}/pair`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repo,branch,runner,sessionId}),signal});
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(body.error??`The gateway refused the pairing request (${response.status}).`),{code:'PAIRING_REFUSED'});
  onCode(body.code);
  const deadline=Date.now()+waitMs;
  while(Date.now()<deadline){
   await new Promise(resolve=>setTimeout(resolve,pollMs));
   const polled=await fetch(`${url.replace(/\/+$/,'')}/pair/${body.requestId}`,{signal}).catch(()=>null);
   if(!polled)continue;
   const answer=await polled.json().catch(()=>({}));
   if(answer.status==='approved'&&answer.token)return answer.token;
   if(answer.error)throw Object.assign(new Error(answer.error),{code:'PAIRING_DENIED'});
  }
  throw Object.assign(new Error('Nobody approved the request in time. Ask again when your teammate is at the machine.'),{code:'PAIRING_TIMEOUT'});
}

// The token is kept for the session, but only for the gateway and the
// repository it was paired for: a token for one room must never be sent to
// another.
let sessionToken=null;
let sessionTokenKey=null;
export async function remoteRpc(project,fields,{signal,url=process.env.AGENT_RELAY_URL,token=process.env.AGENT_RELAY_TOKEN,pollMs=3000}={}){
  if(!url)throw new Error('Remote mode needs AGENT_RELAY_URL.');
  const headers={'content-type':'application/json'};
  if(!token){
   const {originOf,branchOf}=await import('./remote-rooms.mjs');
   const repo=await originOf(project);
   if(!repo)throw Object.assign(new Error('Remote mode needs a token, and this project has no git origin to pair with.'),{code:'NO_TOKEN'});
   const key=`${url}|${repo}`;
   // A token paired earlier in this session is kept in memory, never written
   // down, and only for this gateway and this repository.
   token=sessionTokenKey===key?sessionToken:null;
   if(!token){
    token=await pairForAccess({url,repo,branch:await branchOf(project),runner:fields.runner??'remote',sessionId:fields.sessionId??'',signal,pollMs,
     onCode:code=>console.error(`Ask your teammate to run: agent-relay remote approve ${code}`)});
    sessionToken=token;sessionTokenKey=key;
   }
  }
  headers.authorization=`Bearer ${token}`;
  let response;
  try{
   response=await fetch(`${url.replace(/\/+$/,'')}/rpc`,{method:'POST',headers,body:JSON.stringify(fields),signal});
  }catch(error){
   const codes=new Set();
   for(let cause=error;cause&&cause!==cause.cause;cause=cause.cause){if(cause.code)codes.add(cause.code);if(Array.isArray(cause.errors))for(const inner of cause.errors)if(inner.code)codes.add(inner.code);}
   if(codes.has('ENOTFOUND')||codes.has('EAI_AGAIN'))throw Object.assign(new Error(`The tunnel at ${url} is not answering. Run \`agent-relay remote on\` again.`),{code:'TUNNEL_DOWN'});
   if(codes.has('ECONNREFUSED')){
    // A refused connection is either a dead tunnel or a dead gateway: the local
    // gateway answers /health, so it says which one it is.
    const local=process.env.AGENT_RELAY_LOCAL_PORT;
    let alive=false;
    if(local){try{alive=(await fetch(`http://127.0.0.1:${local}/health`,{signal:AbortSignal.timeout(1500)})).ok;}catch{alive=false;}}
    throw Object.assign(new Error(alive
     ?`The tunnel at ${url} is not answering, but the gateway is up. Run \`agent-relay remote on\` again.`
     :`The relay gateway at ${url} is not answering. Check that it is running with \`agent-relay remote on\`.`),{code:alive?'TUNNEL_DOWN':'GATEWAY_OFF'});
   }
   throw Object.assign(new Error(`The relay gateway at ${url} could not be reached: ${error.message}`),{code:'TUNNEL_DOWN'});
  }
  const text=await response.text();
  let result={};
  try{result=text?JSON.parse(text):{};}catch{result={};}
  if(response.status===401)throw Object.assign(new Error(result.error??'This relay token is not valid. Ask for a new one with `agent-relay remote approve`.'),{code:'TOKEN_REJECTED'});
  if(response.status===403)throw Object.assign(new Error(result.error??'This relay token may not do that.'),{code:'OP_DENIED'});
  if(response.status===429)throw Object.assign(new Error(result.error??'The relay gateway is rate limiting this client.'),{code:'RATE_LIMITED',retryAfter:Number(response.headers.get('retry-after'))||result.retryAfter||null});
  if(!response.ok||result.ok===false)throw Object.assign(new Error(result.error?.message??result.error??`Relay HTTP ${response.status}`),{code:result.error?.code??result.code??'GATEWAY_ERROR'});
  return result;
}

/** The local broker, always. Room discovery is a local question, so it never
 *  goes through a remote gateway. */
export async function localRpc(project,fields,{dataDir,signal}={}){
  const previous=process.env.AGENT_RELAY_URL;
  delete process.env.AGENT_RELAY_URL;
  try{return await rpc(project,fields,{dataDir,signal});}
  finally{if(previous===undefined)delete process.env.AGENT_RELAY_URL;else process.env.AGENT_RELAY_URL=previous;}
}

export async function rpc(project,fields,{dataDir,signal}={}) {
  if(process.env.AGENT_RELAY_URL)return remoteRpc(project,fields,{signal});
  const info=await ensureBroker({dataDir,project});
  // Brokers advertise the endpoint they speak in the discovery file. Older ones only know /rpc.
  const endpoint=info.api??'/rpc';
  const features=requiredFeatures(fields);
  if(features.length){
    const check=await fetch(`${info.url}${endpoint}`,{method:'POST',headers:{authorization:`Bearer ${info.token}`,'content-type':'application/json'},body:JSON.stringify({op:'capabilities'}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
    const capabilities=await check.json();
    const missing=Array.isArray(capabilities?.features)?features.filter(f=>!capabilities.features.includes(f)):features.slice();
    if(!check.ok||!capabilities.ok||missing.length){
      const names=missing.length?missing:features;
      const error=new Error(`This broker does not advertise ${names.join(', ')}; ask the owner to restart it when ready. No operation was submitted.`);error.code='UNSUPPORTED_FEATURE';throw error;
    }
  }
  const response=await fetch(`${info.url}${endpoint}`,{method:'POST',headers:{authorization:`Bearer ${info.token}`,'content-type':'application/json'},body:JSON.stringify({project:path.resolve(project),...fields}),signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(fields.op==='wait'?35000:10000)]) : AbortSignal.timeout(fields.op==='wait'?35000:10000)});
  const result=await response.json();
  if(!response.ok || !result.ok) {const e=new Error(result.error?.message || `Relay HTTP ${response.status}`); e.code=result.error?.code; e.details=result.error; throw e;}
  return result;
}
export const wait=(project,agentId,after=0,options={})=>rpc(project,{op:'wait',agentId,after,timeoutMs:25000},options);
