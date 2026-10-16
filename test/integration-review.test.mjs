import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createBroker,validateStore} from '../lib/broker.mjs';
import {createMcpAdapter} from '../lib/mcp.mjs';
import {AgentRelayPlugin} from '../lib/opencode-plugin.mjs';
import {rpc as clientRpc} from '../lib/client.mjs';
import {buildOwnership} from '../lib/ownership.mjs';
import {isLive,liveness} from '../lib/registry.mjs';
import {derivedStatuses,reportedStatus} from '../lib/workitems.mjs';

// Cross-stream integration review of the 0.4 backend: registry hygiene x branch ownership x work items x adapters.
const run=promisify(execFile);
const MIN=60000;
const identity=['-c','user.name=t','-c','user.email=t@t','-c','commit.gpgsign=false'];
const git=(cwd,...args)=>run('git',[...identity,...args],{cwd});
let gitAvailable=true;
try{await run('git',['--version']);}catch{gitAvailable=false;}
const gitTest=(name,fn)=>test(name,async t=>{if(!gitAvailable){t.skip('git is unavailable');return;}await fn(t);});

// Real HTTP handler, serial writer and durable ledger without binding TCP. `repo` mode adds a git repo with linked worktrees.
async function fixture(t,{repo=false,worktrees=['feature'],options={pruneAfterMinutes:0}}={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'relay-review-')));
 const dataDir=path.join(root,'data'),project=path.join(root,repo?'repo':'project');
 await Promise.all([dataDir,project].map(p=>fs.mkdir(p)));
 const trees={};
 if(repo){
  await git(project,'init','-b','main');await fs.writeFile(path.join(project,'file.txt'),'x');
  await git(project,'add','file.txt');await git(project,'commit','-m','init');
  for(const name of worktrees){trees[name]=path.join(root,`wt-${name}`);await git(project,'worktree','add',trees[name],'-b',name);}
 }
 let handler,broker,current=options;
 const serverFactory=callback=>{handler=callback;const server=new EventEmitter();server.listen=(port,host,ready)=>queueMicrotask(ready);server.address=()=>({port:0});server.close=done=>done?.();return server;};
 const open=()=>createBroker({dataDir,serverFactory,...current});
 broker=await open();
 t.after(async()=>{await broker.close();await fs.rm(root,{recursive:true,force:true,maxRetries:15,retryDelay:200});});
 async function request(fields,room=project){
  let status,result;const response=new EventEmitter();response.writeHead=code=>{status=code;};response.end=body=>{result=JSON.parse(body);};
  const incoming={method:'POST',url:'/rpc',headers:{authorization:'Bearer '+broker.token},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({project:room,...fields}));}};
  await handler(incoming,response);return {status,...result};
 }
 const rpc=async(fields,room)=>{const result=await request(fields,room);assert.equal(result.ok,true,JSON.stringify(result));return result;};
 const stateFile=path.join(dataDir,'state.json');
 return {root,dataDir,project,trees,stateFile,request,rpc,
  register:(agentId,extra={},room)=>rpc({op:'register',agentId,runner:'test',...extra},room),
  readState:async()=>JSON.parse(await fs.readFile(stateFile,'utf8')),
  async restart(mutate,next){
   await broker.close();
   if(mutate){const state=JSON.parse(await fs.readFile(stateFile,'utf8'));mutate(state);await fs.writeFile(stateFile,JSON.stringify(state));}
   if(next)current=next;
   broker=await open();
  }};
}
const ago=minutes=>new Date(Date.now()-minutes*MIN).toISOString();
const task=(id,extra={})=>({id,title:id,state:['done','cancelled'].includes(extra.status)?'complete':'open',...extra});

// ---- Work tree: derived status -------------------------------------------------------------------------------------

