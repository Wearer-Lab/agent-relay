import http from 'node:http';
import {promises as fs} from 'node:fs';
import {randomBytes, timingSafeEqual, createHash} from 'node:crypto';
import spawn from 'cross-spawn';
import path from 'node:path';
import {rpc, ensureBroker, defaultDataDir} from './client.mjs';
import {validateStore} from './broker.mjs';
import {projectSummaries, roomSnapshot} from './observability.mjs';

const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/dashboard.css',['dashboard.css','text/css; charset=utf-8']],['/dashboard.js',['dashboard.js','text/javascript; charset=utf-8']],['/theme.js',['theme.js','text/javascript; charset=utf-8']],['/model.js',['model.js','text/javascript; charset=utf-8']]]);
export function createDashboardHandler({project,secret,getSnapshot,getRooms,getHistory,getWork,getOwnership,getUsage,assets:files,origin}) {
 const feeds={'/api/work':getWork,'/api/ownership':getOwnership,'/api/usage':getUsage};
 const expected=Buffer.from(`Bearer ${secret}`);
 return async (req,res)=>{
  const base=origin();
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  const reply=(code,message)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:message}));};
  if(req.headers.host!==new URL(base).host || (req.headers.origin && req.headers.origin!==base))return reply(403,'Local dashboard origin required.');
  if(req.method!=='GET')return reply(405,'This dashboard is read-only.');
  let url;
  try{url=new URL(req.url,base);}catch{return reply(400,'Invalid request URL.');}
  if(url.pathname==='/api/snapshot'||url.pathname==='/api/projects'||url.pathname==='/api/history'||url.pathname in feeds){
   const auth=Buffer.from(req.headers.authorization??'');
   if(auth.length!==expected.length || !timingSafeEqual(auth,expected))return reply(401,'Open the dashboard using its CLI link.');
   try{
    const listing=await getRooms();
    let snapshot;
    if(url.pathname==='/api/projects')snapshot={...listing,preferredProject:project};
    else {
     const selected=url.searchParams.get('project')||project;
     if(!listing.rooms.some(r=>r.project===selected))return reply(404,'Project is not registered with this broker.');
     if(url.pathname==='/api/history'){
      const bound=(value,fallback)=>{if(value===null||value==='')return fallback;const n=Number(value);return Number.isSafeInteger(n)&&n>=0?n:null;};
      const before=bound(url.searchParams.get('before'),Number.MAX_SAFE_INTEGER),limit=bound(url.searchParams.get('limit'),100);
      if(before===null||limit===null||limit<1||limit>200)return reply(400,'Invalid history cursor or limit.');
      const page=getHistory?await getHistory(selected,{before,limit}):{available:false,messages:[],nextCursor:null,done:true};
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(page));return;
     }
     // Optional feeds answer {available:false} when the broker (or this dashboard) cannot supply them.
     if(url.pathname in feeds)snapshot=feeds[url.pathname]?await feeds[url.pathname](selected):{available:false};
     else snapshot=await getSnapshot(selected);
    }
    // generatedAt changes on every call; excluding it keeps conditional requests useful.
    const body=JSON.stringify(snapshot),tag=`"${createHash('sha256').update(JSON.stringify(snapshot,(key,value)=>key==='generatedAt'?undefined:value)).digest('hex')}"`;
    res.setHeader('ETag',tag);
    if(req.headers['if-none-match']===tag){res.writeHead(304);res.end();return;}
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(body);
   }catch{reply(503,'Relay unavailable. Showing saved data until the broker reconnects.');}
   return;
  }
  const file=files.get(url.pathname);
  if(!file)return reply(404,'Not found.');
  res.writeHead(200,{'Content-Type':file.type});res.end(file.body);
 };
}
// Older running brokers do not implement observability RPCs. Their ledger is
// atomically replaced by the sole writer, so it is safe to read a committed
// snapshot without interrupting an agent or taking the writer lease.
// Brokers that predate an operation answer with one of these; the dashboard then degrades quietly.
const SOFT_FAILURES=['UNKNOWN_OPERATION','UNKNOWN_ROOM','INVALID_INPUT','UNSUPPORTED_FEATURE'];
const WORK_STATUSES=['todo','in-progress','blocked','review','done','cancelled'];
// Builds a flat work tree (every task a root of kind 'task') from the plain task ledger of brokers without the tree action.
export function flatWork(tasks=[]){
 const roots=tasks.map(task=>{
  const status=task.state==='complete'?'done':task.blocked?'blocked':'todo',done=status==='done';
  return {id:String(task.id),title:String(task.title??task.id),kind:'task',status,state:task.state??null,owner:task.owner??null,priority:null,labels:[],branch:null,artifacts:[],
   blocked:task.blocked===true,blocking:task.blocking??[],progress:{done:done?1:0,total:1,percent:done?100:0},children:[],createdAt:task.createdAt??null,updatedAt:task.updatedAt??null};
 });
 const byStatus=Object.fromEntries(WORK_STATUSES.map(s=>[s,0]));for(const root of roots)byStatus[root.status]++;
 return {available:true,legacy:true,roots,counts:{byKind:{task:roots.length},byStatus}};
}
const without=({ok,...rest})=>rest;
export function createObserver({project,dataDir,call=rpc,ensure=ensureBroker}){
 let legacy=false,cached,key,historyOpen=true,treeOpen=true,ownershipOpen=true,usageOpen=true;
 async function readCommitted(){
  const handle=await fs.open(path.join(dataDir,'state.json'),'r');
  try{
   const stat=await handle.stat();
   if(stat.size>64*1024*1024)throw new Error('Relay state exceeds its storage bound.');
   const nextKey=`${stat.ino}:${stat.mtimeMs}:${stat.size}`;
   if(cached&&nextKey===key)return cached;
   const state=JSON.parse(await handle.readFile('utf8'));validateStore(state);
   cached=state;key=nextKey;return state;
  }finally{await handle.close();}
 }
 return {
  async getRooms(){
   if(!legacy){try{return await call(project,{op:'rooms'},{dataDir});}catch(error){if(!['UNKNOWN_OPERATION','UNKNOWN_ROOM','INVALID_INPUT'].includes(error.code))throw error;legacy=true;}}
   await ensure({dataDir});return {rooms:projectSummaries(await readCommitted())};
  },
  async getSnapshot(selected){
   if(!legacy)return call(selected,{op:'snapshot',limit:100},{dataDir});
   const state=await readCommitted();return roomSnapshot(selected,state.rooms.find(r=>r.project===selected),100,state);
  },
  async getHistory(selected,{before=Number.MAX_SAFE_INTEGER,limit=100}={}){
   if(!historyOpen)return {available:false,messages:[],nextCursor:null,done:true};
   if(!legacy){
    try{
     const result=await call(selected,{op:'history',before,limit},{dataDir});
     const rows=Array.isArray(result)?result:result?.messages??[];
     return {available:true,messages:rows,nextCursor:rows.at(-1)?.cursor??null,done:result?.done??rows.length<limit};
    }catch(error){
     if(!['UNKNOWN_OPERATION','UNKNOWN_ROOM','INVALID_INPUT'].includes(error.code))throw error;
     historyOpen=false;return {available:false,messages:[],nextCursor:null,done:true};
    }
   }
   const state=await readCommitted();
   const candidates=(state.rooms.find(r=>r.project===selected)?.messages??[]).filter(m=>m.cursor<before);
   const messages=candidates.slice(-limit).reverse();
   return {available:true,messages,nextCursor:messages.at(-1)?.cursor??null,done:candidates.length<=limit};
  },
  // Work tree: tasks/tree where supported, else the flat task ledger, else {available:false}.
  async getWork(selected){
   if(legacy){
    const tasks=(await readCommitted()).rooms.find(r=>r.project===selected)?.tasks;
    return tasks===undefined?{available:false}:flatWork(tasks);
   }
   if(treeOpen){
    try{
     const result=await call(selected,{op:'tasks',action:'tree'},{dataDir});
     if(Array.isArray(result?.roots))return {available:true,...without(result),roots:result.roots,counts:result.counts??{byKind:{},byStatus:{}}};
     treeOpen=false;
    }catch(error){if(SOFT_FAILURES.includes(error.code))treeOpen=false;}
   }
   try{
    const result=await call(selected,{op:'tasks',action:'list'},{dataDir});
    return Array.isArray(result?.tasks)?flatWork(result.tasks):{available:false};
   }catch{return {available:false};}
  },
  async getOwnership(selected){
   if(legacy||!ownershipOpen)return {available:false};
   try{return {available:true,...without(await call(selected,{op:'ownership'},{dataDir}))};}
   catch(error){if(!SOFT_FAILURES.includes(error.code))throw error;ownershipOpen=false;return {available:false};}
  },
  async getUsage(selected){
   if(legacy||!usageOpen)return {available:false};
   try{return {available:true,...without(await call(selected,{op:'usage'},{dataDir}))};}
   catch(error){if(!SOFT_FAILURES.includes(error.code))throw error;usageOpen=false;return {available:false};}
  }
 };
}
// `decorate` lets a caller (the preview fixture, tests) wrap or replace observer reads; the server itself stays read-only.
export async function startDashboard({project,dataDir=defaultDataDir(),port=0,decorate}){
 if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Dashboard port must be between 0 and 65535.');
 project=await fs.realpath(project);if(!(await fs.stat(project)).isDirectory())throw new Error('Project must be a directory.');
 const files=new Map();for(const [route,[file,type]] of assets)files.set(route,{type,body:await fs.readFile(new URL(`./dashboard/${file}`,import.meta.url))});
 dataDir=path.resolve(dataDir);
 await ensureBroker({dataDir});
 const observer=decorate?decorate(createObserver({project,dataDir})):createObserver({project,dataDir});
 const secret=randomBytes(32).toString('hex');let base;
 const server=http.createServer(createDashboardHandler({project,secret,assets:files,origin:()=>base,
  getRooms:observer.getRooms, getSnapshot:observer.getSnapshot, getHistory:observer.getHistory,getWork:observer.getWork,getOwnership:observer.getOwnership,getUsage:observer.getUsage}));
 server.requestTimeout=15000;server.headersTimeout=10000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{base=`http://127.0.0.1:${server.address().port}`;server.off('error',reject);resolve();});});
 let closing;
 return {url:`${base}/#${secret}`,close:()=>closing??=(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));})()};
}
export async function openDashboard(url){
 const [command,args]=process.platform==='darwin'?['open',[url]]:process.platform==='win32'?['rundll32.exe',['url.dll,FileProtocolHandler',url]]:['xdg-open',[url]];
 await new Promise(resolve=>{const child=spawn(command,args,{stdio:'ignore',windowsHide:true});child.on('error',()=>{console.error('Could not open a browser automatically. Use the dashboard link above.');resolve();});child.on('exit',code=>{if(code)console.error('Could not open a browser automatically. Use the dashboard link above.');resolve();});});
}
