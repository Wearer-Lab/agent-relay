import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
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
function harness({getHistory}={}){
 const calls=[],state=fixture();
 const handler=createDashboardHandler({project:'/work/alpha',secret:'dashboard-secret',origin:()=> 'http://127.0.0.1:1234',assets:new Map([['/',{type:'text/html',body:'<h1>Dashboard</h1>'}]]),getRooms:async()=>({rooms:projectSummaries(state)}),getSnapshot:async project=>{calls.push(project);return roomSnapshot(project,state.rooms.find(r=>r.project===project));},getHistory});
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

test('history endpoint pages older messages with durable cursors and falls back to the window when history is absent',async()=>{
 const asked=[];
 const h=harness({getHistory:async(project,{before,limit})=>{asked.push([project,before,limit]);return {available:true,messages:[{messageId:'old',cursor:before-1}],nextCursor:before-1,done:false};}});
 const page=await h.request('/api/history?project=%2Fwork%2Falpha&before=2&limit=1');
 assert.equal(page.status,200);assert.deepEqual(JSON.parse(page.body),{available:true,messages:[{messageId:'old',cursor:1}],nextCursor:1,done:false});
 assert.deepEqual(asked,[['/work/alpha',2,1]]);
 const defaults=await h.request('/api/history?project=%2Fwork%2Falpha');assert.deepEqual(asked.at(-1),['/work/alpha',Number.MAX_SAFE_INTEGER,100]);
 assert.equal((await h.request('/api/history?project=%2Fwork%2Falpha&before=2',{headers:{authorization:''}})).status,401);
 assert.equal((await h.request('/api/history?project=%2Fwork%2Falpha&before=x')).status,400);
 assert.equal((await h.request('/api/history?project=%2Fwork%2Falpha&limit=201')).status,400);
 assert.equal((await h.request('/api/history?project=%2Fprivate%2Funregistered')).status,404);
 assert.equal((await h.request('/api/history?project=%2Fwork%2Falpha',{method:'POST'})).status,405);
 assert.equal(defaults.status,200);
 const plain=harness();
 assert.deepEqual(JSON.parse((await plain.request('/api/history?project=%2Fwork%2Falpha')).body),{available:false,messages:[],nextCursor:null,done:true});
});

test('observer feature-detects broker history paging and falls back to the labeled window when the op is absent',async t=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {createObserver}=await import('../lib/dashboard.mjs');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-history-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const asked=[];
 const paging=createObserver({project:'/work/alpha',dataDir:directory,call:async(project,fields)=>{asked.push({project,...fields});if(fields.op==='history')return {messages:[{messageId:'old',cursor:fields.before-1}],nextCursor:fields.before-1,done:false};return {rooms:[]};},ensure:async()=>{}});
 const page=await paging.getHistory('/work/alpha',{before:2,limit:5});
 assert.deepEqual(asked.at(-1),{project:'/work/alpha',op:'history',before:2,limit:5});
 assert.deepEqual(page,{available:true,messages:[{messageId:'old',cursor:1}],nextCursor:1,done:false});
 let calls=0;
 const absent=createObserver({project:'/work/alpha',dataDir:directory,call:async()=>{calls++;throw Object.assign(new Error('Old broker'),{code:'UNKNOWN_OPERATION'});},ensure:async()=>{}});
 assert.deepEqual(await absent.getHistory('/work/alpha'),{available:false,messages:[],nextCursor:null,done:true});
 assert.deepEqual(await absent.getHistory('/work/alpha',{before:1}),{available:false,messages:[],nextCursor:null,done:true});
 assert.equal(calls,1);
 const state=fixture();state.version=1;state.nextCursor=4;
 state.rooms[0].messages.push({messageId:'three',cursor:3,from:'a',to:'b',recipients:['b'],ackedBy:[],notified:[],body:'Third',createdAt:'2026-10-05T01:05:00Z'});state.rooms[0].cursor=3;
 for(const room of state.rooms)for(const agent of room.agents)Object.assign(agent,{runner:'test',registeredAt:agent.updatedAt,status:'idle',frozen:false,resources:[],task:null});
 await fs.writeFile(path.join(directory,'state.json'),JSON.stringify(state));
 const legacy=createObserver({project:'/work/alpha',dataDir:directory,call:async()=>{throw Object.assign(new Error('Old broker'),{code:'UNKNOWN_ROOM'});},ensure:async()=>{}});
 await legacy.getRooms();
 const first=await legacy.getHistory('/work/alpha',{before:3,limit:1});
 assert.equal(first.available,true);assert.deepEqual(first.messages.map(m=>m.messageId),['two']);assert.equal(first.nextCursor,2);assert.equal(first.done,false);
 const older=await legacy.getHistory('/work/alpha',{before:3,limit:2});
 assert.deepEqual(older.messages.map(m=>m.messageId),['two','one']);assert.equal(older.nextCursor,1);assert.equal(older.done,true);
});

