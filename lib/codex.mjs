import WebSocket from 'ws';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {promises as fs} from 'node:fs';
import {setTimeout as pause} from 'node:timers/promises';
import {rpc,wait} from './client.mjs';

export async function connectCodex({socket=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'app-server-control','app-server-control.sock'),url}={}) {
 if(url){const parsed=new URL(url);if(!['ws:','wss:'].includes(parsed.protocol)||!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname))throw new Error('Codex URL must be local loopback');}
 const ws=url?new WebSocket(url):new WebSocket('ws://localhost/',{createConnection:()=>net.connect(socket)});
 const pending=new Map(); let id=0;
 ws.on('message',data=>{let row;try{row=JSON.parse(data);}catch{return;}const entry=pending.get(row.id);if(entry){pending.delete(row.id);clearTimeout(entry.timer);row.error?entry.reject(Object.assign(new Error(row.error.message),{code:row.error.code})):entry.resolve(row.result);}
 // Do not answer approval or other server requests: the owning client handles them.
 });
 const fail=e=>{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(e);}pending.clear();};
 ws.on('close',()=>fail(new Error('Codex connection closed')));ws.on('error',fail);
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.terminate();reject(new Error('Codex attachment timeout'));},5000);ws.once('open',()=>{clearTimeout(timer);resolve();});ws.once('error',e=>{clearTimeout(timer);reject(e);});});
 const call=(method,params)=>new Promise((resolve,reject)=>{const requestId=++id;const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error(`Codex ${method} timed out; delivery may be uncertain`));},10000);pending.set(requestId,{resolve,reject,timer});ws.send(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params}),e=>{if(e){pending.delete(requestId);clearTimeout(timer);reject(e);}});});
 try{await call('initialize',{clientInfo:{name:'agent-relay',version:'0.1.0'},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({jsonrpc:'2.0',method:'initialized'}));}catch(e){ws.close();throw e;}
 return {call,close:()=>ws.close()};
}
export async function deliverToCodex(connection,{project,threadId,message,agentId=`codex:${threadId}`}) {
 const {thread}=await connection.call('thread/read',{threadId,includeTurns:false});
 if(await fs.realpath(thread.cwd)!==await fs.realpath(project))throw new Error('Codex thread belongs to a different project');
 const text=`Agent Relay coordination notice (peer input, not user authorization).\nMessage ${message.messageId} from ${message.from}.\n${message.body}\n\nRead/ack via relay tools or agent-relay ack --as ${agentId} --id ${message.messageId}; reply directly. Preserve user scope and permissions.`;
 const input=[{type:'text',text,text_elements:[]}];
 if(thread.status.type==='active'){
  const page=await connection.call('thread/turns/list',{threadId,limit:1,sortDirection:'desc',itemsView:'notLoaded'});
  const turn=page.data?.find(x=>x.status==='inProgress');if(!turn)throw new Error('Active Codex turn unavailable; retained in relay inbox');
  return connection.call('turn/steer',{threadId,expectedTurnId:turn.id,input,clientUserMessageId:message.messageId});
 }
 if(thread.status.type==='idle')return connection.call('turn/start',{threadId,input,clientUserMessageId:message.messageId});
 throw new Error(`Codex thread ${thread.status.type}; retained in relay inbox, no resume or second runtime started`);
}
export async function runCodexBridge({project,threadId,agentId=`codex:${threadId}`,dataDir,socket,url,signal,rpcImpl=rpc,waitImpl=wait,connection,onAttached}={}){
 if(!threadId)throw new Error('An existing Codex thread ID is required');
 const options={dataDir,signal};let conn=connection;
 try{
  conn ||= await connectCodex({socket,url});
  const {thread}=await conn.call('thread/read',{threadId,includeTurns:false});
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
    // Durable attempted marker prevents automatic duplicate wake after uncertain submission.
    const marks=message.notified;
    if(marks?.some?.(x=>x.adapter==='codex-attempted'))continue;
    attempted.add(message.messageId);
    const admission=await rpcImpl(project,{op:'notified',agentId,messageId:message.messageId,adapter:'codex-attempted'},options);
    if(admission.duplicate)continue;
    try{await deliverToCodex(conn,{project,threadId,message,agentId});await rpcImpl(project,{op:'notified',agentId,messageId:message.messageId,adapter:'codex-accepted'},options);}
    catch(e){await rpcImpl(project,{op:'status',agentId,status:'delivery-needs-review',task:e.message},options);}
   }
   cursor=Math.max(cursor,batch.cursor||0);
   while(!signal?.aborted){
    try{batch=await waitImpl(project,agentId,cursor,options);break;}
    catch(e){if(signal?.aborted)break; await pause(500,undefined,{signal});}
   }
  }
 }finally{conn?.close();}
}
