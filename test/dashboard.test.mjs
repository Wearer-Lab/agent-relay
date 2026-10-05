import test from 'node:test';
import assert from 'node:assert/strict';
import {createDashboardHandler} from '../lib/dashboard.mjs';
import {projectSummaries,roomSnapshot} from '../lib/observability.mjs';

const fixture=()=>({rooms:[{project:'/work/alpha',cursor:2,agents:[{agentId:'a',updatedAt:'2026-10-05T01:00:00Z'},{agentId:'b',updatedAt:'2026-10-05T01:01:00Z'}],claims:[{resource:'build',agentId:'a',claimedAt:'2026-10-05T01:02:00Z'}],messages:[{messageId:'one',cursor:1,from:'a',to:'b',recipients:['b'],ackedBy:['b'],notified:[],body:'Question?',createdAt:'2026-10-05T01:03:00Z'},{messageId:'two',cursor:2,from:'b',to:'*',recipients:['a'],ackedBy:[],notified:[],body:'Reply',createdAt:'2026-10-05T01:04:00Z'}]},{project:'/work/beta',cursor:0,agents:[],messages:[],claims:[]}]});
test('observability summarizes all rooms and isolates, bounds, and clones a project snapshot without changing state',()=>{
 const state=fixture(),before=JSON.stringify(state),summary=projectSummaries(state);
 assert.deepEqual(summary.map(r=>r.project),['/work/alpha','/work/beta']);assert.equal(summary[0].pendingDeliveries,1);assert.equal(summary[1].lastActivityAt,null);
 const view=roomSnapshot('/work/alpha',state.rooms[0],1);assert.equal(view.messages.length,1);assert.equal(view.messages[0].messageId,'two');assert.equal(view.totalMessages,2);assert.deepEqual(view.pendingByAgent,{a:1,b:0});
 view.agents[0].agentId='changed';view.messages[0].ackedBy.push('a');assert.equal(JSON.stringify(state),before);
 assert.deepEqual(roomSnapshot('/work/beta',state.rooms[1]).messages,[]);
});
function harness(){
 const calls=[],state=fixture();
 const handler=createDashboardHandler({project:'/work/alpha',secret:'dashboard-secret',origin:()=> 'http://127.0.0.1:1234',assets:new Map([['/',{type:'text/html',body:'<h1>Dashboard</h1>'}]]),getRooms:async()=>({rooms:projectSummaries(state)}),getSnapshot:async project=>{calls.push(project);return roomSnapshot(project,state.rooms.find(r=>r.project===project));}});
 const request=async(url,options={})=>{const response={headers:{},status:0,body:'',setHeader(k,v){this.headers[k.toLowerCase()]=v;},writeHead(status,headers={}){this.status=status;for(const [k,v] of Object.entries(headers))this.setHeader(k,v);},end(body=''){this.body=body;}};await handler({url,method:'GET',headers:{host:'127.0.0.1:1234',authorization:'Bearer dashboard-secret',...options.headers},...options,headers:{host:'127.0.0.1:1234',authorization:'Bearer dashboard-secret',...options.headers}},response);return response;};
 return {request,calls};
}
test('dashboard requires its own read-only token and trusted origin; refuses writes and unknown projects',async()=>{
 const h=harness();
 assert.equal((await h.request('/api/projects',{headers:{authorization:''}})).status,401);
 assert.equal((await h.request('/api/projects',{headers:{host:'attacker.example'}})).status,403);
 assert.equal((await h.request('/api/projects',{headers:{origin:'https://attacker.example'}})).status,403);
 assert.equal((await h.request('/api/snapshot',{method:'POST'})).status,405);
 assert.equal((await h.request('/api/snapshot?project=%2Fprivate%2Funregistered')).status,404);assert.deepEqual(h.calls,[]);
 const projects=await h.request('/api/projects');assert.equal(projects.status,200);assert.equal(JSON.parse(projects.body).rooms.length,2);
 assert.equal((await h.request('/')).status,200);assert.match((await h.request('/')).headers['content-security-policy'],/frame-ancestors 'none'/);
 assert.equal((await h.request('/../token')).status,404);
});
test('one dashboard switches projects and returns conditional snapshots with no writes',async()=>{
 const h=harness();const alpha=await h.request('/api/snapshot?project=%2Fwork%2Falpha');assert.equal(alpha.status,200);assert.equal(JSON.parse(alpha.body).messages.length,2);
 const beta=await h.request('/api/snapshot?project=%2Fwork%2Fbeta');assert.equal(JSON.parse(beta.body).messages.length,0);assert.deepEqual(h.calls,['/work/alpha','/work/beta']);
 assert.equal((await h.request('/api/snapshot?project=%2Fwork%2Falpha',{headers:{'if-none-match':alpha.headers.etag}})).status,304);
});

