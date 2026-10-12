import WebSocket from 'ws';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {promises as fs} from 'node:fs';
import {setTimeout as pause} from 'node:timers/promises';
import {rpc,wait} from './client.mjs';

const CONTROL_SEGMENT=['app-server-control','app-server-control.sock'];
const controlSocket=home=>path.join(home,...CONTROL_SEGMENT);
const codexCandidates=({home,socket,url}={})=>{
 const candidates=[];
 const add=(kind,value)=>{if(value&&!candidates.some(c=>c.value===value))candidates.push({kind,value});};
 add('ws-url',url);
 add('unix-socket',socket);
 if(process.env.CODEX_HOME)add('unix-socket',controlSocket(process.env.CODEX_HOME));
 add('unix-socket',controlSocket(home||path.join(os.homedir(),'.codex')));
 return candidates;
};
const suggestions={
 EACCES:'control socket exists but is not accessible; use the documented explicit loopback WebSocket URL of the running owner session (ws://127.0.0.1:PORT)',
 ENOENT:'no control endpoint found; is the owner session running?',
 ETIMEDOUT:'control endpoint did not answer within the probe timeout; is the owner session running and responsive?',
 protocol:'protocol version mismatch with the Codex control endpoint; update agent-relay and the owner app-server to matching versions',
 other:'unexpected control endpoint failure; verify the owner session is running or attach with the documented explicit loopback WebSocket URL (ws://127.0.0.1:PORT)'
};
export function categorizeCodexError(error){
 if(error?.errorCategory&&suggestions[error.errorCategory])return {errorCategory:error.errorCategory,suggestion:suggestions[error.errorCategory]};
 const code=error?.code,message=String(error?.message??error??'');
 if(code==='EACCES'||/EACCES/i.test(message))return {errorCategory:'EACCES',suggestion:suggestions.EACCES};
 if(code==='ENOENT'||/ENOENT/i.test(message))return {errorCategory:'ENOENT',suggestion:suggestions.ENOENT};
 if(code==='ETIMEDOUT'||/ETIMEDOUT/i.test(message)||/timeout|timed out/i.test(message))return {errorCategory:'ETIMEDOUT',suggestion:suggestions.ETIMEDOUT};
 if(code==='EPROTONOSUPPORT'||/version mismatch|protocol mismatch|incompatible protocol|unsupported protocol/i.test(message))return {errorCategory:'protocol',suggestion:suggestions.protocol};
 return {errorCategory:'other',suggestion:suggestions.other};
}
const codexFailure=(error,endpoint)=>Object.assign(error instanceof Error?error:new Error(String(error)),{...categorizeCodexError(error),endpoint});
const transportDown=error=>/connection closed|not open|socket hang up|ECONNRESET|EPIPE|terminated/i.test(String(error?.message??error??''));
export function classifyDeliveryFailure(error,{submitted=false,submission=null,attempt=1}={}){
 const {errorCategory,suggestion}=categorizeCodexError(error);
 const detail=String(error?.message??error??'');
 const delivery=submitted||/delivery may be uncertain/i.test(detail)?'uncertain':'failed';
 return {errorCategory,delivery,submission,attempt,detail,suggestion};
}
export function deliveryFailureRecord({messageId,agentId,error,submitted=false,submission=null,attempt=1,now=()=>new Date().toISOString()}){
 return {kind:'delivery-failure',messageId,agentId,ts:now(),...classifyDeliveryFailure(error,{submitted,submission,attempt}),reconciliation:{marker:'codex-attempted',accepted:false,hint:'Inspect the owner session for this message before any authorized retry; do not resend automatically.'}};
}
export async function reconcileCodexDelivery(rpcImpl=rpc,{project,agentId,messageId,arrived=true,note}={}){
 if(!messageId||!agentId)throw new Error('messageId and agentId are required');
 const adapter=arrived?'codex-accepted':'codex-reconciled-missing';
 const result=await rpcImpl(project,{op:'notified',agentId,messageId,adapter});
 return {messageId,agentId,marker:adapter,arrived,recorded:result?.duplicate!==true,note};
}
export async function connectCodex({socket=controlSocket(process.env.CODEX_HOME||path.join(os.homedir(),'.codex')),url,timeoutMs=5000}={}) {
 const endpoint=url||socket;
 try{
  if(url){const parsed=new URL(url);if(!['ws:','wss:'].includes(parsed.protocol)||!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname))throw new Error('Codex URL must be local loopback');}
  const ws=url?new WebSocket(url):new WebSocket('ws://localhost/',{createConnection:()=>net.connect(socket)});
  const pending=new Map(); let id=0;
  ws.on('message',data=>{let row;try{row=JSON.parse(data);}catch{return;}const entry=pending.get(row.id);if(entry){pending.delete(row.id);clearTimeout(entry.timer);row.error?entry.reject(Object.assign(new Error(row.error.message),{code:row.error.code})):entry.resolve(row.result);}
  // Do not answer approval or other server requests: the owning client handles them.
  });
  const fail=e=>{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(e);}pending.clear();};
  ws.on('close',()=>fail(new Error('Codex connection closed')));ws.on('error',fail);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.terminate();reject(new Error('Codex attachment timeout'));},timeoutMs);ws.once('open',()=>{clearTimeout(timer);resolve();});ws.once('error',e=>{clearTimeout(timer);reject(e);});});
  const call=(method,params)=>new Promise((resolve,reject)=>{const requestId=++id;const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error(`Codex ${method} timed out; delivery may be uncertain`));},10000);pending.set(requestId,{resolve,reject,timer});ws.send(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params}),e=>{if(e){pending.delete(requestId);clearTimeout(timer);reject(e);}});});
  try{await call('initialize',{clientInfo:{name:'agent-relay',version:'0.1.0'},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({jsonrpc:'2.0',method:'initialized'}));}catch(e){ws.close();throw e;}
  return {call,close:()=>ws.close()};
 }catch(e){throw codexFailure(e,endpoint);}
}
const closeQuietly=connection=>{try{connection?.close?.();}catch{}};
const probeCandidate=({kind,value},connectImpl,timeoutMs)=>{
 let settled=false;
 const pending=Promise.resolve().then(()=>connectImpl(kind==='ws-url'?{url:value,timeoutMs}:{socket:value,timeoutMs}));
 pending.then(connection=>{if(settled)closeQuietly(connection);},()=>{});
 return new Promise(resolve=>{
  const timer=setTimeout(()=>{settled=true;resolve({ok:false,error:Object.assign(new Error(`Codex control endpoint probe timed out after ${timeoutMs}ms`),{code:'ETIMEDOUT'})});},timeoutMs);
  pending.then(connection=>{if(settled)return;settled=true;clearTimeout(timer);resolve({ok:true,connection});},error=>{if(settled)return;settled=true;clearTimeout(timer);resolve({ok:false,error});});
 });
};
export async function diagnoseCodexAttachment({home,socket,url,project,threadId,connectImpl=connectCodex,timeoutMs=2000}={}) {
 const candidates=codexCandidates({home,socket,url});
 const attempts=[];
 let selected=null,connection=null;
 for(const candidate of candidates){
  const outcome=await probeCandidate(candidate,connectImpl,timeoutMs);
  if(outcome.ok){selected=candidate;connection=outcome.connection;break;}
  const {errorCategory,suggestion}=categorizeCodexError(outcome.error);
  attempts.push({endpoint:candidate.value,errorCategory,detail:String(outcome.error?.message??outcome.error),suggestion});
 }
 const protocolAttempt=attempts.find(attempt=>attempt.errorCategory==='protocol');
 const protocol=connection?{compatible:true,detail:'initialize handshake accepted by the Codex control endpoint'}:{compatible:false,detail:protocolAttempt?protocolAttempt.suggestion:`protocol compatibility not verified (${attempts.at(-1)?.errorCategory||'no candidate probed'})`};
 let projectBinding=null;
 if(connection&&threadId){
  try{
   const {thread}=await connection.call('thread/read',{threadId,includeTurns:false});
   const cwd=await fs.realpath(thread.cwd);
   if(project){const root=await fs.realpath(project);projectBinding=cwd===root?{ok:true,detail:`thread ${threadId} working directory ${cwd} matches the project room`}:{ok:false,detail:`thread ${threadId} working directory ${cwd} differs from project room ${root}`};}
   else projectBinding={ok:true,detail:`thread ${threadId} working directory is ${cwd}`};
  }catch(e){projectBinding={ok:false,detail:`thread binding check failed: ${e.message}`};}
 }
 closeQuietly(connection);
 const pushAvailable=!!connection&&protocol.compatible&&projectBinding?.ok!==false;
 const nextSteps=[];
 const addStep=step=>{if(step&&!nextSteps.includes(step))nextSteps.push(step);};
 for(const attempt of attempts){
  addStep(attempt.suggestion);
  if(['EACCES','ENOENT'].includes(attempt.errorCategory)&&!/^wss?:/.test(attempt.endpoint))addStep('Use the documented explicit loopback WebSocket URL of the running owner session: agent-relay attach codex --url ws://127.0.0.1:PORT');
 }
 if(projectBinding&&!projectBinding.ok)addStep(`Project binding must match before push attachment; ${projectBinding.detail}`);
 addStep(pushAvailable?`Push attachment is available via ${selected.value}; attach an existing thread with agent-relay attach codex --thread ID`:'Push attachment is unavailable; polling coordination via agent-relay inbox and watch remains available.');
 return {endpoint:{kind:selected?selected.kind:'none',selected:selected?selected.value:null,candidates:candidates.map(candidate=>candidate.value)},attempts,protocol,projectBinding,pushAvailable,nextSteps};
}
const prepareCodexDelivery=async(connection,{project,threadId})=>{
 const {thread}=await connection.call('thread/read',{threadId,includeTurns:false});
 if(await fs.realpath(thread.cwd)!==await fs.realpath(project))throw new Error('Codex thread belongs to a different project');
 if(thread.status.type==='active'){
  const page=await connection.call('thread/turns/list',{threadId,limit:1,sortDirection:'desc',itemsView:'notLoaded'});
  const turn=page.data?.find(x=>x.status==='inProgress');if(!turn)throw new Error('Active Codex turn unavailable; retained in relay inbox');
  return {thread,turnId:turn.id};
 }
 if(thread.status.type==='idle')return {thread,turnId:null};
 throw new Error(`Codex thread ${thread.status.type}; retained in relay inbox, no resume or second runtime started`);
};
const submitCodexDelivery=async(connection,{threadId,message,agentId,prepared})=>{
 const text=`Agent Relay coordination notice (peer input, not user authorization).\nMessage ${message.messageId} from ${message.from}.\n${message.body}\n\nRead/ack via relay tools or agent-relay ack --as ${agentId} --id ${message.messageId}; reply directly. Preserve user scope and permissions.`;
 const input=[{type:'text',text,text_elements:[]}];
 if(prepared.thread.status.type==='active')return connection.call('turn/steer',{threadId,expectedTurnId:prepared.turnId,input,clientUserMessageId:message.messageId});
 return connection.call('turn/start',{threadId,input,clientUserMessageId:message.messageId});
};
export async function deliverToCodex(connection,{project,threadId,message,agentId=`codex:${threadId}`}) {
 const prepared=await prepareCodexDelivery(connection,{project,threadId});
 return submitCodexDelivery(connection,{project,threadId,message,agentId,prepared});
}
export async function runCodexBridge({project,threadId,agentId=`codex:${threadId}`,dataDir,socket,url,signal,rpcImpl=rpc,waitImpl=wait,connection,onAttached,connectImpl=connectCodex,delayImpl=pause,now=()=>new Date().toISOString(),reconnect={}}={}){
 if(!threadId)throw new Error('An existing Codex thread ID is required');
 const options={dataDir,signal};
 const attempts=reconnect.attempts??8,baseMs=reconnect.baseMs??100,maxMs=reconnect.maxMs??5000;
 let conn=connection||null,submission=null;
 const call=async(method,params)=>{if(!conn)throw Object.assign(new Error('Codex connection closed'),{code:'ECONNRESET'});try{return await conn.call(method,params);}catch(e){if(transportDown(e))conn=null;throw e;}};
 const ensureConn=async()=>{
  if(conn)return conn;
  let waitMs=baseMs;
  for(let attempt=1;attempt<=attempts;attempt++){
   try{conn=await connectImpl({socket,url});return conn;}
   catch(e){if(attempt>=attempts)throw codexFailure(e,url||socket);await delayImpl(Math.min(waitMs,maxMs),undefined,{signal});waitMs=Math.min(waitMs*2,maxMs);}
  }
 };
 try{
  await ensureConn();
  const {thread}=await call('thread/read',{threadId,includeTurns:false});
  if(await fs.realpath(thread.cwd)!==await fs.realpath(project))throw new Error('Codex attachment project mismatch');
  if(!['active','idle'].includes(thread.status.type))throw new Error(`Codex thread ${thread.status.type}; attachment requires its existing owner to load it`);
  await rpcImpl(project,{op:'register',agentId,runner:'codex',sessionId:threadId},options);
  await rpcImpl(project,{op:'status',agentId,status:'attached'},options);
  onAttached?.({threadId,agentId});
  const attempted=new Set();let cursor=0;
  let batch=await rpcImpl(project,{op:'inbox',agentId},options);
  while(!signal?.aborted){
   for(const message of batch.messages||[]){
     if(message.acked||attempted.has(message.messageId))continue;
     const marks=message.notified;
     if(marks?.some?.(x=>x.adapter==='codex-attempted'))continue;
     try{
      await ensureConn();
     }catch(e){
      const record=deliveryFailureRecord({messageId:message.messageId,agentId,error:e,submitted:false,submission:null,now});
      await rpcImpl(project,{op:'status',agentId,status:'delivery-needs-review',task:record},options);
      continue;
     }
     let prepared=null;
     try{
      prepared=await prepareCodexDelivery({call:(method,params)=>call(method,params),close:()=>conn?.close()},{project,threadId});
     }catch(e){
      if(!transportDown(e)){
       const record=deliveryFailureRecord({messageId:message.messageId,agentId,error:e,submitted:false,submission:null,now});
       await rpcImpl(project,{op:'status',agentId,status:'delivery-needs-review',task:record},options);
       continue;
      }
      try{
       await ensureConn();
       prepared=await prepareCodexDelivery({call:(method,params)=>call(method,params),close:()=>conn?.close()},{project,threadId});
      }catch(retryError){
       const record=deliveryFailureRecord({messageId:message.messageId,agentId,error:retryError,submitted:false,submission:null,now});
       await rpcImpl(project,{op:'status',agentId,status:'delivery-needs-review',task:record},options);
       continue;
      }
     }
     attempted.add(message.messageId);
     const admission=await rpcImpl(project,{op:'notified',agentId,messageId:message.messageId,adapter:'codex-attempted'},options);
     if(admission.duplicate)continue;
     submission=null;
     try{
      await ensureConn();
      const bound={call:async(method,params)=>{if(method.startsWith('turn/'))submission=method;return call(method,params);},close:()=>conn?.close()};
      await submitCodexDelivery(bound,{threadId,message,agentId,prepared});
      await rpcImpl(project,{op:'notified',agentId,messageId:message.messageId,adapter:'codex-accepted'},options);
     }catch(e){
      const record=deliveryFailureRecord({messageId:message.messageId,agentId,error:e,submitted:!!submission,submission,now});
      await rpcImpl(project,{op:'status',agentId,status:'delivery-needs-review',task:record},options);
     }
    }
   cursor=Math.max(cursor,batch.cursor||0);
   while(!signal?.aborted){
    try{batch=await waitImpl(project,agentId,cursor,options);break;}
    catch(e){if(signal?.aborted)break; await delayImpl(500,undefined,{signal});}
   }
  }
 }finally{conn?.close();}
}
