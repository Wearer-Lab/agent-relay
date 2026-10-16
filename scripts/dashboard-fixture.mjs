// Preview helper: starts a throwaway broker, fills it with a small fleet, and serves the read-only dashboard on loopback.
//   node scripts/dashboard-fixture.mjs [--mock] [--port N] [--open] [--keep]
// --mock overlays synthetic roadmap, branch-ownership, registry and liveness data, for brokers that cannot report them yet.
// Everything lives in a temporary directory that is removed on exit (unless --keep).
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createBroker} from '../lib/broker.mjs';
import {startDashboard,openDashboard} from '../lib/dashboard.mjs';

const flags=new Set(process.argv.slice(2).filter(a=>a.startsWith('--'))),portArg=process.argv.indexOf('--port');
const port=portArg>0?Number(process.argv[portArg+1]):0;

function tree(){
 let n=0;const leaf=(title,status,extra={})=>({id:`T-${++n}`,title,kind:'task',status,state:status==='done'?'complete':'open',owner:null,priority:null,labels:[],branch:null,artifacts:[],blocked:status==='blocked',blocking:[],children:[],createdAt:'2026-10-01T09:00:00Z',updatedAt:'2026-10-14T09:00:00Z',...extra});
 const todo=(title,status)=>leaf(title,status,{kind:'todo'});
 const roll=node=>{
  if(!node.children.length){node.progress={done:node.status==='done'?1:0,total:node.status==='cancelled'?0:1,percent:node.status==='done'?100:0};return node.progress;}
  const sum={done:0,total:0};for(const child of node.children){const p=roll(child);sum.done+=p.done;sum.total+=p.total;}
  node.progress={...sum,percent:sum.total?Math.round(sum.done/sum.total*100):0};
  node.status=node.progress.percent===100?'done':sum.done||node.children.some(c=>c.status==='in-progress')?'in-progress':node.status;return node.progress;
 };
 const roadmap={id:'RM-1',title:'Relay 0.4 launch',kind:'roadmap',status:'in-progress',state:'open',owner:'atlas-7',priority:1,labels:['launch'],branch:null,artifacts:[],blocked:false,blocking:[],createdAt:'2026-09-20T09:00:00Z',updatedAt:'2026-10-14T09:00:00Z',children:[
  {...leaf('Foundations','todo',{kind:'phase',id:'PH-1',owner:'atlas-7'}),children:[
   {...leaf('Durable work tree','todo',{kind:'epic',id:'EP-1',owner:'atlas-7',branch:'feat/work-tree',labels:['broker']}),children:[
    leaf('Tree action on tasks op','done',{owner:'atlas-7',branch:'feat/work-tree',labels:['broker']}),
    leaf('Roll-up progress','done',{owner:'atlas-7',branch:'feat/work-tree'}),
    leaf('Legacy list fallback','review',{owner:'vector-4',branch:'feat/work-tree',labels:['compat']}),
    {...leaf('Validation hardening','todo',{kind:'task',owner:'vector-4'}),children:[todo('Bound label arrays','done'),todo('Reject cycles','in-progress'),todo('Backward compatible load','todo')]}]},
   {...leaf('Branch ownership map','todo',{kind:'epic',id:'EP-2',owner:'kestrel-9',branch:'feat/ownership',labels:['git']}),children:[
    leaf('Enumerate branches and worktrees','done',{owner:'kestrel-9',branch:'feat/ownership'}),
    leaf('Flag contested and orphaned','in-progress',{owner:'kestrel-9',branch:'feat/ownership',labels:['git']}),
    leaf('Surface in the dashboard','blocked',{owner:'nimbus-2',blocked:true,blocking:[{ref:'feat/ownership',kind:'claim',holder:'kestrel-9',state:'held'}]})]}]},
  {...leaf('Tower redesign','todo',{kind:'phase',id:'PH-2',owner:'nimbus-2'}),children:[
   {...leaf('Views','todo',{kind:'epic',id:'EP-3',owner:'nimbus-2',branch:'feat/tower',labels:['dashboard']}),children:[
    leaf('Tower overview','in-progress',{owner:'nimbus-2',branch:'feat/tower',labels:['dashboard','design']}),
    leaf('Flight plan tree and lanes','in-progress',{owner:'nimbus-2',branch:'feat/tower'}),
    leaf('Runways board','todo',{owner:'nimbus-2',branch:'feat/tower'}),
    leaf('Strips and radio log','todo',{owner:'harbor-1',branch:'feat/tower'}),
    leaf('Retired mockups','cancelled',{owner:'quill-3'})]}]},
  {...leaf('Release','todo',{kind:'phase',id:'PH-3'}),children:[
   leaf('Publish npm package','todo',{owner:'quill-3',branch:'release/0.4',priority:2,labels:['release']}),
   leaf('Landing page','todo',{owner:'quill-3',branch:'feat/site',labels:['release','docs']})]}]};
 roll(roadmap);
 const counts={byKind:{},byStatus:{}};const count=node=>{counts.byKind[node.kind]=(counts.byKind[node.kind]??0)+1;counts.byStatus[node.status]=(counts.byStatus[node.status]??0)+1;node.children.forEach(count);};count(roadmap);
 return {available:true,roots:[roadmap],counts};
}
function ownership(project){
 const minutesAgo=m=>new Date(Date.now()-m*60000).toISOString();
 const live=(agentId,l=true)=>({agentId,project,live:l,source:l?'claim':'commit'});
 return {available:true,repo:project,rooms:[project],generatedAt:new Date().toISOString(),branches:[
  {name:'main',head:'9f3c2a1b7',upstream:'origin/main',committedAt:minutesAgo(90),worktrees:[{path:project,project}],claim:null,agents:[],tasks:[],artifacts:[],flags:[]},
  {name:'feat/tower',head:'a41be09c2',upstream:null,committedAt:minutesAgo(4),worktrees:[{path:project+'/.wt/tower',project}],claim:{agentId:'nimbus-2',project,claimedAt:minutesAgo(130),note:'dashboard redesign',live:true,stale:false},agents:[live('nimbus-2'),live('harbor-1')],tasks:[{id:'T-9',title:'Tower overview',state:'open',owner:'nimbus-2'},{id:'T-10',title:'Flight plan tree and lanes',state:'open',owner:'nimbus-2'}],artifacts:['docs/dashboard.md'],flags:['contested']},
  {name:'feat/ownership',head:'77d0e5f31',upstream:'origin/feat/ownership',committedAt:minutesAgo(46),worktrees:[],claim:{agentId:'kestrel-9',project,claimedAt:minutesAgo(300),note:'branch map',live:true,stale:false},agents:[live('kestrel-9')],tasks:[{id:'T-6',title:'Flag contested and orphaned',state:'open',owner:'kestrel-9'}],artifacts:[],flags:[]},
  {name:'feat/work-tree',head:'1be8a77d0',upstream:'origin/feat/work-tree',committedAt:minutesAgo(2600),worktrees:[],claim:{agentId:'vector-4',project,claimedAt:minutesAgo(2900),note:'stalled',live:false,stale:true},agents:[live('vector-4',false)],tasks:[{id:'T-3',title:'Legacy list fallback',state:'open',owner:'vector-4'}],artifacts:[],flags:['orphaned']},
  {name:'release/0.4',head:'00ac91e55',upstream:null,committedAt:minutesAgo(900),worktrees:[],claim:null,agents:[],tasks:[{id:'T-12',title:'Publish npm package',state:'open',owner:'quill-3'}],artifacts:[],flags:['unclaimed']},
  {name:'feat/site',head:null,upstream:null,committedAt:null,worktrees:[],claim:null,agents:[live('quill-3')],tasks:[{id:'T-13',title:'Landing page',state:'open',owner:'quill-3'}],artifacts:[],flags:['missing']},
  {name:'spike/radar-sweep',head:'c20d4488a',upstream:null,committedAt:minutesAgo(12000),worktrees:[],claim:null,agents:[],tasks:[],artifacts:[],flags:['unclaimed']}],
  unassigned:{agents:[{agentId:'harbor-1',project,live:true,source:'status'}],tasks:[{id:'T-20',title:'Triage backlog',state:'open',owner:null}]}};
}
// Wraps the real observer: the real snapshot, messages and claims stay; work, ownership, registry and liveness are synthetic.
function mock(observer){
 const live=new Set(['atlas-7','nimbus-2','kestrel-9','harbor-1']);
 return {...observer,
  async getSnapshot(project){
   const real=await observer.getSnapshot(project);
   const extra=Array.from({length:44},(_,i)=>({agentId:`${['glint','ember','sable','orbit','fjord'][i%5]}-${100+i}`,runner:['codex','claude','opencode'][i%3],status:'idle',frozen:false,task:null,updatedAt:new Date(Date.now()-(3+i*4)*3600000).toISOString(),live:false,left:false}));
   const agents=[...real.agents.map(a=>({...a,live:live.has(a.agentId),readiness:{...a.readiness,transport:{state:live.has(a.agentId)?'connected':'unknown',adapter:a.runner,ts:new Date().toISOString(),source:'adapter-report'},push:{ready:live.has(a.agentId)}}})),...extra];
   return {...real,agents,registry:{stored:1410,live:live.size,dormant:1262,retired:96,ephemeral:27,prunable:388}};
  },
  async getWork(){return tree();},
  async getOwnership(project){return ownership(project);}};
}

