import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {boot,modelContext,textOf,findAll,byClass,plain} from './dashboard-dom.mjs';

// Real-broker data shapes behind the polish pass: git common dirs as the repo, one worktree row per checkout,
// containers that keep the default 'todo' status while their children move, and rooms with nothing in them yet.
const M=modelContext();
const ago=minutes=>new Date(Date.now()-minutes*60000).toISOString();
const node=(id,title,kind,status,extra={})=>({id,title,kind,status,state:status==='done'?'complete':'open',owner:null,priority:null,labels:[],branch:null,artifacts:[],blocked:status==='blocked',blocking:[],children:[],createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-14T00:00:00Z',...extra});

test('repoLabel names the repository: the parent folder of a .git common dir, the folder of a bare repo, never ".git"',()=>{
 assert.deepEqual(plain(M.repoLabel('/home/me/code/tower-demo/.git')),{name:'tower-demo',path:'/home/me/code/tower-demo/.git'});
 assert.equal(M.repoLabel('/home/me/code/tower-demo/.git/').name,'tower-demo','a trailing slash changes nothing');
 assert.equal(M.repoLabel('C:\\work\\tower-demo\\.git').name,'tower-demo');
 assert.equal(M.repoLabel('/srv/git/relay.git').name,'relay.git','a bare repo is its folder');
 assert.equal(M.repoLabel('/home/me/code/plain-dir').name,'plain-dir','a non-git path keeps its own name');
 assert.equal(M.repoLabel({root:'/a/b/.git'}).name,'b');assert.deepEqual(plain(M.repoLabel(undefined)),{name:'',path:''});assert.equal(M.repoLabel('/.git').name,'.git','nothing above the .git folder to name');
});

test('worktreeRows shows each checkout once, marks the current room and says whether a room is registered',()=>{
 const rows=plain(M.worktreeRows([
  {path:'/r/tower-wt',project:'/r/tower-wt'},{path:'/r/tower-wt',project:'/r/tower-wt'},
  {path:'/r/main',project:'/r/main'},{path:'/r/scratch',project:null},{path:'/r/.wt/review',project:'/r/rooms/review-room'},{path:''}
 ],{project:'/r/main'}));
 assert.deepEqual(rows.map(r=>r.path),['/r/main','/r/.wt/review','/r/scratch','/r/tower-wt'],'deduplicated, the current room first, then by name');
 assert.deepEqual(rows.map(r=>[r.name,r.current,r.registered]),[['main',true,true],['review',false,true],['scratch',false,false],['tower-wt',false,true]]);
 assert.equal(rows[0].roomName,'','no second label when the room folder carries the same name');
 assert.equal(rows[1].roomName,'review-room','a differently named room is shown beside the checkout');
 assert.equal(M.worktreeRows([{path:'/r/x',project:null}],{project:'/r/y',rooms:['/r/x']})[0].registered,true,'a known room at the checkout path counts');
 assert.deepEqual(plain(M.worktreeRows(undefined)),[]);
});

test('conflictSummary counts branches with any flag and captions every flag kind that occurs, contested first',()=>{
 const flagged=(...flags)=>({name:flags.join('+')||'clear',flags});
 const rows=[flagged('orphaned'),flagged('contested','unclaimed'),flagged('missing'),flagged('unclaimed'),flagged('unclaimed'),flagged()];
 assert.deepEqual(plain(M.conflictSummary(rows)),{count:5,total:6,caption:'1 contested · 1 missing · 1 orphaned · 3 unclaimed',tone:'alert'});
 assert.equal(M.conflictSummary([flagged('orphaned')]).tone,'warn');
 assert.equal(M.conflictSummary([flagged('unclaimed'),flagged()]).tone,'','unclaimed alone is information, not an alarm');
 assert.deepEqual(plain(M.conflictSummary([flagged(),flagged()])),{count:0,total:2,caption:'all branches clear',tone:'live'});
 assert.deepEqual(plain(M.conflictSummary([])),{count:0,total:0,caption:'no branches yet',tone:'live'});
});

test('displayStatus shows a container status from the broker roll-up, else derives it from progress and children',()=>{
 const kids=(...statuses)=>statuses.map((s,i)=>node('c'+i,'Child '+i,'task',s));
 const parent=(statuses,extra={})=>node('p','Parent','epic','todo',{children:kids(...statuses),...extra});
 const show=n=>plain(M.displayStatus(n));
 assert.deepEqual(show(parent(['done','todo'])),{status:'in-progress',derived:true},'progress above zero means the work started');
 assert.deepEqual(show(parent(['done','done'])),{status:'done',derived:true});
 assert.deepEqual(show(parent(['todo','todo'])),{status:'todo',derived:false},'nothing started: the plain default, not marked derived');
 assert.deepEqual(show(parent(['todo','in-progress'])),{status:'in-progress',derived:true},'a child in flight is enough');
 assert.deepEqual(show(parent(['todo','review'])).status,'in-progress');assert.deepEqual(show(parent(['todo','blocked'])).status,'in-progress');
 assert.deepEqual(show(parent(['cancelled','cancelled'])),{status:'cancelled',derived:true});
 assert.equal(show(parent(['todo','todo'],{progress:{done:4,total:10,percent:40}})).status,'in-progress','broker progress wins over leaves when present');
 assert.equal(show(parent(['done','todo'],{derivedStatus:'review'})).status,'review','the broker roll-up is preferred');
 assert.equal(show(parent(['todo'],{derivedStatus:'bogus'})).status,'todo','an unknown derivedStatus is ignored');
 assert.deepEqual(show(parent(['done','todo'],{status:'blocked'})),{status:'blocked',derived:false},'an explicit status on the container is respected');
 assert.deepEqual(show(parent(['done','todo'],{status:'in-progress'})),{status:'in-progress',derived:false});
 const nested=node('r','Root','roadmap','todo',{children:[node('ph','Phase','phase','todo',{children:[node('t','Deep','task','todo',{children:[node('d','Do','todo','in-progress')]})]})]});
 assert.equal(show(nested).status,'in-progress','nested leaves count');
 assert.deepEqual(show(node('x','Leaf','task','review')),{status:'review',derived:false});assert.deepEqual(show(node('x','Leaf','task',undefined)),{status:'todo',derived:false});
 assert.deepEqual(show(node('x','No status','epic',undefined,{children:kids('done','todo')})),{status:'in-progress',derived:true});
 assert.equal(M.filterTree([parent(['done','todo'])],{status:'in-progress'})[0].context,false,'filtering by status matches what the chip shows');
});

test('runwayState and describeUnassigned explain each empty or special case in words',()=>{
 assert.equal(M.runwayState(null),'loading');assert.equal(M.runwayState({available:false}),'unavailable');
 assert.equal(M.runwayState({available:true,git:false,branches:[]}),'no-git');assert.equal(M.runwayState({available:true,git:true,branches:[]}),'empty');
 assert.equal(M.runwayState({available:true,branches:[{name:'main'}]}),'ready','a broker that does not say git:true still shows its branches');
 assert.equal(M.describeUnassigned('claims',{branch:'feat/gone',agentId:'k-9',reason:'missing'}),'feat/gone · k-9 · branch not found');
 assert.equal(M.describeUnassigned('claims',{branch:'x',agentId:'a',reason:'no-git',stale:true}),'x · a · no git repository · stale');
 assert.equal(M.describeUnassigned('worktrees',{path:'/r/detached',head:'0123456789',agents:[{},{}]}),'detached · @ 0123456 · 2 agents');
 assert.equal(M.describeUnassigned('worktrees',{path:'/r/d',head:null,agents:[]}),'d · detached');
 assert.equal(M.describeUnassigned('agents',{agentId:'idle-1',source:'status',project:'/w'}),'idle-1 · status · w');
});

// ---- Rendering against the fake DOM ------------------------------------------------------
const rooms={rooms:[{project:'/w',agentCount:2,messageCount:0,pendingDeliveries:0,lastActivityAt:null}],preferredProject:'/w'};
const snapshotOf=(extra={})=>({project:'/w',agents:[{agentId:'atlas',runner:'claude',status:'working',frozen:false,task:'Wire it',updatedAt:ago(1),live:true}],claims:[],messages:[],totalMessages:0,pendingDeliveries:0,pendingByAgent:{},cursor:0,...extra});
const branch=(name,extra={})=>({name,head:'abcdef123456',upstream:null,committedAt:ago(30),worktrees:[],claim:null,agents:[],tasks:[],artifacts:[],flags:[],...extra});

test('runways name the repository instead of the .git directory and show each worktree once with its room',async()=>{
 const ownership={available:true,git:true,repo:'/home/me/tower-demo/.git',rooms:['/w','/home/me/tower-wt'],generatedAt:new Date().toISOString(),unassigned:{claims:[{branch:'feat/gone',agentId:'k-9',reason:'missing'}],worktrees:[]},branches:[
  branch('feat/tower',{flags:['contested'],worktrees:[{path:'/home/me/tower-wt',project:'/home/me/tower-wt'},{path:'/w',project:'/w'},{path:'/home/me/loose',project:null}]})]};
 const page=boot({projects:rooms,snapshot:snapshotOf(),ownership,path:'/branches/'});await page.flush();
 const meta=page.$('branches-meta');
 assert.match(textOf(meta),/^tower-demo · 1 branch · 1 flagged/);assert.doesNotMatch(textOf(meta),/\.git/);assert.equal(meta.title,'/home/me/tower-demo/.git','the full path stays one hover away');
 const card=findAll(page.$('branches'),el=>el.tag==='article')[0],items=byClass(card,'wt');
 assert.equal(items.length,3);
 assert.deepEqual(items.map(el=>byClass(el,'wt-name').map(textOf)[0]),['w','loose','tower-wt'],'each checkout appears once, the current room first');
 assert.deepEqual(items.map(el=>byClass(el,'chip').map(textOf)),[['this room','room registered'],['no room'],['room registered']]);
 assert.doesNotMatch(textOf(items[2]),/tower-wt.*tower-wt/,'the folder name is not repeated');
 assert.equal(items[2].title.includes('/home/me/tower-wt'),true);
 assert.match(textOf(page.$('unassigned')),/Claims without a branch \(1\)/);assert.match(textOf(page.$('unassigned')),/feat\/gone · k-9 · branch not found/);
});

test('tower branch card: the number is every flagged branch and the caption lists each flag kind', async()=>{
 const ownership={available:true,git:true,repo:'/w/.git',rooms:['/w'],branches:[branch('a',{flags:['contested']}),branch('b',{flags:['orphaned']}),branch('c',{flags:['unclaimed']}),branch('d',{flags:['unclaimed']}),branch('e'),branch('f',{flags:['missing']})]};
 const page=boot({projects:rooms,snapshot:snapshotOf(),ownership});await page.flush();
 assert.equal(textOf(page.$('conflicts-count')),'5');assert.equal(textOf(page.$('conflicts-sub')),'1 contested · 1 missing · 1 orphaned · 2 unclaimed');
 assert.equal(textOf(page.$('count-branches')),'5','the rail agrees with the card');
 const clear=boot({projects:rooms,snapshot:snapshotOf(),ownership:{...ownership,branches:[branch('main')]}});await clear.flush();
 assert.equal(textOf(clear.$('conflicts-count')),'0');assert.equal(textOf(clear.$('conflicts-sub')),'all branches clear');
});

test('flight plan shows a derived status on parents that kept the default, falling back to progress on older brokers', async()=>{
 const parent=(extra={})=>node('EP','Registry','epic','todo',{progress:{done:2,total:5,percent:40},children:[node('A','Done one','task','done'),node('B','Open one','task','todo')],...extra});
 const root=extra=>({available:true,roots:[node('RM','Roadmap','roadmap','todo',{progress:{done:2,total:5,percent:40},children:[parent(extra)]})],counts:{byKind:{},byStatus:{}}});
 const chipFor=(page,id)=>byClass(findAll(page.$('roadmap-tree'),el=>el.tag==='li'&&el.dataset.id===id)[0],'status')[0];
 const older=boot({projects:rooms,snapshot:snapshotOf(),work:root(),path:'/roadmap/'});await older.flush();
 assert.match(textOf(chipFor(older,'EP')),/In progress/,'no derivedStatus from the broker: derived from progress');
 assert.match(String(chipFor(older,'EP').className),/derived/);assert.match(chipFor(older,'EP').title,/Derived from the progress/);
 assert.match(textOf(chipFor(older,'RM')),/In progress/);assert.match(textOf(chipFor(older,'A')),/Done/);assert.doesNotMatch(String(chipFor(older,'A').className),/derived/);
 const newer=boot({projects:rooms,snapshot:snapshotOf(),work:root({derivedStatus:'review'}),path:'/roadmap/'});await newer.flush();
 assert.match(textOf(chipFor(newer,'EP')),/In review/,'the broker derivedStatus is used when present');
 const explicit=boot({projects:rooms,snapshot:snapshotOf(),work:root({status:'blocked'}),path:'/roadmap/'});await explicit.flush();
 assert.match(textOf(chipFor(explicit,'EP')),/Blocked/);assert.doesNotMatch(String(chipFor(explicit,'EP').className),/derived/);
 const idle=boot({projects:rooms,snapshot:snapshotOf(),work:root({progress:{done:0,total:2,percent:0},children:[node('A','One','task','todo'),node('B','Two','task','todo')]}),path:'/roadmap/'});await idle.flush();
 assert.match(textOf(chipFor(idle,'EP')),/To do/);assert.doesNotMatch(String(chipFor(idle,'EP').className),/derived/);
});

test('a project that is not a git repository says so instead of showing an empty board', async()=>{
 const ownership={available:true,git:false,repo:'/w',rooms:['/w'],branches:[],totalBranches:0,truncated:false,unassigned:{claims:[{branch:'feat/x',agentId:'a',reason:'no-git'}],worktrees:[]}};
 const page=boot({projects:rooms,snapshot:snapshotOf(),ownership,path:'/branches/'});await page.flush();
 assert.match(textOf(page.$('branches')),/No git repository here/);assert.match(textOf(page.$('branches-meta')),/Not a git repository/);
 assert.equal(findAll(page.$('branch-chips'),el=>el.tag==='button').length,0);
 assert.match(textOf(page.$('unassigned')),/feat\/x · a · no git repository/,'claims that cannot be placed stay visible');
 page.sandbox.go('overview');assert.equal(textOf(page.$('conflicts-count')),'—');assert.equal(textOf(page.$('conflicts-sub')),'not a git repository');
 const empty=boot({projects:rooms,snapshot:snapshotOf(),ownership:{available:true,git:true,repo:'/w/.git',rooms:['/w'],branches:[],unassigned:{claims:[],worktrees:[]}},path:'/branches/'});await empty.flush();
 assert.match(textOf(empty.$('branches')),/No branches yet/);
 const cut=boot({projects:rooms,snapshot:snapshotOf(),ownership:{available:true,git:true,repo:'/w/.git',rooms:['/w'],branches:[branch('a')],totalBranches:900,truncated:true,unassigned:{}},path:'/branches/'});await cut.flush();
 assert.match(textOf(cut.$('branches')),/mapped 1 of 900 branches/);assert.match(textOf(cut.$('branches-meta')),/1 of 900 branches/);
});

test('a brand-new room and a broker with no rooms get an orientation, not a wall of zeros', async()=>{
 const fresh=boot({projects:rooms,snapshot:snapshotOf({agents:[]}),work:{available:true,roots:[],counts:{}},ownership:{available:true,git:true,repo:'/w/.git',rooms:['/w'],branches:[],unassigned:{}}});await fresh.flush();
 assert.equal(fresh.$('welcome').hidden,false);assert.match(textOf(fresh.$('h-welcome')),/Quiet frequency/);assert.match(textOf(fresh.$('welcome-lede')),/No agent has checked in from w yet/);
 assert.equal(textOf(fresh.$('agents-count')),'0');assert.equal(textOf(fresh.$('messages-count')),'0');assert.equal(textOf(fresh.$('roadmap-sub')),'no work items yet');
 assert.match(textOf(fresh.$('traffic')),/No registered agents in this room/);assert.match(textOf(fresh.$('recent')),/No transmissions yet/);
 const busy=boot({projects:rooms,snapshot:snapshotOf()});await busy.flush();assert.equal(busy.$('welcome').hidden,true,'a room with an agent is not new');
 const none=boot({projects:{rooms:[],preferredProject:'/w'},snapshot:snapshotOf()});await none.flush();
 assert.equal(none.$('welcome').hidden,false);assert.match(textOf(none.$('h-welcome')),/No rooms yet/);assert.match(textOf(none.$('welcome-lede')),/No project has registered/);
 assert.match(textOf(none.$('registry')),/No project room is selected/);assert.doesNotMatch(textOf(none.$('registry')),/Waiting for the first snapshot/);
});

test('empty plan state tells you how to start a roadmap', async()=>{
 const page=boot({projects:rooms,snapshot:snapshotOf(),work:{available:true,roots:[],counts:{}},path:'/roadmap/'});await page.flush();
 assert.match(textOf(page.$('roadmap-tree')),/agent-relay work import --file ROADMAP\.md/);
});

// ---- Static design contract --------------------------------------------------------------
test('markup keeps the welcome card hidden by default, labelled, and free of inline script or style', async()=>{
 const html=await readFile(new URL('../lib/dashboard/index.html',import.meta.url),'utf8');
 assert.match(html,/id="welcome"[^>]*aria-labelledby="h-welcome"[^>]*hidden/);assert.match(html,/Branch flags/);assert.doesNotMatch(html,/Branch conflicts/);
});