test('derivedStatuses rolls leaves up: done, in-progress, blocked, todo, cancelled; leaves and explicit parents are untouched',()=>{
 const ledger=[
  task('all-done',{kind:'epic'}),task('d1',{parentId:'all-done',status:'done'}),task('d2',{parentId:'all-done',status:'done'}),task('d3',{parentId:'all-done',status:'cancelled'}),
  task('some',{kind:'epic'}),task('s1',{parentId:'some',status:'done'}),task('s2',{parentId:'some'}),
  task('reviewing',{kind:'epic'}),task('r1',{parentId:'reviewing',status:'review'}),task('r2',{parentId:'reviewing'}),
  task('stuck',{kind:'epic'}),task('k1',{parentId:'stuck',status:'blocked'}),task('k2',{parentId:'stuck'}),
  task('mixed',{kind:'epic'}),task('m1',{parentId:'mixed',status:'blocked'}),task('m2',{parentId:'mixed',status:'in-progress'}),
  task('untouched',{kind:'epic'}),task('u1',{parentId:'untouched'}),
  task('dead',{kind:'epic'}),task('x1',{parentId:'dead',status:'cancelled'}),
  task('explicit',{kind:'epic',status:'review'}),task('e1',{parentId:'explicit',status:'done'}),
  task('phase',{kind:'phase'}),task('nest',{kind:'epic',parentId:'phase'}),task('n1',{parentId:'nest',status:'blocked'}),
  task('phase-wip',{kind:'phase'}),task('wip',{kind:'epic',parentId:'phase-wip'}),task('w1',{parentId:'wip',status:'in-progress'}),
  task('phase-exp',{kind:'phase'}),task('epic-exp',{kind:'epic',parentId:'phase-exp',status:'in-progress'}),task('x2',{parentId:'epic-exp'}),
  task('phase-mix',{kind:'phase'}),task('pm-stuck',{kind:'epic',parentId:'phase-mix'}),task('pm1',{parentId:'pm-stuck',status:'blocked'}),
  task('pm-idle',{kind:'epic',parentId:'phase-mix'}),task('pm2',{parentId:'pm-idle'}),
 ];
 const derived=derivedStatuses(ledger);
 const want={'all-done':'done',some:'in-progress',reviewing:'in-progress',stuck:'blocked',mixed:'in-progress',untouched:'todo',dead:'cancelled',
  explicit:'done',phase:'blocked',nest:'blocked',wip:'in-progress','phase-wip':'in-progress','pm-stuck':'blocked','pm-idle':'todo','phase-mix':'blocked','phase-exp':'in-progress','epic-exp':'todo'};
 assert.deepEqual(Object.fromEntries(derived),want);
 // Leaves never get a derived status; an explicit status still wins in what is reported.
 for(const leaf of ['d1','s2','k1','u1','x1'])assert.equal(derived.has(leaf),false,leaf);
 const byId=Object.fromEntries(ledger.map(item=>[item.id,item]));
 assert.equal(reportedStatus(byId.explicit,derived),'review');
 assert.equal(reportedStatus(byId.some,derived),'in-progress');
 assert.equal(reportedStatus(byId.s2,derived),'todo');
 assert.equal(ledger.some(item=>'derivedStatus' in item),false,'the helper never writes to the ledger');
});

test('views report a derived status for parents without a stored status, never write it, and let an explicit status win',async t=>{
 const f=await fixture(t);
 await f.register('a');
 const upsert=fields=>f.rpc({op:'tasks',action:'upsert',agentId:'a',...fields});
 await upsert({id:'r',title:'Roadmap',kind:'roadmap'});
 await upsert({id:'e',title:'Epic',kind:'epic',parentId:'r'});
 await upsert({id:'t1',title:'One',kind:'task',parentId:'e'});
 await upsert({id:'t2',title:'Two',kind:'task',parentId:'e'});
 const rows=async()=>Object.fromEntries((await f.rpc({op:'tasks',action:'list'})).tasks.map(row=>[row.id,row]));
 let view=await rows();
 assert.equal(view.e.status,'todo');assert.equal(view.e.derivedStatus,'todo');assert.equal(view.t1.derivedStatus,undefined);
 await upsert({id:'t1',status:'in-progress'});
 view=await rows();
 assert.deepEqual([view.e.status,view.e.derivedStatus,view.r.status,view.r.derivedStatus],['in-progress','in-progress','in-progress','in-progress']);
 await upsert({id:'t1',status:'done'});await upsert({id:'t2',status:'done'});
 view=await rows();
 assert.deepEqual([view.e.status,view.r.status],['done','done']);
 // The stored ledger keeps only what was written: no status or derivedStatus on parents, and legacy state untouched.
 const stored=Object.fromEntries((await f.readState()).rooms[0].tasks.map(row=>[row.id,row]));
 for(const id of ['r','e']){assert.equal('status' in stored[id],false,id);assert.equal('derivedStatus' in stored[id],false,id);assert.equal(stored[id].state,'open',id);}
 // An explicit status wins for the reported value while derivedStatus still shows the roll-up.
 await upsert({id:'e',status:'review'});
 view=await rows();
 assert.deepEqual([view.e.status,view.e.derivedStatus],['review','done']);
 assert.equal((await f.readState()).rooms[0].tasks.find(row=>row.id==='e').status,'review');
 // List filters, tree counts, tree nodes and usage all use the reported status.
 const ids=async status=>(await f.rpc({op:'tasks',action:'list',status})).tasks.map(row=>row.id).sort();
 assert.deepEqual(await ids('done'),['r','t1','t2']);assert.deepEqual(await ids('review'),['e']);assert.deepEqual(await ids('todo'),[]);
 const tree=await f.rpc({op:'tasks',action:'tree'});
 assert.deepEqual(tree.counts.byStatus,{todo:0,'in-progress':0,blocked:0,review:1,done:3,cancelled:0});
 assert.deepEqual([tree.roots[0].status,tree.roots[0].derivedStatus,tree.roots[0].children[0].status],['done','done','review']);
 const usage=await f.rpc({op:'usage'});
 assert.deepEqual(usage.workItems.byStatus,{todo:0,'in-progress':0,blocked:0,review:1,done:3,cancelled:0});
 assert.deepEqual(usage.workItems.byKind,{roadmap:1,phase:0,epic:1,task:2,todo:0});
 assert.equal(usage.workItems.total,4);assert.equal(usage.workItems.open,2);assert.equal(usage.workItems.limit,usage.tasks.limit);
 // Moving a done child keeps the moved view consistent.
 const moved=await f.rpc({op:'tasks',action:'move',agentId:'a',id:'t2',parentId:null});
 assert.equal(moved.task.status,'done');
});