test('legacy observer reads committed history without restarting, writing, or swallowing broker faults',async t=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {createObserver}=await import('../lib/dashboard.mjs');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-observer-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const state=fixture();state.version=1;state.nextCursor=3;
 for(const room of state.rooms)for(const agent of room.agents)Object.assign(agent,{runner:'test',registeredAt:agent.updatedAt,status:'idle',frozen:false,resources:[],task:null});
 await fs.writeFile(path.join(directory,'state.json'),JSON.stringify(state));const before=await fs.readFile(path.join(directory,'state.json'),'utf8');
 let calls=0,healthChecks=0;
 const observer=createObserver({project:'/work/unregistered',dataDir:directory,call:async()=>{calls++;throw Object.assign(new Error('Old broker'),{code:'UNKNOWN_ROOM'});},ensure:async()=>{healthChecks++;}});
 assert.equal((await observer.getRooms()).rooms.length,2);assert.equal((await observer.getSnapshot('/work/alpha')).messages.length,2);
 await observer.getRooms();assert.equal(calls,1);assert.equal(healthChecks,2);assert.equal(await fs.readFile(path.join(directory,'state.json'),'utf8'),before);
 const broken=createObserver({project:'/work/alpha',dataDir:directory,call:async()=>{throw Object.assign(new Error('disk fault'),{code:'STORE_IO'});}});
 await assert.rejects(broken.getRooms(),/disk fault/);
});

test('real dashboard serves packaged assets and discovers two broker rooms through authenticated HTTP',async t=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {createBroker}=await import('../lib/broker.mjs'),{startDashboard}=await import('../lib/dashboard.mjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-dashboard-http-')),dataDir=path.join(root,'data'),project=path.join(root,'one'),other=path.join(root,'two');
 await Promise.all([dataDir,project,other].map(dir=>fs.mkdir(dir)));const broker=await createBroker({dataDir});let dashboard;
 t.after(async()=>{await dashboard?.close();await broker.close();await fs.rm(root,{recursive:true,force:true});});
 await fs.writeFile(path.join(dataDir,'broker.json'),JSON.stringify({pid:process.pid,url:broker.url,token:broker.token}));
 const write=async(fields,room=project)=>{const response=await fetch(broker.url+'/rpc',{method:'POST',headers:{authorization:'Bearer '+broker.token,'content-type':'application/json'},body:JSON.stringify({project:room,...fields})});const result=await response.json();assert.equal(result.ok,true,JSON.stringify(result));return result;};
 await write({op:'register',agentId:'a',runner:'test'});await write({op:'register',agentId:'b',runner:'test'},other);
 const before=await fs.readFile(path.join(dataDir,'state.json'),'utf8');dashboard=await startDashboard({project,dataDir});
 const link=new URL(dashboard.url),headers={authorization:'Bearer '+link.hash.slice(1)};
 assert.equal((await fetch(link.origin+'/api/projects')).status,401);
 const projects=await (await fetch(link.origin+'/api/projects',{headers})).json();assert.equal(projects.rooms.length,2);
 const beta=projects.rooms.find(r=>r.project.endsWith(path.sep+'two'));
 const view=await (await fetch(link.origin+'/api/snapshot?project='+encodeURIComponent(beta.project),{headers})).json();assert.equal(view.agents[0].agentId,'b');
 for(const file of ['/','/dashboard.js','/dashboard.css','/theme.js']){const response=await fetch(link.origin+file);assert.equal(response.status,200);assert.ok((await response.text()).length>100);}
 assert.equal(await fs.readFile(path.join(dataDir,'state.json'),'utf8'),before);
});