const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-dashboard-fixture-')),dataDir=path.join(root,'data'),project=path.join(root,'tower-demo'),other=path.join(root,'harbor-ops');
await Promise.all([dataDir,project,other].map(dir=>fs.mkdir(dir)));
const broker=await createBroker({dataDir});let dashboard;
await fs.writeFile(path.join(dataDir,'broker.json'),JSON.stringify({pid:process.pid,url:broker.url,token:broker.token}));
const call=async(fields,room=project)=>{
 const response=await fetch(broker.url+'/rpc',{method:'POST',headers:{authorization:'Bearer '+broker.token,'content-type':'application/json'},body:JSON.stringify({project:room,...fields})});
 const result=await response.json();if(!result.ok)throw Object.assign(new Error(result.error?.message??'Broker call failed.'),{code:result.error?.code});return result;
};
const soft=async(fields,room)=>{try{return await call(fields,room);}catch(error){console.warn(`(skipped ${fields.op}${fields.action?':'+fields.action:''}: ${error.message})`);}};
const fleet=[['atlas-7','claude','Reviewing broker op wiring'],['nimbus-2','claude','Redesigning the tower dashboard'],['vector-4','codex','Waiting on review for the legacy fallback'],['kestrel-9','opencode','Mapping branch ownership'],['harbor-1','codex',null],['quill-3','claude','Drafting release notes']];
for(const [agentId,runner,task] of fleet){await call({op:'register',agentId,runner});await call({op:'status',agentId,status:task?'working':'idle',task});}
await call({op:'register',agentId:'dock-1',runner:'codex'},other);
const say=(from,to,body,extra={})=>call({op:'send',from,to,body,...extra});
await say('atlas-7','*','Tower is open. Branch feat/tower belongs to nimbus-2; ping me before touching the broker.',{messageId:'m1',summary:'Tower open'});
await say('nimbus-2','atlas-7','Understood. Will the work tree op land before I wire the flight plan view?',{messageId:'m2',replyTo:'m1'});
await say('atlas-7','nimbus-2','Yes, tasks tree is in review. Falls back to the flat list on older brokers.',{messageId:'m3',replyTo:'m2'});
await say('kestrel-9','vector-4','Your branch feat/work-tree looks stale. Still yours?',{messageId:'m4',summary:'Stale branch?'});
await say('vector-4','*','Released the claim on the validator. Taking a break; anyone can pick it up.',{messageId:'m5'});
await say('quill-3','nimbus-2','Need screenshots of all six views for the landing page.',{messageId:'m6',summary:'Screenshots'});
await call({op:'ack',agentId:'nimbus-2',messageId:'m1'});await call({op:'ack',agentId:'atlas-7',messageId:'m2'});await call({op:'ack',agentId:'nimbus-2',messageId:'m3'});
await call({op:'claim',agentId:'nimbus-2',resources:['lib/dashboard/dashboard.js','lib/dashboard/dashboard.css','lib/dashboard/index.html']});
await call({op:'claim',agentId:'atlas-7',resources:['lib/broker.mjs']});
await call({op:'claim',agentId:'vector-4',resources:['test/work-tree.test.mjs']});
for(const [id,title,owner] of [['T-1','Tree action on tasks op','atlas-7'],['T-2','Roll-up progress','atlas-7'],['T-3','Surface in the dashboard','nimbus-2']])await soft({op:'tasks',action:'upsert',agentId:owner,id,title,owner});
await soft({op:'tasks',action:'complete',agentId:'atlas-7',id:'T-1'});

