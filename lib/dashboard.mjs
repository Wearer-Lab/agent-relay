import http from 'node:http';
import {promises as fs} from 'node:fs';
import {randomBytes, timingSafeEqual, createHash} from 'node:crypto';
import spawn from 'cross-spawn';
import path from 'node:path';
import {rpc, ensureBroker, defaultDataDir} from './client.mjs';
import {validateStore} from './broker.mjs';
import {projectSummaries, roomSnapshot} from './observability.mjs';

const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/dashboard.css',['dashboard.css','text/css; charset=utf-8']],['/dashboard.js',['dashboard.js','text/javascript; charset=utf-8']],['/theme.js',['theme.js','text/javascript; charset=utf-8']]]);
export function createDashboardHandler({project,secret,getSnapshot,getRooms,assets:files,origin}) {
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
  if(url.pathname==='/api/snapshot'||url.pathname==='/api/projects'){
   const auth=Buffer.from(req.headers.authorization??'');
   if(auth.length!==expected.length || !timingSafeEqual(auth,expected))return reply(401,'Open the dashboard using its CLI link.');
   try{
    const listing=await getRooms();
    let snapshot;
    if(url.pathname==='/api/projects')snapshot={...listing,preferredProject:project};
    else {
     const selected=url.searchParams.get('project')||project;
     if(!listing.rooms.some(r=>r.project===selected))return reply(404,'Project is not registered with this broker.');
     snapshot=await getSnapshot(selected);
    }
    const body=JSON.stringify(snapshot),tag=`"${createHash('sha256').update(body).digest('hex')}"`;
    res.setHeader('ETag',tag);
    if(req.headers['if-none-match']===tag){res.writeHead(304);res.end();return;}
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(body);
   }catch{reply(503,'Relay unavailable. Showing saved data until the broker reconnects.');}
   return;
  }
  const file=files.get(req.url);
  if(!file)return reply(404,'Not found.');
  res.writeHead(200,{'Content-Type':file.type});res.end(file.body);
 };
}
// Older running brokers do not implement observability RPCs. Their ledger is
// atomically replaced by the sole writer, so it is safe to read a committed
// snapshot without interrupting an agent or taking the writer lease.
export function createObserver({project,dataDir,call=rpc,ensure=ensureBroker}){
 let legacy=false,cached,key;
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
   const state=await readCommitted();return roomSnapshot(selected,state.rooms.find(r=>r.project===selected));
  }
 };
}
export async function startDashboard({project,dataDir=defaultDataDir(),port=0}){
 if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Dashboard port must be between 0 and 65535.');
 project=await fs.realpath(project);if(!(await fs.stat(project)).isDirectory())throw new Error('Project must be a directory.');
 const files=new Map();for(const [route,[file,type]] of assets)files.set(route,{type,body:await fs.readFile(new URL(`./dashboard/${file}`,import.meta.url))});
 dataDir=path.resolve(dataDir);
 await ensureBroker({dataDir});
 const observer=createObserver({project,dataDir});
 const secret=randomBytes(32).toString('hex');let base;
 const server=http.createServer(createDashboardHandler({project,secret,assets:files,origin:()=>base,
  getRooms:observer.getRooms, getSnapshot:observer.getSnapshot}));
 server.requestTimeout=15000;server.headersTimeout=10000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{base=`http://127.0.0.1:${server.address().port}`;server.off('error',reject);resolve();});});
 let closing;
 return {url:`${base}/#${secret}`,close:()=>closing??=(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));})()};
}
export async function openDashboard(url){
 const [command,args]=process.platform==='darwin'?['open',[url]]:process.platform==='win32'?['rundll32.exe',['url.dll,FileProtocolHandler',url]]:['xdg-open',[url]];
 await new Promise(resolve=>{const child=spawn(command,args,{stdio:'ignore',windowsHide:true});child.on('error',()=>{console.error('Could not open a browser automatically. Use the dashboard link above.');resolve();});child.on('exit',code=>{if(code)console.error('Could not open a browser automatically. Use the dashboard link above.');resolve();});});
}
