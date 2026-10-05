import {rpc,wait} from './client.mjs';
export function preview(message,maxChars=16384){
 const chars=Array.from(message.body);
 return {id:message.messageId,from:message.from,createdAt:message.createdAt,replyTo:message.replyTo??null,
  body:chars.slice(0,maxChars).join(''),truncated:chars.length>maxChars};
}
async function backoff(ms,signal){
 if(signal.aborted)return;
 await new Promise(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});});
}
export async function watchMessages({project,agentId,dataDir,signal,unread=false,onMessage,call=rpc,poll=wait,pause=backoff}){
 let cursor=0,delay=100;
 while(!signal.aborted){
  try{
   const batch=await call(project,{op:'inbox',agentId,since:cursor,unacked:unread},{dataDir,signal});
   for(const message of batch.messages??[]){await onMessage(message);cursor=Math.max(cursor,message.cursor);}
   await poll(project,agentId,cursor,{dataDir,signal});delay=100;
  }catch(error){
   if(signal.aborted)break;
   if(typeof error.code==='string'&&!['BROKER_UNAVAILABLE','STORE_IO','ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE','ENOTFOUND'].includes(error.code))throw error;
   await pause(delay,signal);delay=Math.min(delay*2,5000);
  }
 }
}