test('import dry-run plan and re-import report derived statuses for headings without a status line',async t=>{
 const f=await fixture(t);
 await f.register('a');
 const markdown='# Plan\n## Phase\n- [x] one\n- [ ] two\n';
 const dry=await f.rpc({op:'tasks',action:'import',dryRun:true,markdown});
 const plan=dry.tree[0];
 assert.deepEqual([plan.status,plan.children[0].status],['in-progress','in-progress']);
 const real=await f.rpc({op:'tasks',action:'import',agentId:'a',markdown});
 assert.equal(real.created.find(row=>row.title==='Plan').status,'in-progress');
 assert.equal(real.created.find(row=>row.title==='Plan').derivedStatus,'in-progress');
 assert.equal('status' in (await f.readState()).rooms[0].tasks.find(row=>row.title==='Plan'),false);
});

test('completing a cancelled item restamps completedAt; repeating completion keeps it',async t=>{
 const f=await fixture(t);
 await f.register('a');
 await f.rpc({op:'tasks',action:'upsert',agentId:'a',id:'x',title:'X',status:'cancelled'});
 const cancelled=(await f.readState()).rooms[0].tasks[0].completedAt;
 await new Promise(resolve=>setTimeout(resolve,15));
 const done=(await f.rpc({op:'tasks',action:'complete',agentId:'a',id:'x'})).task;
 assert.equal(done.status,'done');assert.ok(Date.parse(done.completedAt)>Date.parse(cancelled));
 await new Promise(resolve=>setTimeout(resolve,15));
 assert.equal((await f.rpc({op:'tasks',action:'complete',agentId:'a',id:'x'})).task.completedAt,done.completedAt);
});

test('work-item branches are stored and filtered like branch claims, without refs/heads/',async t=>{
 const f=await fixture(t);
 await f.register('a');
 await f.rpc({op:'tasks',action:'upsert',agentId:'a',id:'x',title:'X',branch:'refs/heads/feat/x'});
 assert.equal((await f.readState()).rooms[0].tasks[0].branch,'feat/x');
 assert.deepEqual((await f.rpc({op:'tasks',action:'list',branch:'refs/heads/feat/x'})).tasks.map(row=>row.id),['x']);
 assert.deepEqual((await f.rpc({op:'tasks',action:'list',branch:'feat/x'})).tasks.map(row=>row.id),['x']);
 assert.equal((await f.request({op:'tasks',action:'upsert',agentId:'a',id:'y',title:'Y',branch:'refs/heads/'})).error.code,'INVALID_INPUT');
});

// ---- Branch names: validation must match what the store accepts -----------------------------------------------------

test('branch names that only fail the store check after stripping refs/heads/ are rejected as input errors, not store faults',async t=>{
 const f=await fixture(t);
 await f.register('a');
 const claim=await f.request({op:'branches',action:'claim',agentId:'a',branch:'refs/heads/ padded'});
 assert.equal(claim.status,200,JSON.stringify(claim));
 assert.equal(claim.claim.branch,'padded');
 const report=await f.request({op:'status',agentId:'a',git:{branch:'refs/heads/ spaced '}});
 assert.equal(report.status,200,JSON.stringify(report));
 assert.equal(report.agent.git.branch,'spaced');
 assert.equal((await f.request({op:'branches',action:'claim',agentId:'a',branch:'refs/heads/   '})).error.code,'INVALID_INPUT');
 validateStore(await f.readState());
});

// ---- One liveness definition ---------------------------------------------------------------------------------------

test('ownership liveness is the registry definition, including the window boundary and connected transports',()=>{
 const now=Date.parse('2026-01-01T12:00:00Z');
 const at=minutes=>new Date(now-minutes*MIN).toISOString();
 const agents=[
  {agentId:'fresh',updatedAt:at(5)},{agentId:'edge',updatedAt:at(30)},{agentId:'old',updatedAt:at(31)},
  {agentId:'connected',updatedAt:at(900),transport:{adapter:'x',state:'connected',ts:at(900)}},
  {agentId:'gone',updatedAt:at(1),left:true},{agentId:'retired',updatedAt:at(1),left:true,retired:true},
  {agentId:'disconnected',updatedAt:at(900),transport:{adapter:'x',state:'disconnected',ts:at(900)}},
 ].map(agent=>({runner:'t',registeredAt:at(1000),status:'idle',frozen:false,resources:[],task:null,...agent}));
 const room={project:'/p',agents,messages:[],claims:[],cursor:0,tasks:[]};
 const claims=agents.map(agent=>({repo:'/r/.git',branch:`b-${agent.agentId}`,agentId:agent.agentId,project:'/p',claimedAt:at(2000)}));
 const state={version:1,nextCursor:1,rooms:[room],branchClaims:claims};
 const view=buildOwnership(state,{repo:'/r/.git',rooms:[room],worktrees:[],branches:claims.map(claim=>({name:claim.branch,head:'h',upstream:null,committedAt:at(3)}))},{staleMinutes:30,now});
 for(const agent of agents){
  const entry=view.branches.find(branch=>branch.name===`b-${agent.agentId}`);
  assert.equal(entry.claim.live,isLive(agent,{now,withinMinutes:30}),agent.agentId);
  assert.equal(entry.claim.live,liveness(agent,{now,withinMinutes:30}).live,agent.agentId);
  assert.equal(entry.claim.stale,!entry.claim.live,agent.agentId);
 }
 const holder=id=>view.branches.find(branch=>branch.name===`b-${id}`).claim.holder;
 assert.deepEqual(['fresh','edge','old','connected','gone','retired','disconnected'].map(holder),
  ['active','active','stale','active','left','retired','stale']);
 // The same agents seen through the broader registry window (the default 120 minutes) agree with the same helper.
 const wide=buildOwnership(state,{repo:'/r/.git',rooms:[room],worktrees:[],branches:claims.map(claim=>({name:claim.branch,head:'h',upstream:null,committedAt:at(3)}))},{staleMinutes:120,now});
 assert.equal(wide.branches.find(branch=>branch.name==='b-old').claim.live,true);
 assert.equal(wide.branches.find(branch=>branch.name==='b-old').flags.includes('orphaned'),false);
});

