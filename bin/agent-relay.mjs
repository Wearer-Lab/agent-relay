#!/usr/bin/env node
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import spawn from 'cross-spawn';
import {rpc,wait,ensureBroker,defaultDataDir} from '../lib/client.mjs';

const raw=process.argv.slice(2);
let command=raw.shift()||'help';
if(['--help','-h'].includes(command))command='help';
if(['--version','-v'].includes(command))command='version';
if(raw.includes('--help')||raw.includes('-h')){command='help';raw.length=0;}
const opts={},positional=[];let tail=[];
for(let i=0;i<raw.length;i++){
 if(raw[i]==='--'){tail=raw.slice(i+1);break;}
 if(raw[i].startsWith('--')){const key=raw[i].slice(2);if(['channel','json','no-open','unread','json-lines','all','force','gate','active'].includes(key))opts[key]=true;else {if(!raw[i+1]||raw[i+1].startsWith('--'))throw new Error(`Missing value for --${key}`);opts[key]=raw[++i];}}
 else positional.push(raw[i]);
}
const project=path.resolve(opts.project||process.cwd()),dataDir=opts['data-dir']||defaultDataDir(),options={dataDir};
const print=x=>process.stdout.write(JSON.stringify(x,null,2)+'\n');
const requireAs=()=>{if(!opts.as)throw new Error('Use --as with your registered agent ID');return opts.as;};
async function main(){
 switch(command){
 case 'version':{const pkg=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));console.log(pkg.version);break;}
 case 'help':
 console.log(`Agent Relay — local communication between coding agents\n\n  npx --yes @wearer-haitch/agent-relay launch codex|claude|opencode\n  agent-relay --version\n  agent-relay dashboard [--no-open] [--port PORT]\n\n  agent-relay setup [--project PATH] [--runners codex,claude,opencode]\n  agent-relay launch claude|codex|opencode [-- runner arguments]\n  agent-relay join --as ID --runner NAME [--session ID]\n  agent-relay agents [--active --within MIN] [--stale-minutes MIN]\n  agent-relay leave --as ID\n  agent-relay send --as ID --to ID|* --message TEXT [--reply-to ID] [--id ID] [--summary TEXT] [--attach PATH ...]\n  agent-relay inbox --as ID [--unread] [--since CURSOR] [--from ID] [--limit N]\n  agent-relay fetch --as ID --id MESSAGE_ID [--out DIR]\n  agent-relay ack --as ID --id MESSAGE_ID|--all|--through CURSOR\n  agent-relay watch --as ID [--json-lines --max-chars N] [--unread]\n  agent-relay claim --as ID [--scope machine] [--gate] RESOURCE...\n  agent-relay release --as ID [--scope machine] [RESOURCE...] [--force]\n  agent-relay gate [--max-swap-gb 8] [--max-load 40] [--min-free-gb 10] [--path /]\n  agent-relay status [--as ID --state TEXT --task TEXT]\n  agent-relay attach codex --thread ID [--as ID] [--socket PATH|--url ws://loopback]\n  agent-relay start\n\nCommands use the current project; --project PATH and --data-dir PATH override it.\nMessages persist locally. Setup does not publish anything or change permissions.`);break;
 case 'daemon':{
  const {createBroker}=await import('../lib/broker.mjs');
  const broker=await createBroker({dataDir,staleMinutes:opts['stale-minutes']===undefined?Number(process.env.AGENT_RELAY_STALE_MINUTES??30):Number(opts['stale-minutes'])});
  const discovery=path.join(dataDir,'broker.json'),tmp=discovery+`.${process.pid}.tmp`;
  await fs.writeFile(tmp,JSON.stringify({pid:process.pid,url:broker.url,token:broker.token}),{mode:0o600});await fs.rename(tmp,discovery);
  if(opts['startup-lock'])await fs.rm(opts['startup-lock'],{recursive:true,force:true});
  const stop=async()=>{await broker.close();try{const current=JSON.parse(await fs.readFile(discovery,'utf8'));if(current.pid===process.pid)await fs.unlink(discovery);}catch{}process.exit(0);};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);break;
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
  const {setupProject}=await import('../lib/setup.mjs');
  print(await setupProject(project,{runners:opts.runners?.split(',')}));await ensureBroker(options);break;
 }
 case 'join': print(await rpc(project,{op:'register',agentId:requireAs(),runner:opts.runner||'generic',sessionId:opts.session},options));break;
 case 'agents': print(await rpc(project,{op:'agents',staleMinutes:opts['stale-minutes']===undefined?undefined:Number(opts['stale-minutes'])},options));break;
 case 'send':{
  let body=opts.message;if(body==='-'){body='';for await(const chunk of process.stdin)body+=chunk;}
  if(!body||!opts.to)throw new Error('Use --to and --message (or --message - for stdin)');
  print(await rpc(project,{op:'send',from:requireAs(),to:opts.to,body,replyTo:opts['reply-to'],messageId:opts.id||randomUUID()},options));break;
 }
 case 'inbox':print(await rpc(project,{op:'inbox',agentId:requireAs(),unacked:opts.unread?true:undefined,since:opts.since===undefined?undefined:Number(opts.since),from:opts.from,limit:opts.limit===undefined?undefined:Number(opts.limit)},options));break;
 case 'ack':if(!opts.id&&!opts.all&&opts.through===undefined)throw new Error('Use --id, --all or --through');print(await rpc(project,{op:'ack',agentId:requireAs(),messageId:opts.id,all:opts.all,through:opts.through===undefined?undefined:Number(opts.through)},options));break;
 case 'claim':if(!positional.length)throw new Error('Specify one or more file/resource claims');print(await rpc(project,{op:'claim',agentId:requireAs(),resources:positional,scope:opts.scope},options));break;
 case 'release':print(await rpc(project,{op:'release',agentId:requireAs(),resources:positional.length?positional:undefined,scope:opts.scope,force:opts.force},options));break;
 case 'status':print(await rpc(project,opts.as?{op:'status',agentId:opts.as,status:opts.state,task:opts.task,frozen:opts.frozen===undefined?undefined:opts.frozen==='true'}:{op:'agents',staleMinutes:opts['stale-minutes']===undefined?undefined:Number(opts['stale-minutes'])},options));break;
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
  try{await runCodexBridge({project,threadId:opts.thread,agentId:opts.as,dataDir,socket:opts.socket,url:opts.url,signal:controller.signal});}catch(e){if(!controller.signal.aborted)throw e;}break;
 }
 case 'mcp':{
  const {runMcp}=await import('../lib/mcp.mjs');
  const runner=opts.runner||'generic',sessionId=opts.session||(runner==='codex'?process.env.CODEX_THREAD_ID:runner==='claude'?process.env.CLAUDE_SESSION_ID:undefined),agentId=opts.as||(sessionId?`${runner}:${sessionId}`:undefined);
  const lifetime=new AbortController();let attachment,adapter;
  process.stdin.once('end',()=>lifetime.abort());
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
  adapter=await runMcp({project,runner,agentId,sessionId,dataDir,channel:!!opts.channel,attachCodex});
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
