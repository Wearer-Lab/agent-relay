import test from 'node:test';
import assert from 'node:assert/strict';
import {createDashboardHandler,createObserver,flatWork} from '../lib/dashboard.mjs';
import {boot,modelContext,textOf,findAll,byClass,findButton,plain} from './dashboard-dom.mjs';

const ago=minutes=>new Date(Date.now()-minutes*60000).toISOString();
const node=(id,title,kind,status,extra={})=>({id,title,kind,status,state:status==='done'?'complete':'open',owner:null,priority:null,labels:[],branch:null,artifacts:[],blocked:status==='blocked',blocking:[],children:[],createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-14T00:00:00Z',...extra});
const roadmap=()=>node('RM','Launch','roadmap','in-progress',{children:[
 node('PH1','Foundations','phase','in-progress',{owner:'atlas',children:[
  node('EP1','Work tree','epic','in-progress',{owner:'atlas',branch:'feat/tree',labels:['broker'],children:[
   node('T1','Tree op','task','done',{owner:'atlas',branch:'feat/tree'}),
   node('T2','Fallback','task','blocked',{owner:'vector',branch:'feat/tree',labels:['compat']}),
   node('T3','Validation','task','todo',{owner:'vector',children:[node('D1','Bound labels','todo','done'),node('D2','Reject cycles','todo','in-progress')]})]})]}),
 node('PH2','Release','phase','todo',{children:[node('T4','Publish','task','todo',{owner:'quill',branch:'release',labels:['release']}),node('T5','Old plan','task','cancelled')]})]});
const workPayload=()=>({available:true,roots:[roadmap()],counts:{byKind:{},byStatus:{}}});
const branches=()=>[
 {name:'main',head:'abcdef123456',upstream:'origin/main',committedAt:ago(30),worktrees:[],claim:null,agents:[],tasks:[],artifacts:[],flags:[]},
 {name:'feat/tree',head:'1234567890',upstream:null,committedAt:ago(3),worktrees:[{path:'/w/tree',project:'/w'}],claim:{agentId:'atlas',project:'/w',claimedAt:ago(100),note:'tree',live:true,stale:false},agents:[{agentId:'atlas',project:'/w',live:true,source:'claim'},{agentId:'vector',project:'/w',live:false,source:'commit'}],tasks:[{id:'T1',title:'Tree op',state:'open',owner:'atlas'}],artifacts:[],flags:['contested']},
 {name:'old',head:'ffff0000',upstream:null,committedAt:ago(5000),worktrees:[],claim:{agentId:'vector',project:'/w',claimedAt:ago(4000),note:'',live:false,stale:true},agents:[],tasks:[],artifacts:[],flags:['orphaned']},
 {name:'spike',head:null,upstream:null,committedAt:null,worktrees:[],claim:null,agents:[],tasks:[],artifacts:[],flags:['unclaimed','missing']}];
const ownershipPayload=()=>({available:true,repo:'/w',rooms:['/w'],branches:branches(),unassigned:{agents:[{agentId:'idle-1',project:'/w',live:false,source:'status'}],tasks:[]},generatedAt:new Date().toISOString()});

// ---- HTTP surface ---------------------------------------------------------------------
function api(feeds={}){
 const handler=createDashboardHandler({project:'/w',secret:'s3cret',origin:()=>'http://127.0.0.1:9',assets:new Map([['/',{type:'text/html',body:'<h1>Tower</h1>'}]]),
  getRooms:async()=>({rooms:[{project:'/w',agentCount:0,messageCount:0,pendingDeliveries:0,lastActivityAt:null}]}),getSnapshot:async()=>({}),...feeds});
 return async(url,{method='GET',headers={}}={})=>{
  const response={headers:{},status:0,body:'',setHeader(k,v){this.headers[k.toLowerCase()]=v;},writeHead(status,h={}){this.status=status;for(const [k,v] of Object.entries(h))this.setHeader(k,v);},end(body=''){this.body=body;}};
  await handler({url,method,headers:{host:'127.0.0.1:9',authorization:'Bearer s3cret',...headers}},response);return response;
 };
}
test('work, ownership and usage endpoints are read-only, authenticated, project-scoped and conditional',async()=>{
 const calls=[],stable=ownershipPayload();
 const request=api({getWork:async p=>{calls.push(['work',p]);return workPayload();},getOwnership:async p=>{calls.push(['ownership',p]);return {...stable,generatedAt:new Date().toISOString()};},getUsage:async()=>({available:true,agents:{stored:3,active:2,left:1}})});
 for(const feed of ['work','ownership','usage']){
  const url=`/api/${feed}?project=%2Fw`;
  assert.equal((await request(url,{headers:{authorization:''}})).status,401);
  assert.equal((await request(url,{headers:{host:'attacker.example'}})).status,403);
  assert.equal((await request(url,{method:'POST'})).status,405);
  assert.equal((await request(`/api/${feed}?project=%2Fprivate%2Fnope`)).status,404);
 }
 assert.deepEqual(calls,[]);
 const first=await request('/api/work?project=%2Fw');assert.equal(first.status,200);assert.equal(JSON.parse(first.body).roots[0].id,'RM');
 assert.deepEqual(calls,[['work','/w']]);
 assert.equal((await request('/api/work?project=%2Fw',{headers:{'if-none-match':first.headers.etag}})).status,304);
 const owned=await request('/api/ownership');assert.equal(owned.status,200);assert.equal(JSON.parse(owned.body).available,true);assert.deepEqual(calls.at(-1),['ownership','/w']);
 await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal((await request('/api/ownership',{headers:{'if-none-match':owned.headers.etag}})).status,304,'generatedAt alone must not defeat conditional requests');
 assert.equal(JSON.parse((await request('/api/usage')).body).agents.stored,3);
});
test('feeds the broker cannot supply answer available:false and static routes ignore the query string',async()=>{
 const request=api();
 for(const feed of ['work','ownership','usage'])assert.deepEqual(JSON.parse((await request(`/api/${feed}`)).body),{available:false});
 assert.equal((await request('/?view=plan')).status,200);assert.equal((await request('/?view=plan')).body,'<h1>Tower</h1>');
 assert.equal((await request('/api/other')).status,404);
});

// ---- Observer fallbacks -----------------------------------------------------------------
const broker=(handlers,seen=[])=>createObserver({project:'/w',dataDir:'/unused',ensure:async()=>{},call:async(project,fields)=>{
 seen.push(fields);const handler=handlers[fields.op+(fields.action?':'+fields.action:'')];
 if(!handler)throw Object.assign(new Error('Unknown operation'),{code:'UNKNOWN_OPERATION'});
 const result=await handler(fields);return {ok:true,...result};}});
test('work tree is read through tasks:tree and passes the broker roots and counts through',async()=>{
 const seen=[],tree=workPayload();
 const observer=broker({'tasks:tree':()=>({roots:tree.roots,counts:tree.counts})},seen);
 const work=await observer.getWork('/w');
 assert.equal(work.available,true);assert.equal(work.legacy,undefined);assert.equal(work.roots[0].id,'RM');assert.deepEqual(work.counts,tree.counts);assert.equal('ok' in work,false);
 assert.deepEqual(seen,[{op:'tasks',action:'tree'}]);
});
test('work falls back to the flat task list on an older broker and stops asking for the tree',async()=>{
 const seen=[];let treeAttempts=0;
 const tasks=[{id:'a',title:'Open one',state:'open',owner:'x',blocked:false,createdAt:ago(5),updatedAt:ago(1)},{id:'b',title:'Done one',state:'complete',blocked:false},{id:'c',title:'Stuck',state:'open',blocked:true}];
 const observer=createObserver({project:'/w',dataDir:'/unused',ensure:async()=>{},call:async(_p,fields)=>{
  seen.push(`${fields.op}:${fields.action}`);
  if(fields.action==='tree'){treeAttempts++;throw Object.assign(new Error('action must be upsert, list, or complete.'),{code:'INVALID_INPUT'});}
  return {ok:true,tasks};}});
 const first=await observer.getWork('/w'),second=await observer.getWork('/w');
 assert.equal(first.available,true);assert.equal(first.legacy,true);
 assert.deepEqual(first.roots.map(r=>[r.id,r.kind,r.status,r.owner,r.progress.percent]),[['a','task','todo','x',0],['b','task','done',null,100],['c','task','blocked',null,0]]);
 assert.deepEqual(first.counts,{byKind:{task:3},byStatus:{todo:1,'in-progress':0,blocked:1,review:0,done:1,cancelled:0}});
 assert.deepEqual(plain(second),plain(first));assert.equal(treeAttempts,1);
 assert.deepEqual(seen,['tasks:tree','tasks:list','tasks:list']);
 assert.deepEqual(flatWork([]),{available:true,legacy:true,roots:[],counts:{byKind:{task:0},byStatus:{todo:0,'in-progress':0,blocked:0,review:0,done:0,cancelled:0}}});
});
test('work reports available:false when neither the tree nor the list can be read, and keeps retrying transient faults',async()=>{
 let calls=0;
 const down=createObserver({project:'/w',dataDir:'/unused',ensure:async()=>{},call:async()=>{calls++;throw Object.assign(new Error('Unknown operation'),{code:'UNKNOWN_OPERATION'});}});
 assert.deepEqual(await down.getWork('/w'),{available:false});
 const flaky=createObserver({project:'/w',dataDir:'/unused',ensure:async()=>{},call:async(_p,fields)=>{calls++;if(fields.action==='tree'&&calls<2)throw Object.assign(new Error('timeout'),{code:'TIMEOUT'});return fields.action==='tree'?{ok:true,roots:[],counts:{}}:{ok:true,tasks:[]};}});
 calls=0;assert.equal((await flaky.getWork('/w')).legacy,true,'a transient fault falls back for this call only');
 const again=await flaky.getWork('/w');assert.equal(again.available,true);assert.equal(again.legacy,undefined,'the tree op was not disabled by a transient fault');
});
test('ownership and usage are feature-detected: unknown ops are quiet, real faults still surface',async()=>{
 const seen=[];
 const present=broker({ownership:()=>({repo:'/w',branches:[],unassigned:{},generatedAt:'2026-10-15T00:00:00Z'}),usage:()=>({agents:{stored:9}})},seen);
 assert.deepEqual(await present.getOwnership('/w'),{available:true,repo:'/w',branches:[],unassigned:{},generatedAt:'2026-10-15T00:00:00Z'});
 assert.equal((await present.getUsage('/w')).agents.stored,9);
 const absent=broker({},seen);
 assert.deepEqual(await absent.getOwnership('/w'),{available:false});assert.deepEqual(await absent.getUsage('/w'),{available:false});
 const before=seen.length;await absent.getOwnership('/w');await absent.getUsage('/w');assert.equal(seen.length,before,'an op known to be absent is not retried');
 const faulty=createObserver({project:'/w',dataDir:'/unused',ensure:async()=>{},call:async()=>{throw Object.assign(new Error('disk fault'),{code:'STORE_IO'});}});
 await assert.rejects(faulty.getOwnership('/w'),/disk fault/);
});

// ---- Pure view-model helpers --------------------------------------------------------------
const M=modelContext();
test('progress is read from the broker, else rolled up from leaves, and formats without surprises',()=>{
 const tree=roadmap();
 assert.deepEqual(plain(M.progressOf(tree)),{done:2,total:5,percent:40},'cancelled leaves do not count toward the total');
 assert.deepEqual(plain(M.progressOf({...tree,progress:{done:3,total:4,percent:75}})),{done:3,total:4,percent:75});
 assert.deepEqual(plain(M.progressOf({...tree,progress:{done:1,total:3}})),{done:1,total:3,percent:33});
 assert.deepEqual(plain(M.progressOf(node('x','Leaf','task','done'))),{done:1,total:1,percent:100});
 assert.equal(M.formatProgress({done:2,total:6,percent:33}),'2/6 · 33%');assert.equal(M.formatProgress({done:0,total:0,percent:0}),'no items');
 assert.deepEqual(plain(M.rollup([tree,node('y','Other','task','todo')])),{done:2,total:6,percent:33});
 assert.deepEqual(plain(M.rollup([])),{done:0,total:0,percent:0});
 assert.equal(M.formatCount(1410),'1,410');assert.equal(M.formatCount(undefined),'—');assert.equal(M.formatCount(NaN),'—');
});
test('status counts use leaves so containers never inflate lanes or alerts, with a counts fallback for empty trees',()=>{
 assert.deepEqual(plain(M.statusCounts([roadmap()])),{todo:1,'in-progress':1,blocked:1,review:0,done:2,cancelled:1});
 assert.equal(M.statusCounts([],{byStatus:{done:7}}).done,7);
});
test('flight plan filters keep matching items with their ancestors, and flatten honors collapsed branches',()=>{
 const roots=[roadmap()];
 assert.equal(M.filterTree(roots,{}),roots);
 const blocked=plain(M.filterTree(roots,{status:'blocked'}));
 assert.deepEqual(blocked[0].children[0].children[0].children.map(n=>n.id),['T2']);assert.equal(blocked[0].context,true);assert.equal(blocked[0].children[0].children[0].children[0].context,false);
 assert.equal(plain(M.filterTree(roots,{owner:'quill'}))[0].children[0].children.length,1);
 assert.deepEqual(plain(M.filterTree(roots,{label:'compat'}))[0].children[0].children[0].children.map(n=>n.id),['T2']);
 assert.equal(plain(M.filterTree(roots,{branch:'release'}))[0].children[0].id,'PH2');
 assert.equal(plain(M.filterTree(roots,{q:'CYCLES'}))[0].children[0].children[0].children[0].children[0].id,'D2');
 assert.deepEqual(plain(M.filterTree(roots,{q:'nothing matches this'})),[]);
 assert.deepEqual(plain(M.treeFacets(roots)),{owners:['atlas','quill','vector'],branches:['feat/tree','release'],labels:['broker','compat','release']});
 assert.equal(M.flattenTree(roots).length,11);
 const rows=plain(M.flattenTree(roots,new Set(['PH1'])));assert.equal(rows.length,5);assert.equal(rows[1].collapsed,true);assert.equal(rows[1].hasChildren,true);
 assert.deepEqual(rows.map(r=>r.depth),[0,1,1,2,2]);
});
test('lanes group the leaf work by status and hide the cancelled lane when empty',()=>{
 const lanes=plain(M.laneGroups([roadmap()]));
 assert.deepEqual(lanes.map(l=>[l.status,l.cards.length]),[['todo',1],['in-progress',1],['blocked',1],['review',0],['done',2],['cancelled',1]]);
 assert.deepEqual(lanes[2].cards[0].path,['Launch','Foundations','Work tree']);
 assert.equal(plain(M.laneGroups([node('z','Only','task','todo')])).some(l=>l.status==='cancelled'),false);
});
test('branch flags are summarized, ranked by severity and filterable',()=>{
 const rows=branches();
 assert.deepEqual(plain(M.flagSummary(rows)),{total:4,flagged:3,contested:1,missing:1,orphaned:1,unclaimed:1});
 assert.deepEqual(plain(M.sortBranches(rows).map(b=>b.name)),['feat/tree','spike','old','main']);
 assert.deepEqual(plain(M.filterBranches(rows,{flag:'orphaned'}).map(b=>b.name)),['old']);
 assert.deepEqual(plain(M.filterBranches(rows,{q:'vector'}).map(b=>b.name)),['feat/tree','old']);
 assert.deepEqual(plain(M.filterBranches(rows,{flag:'contested',q:'zzz'}).map(b=>b.name)),[]);
 assert.equal(M.branchSeverity({flags:[]}),0);assert.equal(M.branchSeverity({flags:['contested']}),4);
 assert.deepEqual(plain(M.flagSummary([])),{total:0,flagged:0,contested:0,missing:0,orphaned:0,unclaimed:0});
});
test('agents are classified live, idle or dormant, and the registry story survives missing broker fields',()=>{
 const now=Date.now(),a=(agentId,extra)=>({agentId,updatedAt:new Date(now-extra.mins*60000).toISOString(),...extra});
 assert.equal(M.agentState(a('x',{mins:500,live:true})),'live');
 assert.equal(M.agentState(a('x',{mins:1,live:false})),'idle','the broker says not live, so recent updates alone do not make it live');
 assert.equal(M.agentState(a('x',{mins:1})),'live');assert.equal(M.agentState(a('x',{mins:30})),'idle');assert.equal(M.agentState(a('x',{mins:300})),'dormant');
 assert.equal(M.agentState(a('x',{mins:300,readiness:{transport:{state:'connected'}}})),'live');
 const snapshot={agents:[a('l',{mins:2,live:true}),a('i',{mins:20,live:false}),a('d',{mins:900,live:false}),a('d2',{mins:2000,live:false})]};
 assert.deepEqual(Object.values(plain(M.groupAgents(snapshot.agents))).map(g=>g.map(x=>x.agentId)),[['l'],['i'],['d','d2']]);
 assert.deepEqual(plain(M.registrySummary({...snapshot,registry:{stored:1410,live:25,dormant:1200,retired:150,ephemeral:30,prunable:99}})),{source:'registry',stored:1410,live:25,dormant:1200,retired:150,ephemeral:30,prunable:99});
 assert.deepEqual(plain(M.registrySummary({...snapshot,registry:{stored:10}})),{source:'registry',stored:10,live:1,dormant:9,retired:0,ephemeral:0,prunable:0});
 assert.deepEqual(plain(M.registrySummary(snapshot,{agents:{stored:1410,active:1300,left:110}})),{source:'usage',stored:1410,live:1,dormant:1299,retired:110,ephemeral:0,prunable:0});
 assert.deepEqual(plain(M.registrySummary(snapshot)),{source:'room',stored:4,live:1,dormant:3,retired:0,ephemeral:0,prunable:0});
 const segments=plain(M.registrySegments({stored:1410,live:25,dormant:1200,retired:150,ephemeral:30}));
 assert.deepEqual(segments.map(s=>s.key),['live','dormant','ephemeral','retired']);assert.equal(segments[0].count,25);assert.equal(segments.reduce((n,s)=>n+s.count,0),1410);
 assert.deepEqual(plain(M.registrySegments({stored:0,live:0})),[]);
 assert.equal(M.transportInfo({readiness:{transport:{state:'connected',adapter:'codex'},push:{ready:true}}}).label,'connected · codex · push');
 assert.equal(M.transportInfo({}).label,'unknown');
});
test('attention items rank alerts first, name the destination and say all-clear when nothing is wrong',()=>{
 const snapshot={pendingDeliveries:4,claims:[{stale:true},{stale:false}],messages:[{recipients:['b'],ackedBy:[],notified:[{agentId:'b',adapter:'push-failed',at:'2026-10-05T01:00:00Z'}]}],agents:[]};
 const items=plain(M.attentionItems({snapshot,work:workPayload(),ownership:ownershipPayload(),usage:{nearLimit:['messages']}}));
 assert.deepEqual(items.map(i=>i.level),['alert','alert','alert','warn','warn','warn','warn','warn','info']);
 assert.equal(items[0].text,'1 contested branch: more than one owner attached');assert.deepEqual([items[0].view,items[0].flag],['runways','contested']);
 assert.ok(items.some(i=>i.view==='log'&&i.unacked&&/4 deliveries awaiting/.test(i.text)));
 assert.ok(items.some(i=>i.view==='plan'&&i.status==='blocked'&&i.text==='1 blocked work item'));
 assert.ok(items.some(i=>/1 stale claim/.test(i.text)));assert.ok(items.some(i=>/Storage headroom is low: messages/.test(i.text)));
 assert.ok(items.some(i=>i.level==='info'&&/1 unclaimed branch/.test(i.text)));
 assert.deepEqual(plain(M.attentionItems({snapshot:{pendingDeliveries:0,claims:[],messages:[],agents:[]}})),[{level:'ok',text:'All quiet. Nothing needs attention.',view:'tower'}]);
 assert.equal(M.attentionItems({snapshot:{pendingDeliveries:1,claims:[],messages:[],agents:[],registry:{stored:5,live:1,prunable:3}}}).at(-1).text,'3 identities could be pruned from the registry');
});

// ---- Rendering against the fake DOM ------------------------------------------------------
const rooms={rooms:[{project:'/w',agentCount:4,messageCount:0,pendingDeliveries:0,lastActivityAt:null}],preferredProject:'/w'};
const fleetSnapshot=(extra={})=>({project:'/w',agents:[
 {agentId:'atlas',runner:'claude',status:'working',frozen:false,task:'Wire the broker',updatedAt:ago(1),live:true,readiness:{transport:{state:'connected',adapter:'claude'},push:{ready:true}}},
 {agentId:'vector',runner:'codex',status:'idle',frozen:false,task:null,updatedAt:ago(25),live:false},
 {agentId:'ghost-1',runner:'codex',status:'idle',frozen:false,task:null,updatedAt:ago(3000),live:false},
 ...Array.from({length:30},(_,i)=>({agentId:`dormant-${i}`,runner:'codex',status:'idle',frozen:false,task:null,updatedAt:ago(4000+i),live:false}))],
 claims:[{resource:'/w/lib/a.mjs',agentId:'atlas',claimedAt:ago(10),scope:'project',stale:false}],messages:[],totalMessages:0,pendingDeliveries:3,pendingByAgent:{atlas:3},cursor:0,...extra});
test('tower shows the registry hygiene story, attention items and degraded states for a broker without work or ownership',async()=>{
 const page=boot({projects:rooms,snapshot:fleetSnapshot({registry:{stored:1410,live:25,dormant:1250,retired:100,ephemeral:20,prunable:300}})});
 await page.flush();
 assert.equal(textOf(page.$('agents-count')),'25');assert.equal(textOf(page.$('agents-sub')),'of 1,410 stored');
 assert.equal(textOf(page.$('pending-count')),'3');assert.equal(textOf(page.$('claims-count')),'1');
 const registry=textOf(page.$('registry'));
 assert.match(registry,/1,410 identities stored/);assert.match(registry,/25 on the air/);assert.match(registry,/300 stored identities are prunable/);assert.match(registry,/Source: broker registry report/);
 assert.equal(byClass(page.$('registry'),'seg').length,4);
 assert.equal(textOf(page.$('conflicts-count')),'—');assert.equal(textOf(page.$('conflicts-sub')),'not available on this broker');
 assert.equal(textOf(page.$('plan-count')),'—');assert.equal(textOf(page.$('plan-sub')),'not available on this broker');
 const attention=findAll(page.$('attention'),el=>el.tag==='button').map(textOf);
 assert.ok(attention.some(t=>/3 deliveries awaiting acknowledgement/.test(t)));assert.ok(attention.some(t=>/300 identities could be pruned/.test(t)));
 assert.equal(page.$('view-tower').hidden,false);assert.equal(page.$('view-plan').hidden,true);
 assert.deepEqual(findAll(page.$('traffic'),el=>el.tag==='article').map(el=>el.dataset.agent),['atlas']);
});
test('tower summarizes the flight plan and branch conflicts when the broker supplies them',async()=>{
 const page=boot({projects:rooms,snapshot:fleetSnapshot(),work:workPayload(),ownership:ownershipPayload(),usage:{available:true,agents:{stored:33,active:33,left:0},nearLimit:[]}});
 await page.flush();
 assert.equal(textOf(page.$('conflicts-count')),'3','the number counts branches with any flag');assert.equal(textOf(page.$('conflicts-sub')),'1 contested · 1 missing · 1 orphaned · 1 unclaimed');
 assert.equal(textOf(page.$('plan-count')),'40%');assert.equal(textOf(page.$('plan-sub')),'2/5 items done');
 assert.equal(textOf(page.$('count-runways')),'3');assert.equal(textOf(page.$('count-plan')),'40%');
 assert.equal(textOf(page.$('registry')).includes('Source: broker storage usage'),true);
 const first=findAll(page.$('attention'),el=>el.tag==='button').map(textOf)[0];assert.match(first,/ALERT1 contested branch/);
});
test('navigation switches views, records ?view= without touching the hash, and follows attention links',async()=>{
 const page=boot({projects:rooms,snapshot:fleetSnapshot(),work:workPayload(),ownership:ownershipPayload()});await page.flush();
 page.sandbox.go('runways');assert.equal(page.$('view-runways').hidden,false);assert.equal(page.$('view-tower').hidden,true);assert.equal(page.$('nav-runways').attributes['aria-current'],'page');assert.equal(page.$('nav-tower').attributes['aria-current'],'false');
 assert.deepEqual(page.pushed,['/?view=runways']);assert.equal(page.document.title,'Agent Relay · Runways');
 page.sandbox.go('nope');assert.equal(page.$('view-runways').hidden,false);
 page.sandbox.go('tower');assert.deepEqual(page.pushed,['/?view=runways','/']);
 const blocked=findAll(page.$('attention'),el=>el.tag==='button').find(el=>/blocked work item/.test(textOf(el)));blocked.listeners.click();
 assert.equal(page.$('view-plan').hidden,false);assert.equal(page.$('plan-status').value,'blocked');
 page.$('nav-log').listeners.click();assert.equal(page.$('view-log').hidden,false);
 const deep=boot({projects:rooms,snapshot:fleetSnapshot(),search:'?view=strips'});await deep.flush();assert.equal(deep.$('view-strips').hidden,false);assert.equal(deep.$('view-tower').hidden,true);
 const junk=boot({projects:rooms,snapshot:fleetSnapshot(),search:'?view=%3Cscript%3E'});await junk.flush();assert.equal(junk.$('view-tower').hidden,false);
});
test('flight plan renders the tree with roll-ups, collapses, filters, and switches to lanes',async()=>{
 const page=boot({projects:rooms,snapshot:fleetSnapshot(),work:workPayload(),search:'?view=plan'});await page.flush();
 const titles=()=>findAll(page.$('plan-tree'),el=>el.tag==='li').map(el=>el.dataset.id);
 assert.deepEqual(titles(),['RM','PH1','EP1','T1','T2','T3','D1','D2','PH2','T4','T5']);
 const root=findAll(page.$('plan-tree'),el=>el.tag==='li'&&el.dataset.id==='RM')[0];
 assert.match(textOf(root),/Launch/);assert.match(textOf(root),/2\/5 · 40%/);assert.ok(byClass(root,'meter').length===1);
 assert.equal(byClass(root,'meter')[0].attributes['aria-valuenow'],'40');
 assert.match(textOf(page.$('plan-meta')),/5 items · 40% complete/);assert.ok(!/older broker/.test(textOf(page.$('plan-meta'))));
 const twist=findAll(page.$('plan-tree'),el=>el.tag==='button'&&el.attributes['aria-label']==='Collapse Foundations')[0];assert.equal(twist.attributes['aria-expanded'],'true');
 twist.listeners.click();assert.deepEqual(titles(),['RM','PH1','PH2','T4','T5']);
 page.$('plan-expand').listeners.click();assert.equal(titles().length,11);page.$('plan-collapse').listeners.click();assert.deepEqual(titles(),['RM']);page.$('plan-expand').listeners.click();
 page.$('plan-owner').value='quill';page.$('plan-owner').listeners.change();assert.deepEqual(titles(),['RM','PH2','T4']);
 page.$('plan-reset').listeners.click();assert.equal(titles().length,11);
 assert.deepEqual(page.$('plan-owner').options.map(o=>o.value),['','atlas','quill','vector']);assert.deepEqual(page.$('plan-label').options.map(o=>o.value),['','broker','compat','release']);
 page.$('plan-q').value='zzz';page.$('plan-q').listeners.input();assert.match(textOf(page.$('plan-tree')),/No work items match these filters/);
 page.$('plan-reset').listeners.click();page.$('plan-mode-lanes').listeners.click();
 assert.equal(page.$('plan-lanes').hidden,false);assert.equal(page.$('plan-tree').hidden,true);
 const lanes=byClass(page.$('plan-lanes'),'lane');assert.equal(lanes.length,6);assert.equal(findAll(lanes[2],el=>el.tag==='article').length,1);assert.match(textOf(lanes[2]),/Launch › Foundations › Work tree/);
});
test('flight plan degrades to the flat list note on legacy brokers and to a clear unavailable state otherwise',async()=>{
 const legacy=boot({projects:rooms,snapshot:fleetSnapshot(),work:flatWork([{id:'a',title:'Only task',state:'open'}]),search:'?view=plan'});await legacy.flush();
 assert.match(textOf(legacy.$('plan-meta')),/flat task list \(older broker\)/);assert.match(textOf(legacy.$('plan-tree')),/Only task/);
 const off=boot({projects:rooms,snapshot:fleetSnapshot(),work:{available:false},search:'?view=plan'});await off.flush();
 assert.match(textOf(off.$('plan-tree')),/Flight plan is not available on this broker/);assert.equal(off.$('view-plan').dataset.state,'off');
 const missing=boot({projects:rooms,snapshot:fleetSnapshot(),search:'?view=plan'});await missing.flush();
 assert.match(textOf(missing.$('plan-tree')),/Flight plan is not available on this broker/,'a 404 from the dashboard server counts as unavailable');
 const empty=boot({projects:rooms,snapshot:fleetSnapshot(),work:{available:true,roots:[],counts:{}},search:'?view=plan'});await empty.flush();
 assert.match(textOf(empty.$('plan-tree')),/No work items yet/);
});
test('runways put flags first, filter by flag, and degrade when ownership is unavailable',async()=>{
 const page=boot({projects:rooms,snapshot:fleetSnapshot(),ownership:ownershipPayload(),search:'?view=runways'});await page.flush();
 const names=()=>findAll(page.$('runways'),el=>el.tag==='article').map(el=>el.dataset.branch);
 assert.deepEqual(names(),['feat/tree','spike','old','main']);
 const cards=findAll(page.$('runways'),el=>el.tag==='article');assert.equal(cards[0].dataset.tone,'alert');assert.equal(cards[2].dataset.tone,'warn');assert.equal(cards[3].dataset.tone,'clear');
 assert.deepEqual(byClass(cards[1],'flag').map(textOf),['Missing','Unclaimed']);assert.deepEqual(byClass(cards[3],'flag').map(textOf),['Clear']);
 assert.match(textOf(cards[0]),/atlas/);assert.match(textOf(cards[0]),/@ 1234567/);assert.match(textOf(page.$('runways-meta')),/4 branches · 3 flagged/);
 const chips=findAll(page.$('runway-chips'),el=>el.tag==='button').map(textOf);assert.deepEqual(chips,['All4','Contested1','Missing1','Orphaned1','Unclaimed1']);
 findButton(page.$('runway-chips'),'Orphaned1').listeners.click();assert.deepEqual(names(),['old']);
 assert.equal(findButton(page.$('runway-chips'),'Orphaned1').attributes['aria-pressed'],'true');
 findButton(page.$('runway-chips'),'Orphaned1').listeners.click();assert.equal(names().length,4);
 page.$('runway-q').value='vector';page.$('runway-q').listeners.input();assert.deepEqual(names(),['feat/tree','old']);
 assert.match(textOf(page.$('unassigned')),/Agents not on a branch \(1\)/);assert.match(textOf(page.$('unassigned')),/idle-1/);
 const off=boot({projects:rooms,snapshot:fleetSnapshot(),ownership:{available:false},search:'?view=runways'});await off.flush();
 assert.match(textOf(off.$('runways')),/Branch ownership is not available on this broker/);assert.equal(findAll(off.$('runway-chips'),el=>el.tag==='button').length,0);
});
test('strips group agents by liveness, cap the dormant pile, and filter to live only',async()=>{
 const page=boot({projects:rooms,snapshot:fleetSnapshot({registry:{stored:1410,live:1,dormant:1400,retired:9,ephemeral:0,prunable:0}}),search:'?view=strips'});await page.flush();
 const groups=()=>byClass(page.$('agents'),'strip-group').map(el=>[el.className.split(' ').find(c=>c.startsWith('g-')),findAll(el,e=>e.tag==='article').length]);
 assert.deepEqual(groups(),[['g-live',1],['g-idle',1],['g-dormant',24]]);
 assert.equal(textOf(page.$('strips-meta')),'1 live · 33 in this room · 1,410 stored broker-wide');
 const more=findButton(page.$('agents'),'Show 7 more dormant');assert.ok(more);more.listeners.click();assert.deepEqual(groups()[2],['g-dormant',31]);
 page.$('live-only').checked=true;page.$('live-only').listeners.change();assert.deepEqual(groups(),[['g-live',1]]);
 const strip=findAll(page.$('agents'),el=>el.tag==='article')[0];assert.match(textOf(strip),/atlas/);assert.match(textOf(strip),/Wire the broker/);assert.match(textOf(strip),/connected · claude · push/);assert.match(textOf(strip),/3 awaiting ack/);assert.match(textOf(strip),/1 claims/);
 page.$('strip-q').value='nomatch';page.$('strip-q').listeners.input();assert.match(textOf(page.$('agents')),/No agents are live right now|No agents match/);
 page.$('live-only').checked=false;page.$('live-only').listeners.change();assert.match(textOf(page.$('agents')),/No agents match this search/);
 page.$('strip-q').value='ghost';page.$('strip-q').listeners.input();assert.equal(findAll(page.$('agents'),el=>el.tag==='article').length,1);
});
test('claims render stale state and an empty note',async()=>{
 const page=boot({projects:rooms,snapshot:fleetSnapshot({claims:[{resource:'/w/a.mjs',agentId:'atlas',claimedAt:ago(10),scope:'project',stale:true},{resource:'native',agentId:'vector',project:'/w',claimedAt:ago(3),scope:'machine',stale:false}]}),search:'?view=claims'});await page.flush();
 const rows=findAll(page.$('claims'),el=>el.tag==='tr');assert.equal(rows.length,2);assert.match(textOf(rows[0]),/a\.mjs/);assert.match(textOf(rows[0]),/stale/);assert.match(textOf(rows[1]),/Machine · native/);assert.equal(page.$('no-claims').hidden,true);assert.match(textOf(page.$('claims-meta')),/2 held · 1 stale/);
 const none=boot({projects:rooms,snapshot:fleetSnapshot({claims:[]}),search:'?view=claims'});await none.flush();assert.equal(none.$('no-claims').hidden,false);
});
test('dashboard script only reads: no writes, inline handlers or hash routing',async()=>{
 const {dashboardSource}=await import('./dashboard-dom.mjs');
 assert.doesNotMatch(dashboardSource,/method\s*:\s*['"](POST|PUT|PATCH|DELETE)/i);
 assert.doesNotMatch(dashboardSource,/location\.hash\s*=|innerHTML|insertAdjacentHTML|eval\(|new Function/);
 const {readFile}=await import('node:fs/promises');
 const html=await readFile(new URL('../lib/dashboard/index.html',import.meta.url),'utf8');
 assert.doesNotMatch(html,/<style|\sstyle=|\son[a-z]+=|<script(?![^>]*\ssrc=)/i,'CSP forbids inline scripts, styles and handlers');
 assert.doesNotMatch(html,/https?:\/\//);
 const css=await readFile(new URL('../lib/dashboard/dashboard.css',import.meta.url),'utf8');
 assert.doesNotMatch(css,/@import|url\(\s*['"]?(https?:|data:)/i);assert.match(css,/prefers-reduced-motion: reduce/);
});

// ---- Real broker, real HTTP --------------------------------------------------------------
test('a real dashboard serves work, ownership and usage from a live broker, degrading by what the broker supports',async t=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {createBroker}=await import('../lib/broker.mjs'),{startDashboard}=await import('../lib/dashboard.mjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-dashboard-feeds-')),dataDir=path.join(root,'data'),project=path.join(root,'one');
 await Promise.all([dataDir,project].map(dir=>fs.mkdir(dir)));const live=await createBroker({dataDir});let dashboard,decorated;
 t.after(async()=>{await dashboard?.close();await decorated?.close();await live.close();await fs.rm(root,{recursive:true,force:true});});
 await fs.writeFile(path.join(dataDir,'broker.json'),JSON.stringify({pid:process.pid,url:live.url,token:live.token}));
 const write=async fields=>{const response=await fetch(live.url+'/rpc',{method:'POST',headers:{authorization:'Bearer '+live.token,'content-type':'application/json'},body:JSON.stringify({project,...fields})});const result=await response.json();assert.equal(result.ok,true,JSON.stringify(result));return result;};
 await write({op:'register',agentId:'a',runner:'test'});await write({op:'tasks',action:'upsert',agentId:'a',id:'t1',title:'First task',owner:'a'});
 const before=await fs.readFile(path.join(dataDir,'state.json'),'utf8');
 dashboard=await startDashboard({project,dataDir});
 const link=new URL(dashboard.url),headers={authorization:'Bearer '+link.hash.slice(1)},get=async p=>(await fetch(link.origin+p,{headers})).json();
 const q='?project='+encodeURIComponent(await fs.realpath(project));
 const work=await get('/api/work'+q);assert.equal(work.available,true);assert.ok(Array.isArray(work.roots));assert.ok(JSON.stringify(work).includes('First task'));
 const ownership=await get('/api/ownership'+q);assert.equal(typeof ownership.available,'boolean');if(ownership.available)assert.ok(Array.isArray(ownership.branches));
 const usage=await get('/api/usage'+q);assert.equal(usage.available,true);assert.equal(usage.agents.stored,1);
 assert.equal((await fetch(link.origin+'/api/work'+q,{method:'POST',headers})).status,405);assert.equal((await fetch(link.origin+'/api/work'+q)).status,401);
 assert.equal(await fs.readFile(path.join(dataDir,'state.json'),'utf8'),before,'reading the dashboard feeds never changes the ledger');
 decorated=await startDashboard({project,dataDir,decorate:observer=>({...observer,getWork:async()=>({available:true,roots:[node('X','Synthetic','roadmap','todo')],counts:{byKind:{},byStatus:{}}})})});
 const other=new URL(decorated.url),again=await (await fetch(other.origin+'/api/work'+q,{headers:{authorization:'Bearer '+other.hash.slice(1)}})).json();
 assert.equal(again.roots[0].id,'X');
});