if(!flags.has('--mock')){
 // Real git worktrees, branch claims and an imported roadmap exercise the merged broker ops end to end.
 const {execFileSync}=await import('node:child_process');
 const git=(args,cwd=project)=>{try{return execFileSync('git',args,{cwd,stdio:['ignore','pipe','ignore']}).toString();}catch{return null;}};
 if(git(['init','-q','-b','main'])!==null){
  for(const args of [['config','user.email','fixture@example.invalid'],['config','user.name','Fixture'],['commit','-q','--allow-empty','-m','init'],['branch','feat/tower'],['branch','feat/work-tree'],['branch','release/0.4'],['worktree','add','-q',path.join(root,'tower-wt'),'feat/tower']])git(args);
  const wt=path.join(root,'tower-wt');
  await soft({op:'register',agentId:'nimbus-wt',runner:'claude'},wt);
  await soft({op:'branches',action:'claim',agentId:'nimbus-2',branch:'feat/tower',note:'dashboard redesign'});
  await soft({op:'branches',action:'claim',agentId:'vector-4',branch:'feat/work-tree',note:'stalled'});
  await soft({op:'branches',action:'claim',agentId:'kestrel-9',branch:'feat/gone',note:'deleted upstream'});
 }
 const roadmap=['# Relay 0.4','Owner: atlas-7','## Phase 1: Registry hygiene','### Live broadcast','- [x] Liveness window','- [x] Dormant direct delivery','- [ ] Prune sweep','  - [ ] Dry-run report','  - [x] Obligation guard','## Phase 2: Ownership','Branch: feat/tower','### Branch claims','- [x] Repo-scoped claims','- [ ] Ownership flags','### Dashboard','- [ ] Runways view','- [ ] Flight plan view','## Phase 3: Launch','### Release','- [ ] Landing page','- [ ] npm provenance'].join('\n');
 await soft({op:'tasks',action:'import',agentId:'atlas-7',markdown:roadmap});
}
dashboard=await startDashboard({project,dataDir,port,decorate:flags.has('--mock')?mock:undefined});
console.log(`Agent Relay dashboard fixture${flags.has('--mock')?' (with synthetic work, ownership and registry data)':''}:\n${dashboard.url}\nPress Ctrl+C to stop.`);
if(flags.has('--open'))await openDashboard(dashboard.url);
let stopping;
const stop=()=>stopping??=(async()=>{await dashboard.close();await broker.close();if(!flags.has('--keep'))await fs.rm(root,{recursive:true,force:true});else console.log(`Kept ${root}`);process.exit(0);})();
process.once('SIGINT',stop);process.once('SIGTERM',stop);
