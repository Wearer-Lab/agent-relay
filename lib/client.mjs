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
export async function rpc(project,fields,{dataDir,signal}={}) {
  const info=await ensureBroker({dataDir});
  const response=await fetch(`${info.url}/rpc`,{method:'POST',headers:{authorization:`Bearer ${info.token}`,'content-type':'application/json'},body:JSON.stringify({project:path.resolve(project),...fields}),signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(fields.op==='wait'?35000:10000)]) : AbortSignal.timeout(fields.op==='wait'?35000:10000)});
  const result=await response.json();
  if(!response.ok || !result.ok) {const e=new Error(result.error?.message || `Relay HTTP ${response.status}`); e.code=result.error?.code; throw e;}
  return result;
}
export const wait=(project,agentId,after=0,options={})=>rpc(project,{op:'wait',agentId,after,timeoutMs:25000},options);