// ---- Obligations: one definition for prune, sweep, ephemeral leave and retire -----------------------------------------

async function obligated(f){
 await f.register('x',{ephemeral:true});await f.register('y');await f.register('z');
 await f.rpc({op:'claim',agentId:'x',resources:['build']});
 await f.rpc({op:'claim',agentId:'x',scope:'machine',resources:['native']});
 await f.rpc({op:'branches',action:'claim',agentId:'x',branch:'topic'});
 await f.rpc({op:'requestHandoff',agentId:'x',to:'y',resources:['build'],reason:'swap'});
 await f.rpc({op:'processes',action:'register',agentId:'x',pid:process.pid,command:'sleep'});
 await f.rpc({op:'tasks',action:'upsert',agentId:'x',id:'work',title:'Open work',kind:'epic',owner:'x'});
}

test('leave --if-idle, retire, prune and the sweep share one obligation set that includes branch claims and open work items',async t=>{
 const f=await fixture(t);
 await obligated(f);
 const kept=await f.rpc({op:'leave',agentId:'x',ifIdle:true});
 assert.equal(kept.left,false);assert.equal(kept.kept,true);
 const keys=['claims','machineClaims','branchClaims','handoffs','processes','tasks'];
 for(const key of keys)assert.equal(kept.obligations[key].length,1,key);
 assert.deepEqual(kept.obligations.branchClaims,['topic']);assert.deepEqual(kept.obligations.tasks,['work']);
 // retire reports the identical set, including open work items.
 const blocked=await f.request({op:'retire',agentId:'x'});
 assert.equal(blocked.status,409);assert.equal(blocked.error.code,'RETIRE_BLOCKED');
 for(const key of keys)assert.deepEqual(blocked.error[key],kept.obligations[key],key);
 // prune and the broker sweep keep the agent for the same reasons.
 const dry=await f.rpc({op:'prune',idleMinutes:0,ephemeralIdleMinutes:0,includeTest:true});
 assert.equal(dry.candidates.some(row=>row.agentId==='x'),false);
 // y holds the other end of x's pending handoff, so both are kept; only z is idle and obligation-free.
 assert.equal(dry.kept.withObligations,2);assert.deepEqual(dry.candidates.map(row=>row.agentId),['z']);
 await f.restart(state=>{for(const agent of state.rooms[0].agents)agent.updatedAt=ago(5000);},{pruneAfterMinutes:60,ephemeralPruneMinutes:15});
 const after=(await f.readState()).rooms[0].agents;
 assert.equal(after.find(agent=>agent.agentId==='x').left,undefined,'the sweep must not make an obligated agent dormant');
 assert.equal(after.find(agent=>agent.agentId==='y').left,undefined,'the handoff counterparty is kept too');
 assert.equal(after.find(agent=>agent.agentId==='z').left,true,'an obligation-free idle agent is swept');
 // relinquish retires and reports everything stranded, tasks included.
 const retired=await f.rpc({op:'retire',agentId:'x',relinquish:true});
 for(const key of keys)assert.deepEqual(retired.stranded[key],kept.obligations[key],key);
});

test('an open work item alone keeps an idle ephemeral agent from leaving or being pruned; finishing it releases the agent',async t=>{
 const f=await fixture(t);
 await f.register('w',{ephemeral:true});
 await f.rpc({op:'tasks',action:'upsert',agentId:'w',id:'job',title:'Job',owner:'w',status:'review'});
 assert.equal((await f.rpc({op:'leave',agentId:'w',ifIdle:true})).kept,true);
 assert.equal((await f.rpc({op:'prune',idleMinutes:0,ephemeralIdleMinutes:0})).kept.withObligations,1);
 await f.rpc({op:'tasks',action:'upsert',agentId:'w',id:'job',status:'done'});
 assert.equal((await f.rpc({op:'leave',agentId:'w',ifIdle:true})).left,'w');
});

test('prune op defaults to the broker prune threshold, like the prunable count and the sweep',async t=>{
 const f=await fixture(t,{options:{pruneAfterMinutes:60,ephemeralPruneMinutes:15,pruneIntervalMs:3600000}});
 await f.register('probe',{test:true});
 // Test-marked agents are skipped by the startup sweep, so the manual op is the only thing that can see this one.
 await f.restart(state=>{state.rooms[0].agents[0].updatedAt=ago(90);});
 const dry=await f.rpc({op:'prune',includeTest:true});
 assert.equal(dry.total,1,'a 90 minute idle agent is over the broker threshold of 60');
 assert.equal((await f.rpc({op:'prune',includeTest:true,idleMinutes:120})).total,0);
 assert.equal((await f.rpc({op:'prune',includeTest:true,idleMinutes:60})).total,1);
});