const dashboardSource=await readFile(new URL('../lib/dashboard/dashboard.js',import.meta.url),'utf8');
const textOf=el=>(el.textContent??'')+(el.children??[]).map(textOf).join('');
const findAll=(root,pred)=>{const out=[];const walk=n=>{for(const child of n.children??[]){if(pred(child))out.push(child);walk(child);}};walk(root);return out;};
const findButton=(root,label)=>findAll(root,el=>el.tag==='button'&&el.textContent===label)[0];
const plain=value=>JSON.parse(JSON.stringify(value));
function boot({projects,snapshot,history}={}){
 const elements=new Map();
 const make=tag=>{
  const el={tag,children:[],parent:null,dataset:{},listeners:{},textContent:'',className:'',type:'',value:'',checked:false,hidden:false,disabled:false,title:'',dateTime:'',open:false,scrollTop:0,scrolled:false,
   classList:{toggle(){}},
   addEventListener(event,callback){el.listeners[event]=callback;},
   setAttribute(name,value){(el.attributes??={})[name]=value;},
   append(...nodes){for(const n of nodes){const items=n&&n.isFragment?n.children.splice(0):[n];for(const item of items){item.parent=el;el.children.push(item);}}},
   replaceChildren(...nodes){el.children=[];el.append(...nodes);},
   querySelectorAll(selector){const found=[];const walk=n=>{for(const child of n.children){if(selector==='details[open]'&&child.tag==='details'&&child.open)found.push(child);walk(child);}};walk(el);return found;},
   scrollIntoView(){el.scrolled=true;}};
  Object.defineProperty(el,'options',{get(){return el.children.filter(c=>c.tag==='option');}});
  return el;
 };
 class Option{constructor(text,value=''){this.tag='option';this.text=text;this.value=value;this.children=[];this.dataset={};}}
 const document={hidden:false,activeElement:null,cookie:'',
  getElementById(id){if(!elements.has(id))elements.set(id,make('div'));return elements.get(id);},
  createElement:make,
  createDocumentFragment(){return {isFragment:true,children:[],append(...nodes){this.children.push(...nodes);}};},
  addEventListener(){}};
 const fetchLog=[];
 const response=(body,status=200)=>({status,ok:status<400,headers:{get:()=>null},json:async()=>body});
 const fetch=async url=>{
  fetchLog.push(url);
  if(url.startsWith('/api/projects'))return response(projects??{rooms:[],preferredProject:''});
  if(url.startsWith('/api/snapshot'))return response(typeof snapshot==='function'?snapshot(url):snapshot??{project:'',agents:[],claims:[],messages:[],totalMessages:0,pendingDeliveries:0,pendingByAgent:{},cursor:0});
  if(url.startsWith('/api/history'))return response(typeof history==='function'?history(url):history??{available:false,messages:[],nextCursor:null,done:true});
  return response({error:'Not found.'},404);
 };
 const sandbox={document,location:{hash:'#dashboard-test-secret',pathname:'/'},history:{replaceState(){}},sessionStorage:{getItem:()=>null,setItem(){}},fetch,AbortSignal:{timeout:()=>({})},Option,setInterval:()=>0,queueMicrotask,setTimeout,clearTimeout};
 runInNewContext(dashboardSource,sandbox);
 const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
 return {elements,sandbox,fetchLog,flush,$:id=>elements.get(id)};
}
const agent={agentId:'a',runner:'test',status:'idle',frozen:false,task:null,updatedAt:'2026-10-05T01:00:00Z'};
const projectsOf=count=>({rooms:[{project:'/work/alpha',agentCount:1,messageCount:count,pendingDeliveries:0,lastActivityAt:null}],preferredProject:'/work/alpha'});
const windowMessages=(count,total,needles=[])=>Array.from({length:count},(_,i)=>{const cursor=total-i;return {messageId:`m${cursor}`,cursor,from:'a',to:'b',body:needles.includes(cursor)?'needle here':'hello world',createdAt:'2026-10-05T01:00:00Z',recipients:['b'],ackedBy:['b'],notified:[]};});
const windowSnapshot=(count,total,extra={})=>({project:'/work/alpha',agents:[agent],claims:[],messages:windowMessages(count,total,extra.needles),totalMessages:total,pendingDeliveries:0,pendingByAgent:{a:0},cursor:total});
test('search window label reports the full retained total alongside the searchable window',async()=>{
 const page=boot({projects:projectsOf(250),snapshot:windowSnapshot(100,250,{needles:[151,152,153]})});
 await page.flush();
 assert.equal(textOf(page.$('message-range')),'Showing 100 of 250 messages (window: latest 100) · search covers this window only');
 page.$('search').value='needle';page.$('search').listeners.input();
 assert.equal(textOf(page.$('message-range')),'Showing 3 of 250 messages (window: latest 100) · search covers this window only');
 page.$('search').value='zzz';page.$('search').listeners.input();
 assert.equal(textOf(page.$('message-range')),'Showing 0 of 250 messages (window: latest 100) · search covers this window only');
 assert.equal(page.sandbox.windowLabel(20,20,20),'Showing 20 of 20 messages (window: latest 20) · search covers the full retained history');
 assert.equal(page.sandbox.windowLabel(1,1,1),'Showing 1 of 1 message (window: latest 1) · search covers the full retained history');
 assert.equal(page.sandbox.windowLabel(0,0,0),'Showing 0 of 0 messages (window: empty)');
 assert.equal(page.sandbox.windowLabel(50,250,100,true),'Showing 50 of 250 messages (window: latest 100) · search covers this window only, older history can be loaded');
 assert.equal(page.sandbox.windowLabel(50,250,100,false),'Showing 50 of 250 messages (window: latest 100) · search covers this window only, older history is unreachable here');
});
test('load older pulls prior pages into the searchable window and falls back when the broker has no history',async()=>{
 const older=(from,count)=>Array.from({length:count},(_,i)=>{const cursor=from-i;return {messageId:`m${cursor}`,cursor,from:'b',to:'a',body:'older note',createdAt:'2026-10-05T00:00:00Z',recipients:['a'],ackedBy:[],notified:[]};});
 const page=boot({projects:projectsOf(250),snapshot:windowSnapshot(100,250),history:url=>{const before=Number(new URL(url,'http://localhost').searchParams.get('before'));return before===151?{available:true,messages:older(150,50),nextCursor:101,done:false}:{available:true,messages:older(100,100),nextCursor:1,done:true};}});
 await page.flush();
 const button=findButton(page.$('messages'),'Load older messages');assert.ok(button);assert.equal(button.parent.hidden,false);
 assert.equal(textOf(page.$('message-range')),'Showing 100 of 250 messages (window: latest 100) · search covers this window only');
 button.listeners.click();await page.flush();
 assert.ok(page.fetchLog.some(url=>url.startsWith('/api/history')&&url.includes('before=151')));
 assert.equal(textOf(page.$('message-range')),'Showing 150 of 250 messages (window: latest 150) · search covers this window only, older history can be loaded');
 assert.equal(findButton(page.$('messages'),'Load older messages').parent.hidden,false);
 findButton(page.$('messages'),'Load older messages').listeners.click();await page.flush();
 assert.ok(page.fetchLog.some(url=>url.startsWith('/api/history')&&url.includes('before=101')));
 assert.equal(textOf(page.$('message-range')),'Showing 250 of 250 messages (window: latest 250) · search covers the full retained history');
 assert.equal(findButton(page.$('messages'),'Load older messages').parent.hidden,true);
 const fallback=boot({projects:projectsOf(250),snapshot:windowSnapshot(100,250),history:{available:false,messages:[],nextCursor:null,done:true}});
 await fallback.flush();
 findButton(fallback.$('messages'),'Load older messages').listeners.click();await fallback.flush();
 assert.equal(textOf(fallback.$('message-range')),'Showing 100 of 250 messages (window: latest 100) · search covers this window only, older history is unreachable here');
 assert.equal(findButton(fallback.$('messages'),'Load older messages').parent.hidden,true);
});
const T=['2026-10-05T01:00:00Z','2026-10-05T01:01:00Z','2026-10-05T01:02:00Z','2026-10-05T01:03:00Z','2026-10-05T01:04:00Z','2026-10-05T01:05:00Z','2026-10-05T01:06:00Z'];
const oldShape={messageId:'old1',cursor:2,from:'a',to:'*',body:'Policy notice',createdAt:T[0],recipients:['b','c','d'],ackedBy:['b'],notified:[{agentId:'b',adapter:'codex',at:T[1]},{agentId:'c',adapter:'opencode-accepted',at:T[2]}]};
const newShape={messageId:'new1',cursor:1,from:'a',to:'b',body:'Status ping',createdAt:T[0],receipt:{recipients:[{agentId:'x',state:'acked',ackTs:T[5],notified:[{adapter:'codex',ts:T[4]}],accepted:[]},{agentId:'y',state:'attempted',notified:[{adapter:'opencode-attempted',ts:T[6]}],accepted:[]}]}};
test('receipts summarize every recipient from old snapshot markers and richer receipt shapes',async()=>{
 const page=boot({projects:projectsOf(2),snapshot:{project:'/work/alpha',agents:[agent],claims:[],messages:[newShape,oldShape],totalMessages:2,pendingDeliveries:3,pendingByAgent:{a:0},cursor:2}});
 await page.flush();
 assert.deepEqual(plain(page.sandbox.receiptSummary(oldShape)),{rows:[
  {agentId:'b',state:'acked',ts:T[1],adapters:['codex']},
  {agentId:'c',state:'accepted',ts:T[2],adapters:['opencode-accepted']},
  {agentId:'d',state:'stored',ts:T[0],adapters:[],reason:'no-transport-markers'}],counts:{recipients:3,acked:1,accepted:1,notified:0,attempted:0,missing:0,stored:1,pending:1}});
 assert.deepEqual(plain(page.sandbox.receiptSummary({...oldShape,ackedBy:[]})).rows[0],{agentId:'b',state:'notified',ts:T[1],adapters:['codex']});
 assert.deepEqual(plain(page.sandbox.receiptSummary({...oldShape,acks:[{agentId:'b',at:T[3]}]})).rows[0],{agentId:'b',state:'acked',ts:T[3],adapters:['codex']});
 assert.deepEqual(plain(page.sandbox.receiptSummary(newShape)),{rows:[
  {agentId:'x',state:'acked',ts:T[5],adapters:['codex']},
  {agentId:'y',state:'attempted',ts:T[6],adapters:['opencode-attempted']}],counts:{recipients:2,acked:1,accepted:0,notified:0,attempted:1,missing:0,stored:0,pending:0}});
 const summaries=findAll(page.$('messages'),el=>el.tag==='summary').map(textOf);
 assert.ok(summaries.includes('Delivery · 3 recipients · 1 acked · 1 accepted · 0 notified · 0 attempted · 0 missing · 1 stored'));
 assert.ok(summaries.includes('Delivery · 2 recipients · 1 acked · 0 accepted · 0 notified · 1 attempted · 0 missing · 0 stored'));
 const badges=findAll(page.$('messages'),el=>el.tag==='span'&&el.className.startsWith('tag')).map(textOf);
 for(const label of ['acked','accepted','stored','attempted'])assert.ok(badges.includes(label));
 assert.ok(!badges.includes('notified')||badges.includes('attempted'));
 assert.ok(findAll(page.$('messages'),el=>el.tag==='span'&&el.textContent==='2 unacked').length===1);
 const counts=page.sandbox.receiptSummary(oldShape).counts;
 assert.equal(counts.acked+counts.accepted+counts.notified+counts.attempted+counts.missing+counts.stored,counts.recipients);
});
test('attempted and notified stay distinct on legacy marker shapes',async()=>{
 const legacy={messageId:'legacy-attempted',cursor:3,from:'a',to:'*',body:'Attempted vs notified',createdAt:T[0],recipients:['n','t'],ackedBy:[],notified:[{agentId:'n',adapter:'codex',at:T[1]},{agentId:'t',adapter:'codex-attempted',at:T[2]}]};
 const page=boot({projects:projectsOf(1),snapshot:{project:'/work/alpha',agents:[agent],claims:[],messages:[legacy],totalMessages:1,pendingDeliveries:2,pendingByAgent:{a:0},cursor:3}});
 await page.flush();
 const summary=plain(page.sandbox.receiptSummary(legacy));
 assert.deepEqual(summary.rows.map(r=>({agentId:r.agentId,state:r.state})),[{agentId:'n',state:'notified'},{agentId:'t',state:'attempted'}]);
 assert.deepEqual(summary.counts,{recipients:2,acked:0,accepted:0,notified:1,attempted:1,missing:0,stored:0,pending:0});
 assert.equal(summary.counts.acked+summary.counts.accepted+summary.counts.notified+summary.counts.attempted+summary.counts.missing+summary.counts.stored,summary.counts.recipients);
 const badges=findAll(page.$('messages'),el=>el.tag==='span'&&el.className.startsWith('tag')).map(textOf);
 assert.ok(badges.includes('notified'));
 assert.ok(badges.includes('attempted'));
 const summaries=findAll(page.$('messages'),el=>el.tag==='summary').map(textOf);
 assert.ok(summaries.includes('Delivery · 2 recipients · 0 acked · 0 accepted · 1 notified · 1 attempted · 0 missing · 0 stored'));
});
test('missing renders as an explicitly negative badge and stays out of delivered counts',async()=>{
 const legacyMissing={messageId:'legacy-missing',cursor:4,from:'a',to:'b',body:'Lost delivery',createdAt:T[0],recipients:['m'],ackedBy:[],notified:[{agentId:'m',adapter:'codex-reconciled-missing',at:T[3]}]};
 const richMissing={messageId:'rich-missing',cursor:5,from:'a',to:'b',body:'Reconciled loss',createdAt:T[0],receipt:{recipients:[{agentId:'r',state:'missing',missing:[{adapter:'codex-reconciled-missing',ts:T[3]}],notified:[],accepted:[]}],pending:[{agentId:'r',reason:'operator-confirmed-missing',ts:T[3]}]}};
 const genericMissing={messageId:'generic-missing',cursor:6,from:'a',to:'b',body:'Failed push',createdAt:T[0],recipients:['g'],ackedBy:[],notified:[{agentId:'g',adapter:'push-failed',at:T[4]}]};
 const page=boot({projects:projectsOf(3),snapshot:{project:'/work/alpha',agents:[agent],claims:[],messages:[genericMissing,richMissing,legacyMissing],totalMessages:3,pendingDeliveries:3,pendingByAgent:{a:0},cursor:6}});
 await page.flush();
 const legacySummary=plain(page.sandbox.receiptSummary(legacyMissing));
 assert.equal(legacySummary.rows[0].state,'missing');
 assert.equal(legacySummary.rows[0].reason,'operator-confirmed-missing');
 assert.deepEqual(legacySummary.counts,{recipients:1,acked:0,accepted:0,notified:0,attempted:0,missing:1,stored:0,pending:1});
 const richSummary=plain(page.sandbox.receiptSummary(richMissing));
 assert.equal(richSummary.rows[0].state,'missing');
 assert.equal(richSummary.rows[0].reason,'operator-confirmed-missing');
 assert.equal(richSummary.counts.missing,1);
 assert.equal(richSummary.counts.notified,0);
 assert.equal(richSummary.counts.pending,1);
 const genericSummary=plain(page.sandbox.receiptSummary(genericMissing));
 assert.equal(genericSummary.rows[0].state,'missing');
 assert.equal(genericSummary.rows[0].reason,'negative-reconciliation');
 for(const summary of [legacySummary,richSummary,genericSummary]){
  assert.equal(summary.counts.acked+summary.counts.accepted+summary.counts.notified+summary.counts.attempted+summary.counts.missing+summary.counts.stored,summary.counts.recipients);
 }
 const badges=findAll(page.$('messages'),el=>el.tag==='span'&&el.className.startsWith('tag')).map(textOf);
 assert.ok(badges.includes('missing — confirmed not delivered'));
 assert.ok(!badges.includes('missing')||badges.includes('missing — confirmed not delivered'));
 const metas=findAll(page.$('messages'),el=>el.tag==='span'&&el.className==='meta').map(textOf);
 assert.ok(metas.some(text=>text.includes('operator-confirmed-missing')));
 assert.ok(metas.some(text=>text.includes('negative-reconciliation')));
 const summaries=findAll(page.$('messages'),el=>el.tag==='summary').map(textOf);
 assert.ok(summaries.some(text=>text.includes('1 missing')));
 assert.ok(findAll(page.$('messages'),el=>el.tag==='span'&&el.textContent==='1 unacked').length>=1);
});
test('legacy-only snapshots without richer receipt fields still render',async()=>{
 const minimal={messageId:'minimal',cursor:7,from:'a',to:'b',body:'Hello',createdAt:T[0],recipients:['b'],ackedBy:[],notified:[]};
 const bare={messageId:'bare',cursor:8,from:'a',to:'b',body:'Bare',createdAt:T[0],recipients:['b']};
 const page=boot({projects:projectsOf(2),snapshot:{project:'/work/alpha',agents:[agent],claims:[],messages:[bare,minimal],totalMessages:2,pendingDeliveries:2,pendingByAgent:{a:0},cursor:8}});
 await page.flush();
 for(const message of [minimal,bare]){
  const summary=plain(page.sandbox.receiptSummary(message));
  assert.equal(summary.rows[0].state,'stored');
  assert.equal(summary.rows[0].reason,'no-transport-markers');
  assert.equal(summary.counts.stored,1);
  assert.equal(summary.counts.acked+summary.counts.accepted+summary.counts.notified+summary.counts.attempted+summary.counts.missing+summary.counts.stored,summary.counts.recipients);
 }
 const summaries=findAll(page.$('messages'),el=>el.tag==='summary').map(textOf);
 assert.ok(summaries.includes('Delivery · 1 recipients · 0 acked · 0 accepted · 0 notified · 0 attempted · 0 missing · 1 stored'));
});
test('reply threads link parents and replies for navigation inside the loaded window',async()=>{
 const parent={messageId:'parent',cursor:2,from:'a',to:'b',body:'Root',createdAt:T[0],recipients:['b'],ackedBy:['b'],notified:[]};
 const child={messageId:'child',cursor:3,from:'b',to:'a',replyTo:'parent',body:'Reply',createdAt:T[1],recipients:['a'],ackedBy:[],notified:[]};
 const orphan={messageId:'orphan',cursor:4,from:'a',to:'b',replyTo:'gone',body:'Late',createdAt:T[2],recipients:['b'],ackedBy:['b'],notified:[]};
 const page=boot({projects:projectsOf(4),snapshot:{project:'/work/alpha',agents:[agent],claims:[],messages:[orphan,child,parent],totalMessages:4,pendingDeliveries:1,pendingByAgent:{a:0},cursor:4}});
 await page.flush();
 assert.deepEqual(plain(page.sandbox.threadView(child,[orphan,child,parent])),{parent:'parent',parentLoaded:true,replies:[]});
 assert.deepEqual(plain(page.sandbox.threadView(parent,[orphan,child,parent])),{parent:null,parentLoaded:false,replies:['child']});
 assert.deepEqual(plain(page.sandbox.threadView(orphan,[orphan,child,parent])),{parent:'gone',parentLoaded:false,replies:[]});
 assert.ok(findButton(page.$('messages'),'Reply to parent'));
 assert.ok(findButton(page.$('messages'),'child'));
 assert.ok(findAll(page.$('messages'),el=>el.tag==='span'&&el.textContent==='Reply to gone (not in this window)').length===1);
 assert.equal(findButton(page.$('messages'),'Reply to gone'),undefined);
 findButton(page.$('messages'),'child').listeners.click();
 const details=findAll(page.$('messages'),el=>el.tag==='details'&&el.dataset.message==='child')[0],row=findAll(page.$('messages'),el=>el.tag==='article'&&el.dataset.message==='child')[0];
 assert.equal(details.open,true);assert.equal(row.scrolled,true);
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
 const history=await (await fetch(link.origin+'/api/history?project='+encodeURIComponent(beta.project)+'&before=5&limit=5',{headers})).json();
 assert.equal(typeof history.available,'boolean');
 for(const file of ['/','/dashboard.js','/dashboard.css','/theme.js']){const response=await fetch(link.origin+file);assert.equal(response.status,200);assert.ok((await response.text()).length>100);}
 assert.equal(await fs.readFile(path.join(dataDir,'state.json'),'utf8'),before);
});
