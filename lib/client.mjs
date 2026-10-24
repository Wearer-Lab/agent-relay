import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
export async function ensureBroker({dataDir=defaultDataDir()}={}) {
  dataDir = path.resolve(dataDir);
  const live = await discovery(dataDir); if(live) return live;
  await fs.mkdir(dataDir,{recursive:true,mode:0o700});
  const lock = path.join(dataDir,'startup.lock');
  const end=Date.now()+15000;
  while(Date.now()<end) {
    const found=await discovery(dataDir); if(found) return found;
    let own=false;
    try { await fs.mkdir(lock,{mode:0o700}); own=true; await fs.writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,at:Date.now()}),{mode:0o600}); }
    catch(e) {
      if(e.code!=='EEXIST') throw e;
      try { const owner=JSON.parse(await fs.readFile(path.join(lock,'owner.json'),'utf8')); if(!alive(owner.pid)) await fs.rm(lock,{recursive:true,force:true}); } catch { /* Never steal an unidentifiable lock. */ }
    }
    if(own) {
      try {
        const log=await fs.open(path.join(dataDir,'broker.log'),'a',0o600);
        const child=spawn(process.execPath,[cli,'daemon','--data-dir',dataDir,'--startup-lock',lock],{detached:true,stdio:['ignore',log.fd,log.fd],windowsHide:true});
        let error; child.on('error',e=>{error=e;}); child.unref(); await log.close();
        while(Date.now()<end) {
          if(error) throw error;
          const ready=await discovery(dataDir); if(ready) return ready;
          await new Promise(r=>setTimeout(r,75));
        }
      } finally { await fs.rm(lock,{recursive:true,force:true}); }
      throw new Error(`Agent relay failed to start; see ${path.join(dataDir,'broker.log')}`);
    }
    await new Promise(r=>setTimeout(r,75));
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
    case 'compact': return ['compaction'];
    case 'leave': return fields.ifIdle!==undefined?['ephemeral']:[];
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
      return (fields.since!==undefined||fields.from!==undefined||fields.limit!==undefined||fields.unacked!==undefined)?['inbox-filters']:[];
    case 'ack': return (fields.all!==undefined||fields.through!==undefined)?['bulk-ack']:[];
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
export async function rpc(project,fields,{dataDir,signal}={}) {
  const info=await ensureBroker({dataDir});
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