// ---- Ownership join across rooms -----------------------------------------------------------------------------------

gitTest('a dormant holder leaves its branch claim orphaned; the sweep never takes an agent that holds one',async t=>{
 const f=await fixture(t,{repo:true,worktrees:['feature']});
 await f.register('lead');
 await f.register('keeper',{},f.trees.feature);
 await f.rpc({op:'branches',action:'claim',agentId:'keeper',branch:'feature'},f.trees.feature);
 const own=async()=>(await f.rpc({op:'ownership'})).branches.find(branch=>branch.name==='feature');
 assert.equal((await own()).flags.includes('orphaned'),false);
 await f.restart(state=>{for(const room of state.rooms)for(const agent of room.agents)agent.updatedAt=ago(5000);},{pruneAfterMinutes:60,ephemeralPruneMinutes:15});
 const state=await f.readState();
 const keeper=state.rooms.find(room=>room.project===f.trees.feature).agents[0];
 assert.equal(keeper.left,undefined);
 assert.equal(state.rooms.find(room=>room.project===f.project).agents[0].left,true,'idle claim-free agent is pruned');
 const stale=await own();
 assert.equal(stale.claim.holder,'stale');assert.ok(stale.flags.includes('orphaned'));
 await f.rpc({op:'leave',agentId:'keeper'},f.trees.feature);
 const left=await own();
 assert.equal(left.claim.holder,'left');assert.ok(left.flags.includes('orphaned'));
 assert.equal(validateStore(await f.readState()),undefined);
});

gitTest('ownership joins tasks from sibling worktree rooms with kind and reported status, normalized branches, resources and artifacts',async t=>{
 const f=await fixture(t,{repo:true,worktrees:['feature']});
 await f.register('lead');await f.register('wt',{},f.trees.feature);
 const lead=fields=>f.rpc({op:'tasks',action:'upsert',agentId:'lead',...fields});
 const wt=fields=>f.rpc({op:'tasks',action:'upsert',agentId:'wt',...fields},f.trees.feature);
 await lead({id:'epic',title:'Epic',kind:'epic',branch:'refs/heads/feature',artifacts:['reports/epic']});
 await lead({id:'child',title:'Child',kind:'task',parentId:'epic',status:'in-progress'});
 await wt({id:'local',title:'Local',kind:'todo',branch:'feature',status:'review',artifacts:['reports/local','reports/epic']});
 await wt({id:'viaResource',title:'Resource',resources:['branch:feature'],status:'done'});
 await wt({id:'elsewhere',title:'Elsewhere',branch:'main'});
 const view=await f.rpc({op:'ownership'});
 const feature=view.branches.find(branch=>branch.name==='feature');
 const rows=Object.fromEntries(feature.tasks.map(row=>[row.id,row]));
 assert.deepEqual(Object.keys(rows).sort(),['epic','local','viaResource']);
 assert.deepEqual([rows.epic.kind,rows.epic.status,rows.epic.project],['epic','in-progress',f.project]);
 assert.deepEqual([rows.local.kind,rows.local.status,rows.local.project],['todo','review',f.trees.feature]);
 assert.deepEqual([rows.viaResource.kind,rows.viaResource.status],['task','done']);
 assert.deepEqual(feature.artifacts.sort(),['reports/epic','reports/local']);
 assert.deepEqual(view.branches.find(branch=>branch.name==='main').tasks.map(row=>row.id),['elsewhere']);
 // The work-item list agrees with the ownership join.
 assert.deepEqual((await f.rpc({op:'tasks',action:'list',branch:'feature'})).tasks.map(row=>row.id),['epic']);
});

// ---- usage: branch claims and work item counts -------------------------------------------------------------------------

test('usage counts branch claims and work items and flags branch claims near their bound',async t=>{
 const f=await fixture(t);
 await f.register('a');
 await f.rpc({op:'branches',action:'claim',agentId:'a',branch:'one'});
 await f.rpc({op:'tasks',action:'upsert',agentId:'a',id:'t',title:'T',kind:'epic'});
 const usage=await f.rpc({op:'usage'});
 assert.deepEqual(usage.branchClaims,{used:1,limit:4096});
 assert.equal(usage.headroom.branchClaims,4095);
 assert.equal(usage.rooms.detail[0].branchClaims,1);
 assert.deepEqual([usage.workItems.total,usage.workItems.byKind.epic,usage.workItems.byStatus.todo],[1,1,1]);
 assert.equal(usage.nearLimit.includes('branch-claims'),false);
 await f.restart(state=>{
  const room=state.rooms[0];
  state.branchClaims=Array.from({length:3800},(_,i)=>({repo:'/elsewhere/.git',branch:`b${i}`,agentId:'a',project:room.project,claimedAt:ago(1)}));
 });
 const near=await f.rpc({op:'usage'});
 assert.equal(near.headroom.branchClaims,296);assert.ok(near.nearLimit.includes('branch-claims'));
 validateStore(await f.readState());
});

// ---- validateStore / export / restore with every feature ------------------------------------------------------------

gitTest('a ledger using every new feature validates, round-trips through export and restore, and old ledgers still load',async t=>{
 const f=await fixture(t,{repo:true,worktrees:['feature']});
 await f.register('lead',{ephemeral:true});await f.register('wt',{},f.trees.feature);await f.register('sleeper');await f.register('peer');
 await f.rpc({op:'status',agentId:'lead',git:{branch:'main',head:'abc123',worktree:f.project}});
 await f.rpc({op:'branches',action:'claim',agentId:'lead',branch:'main',note:'trunk',meta:{baseCommit:'abc'}});
 // A forced release leaves a branch-scoped receipt in the release log, which must also survive validation and restore.
 await f.rpc({op:'branches',action:'forceRelease',agentId:'human',branch:'main',reason:'audit'});
 await f.rpc({op:'branches',action:'claim',agentId:'lead',branch:'main',note:'trunk',meta:{baseCommit:'abc'}});
 await f.rpc({op:'branches',action:'claim',agentId:'wt',branch:'feature'},f.trees.feature);
 const work=fields=>f.rpc({op:'tasks',action:'upsert',agentId:'lead',...fields});
 await work({id:'rm',title:'Roadmap',kind:'roadmap',description:'plan',priority:'p0',labels:['a','b'],order:1,dueAt:'2026-12-31T00:00:00Z'});
 await work({id:'ep',title:'Epic',kind:'epic',parentId:'rm',owner:'lead',branch:'feature',artifacts:['reports/x'],status:'in-progress'});
 await work({id:'td',title:'Todo',kind:'todo',parentId:'ep'});
 await f.rpc({op:'leave',agentId:'sleeper'});
 await f.rpc({op:'send',from:'lead',to:'*all',body:'everyone'});
 await f.rpc({op:'send',from:'lead',to:'*',body:'live ones'});
 const dormantSend=await f.rpc({op:'send',from:'lead',to:'sleeper',body:'wake up'});
 assert.equal(dormantSend.recipientDormant,true);
 const exported=await f.rpc({op:'export'});
 validateStore(structuredClone(exported.state));
 // Restore into a second, empty broker and compare the ledgers.
 const other=await fixture(t,{});
 const restored=await other.rpc({op:'restore',state:exported.state,schemaVersion:exported.schemaVersion});
 assert.equal(restored.restored,true);
 const again=await other.rpc({op:'export'},f.project);
 assert.deepEqual(again.state,exported.state);
 assert.deepEqual((await other.rpc({op:'branches',action:'list'},f.project)).claims.map(claim=>claim.branch).sort(),['feature','main']);
 assert.equal((await other.rpc({op:'tasks',action:'tree'},f.project)).roots[0].derivedStatus,'in-progress');
 assert.equal((await other.rpc({op:'ownership'},f.project)).branches.find(branch=>branch.name==='feature').claim.agentId,'wt');
 // Corrupt combinations are refused and old shapes load.
 const bad=structuredClone(exported.state);bad.branchClaims[0].agentId='ghost';
 assert.throws(()=>validateStore(bad),/corrupt/u);
 const worse=structuredClone(exported.state);worse.rooms[0].tasks.find(row=>row.id==='td').parentId='rm';
 validateStore(worse);worse.rooms[0].tasks.find(row=>row.id==='rm').parentId='td';
 assert.throws(()=>validateStore(worse),/corrupt/u);
 const old={version:1,nextCursor:2,rooms:[{project:f.project,cursor:1,claims:[],agents:[
  {agentId:'a',runner:'x',registeredAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z',status:'idle',frozen:false,resources:[],task:null},
  {agentId:'b',runner:'x',registeredAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z',status:'idle',frozen:false,resources:[],task:null,left:true}],
  messages:[{messageId:'m',from:'a',to:'*',body:'old broadcast',createdAt:'2020-01-01T00:00:00Z',cursor:1,recipients:['b'],ackedBy:[],notified:[]}],
  tasks:[{id:'t',creator:'a',title:'Legacy',state:'complete',createdAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z'}]}]};
 validateStore(old);
 assert.equal(reportedStatus(old.rooms[0].tasks[0],derivedStatuses(old.rooms[0].tasks)),'done');
});

// ---- git and the sweep never occupy the serial writer ------------------------------------------------------------

gitTest('slow git (ownership, branch ops, group detection) never blocks the serial writer',async t=>{
 if(process.platform==='win32'){t.skip('shell shim');return;}
 const f=await fixture(t,{repo:true,worktrees:['feature']});
 await f.register('a');
 const real=(await run('which',['git'])).stdout.trim();
 const shimDir=path.join(f.root,'shim');await fs.mkdir(shimDir);
 await fs.writeFile(path.join(shimDir,'git'),`#!/bin/sh\nsleep 1.2\nexec "${real}" "$@"\n`,{mode:0o755});
 const savedPath=process.env.PATH;process.env.PATH=`${shimDir}${path.delimiter}${savedPath}`;
 t.after(()=>{process.env.PATH=savedPath;});
 const slow=[f.request({op:'ownership'}),f.request({op:'branches',action:'claim',agentId:'a',branch:'topic'}),f.request({op:'register',agentId:'g',runner:'t',groupId:'grp'})];
 let settled=0;slow.forEach(promise=>promise.then(()=>{settled++;}));
 await new Promise(resolve=>setTimeout(resolve,150));
 const started=Date.now();
 const quick=await f.request({op:'status',agentId:'a',status:'busy'});
 const send=await f.request({op:'agents'});
 const elapsed=Date.now()-started;
 assert.equal(quick.ok,true);assert.equal(send.ok,true);
 assert.equal(settled,0,'the git-bound calls are still running while the writer serves other ops');
 assert.ok(elapsed<700,`writer was blocked for ${elapsed}ms`);
 const results=await Promise.all(slow);
 for(const result of results)assert.equal(result.ok,true,JSON.stringify(result));
});

// ---- MCP / OpenCode tool parity ----------------------------------------------------------------------------------------

test('MCP and OpenCode expose the same tools with the same arguments and required sets',async t=>{
 const adapter=await createMcpAdapter({project:'/tmp',runner:'claude',sessionId:'parity',rpcImpl:async()=>({ok:true}),waitImpl:async()=>({ok:true,messages:[],cursor:0})});
 const [serverSide,clientSide]=InMemoryTransport.createLinkedPair();
 const client=new Client({name:'parity',version:'1'});
 await adapter.server.connect(serverSide);await client.connect(clientSide);
 t.after(async()=>{try{await client.close();}catch{}try{await adapter.close();}catch{}});
 const mcp=(await client.listTools()).tools;
 const plugin=await AgentRelayPlugin({client:{},directory:'/tmp'},{transport:{rpc:async()=>({ok:true}),wait:()=>new Promise(()=>{})}});
 t.after(()=>plugin.dispose());
 const opencode=plugin.tool;
 assert.deepEqual(mcp.map(tool=>tool.name).sort(),Object.keys(opencode).sort());
 for(const name of ['relay_ownership','relay_branch','relay_prune','relay_roadmap','relay_tasks'])assert.ok(opencode[name],name);
 const drift=[];
 for(const tool of mcp){
  const other=opencode[tool.name];
  const left=Object.keys(tool.inputSchema.properties).sort(),right=Object.keys(other.args).sort();
  if(JSON.stringify(left)!==JSON.stringify(right))drift.push(`${tool.name} args mcp=[${left}] opencode=[${right}]`);
  const required=[...tool.inputSchema.required].sort(),optional=right.filter(key=>!other.args[key].isOptional()).sort();
  if(JSON.stringify(required)!==JSON.stringify(optional))drift.push(`${tool.name} required mcp=[${required}] opencode=[${optional}]`);
 }
 assert.deepEqual(drift,[]);
});

test('OpenCode relay_status needs no status, so a git-only report is possible, and handoff/narrow tools carry meta',async()=>{
 const calls=[];
 const plugin=await AgentRelayPlugin({client:{tui:{showToast:async()=>true},session:{status:async()=>({}),promptAsync:async()=>({})}},directory:'/tmp'},
  {transport:{rpc:async(project,fields)=>{calls.push(fields);return {ok:true,messages:[],cursor:0,agent:{},claims:[]};},wait:(project,agentId,cursor,options)=>new Promise((resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new Error('aborted'))))}});
 const ctx={sessionID:'ses_parity',directory:'/tmp',abort:new AbortController().signal};
 await plugin.tool.relay_status.execute({git:{branch:'feature'}},ctx);
 await plugin.tool.relay_handoff_request.execute({resources:['a'],reason:'r',meta:{baseCommit:'abc'}},ctx);
 await plugin.tool.relay_claim_narrow.execute({resource:'a',resources:['a/b'],meta:{baseCommit:'abc'}},ctx);
 const status=calls.find(fields=>fields.op==='status'&&fields.git);
 assert.equal(status.status,undefined);assert.deepEqual(status.git,{branch:'feature'});
 assert.deepEqual(calls.find(fields=>fields.op==='requestHandoff').meta,{baseCommit:'abc'});
 assert.deepEqual(calls.find(fields=>fields.op==='claimNarrow').meta,{baseCommit:'abc'});
 await plugin.dispose();
});

// ---- Client capability gating for every new op and field ---------------------------------------------------------------------

test('the client refuses every new op, action and field unless the broker advertises its feature',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-review-gate-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:200}));
 await fs.writeFile(path.join(dir,'broker.json'),JSON.stringify({pid:process.pid,url:'http://127.0.0.1:12399',token:'fixture'}));
 const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});
 const cases=[
  [{op:'register',agentId:'a',runner:'x',ephemeral:true},['ephemeral']],
  [{op:'register',agentId:'a',runner:'x',groupId:'g',ephemeral:true},['groups','ephemeral']],
  [{op:'leave',agentId:'a',ifIdle:true},['ephemeral']],
  [{op:'send',from:'a',to:'*all',body:'x'},['live-broadcast']],
  [{op:'send',from:'a',to:'*',body:'x',within:5},['live-broadcast']],
  [{op:'send',from:'a',to:'*all',body:'x',summary:'s'},['live-broadcast','summary']],
  [{op:'prune',dryRun:true},['prune']],
  [{op:'status',agentId:'a',git:{branch:'x'}},['git-context']],
  [{op:'status',agentId:'a',git:null},['git-context']],
  [{op:'status',agentId:'a',git:{branch:'x'},transport:{adapter:'a',state:'connected'}},['readiness','git-context']],
  [{op:'branches',action:'claim',agentId:'a',branch:'x'},['branch-claims']],
  [{op:'branches',action:'forceRelease',agentId:'h',branch:'x',reason:'r'},['branch-claims']],
  [{op:'ownership'},['ownership']],
  [{op:'tasks',action:'tree'},['tasks','work-items','work-tree']],
  [{op:'tasks',action:'import',markdown:'# x'},['tasks','work-items','work-import']],
  [{op:'tasks',action:'move',id:'a',parentId:null},['tasks','work-items']],
  [{op:'tasks',action:'remove',id:'a'},['tasks','work-items']],
  [{op:'tasks',action:'upsert',id:'a',kind:'epic'},['tasks','work-items']],
  [{op:'tasks',action:'list',status:'done'},['tasks','work-items']],
  [{op:'tasks',action:'list',parentId:null},['tasks','work-items']],
  [{op:'tasks',action:'list',label:'x'},['tasks','work-items']],
  [{op:'tasks',action:'upsert',id:'a',branch:'b'},['tasks','work-items']],
  [{op:'tasks',action:'upsert',id:'a',artifacts:['x']},['tasks','work-items']],
  [{op:'tasks',action:'upsert',id:'a',dueAt:'2026-01-01'},['tasks','work-items']],
  [{op:'retire',agentId:'a'},['retire']],
  [{op:'usage'},['storage-maintenance']],
 ];
 for(const [fields,needed] of cases){
  for(const advertised of [[],needed.slice(0,-1),...(needed.length>1?[needed.slice(1)]:[])]){
   const calls=[];
   globalThis.fetch=async(url,opts)=>{
    if(url.endsWith('/health'))return {ok:true};
    const input=JSON.parse(opts.body);calls.push(input.op);
    if(input.op==='capabilities')return {ok:true,json:async()=>({ok:true,features:advertised})};
    return {ok:true,json:async()=>({ok:true})};
   };
   const error=await clientRpc('/tmp',fields,{dataDir:dir}).then(()=>null,e=>e);
   assert.ok(error,`${JSON.stringify(fields)} with ${advertised}`);
   assert.equal(error.code,'UNSUPPORTED_FEATURE');
   for(const name of needed.filter(feature=>!advertised.includes(feature)))assert.ok(error.message.includes(name),`${name} in ${error.message}`);
   assert.deepEqual(calls,['capabilities'],'nothing may be submitted');
  }
  const calls=[];
  globalThis.fetch=async(url,opts)=>{
   if(url.endsWith('/health'))return {ok:true};
   const input=JSON.parse(opts.body);calls.push(input.op);
   if(input.op==='capabilities')return {ok:true,json:async()=>({ok:true,features:needed})};
   return {ok:true,json:async()=>({ok:true})};
  };
  await clientRpc('/tmp',fields,{dataDir:dir});
  assert.deepEqual(calls,['capabilities',fields.op],JSON.stringify(fields));
 }
 // Plain legacy calls never need a capability round trip.
 const calls=[];
 globalThis.fetch=async(url,opts)=>{if(url.endsWith('/health'))return {ok:true};calls.push(JSON.parse(opts.body).op);return {ok:true,json:async()=>({ok:true})};};
 for(const fields of [{op:'send',from:'a',to:'*',body:'x'},{op:'send',from:'a',to:'b',body:'x'},{op:'status',agentId:'a',status:'busy'},{op:'leave',agentId:'a'},
  {op:'register',agentId:'a',runner:'x'}])await clientRpc('/tmp',fields,{dataDir:dir});
 assert.equal(calls.includes('capabilities'),false);
});

test('the broker advertises a feature for everything the client gates on',async t=>{
 const f=await fixture(t);
 const {features}=await f.rpc({op:'capabilities'});
 for(const name of ['live-broadcast','dormant-delivery','ephemeral','prune','branch-claims','ownership','git-context','work-items','work-tree','work-import','tasks','groups','retire','storage-maintenance'])
  assert.ok(features.includes(name),name);
});

// ---- CLI help ------------------------------------------------------------------------------------------------------------

test('CLI help lists every command once and every work and branch subcommand once',async()=>{
 const source=await fs.readFile(new URL('../bin/agent-relay.mjs',import.meta.url),'utf8');
 const main=source.slice(source.indexOf('async function main()'));
 const commands=[...new Set([...main.matchAll(/^\s*case '([a-z-]+)':/gmu)].map(match=>match[1]))].filter(name=>name!=='help');
 const {stdout}=await run(process.execPath,[fileURLToPath(new URL('../bin/agent-relay.mjs',import.meta.url)),'help']);
 const lines=stdout.split('\n').filter(line=>/^ {2}agent-relay /u.test(line));
 const counts=new Map();
 for(const line of lines){const name=line.trim().split(/\s+/u)[1];counts.set(name,(counts.get(name)??0)+1);}
 const missing=commands.filter(name=>!counts.has(name)&&!(name==='version'));
 assert.deepEqual(missing,[]);
 for(const [name,count] of counts){
  if(name==='work')continue;
  assert.equal(count,1,`${name} appears ${count} times in help`);
 }
 const subcommands=lines.filter(line=>/^ {2}agent-relay work /u.test(line)).map(line=>line.trim().split(/\s+/u)[2]).sort();
 assert.deepEqual(subcommands,['add','import','list','move','rm','set','tree']);
 const branch=lines.find(line=>/^ {2}agent-relay branch /u.test(line));
 for(const word of ['claim','release','list','force-release'])assert.ok(branch.includes(word),word);
 assert.ok(lines.some(line=>/agent-relay leave .*--if-idle/u.test(line)));
 assert.ok(lines.some(line=>/agent-relay retire .*--relinquish/u.test(line)));
});
