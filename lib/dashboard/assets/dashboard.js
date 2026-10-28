'use strict';
// Read-only dashboard view. Pure view-model helpers live in model.js (loaded first).
const $=id=>document.getElementById(id);
let secret=location.hash.slice(1);
try{if(secret)sessionStorage.setItem('relay-dashboard-token',secret);else secret=sessionStorage.getItem('relay-dashboard-token')||'';}catch{}
if(location.hash)history.replaceState(null,'',location.pathname+(location.search||''));
const VIEWS=['overview','roadmap','branches','agents','messages','claims'];
const VIEW_TITLES={overview:'Overview',roadmap:'Roadmap',branches:'Branches',agents:'Agents',messages:'Messages',claims:'Claims'};
// Every view is a real URL. The shell is served for each of them and the router swaps the panels.
const VIEW_PATHS={overview:'/',roadmap:'/roadmap/',branches:'/branches/',agents:'/agents/',messages:'/messages/',claims:'/claims/'};
const PATH_VIEWS={'/':'overview','/roadmap/':'roadmap','/branches/':'branches','/agents/':'agents','/messages/':'messages','/claims/':'claims'};
const API='/api/v1';
let selected='',rooms=[],snapshot=null,work=null,ownership=null,usage=null,pairings=null,paused=false,busy=false,lastUpdated=null,historyPaging=null,historyDone=false,olderUI=null,cycle=0,view='overview',roomsKnown=false;
try{selected=sessionStorage.getItem('relay-dashboard-project')||'';}catch{}
const tags=new Map(),loaded=new Map(),rendered=new Map(),entered=new Set(),seen=new Set(),dirty={plan:true,log:true},skipUntil={work:0,ownership:0,usage:0,pairings:0};
const ui={liveOnly:false,dormantShown:false,planMode:'tree',collapsed:new Set(),planLimit:300,plan:{status:'',owner:'',branch:'',label:'',q:''},flag:'',branchQ:'',stripQ:''};
function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=String(text);if(className)el.className=className;return el;}
function h(tag,className,...kids){const el=document.createElement(tag);if(className)el.className=className;for(const kid of kids)if(kid)el.append(kid);return el;}
function button(label,onClick,className){const el=node('button',label,className);el.type='button';el.addEventListener('click',onClick);return el;}
function empty(target,text){target.replaceChildren(node('p',text,'empty'));}
function setVar(el,name,value){el.style?.setProperty?.(name,String(value));}
function time(value){const date=new Date(value);return Number.isNaN(date.getTime())?'Unknown':date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});}
function name(path){return leafName(path);}
function relative(resource){return resource.startsWith(selected+'/')||resource.startsWith(selected+'\\')?resource.slice(selected.length+1):resource;}
function connection(label,stale=false){$('connection').textContent=label;$('connection').classList.toggle('stale',stale);}
function fail(message){$('error').textContent=message+(snapshot?' Showing the last successful snapshot.':'');$('error').hidden=false;}
async function read(url){
 const headers={authorization:`Bearer ${secret}`};if(tags.has(url))headers['if-none-match']=tags.get(url);
 const response=await fetch(url,{headers,cache:'no-store',signal:AbortSignal.timeout(12000)});
 if(response.status===304)return null;
 if(!response.ok){let error;try{error=(await response.json()).error;}catch{}throw new Error(error||`Dashboard request failed (${response.status}).`);}
 const data=await response.json();if(response.headers.get('etag'))tags.set(url,response.headers.get('etag'));return data;
}
// Keeps keyboard focus on the same logical control when a view is rebuilt by a poll.
function keepFocus(container,render){
 const key=document.activeElement?.dataset?.fk;render();
 if(!key)return;
 const next=[...(container.querySelectorAll?.('[data-fk]')??[])].find(el=>el.dataset.fk===key);next?.focus?.({preventScroll:true});
}
function unavailable(target,title,detail){
 target.replaceChildren(h('div','unavailable',node('strong',title),node('p',detail)));
}
function chip(text,className){return node('span',text,'chip'+(className?' '+className:''));}
function callsign(id){return node('span',id,'callsign');}
function meter(percent,label){
 const bar=h('span','meter',h('span','fill'));bar.setAttribute('role','progressbar');bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax','100');bar.setAttribute('aria-valuenow',String(percent));bar.setAttribute('aria-label',label);
 setVar(bar,'--p',Math.max(0,Math.min(100,percent)));return bar;
}
function stagger(items){items.forEach((el,i)=>setVar(el,'--i',Math.min(i,28)));}
// Entrance animations run once per view and project, then settle so polling never replays them.
const bootAt=Date.now();
function startEntrance(panel){
 panel.classList.add('entering');setTimeout(()=>panel.classList.remove('entering'),1600);
 stagger([...(panel.querySelectorAll?.('.rise')??[])]);
}
function firstShow(panel){
 if(!snapshot)return;
 const key=`${view}:${selected}`;if(entered.has(key))return;entered.add(key);
 if(Date.now()-bootAt>1800)startEntrance(panel);
}

// ---- Navigation -------------------------------------------------------------------------
function normalizePath(value){
 let path=String(value||'/');
 if(!path.startsWith('/'))path='/'+path;
 if(path.length>1&&!path.endsWith('/'))path+='/';
 return path;
}
function readView(){
 try{return PATH_VIEWS[normalizePath(location.pathname)]??'overview';}catch{return 'overview';}
}
function go(next,{push=true,focus=true}={}){
 if(!VIEWS.includes(next))return;
 const changed=next!==view;view=next;
 for(const name of VIEWS){
  const on=name===view;$('view-'+name).hidden=!on;
  const nav=$('nav-'+name);nav.setAttribute('aria-current',on?'page':'false');nav.classList.toggle('on',on);
 }
 document.title=`Agent Relay · ${VIEW_TITLES[view]}`;
 if(changed&&push)try{history.pushState?.(null,'',VIEW_PATHS[view]);}catch{}
 dirty.plan=dirty.log=true;
 firstShow($('view-'+view));renderActive();
 if(changed){
  // Every view is a page of its own, so it starts at the top.
  try{window.scrollTo({top:0});}catch{}
 }
 if(changed&&focus){const heading=$('h-'+view);heading.tabIndex=-1;heading.focus?.({preventScroll:true});}
 if(changed&&!paused)refresh();
}
function follow(item){
 if(item.flag)ui.flag=item.flag;
 if(item.unacked)$('pending-only').checked=true;
 if(item.status){ui.plan.status=item.status;$('roadmap-status').value=item.status;}
 go(item.view);
}

// ---- Rooms --------------------------------------------------------------------------------
function renderProjects(){
 $('projects-count').textContent=`${rooms.length} project${rooms.length===1?'':'s'}`;
 $('room-name').textContent=selected?name(selected):rooms.length?'Choose a room':'No rooms';
 $('room-name').title=selected;
 if(!rooms.length){empty($('projects'),'No project rooms yet. Launch a coding runner and let it register with Agent Relay.');return;}
 keepFocus($('projects'),()=>{
  const fragment=document.createDocumentFragment();
  for(const room of rooms){
   const choice=node('button');choice.type='button';choice.className='project-choice';choice.dataset.project=room.project;choice.dataset.fk='room:'+room.project;choice.setAttribute('aria-pressed',String(room.project===selected));
   choice.append(node('strong',name(room.project)),node('span',room.project,'path'),node('span',`${room.agentCount} agents · ${room.messageCount} messages · ${room.pendingDeliveries} awaiting acknowledgement`,'project-stats'));
   const recent=room.lastActivityAt&&Date.now()-new Date(room.lastActivityAt)<300000;
   choice.append(node('span',room.lastActivityAt?`${recent?'Recent activity':'Saved room'} · ${age(room.lastActivityAt)}`:'Saved room · no recorded activity',`activity-age${recent?'':' old'}`));
   choice.addEventListener('click',()=>{selectProject(room.project);$('rooms-menu').open=false;});fragment.append(choice);
  }
  $('projects').replaceChildren(fragment);
 });
}
function selectProject(project){
 if(selected===project)return;
 selected=project;version++;snapshot=work=ownership=usage=null;loaded.clear();rendered.clear();seen.clear();historyPaging=null;historyDone=false;olderUI=null;
 try{sessionStorage.setItem('relay-dashboard-project',project);}catch{}
 for(const feed of ['snapshot','work','ownership','usage','pairings'])tags.delete(`${API}/${feed}?project=${encodeURIComponent(project)}`);
 skipUntil.work=skipUntil.ownership=skipUntil.usage=skipUntil.pairings=0;
 $('agent-filter').replaceChildren(new Option('All agents',''));$('search').value='';$('pending-only').checked=false;
 ui.collapsed.clear();ui.planLimit=300;ui.plan={status:'',owner:'',branch:'',label:'',q:''};ui.flag='';ui.dormantShown=false;
 for(const id of ['roadmap-q','roadmap-status','roadmap-owner','roadmap-branch','roadmap-label'])$(id).value='';
 $('project').textContent=project;renderProjects();firstShow($('view-'+view));renderChrome();renderActive(true);refresh();
}

// ---- Shared chrome (rail counts, gauges that other views depend on) ---------------------------
function setCount(id,value,tone){const el=$('count-'+id);el.hidden=!value;el.textContent=value?formatCount(value):'';el.dataset.tone=tone||'';}
function derived(){
 const reg=registrySummary(snapshot,usage),flags=ownership?.available?flagSummary(ownership.branches):null;
 const roll=work?.available?rollup(work.roots):null;
 return {reg,flags,roll};
}
function renderChrome(){
 const {reg,flags,roll}=derived();
 setCount('agents',snapshot?reg.live:0,'live');
 setCount('messages',snapshot?pendingHeadline(snapshot,usage).live:0,'warn');
 setCount('claims',snapshot?.claims?.length??0);
 setCount('branches',flags?.flagged??0,flags&&(flags.contested||flags.missing)?'alert':'warn');
 setCount('roadmap',0);
 const plan=$('count-roadmap');if(roll&&roll.total){plan.hidden=false;plan.textContent=`${roll.percent}%`;}
}

// ---- Tower ---------------------------------------------------------------------------------------
// The headline is the deliveries a live agent has not acknowledged. The other groups
// are secondary figures: a durable inbox for a dormant identity is deliberate.
function renderPendingGauge(){
 const pending=pendingHeadline(snapshot,usage),gauge=$('pending-count').parentNode;
 $('pending-label').textContent=pending.split?'Awaiting live agents':'Awaiting ack';
 $('pending-count').textContent=snapshot?formatCount(pending.live):'—';
 const held=pending.split?pendingGroupList(pending.split):[];
 const sub=$('pending-sub');
 sub.textContent=pending.split?(held.length?held.map(group=>`${formatCount(group.count)} ${group.key}`).join(' · '):'nothing held'):'pending deliveries';
 const hint=pending.split?pendingTooltip(pending.split):'';
 sub.title=hint;
 if(gauge?.dataset)gauge.dataset.tone=pending.live?'warn':'';
 if(gauge)gauge.title=hint;
}
function renderOverview(){
 const {reg,flags,roll}=derived();
 $('project').textContent=selected||'Choose a project room';
 const set=(id,value,sub,tone)=>{$(id).textContent=value;const g=$(id).parentNode;if(g?.dataset)g.dataset.tone=tone||'';if(sub!==undefined)$(id.replace('-count','-sub')).textContent=sub;};
 set('agents-count',snapshot?formatCount(reg.live):'—',snapshot?`of ${formatCount(reg.stored)} stored`:'live agents',reg.live?'live':'');
 renderPendingGauge();
 const stale=(snapshot?.claims??[]).filter(c=>c.stale).length;
 set('claims-count',snapshot?formatCount(snapshot.claims.length):'—',stale?`${stale} stale`:'files and resources',stale?'warn':'');
 set('messages-count',snapshot?formatCount(snapshot.totalMessages):'—');
 if(ownership?.available&&ownership.git===false)set('conflicts-count','—','not a git repository','off');
 else if(flags){const c=conflictSummary(ownership.branches);set('conflicts-count',formatCount(c.count),c.caption,c.tone);}
 else set('conflicts-count','—',ownership&&!ownership.available?'not available on this broker':'ownership map',ownership&&!ownership.available?'off':'');
 if(roll&&roll.total){set('roadmap-count',`${roll.percent}%`,`${roll.done}/${roll.total} items done`,'live');setVar($('roadmap-ring'),'--p',roll.percent);}
 else{set('roadmap-count','—',work&&!work.available?'not available on this broker':work?'no work items yet':'roadmap progress',work&&!work.available?'off':'');setVar($('roadmap-ring'),'--p',0);}
 renderWelcome();
 renderRegistry(reg);renderAttention();renderTraffic();renderRecent();renderPairings();
}
const noRooms=()=>roomsKnown&&!selected;
const waiting=()=>noRooms()?'No project room is selected.':'Waiting for the first snapshot…';
// A broker with no rooms, or a room nobody has used yet, gets a short orientation instead of a wall of zeros.
function renderWelcome(){
 const none=noRooms(),fresh=!!snapshot&&!(snapshot.agents??[]).length&&!(snapshot.totalMessages>0)&&!(snapshot.claims??[]).length;
 $('welcome').hidden=!(none||fresh);if(!none&&!fresh)return;
 $('h-welcome').textContent=none?'No rooms yet':'Quiet frequency';
 $('welcome-lede').replaceChildren(...(none?[node('span','No project has registered with this broker yet. Nothing is wrong: a room appears the moment a runner registers from a project.')]:[node('span','No agent has checked in from '),node('b',selected?name(selected):'this room'),node('span',' yet. Nothing is wrong: the room fills in as soon as one does.')]));
}
function renderRegistry(reg){
 const target=$('registry');
 if(!snapshot){empty(target,waiting());return;}
 const wrap=h('div','registry-body');
 const head=h('p','registry-head');head.append(node('strong',formatCount(reg.stored)),node('span',' identities stored','muted'),node('span','  ·  ','muted'),node('strong',formatCount(reg.live),'live-n'),node('span',' on the air','muted'));
 const bar=h('div','hbar');bar.setAttribute('role','img');
 const segments=registrySegments(reg);
 bar.setAttribute('aria-label',segments.length?segments.map(s=>`${formatCount(s.count)} ${s.key}`).join(', '):'No identities');
 for(const seg of segments){const part=node('span','',`seg seg-${seg.key}`);setVar(part,'--w',seg.percent.toFixed(2));part.title=`${formatCount(seg.count)} ${seg.key}`;bar.append(part);}
 const legend=h('ul','legend');
 for(const [key,label,count] of [['live','Live',reg.live],['dormant','Dormant',reg.dormant],['ephemeral','Ephemeral',reg.ephemeral],['retired','Retired',reg.retired]]){
  if(!count&&key!=='live'&&key!=='dormant')continue;
  const li=h('li','',node('i','',`sw seg-${key}`),node('span',label),node('b',formatCount(count)));legend.append(li);
 }
 wrap.append(head,bar,legend);
 if(reg.prunable>0)wrap.append(h('p','callout',node('b',formatCount(reg.prunable)),node('span',' stored identities are prunable: they hold registry space without being on the air.')));
 wrap.append(node('p',reg.source==='registry'?'Source: broker registry report.':reg.source==='usage'?'Source: broker storage usage. Liveness is estimated from recorded updates in this room.':'This broker does not report a registry. Figures cover this room only, with liveness estimated from recorded updates.','note'));
 target.replaceChildren(wrap);
}
// The pending pairing requests belong to the gateway. The dashboard shows them and
// nothing else: there is no approve and no deny here, only the code to run at the machine.
function renderPairings(){
 const panel=$('pairings'),list=$('pairing-list'),rows=pairingRows(pairings);
 if(!rows){panel.hidden=true;list.replaceChildren();return;}
 panel.hidden=false;
 if(!rows.length){list.replaceChildren(node('p','No pairing request is waiting.','empty'));return;}
 list.replaceChildren(...rows.map(row=>{
  const card=h('div','pairing');
  card.append(h('div','pairing-head',node('b',row.code,'pairing-code'),node('span',row.runner||'remote','meta')));
  card.append(node('p',[row.repo,row.branch].filter(Boolean).join(' · ')||'unknown repository','meta'));
  card.append(node('p',`waiting ${row.waiting} · expires in ${row.expiresIn}`,'meta'));
  return card;
 }));
}
function renderAttention(){
 const items=attentionItems({snapshot,work,ownership,usage}),list=$('attention');
 if(!snapshot){list.replaceChildren();return;}
 keepFocus(list,()=>list.replaceChildren(...items.map((item,i)=>{
  const row=node('button',undefined,`attn ${item.level}`);row.type='button';row.dataset.fk='attn:'+i;
  row.append(node('span',item.level==='ok'?'OK':item.level==='alert'?'ALERT':item.level==='warn'?'CAUTION':'NOTE','attn-tag'),node('span',item.text,'attn-text'),node('span','→','attn-go'));
  row.addEventListener('click',()=>follow(item));return h('li','',row);
 })));
}
function stripEl(agent,ctx,{compact=false}={}){
 const state=agentState(agent),pending=pendingForAgent(snapshot,agent.agentId),claims=ctx.claims.get(agent.agentId)??0,transport=transportInfo(agent);
  const mark=cloudMark(agent),runner=cloudRunner(agent);
 const row=h('article',`strip s-${state}${agent.frozen?' frozen':''}`);row.dataset.agent=agent.agentId;
 const stub=h('div','stub',node('span',agent.frozen?'FRZ':state==='live'?'LIVE':state==='idle'?'IDLE':'DORM'));
 const id=h('div','strip-id',callsign(agent.agentId));
 // A cloud agent shows its runner as a badge and says where it came from. A local
 // agent keeps the plain runner line and shows no badge at all.
 if(mark.cloud){
  const badge=node('span',runner||'cloud','cloud-badge');
  badge.title=mark.prefix?`Joined through the gateway with the agent-ID prefix ${mark.prefix}.`:'Joined through the gateway.';
  id.append(h('div','strip-marks',badge,node('span','via gateway','via-gateway')));
 }else id.append(node('span',agent.runner??'','meta'));
 const task=agent.task===null||agent.task===undefined?'No task reported':typeof agent.task==='string'?agent.task:JSON.stringify(agent.task,null,2);
 const status=h('div','strip-work',node('span',agent.frozen?'Frozen':agent.status??'unknown','tag'),node('p',task,'task'));
 row.append(stub,id,status);
 if(!compact){
  const wire=h('div','strip-wire',node('span',transport.label,`wire w-${transport.state}`));
  const nums=h('div','strip-nums');
  const backlog=pending.split?pending.live:pending.total;
  nums.append(h('p','',node('b',backlog,backlog?'warn-n':''),node('span',pending.split?' awaiting live':' awaiting ack','meta')),h('p','',node('b',claims),node('span',' claims','meta')));
  const held=pendingGroupList(pending);
  if(pending.split&&held.length){
   const line=h('p','pending-held',node('span',held.map(group=>`${formatCount(group.count)} ${group.key}`).join(' · '),'meta'));
   line.title=pendingTooltip(pending);
   nums.append(line);
  }
  const updated=h('div','strip-age',node('span','Last update'),node('b',age(agent.updatedAt)));updated.title=new Date(agent.updatedAt).toLocaleString();
  row.append(wire,nums,updated);
 }else{
  const updated=h('div','strip-age',node('b',age(agent.updatedAt)));row.append(updated);
 }
 return row;
}
function claimCounts(){
 const counts=new Map();
 for(const claim of snapshot?.claims??[])if(!claim.project||claim.project===snapshot.project)counts.set(claim.agentId,(counts.get(claim.agentId)??0)+1);
 return {claims:counts};
}
function renderTraffic(){
 const target=$('traffic');
 if(!snapshot){empty(target,waiting());return;}
 const live=groupAgents(snapshot.agents).live.slice(0,6),ctx=claimCounts();
 if(!live.length){empty(target,snapshot.agents.length?'No agents are on the air right now.':'No registered agents in this room.');return;}
 target.replaceChildren(...live.map(agent=>stripEl(agent,ctx,{compact:true})));
}
function renderRecent(){
 const target=$('recent'),messages=allMessages().slice(0,6);
 if(!snapshot){target.replaceChildren();return;}
 if(!messages.length){target.replaceChildren(node('li','No transmissions yet.','empty'));return;}
 keepFocus(target,()=>target.replaceChildren(...messages.map(message=>{
  const row=node('button',undefined,'recent-row');row.type='button';row.dataset.fk='recent:'+idOf(message);
  row.append(node('time',time(message.createdAt)),node('span',`${message.from} → ${message.to==='*'?'all':message.to}`,'route'),node('span',message.summary||message.body,'snippet'));
  row.addEventListener('click',()=>{go('messages');jumpTo(idOf(message));});return h('li','',row);
 })));
}

// ---- Strips ---------------------------------------------------------------------------------------
function renderAgents(){
 const target=$('agents'),agents=snapshot?.agents??[];
 const reg=registrySummary(snapshot,usage);
 $('agents-meta').textContent=snapshot?`${formatCount(reg.live)} live · ${formatCount(agents.length)} in this room${reg.stored>agents.length?` · ${formatCount(reg.stored)} stored broker-wide`:''}`:'';
 if(!snapshot){empty(target,noRooms()?waiting():'Loading agents…');return;}
 if(!agents.length){empty(target,'No registered agents in this room.');return;}
 const q=ui.stripQ.trim().toLowerCase(),ctx=claimCounts();
 const match=a=>!q||`${a.agentId} ${a.runner??''} ${a.status??''} ${typeof a.task==='string'?a.task:JSON.stringify(a.task??'')}`.toLowerCase().includes(q);
 const groups=groupAgents(agents.filter(match));
 keepFocus(target,()=>{
  const fragment=document.createDocumentFragment();let shown=0;
  for(const state of AGENT_STATES){
   if(ui.liveOnly&&state!=='live')continue;
   const list=groups[state];if(!list.length)continue;
   const limit=state==='dormant'&&!ui.dormantShown?24:list.length;
   const section=h('section',`strip-group g-${state}`),title=h('h3','',node('span',state==='live'?'Running':state==='idle'?'Idle':'Dormant'),node('b',formatCount(list.length)));
   section.append(title);
   const rows=list.slice(0,limit).map(agent=>stripEl(agent,ctx));stagger(rows);rows.forEach(r=>{r.classList.add('rise');section.append(r);});shown+=rows.length;
   if(list.length>limit){const more=button(`Show ${formatCount(list.length-limit)} more dormant`,()=>{ui.dormantShown=true;renderAgents();},'more');more.dataset.fk='more-dormant';section.append(more);}
   fragment.append(section);
  }
  if(!shown&&!fragment.children?.length)fragment.append(node('p',ui.liveOnly&&!groups.live.length?'No agents are live right now. Clear "Show only live" to see the rest.':'No agents match this search.','empty'));
  target.replaceChildren(fragment);
 });
}

// ---- Flight plan ----------------------------------------------------------------------------------
function fillSelect(select,first,values,current,labeller=v=>v){
 const wanted=['',...values].join('\n'),have=[...select.options].map(o=>o.value).join('\n');
 if(wanted===have)return;
 select.replaceChildren(new Option(first,''),...values.map(v=>new Option(labeller(v),v)));select.value=values.includes(current)?current:'';
}
function renderPlanFilters(){
 const facets=work?.available?treeFacets(work.roots):{owners:[],branches:[],labels:[]};
 fillSelect($('roadmap-status'),'Any status',STATUS_ORDER,ui.plan.status,s=>STATUS_LABEL[s]);
 fillSelect($('roadmap-owner'),'Any owner',facets.owners,ui.plan.owner);
 fillSelect($('roadmap-branch'),'Any branch',facets.branches,ui.plan.branch);
 fillSelect($('roadmap-label'),'Any label',facets.labels,ui.plan.label);
 $('roadmap-mode-tree').setAttribute('aria-pressed',String(ui.planMode==='tree'));$('roadmap-mode-lanes').setAttribute('aria-pressed',String(ui.planMode==='lanes'));
}
// Containers without a status of their own show the one their children imply, marked so it is never mistaken for a status someone set.
function statusChip(n){
 const {status,derived}=displayStatus(n);
 const chipEl=node('span',`${STATUS_GLYPH[status]??'·'} ${STATUS_LABEL[status]??status}`,`status st-${status}${derived?' derived':''}`);
 if(derived)chipEl.title='Derived from the progress of the items inside';
 return chipEl;
}
function nodeRow(row,filtering){
 const {node:n,depth,hasChildren}=row,kind=KIND_ORDER.includes(n.kind)?n.kind:'task';
 const item=h('li',`node k-${kind}${n.context?' context':''}`);setVar(item,'--d',depth);item.dataset.id=n.id;item.dataset.status=displayStatus(n).status;
 const lead=h('div','node-lead');
 if(hasChildren&&!filtering){
  const twist=button(row.collapsed?'▸':'▾',()=>{if(ui.collapsed.has(n.id))ui.collapsed.delete(n.id);else ui.collapsed.add(n.id);renderPlan();},'twist');
  twist.setAttribute('aria-expanded',String(!row.collapsed));twist.setAttribute('aria-label',`${row.collapsed?'Expand':'Collapse'} ${n.title}`);twist.dataset.fk='twist:'+n.id;lead.append(twist);
 }else lead.append(node('span','','twist-gap'));
 lead.append(node('span',kind,'kind'));
 const body=h('div','node-body'),title=h('p','node-title',node('strong',n.title),node('span',n.id,'node-id'));
 const meta=h('div','node-meta');
 meta.append(statusChip(n));
 const progress=progressOf(n);
 if(hasChildren||progress.total>1){meta.append(meter(progress.percent,`${n.title}: ${progress.done} of ${progress.total} done`),node('span',formatProgress(progress),'pct'));}
 if(n.blocked&&n.status!=='blocked')meta.append(chip('blocked','blocked'));
 if(n.priority!==null&&n.priority!==undefined&&n.priority!=='')meta.append(chip(`P${n.priority}`,'prio'));
 if(n.owner)meta.append(callsign(n.owner));
 if(n.branch)meta.append(chip(`⎇ ${n.branch}`,'branch'));
 for(const label of n.labels??[])meta.append(chip(label,'label'));
 body.append(title,meta);item.append(lead,body);return item;
}
function laneCard(card){
 const n=card.node,progress=progressOf(n),el=h('article','card');el.dataset.status=n.status;
 if(card.path.length)el.append(node('p',card.path.join(' › '),'crumb'));
 el.append(h('p','node-title',node('strong',n.title),node('span',n.id,'node-id')));
 const meta=h('div','node-meta');
 if(n.owner)meta.append(callsign(n.owner));
 if(n.branch)meta.append(chip(`⎇ ${n.branch}`,'branch'));
 if(n.blocked&&n.status!=='blocked')meta.append(chip('blocked','blocked'));
 for(const label of n.labels??[])meta.append(chip(label,'label'));
 if(progress.total>1)meta.append(meter(progress.percent,`${progress.done} of ${progress.total}`));
 if(meta.children?.length)el.append(meta);return el;
}
function renderPlan(){
 const tree=$('roadmap-tree'),lanes=$('roadmap-lanes'),panel=$('view-roadmap');
 renderPlanFilters();dirty.plan=false;
 if(!work){panel.dataset.state='loading';tree.hidden=false;lanes.hidden=true;empty(tree,noRooms()?waiting():'Loading the roadmap…');$('roadmap-summary').replaceChildren();$('roadmap-meta').textContent='';return;}
 if(!work.available){panel.dataset.state='off';tree.hidden=false;lanes.hidden=true;$('roadmap-summary').replaceChildren();$('roadmap-meta').textContent='';
  unavailable(tree,'The roadmap is not available on this broker','This broker does not expose the work tree or the task ledger. Restart it on a newer Agent Relay release, then reload this page.');return;}
 panel.dataset.state='ready';
 const filtering=planFilterActive(ui.plan),all=work.roots??[],roots=filterTree(all,ui.plan),roll=rollup(all);
 $('roadmap-meta').textContent=`${formatCount(roll.total)} item${roll.total===1?'':'s'} · ${roll.percent}% complete${work.legacy?' · flat task list (older broker)':''}`;
 const counts=statusCounts(all,work.counts),summary=h('div','plan-bar');
 const bar=h('div','hbar');bar.setAttribute('role','group');bar.setAttribute('aria-label','Work by status');
 const total=Object.values(counts).reduce((a,b)=>a+b,0);
 for(const s of STATUS_ORDER){if(!counts[s])continue;const seg=node('button','',`seg st-${s}`);seg.type='button';setVar(seg,'--w',Math.max(2,counts[s]/total*100).toFixed(2));seg.title=`${counts[s]} ${STATUS_LABEL[s]} · click to filter`;seg.setAttribute('aria-label',`${counts[s]} ${STATUS_LABEL[s]}, filter`);seg.dataset.fk='seg:'+s;seg.addEventListener('click',()=>{ui.plan.status=ui.plan.status===s?'':s;$('roadmap-status').value=ui.plan.status;renderPlan();});bar.append(seg);}
 const legend=h('ul','legend');for(const s of STATUS_ORDER)if(counts[s])legend.append(h('li','',node('i','',`sw st-${s}`),node('span',STATUS_LABEL[s]),node('b',formatCount(counts[s]))));
 summary.append(bar,legend);keepFocus($('roadmap-summary'),()=>$('roadmap-summary').replaceChildren(summary));
 if(!all.length){tree.hidden=false;lanes.hidden=true;empty(tree,'No work items yet. Roadmaps, epics and tasks created through Agent Relay appear here. To start one from a markdown file, run: agent-relay work import --file ROADMAP.md');return;}
 if(!roots.length){tree.hidden=false;lanes.hidden=true;empty(tree,'No work items match these filters.');return;}
 if(ui.planMode==='lanes'){
  tree.hidden=true;lanes.hidden=false;
  keepFocus(lanes,()=>lanes.replaceChildren(...laneGroups(roots).map(lane=>{
   const column=h('section',`lane st-${lane.status}`),head=h('h3','',node('span',`${STATUS_GLYPH[lane.status]} ${lane.label}`),node('b',lane.cards.length));
   column.append(head);const cards=lane.cards.slice(0,40).map(laneCard);cards.forEach(c=>column.append(c));
   if(!cards.length)column.append(node('p','Nothing here','empty'));
   if(lane.cards.length>40)column.append(node('p',`+${lane.cards.length-40} more. Use filters to narrow.`,'meta'));
   return column;
  })));
  return;
 }
 lanes.hidden=true;tree.hidden=false;
 const rows=flattenTree(roots,filtering?new Set():ui.collapsed),visible=rows.slice(0,ui.planLimit);
 keepFocus(tree,()=>{
  const list=h('ul','tree');list.setAttribute('aria-label','Roadmap');
  for(const row of visible)list.append(nodeRow(row,filtering));
  const wrap=h('div','tree-wrap',list);
  if(rows.length>visible.length){const more=button(`Show ${formatCount(rows.length-visible.length)} more items`,()=>{ui.planLimit+=300;renderPlan();},'more');more.dataset.fk='plan-more';wrap.append(more);}
  tree.replaceChildren(wrap);
 });
}
function collapseAll(collapse){
 ui.collapsed.clear();
 if(collapse)walkTree(work?.roots??[],n=>{if(n.children?.length)ui.collapsed.add(n.id);});
 renderPlan();
}

// ---- Runways --------------------------------------------------------------------------------------
function describe(entry){
 if(entry===null||entry===undefined)return '';
 if(typeof entry!=='object')return String(entry);
 const lead=entry.title??entry.name??entry.agentId??entry.path??entry.id??entry.resource;
 const tail=[entry.state,entry.owner,entry.source,entry.project&&name(entry.project)].filter(v=>v&&v!==lead);
 return lead===undefined?JSON.stringify(entry):[lead,...tail].join(' · ');
}
function cell(label,...kids){return h('div','cell',node('h4',label),...kids);}
function list(items,limit=4,className='plain'){
 const ul=h('ul',className);for(const item of items.slice(0,limit))ul.append(typeof item==='string'?node('li',item):item);
 if(items.length>limit)ul.append(node('li',`+${items.length-limit} more`,'meta'));return ul;
}
// Each checkout once: its folder, whether it is the room being viewed, and whether any room is registered for it.
function worktreeItem(w){
 const li=h('li','wt'),label=node('span',w.name,'wt-name');li.title=w.path+(w.project&&w.project!==w.path?`\nRoom: ${w.project}`:'');li.append(label);
 if(w.roomName)li.append(node('span',`room ${w.roomName}`,'meta'));
 if(w.current)li.append(chip('this room','branch'));
 li.append(chip(w.registered?'room registered':'no room',w.registered?'ok':''));
 return li;
}
function runwayCard(branch){
 const severity=branchSeverity(branch),card=h('article','runway');card.dataset.tone=severity>=3?'alert':severity>=1?'warn':'clear';card.dataset.branch=branch.name;
 const flags=(branch.flags??[]).filter(f=>FLAG_ORDER.includes(f)).sort((a,b)=>FLAG_ORDER.indexOf(a)-FLAG_ORDER.indexOf(b));
 const head=h('div','runway-head'),title=h('div','runway-title',node('h3',branch.name),node('p',[branch.head?`@ ${shortSha(branch.head)}`:'',branch.upstream?`↑ ${branch.upstream}`:'',branch.committedAt?`committed ${age(branch.committedAt)}`:''].filter(Boolean).join('  ·  ')||'no commit data','meta'));
 const flagRow=h('div','flags');
 if(!flags.length)flagRow.append(node('span','Clear','flag clear'));
 for(const f of flags){const el=node('span',FLAG_META[f].label,`flag f-${f}`);el.title=FLAG_META[f].hint;flagRow.append(el);}
 head.append(title,flagRow);
 const body=h('div','runway-body');
 const claim=branch.claim,claimBox=cell('Claim');
 if(claim){claimBox.append(h('p','',callsign(claim.agentId),chip(claim.live?'live':claim.stale?'stale':'quiet',claim.live?'ok':claim.stale?'warn':'')),node('p',`${age(claim.claimedAt)}${claim.note?' · '+claim.note:''}`,'meta'));}
 else claimBox.append(node('p','No claim','muted'));
 const agents=cell('Agents on branch');
 if((branch.agents??[]).length)agents.append(list(branch.agents.map(a=>h('li','',callsign(a.agentId),node('span',a.live?' live':' quiet',a.live?'ok-text':'meta'),node('span',a.source&&a.source!=='worktree'?` · ${a.source}`:'','meta'))),5));
 else agents.append(node('p','None','muted'));
 const tasks=cell('Tasks');
 if((branch.tasks??[]).length)tasks.append(list(branch.tasks.map(t=>node('li',`${t.title}${t.state?' · '+t.state:''}${t.owner?' · '+t.owner:''}`)),4));
 else tasks.append(node('p','None','muted'));
 body.append(claimBox,agents,tasks);
 const trees=worktreeRows(branch.worktrees,{project:selected,rooms:ownership?.rooms});
 if(trees.length||(branch.artifacts??[]).length){
  const extra=h('div','runway-extra');
  if(trees.length)extra.append(cell('Worktrees',list(trees.map(worktreeItem),3)));
  if((branch.artifacts??[]).length)extra.append(cell('Artifacts',list(branch.artifacts.map(describe).map(t=>node('li',t)),3)));
  body.append(extra);
 }
 card.append(head,body);return card;
}
function renderBranches(){
 const target=$('branches'),chips=$('branch-chips'),extra=$('unassigned');
 if(!ownership){empty(target,noRooms()?waiting():'Reading the ownership map…');chips.replaceChildren();extra.replaceChildren();$('branches-meta').textContent='';return;}
 if(!ownership.available){unavailable(target,'Branch ownership is not available on this broker','This broker does not report which agent holds which branch. Restart it on a newer Agent Relay release to see branches.');chips.replaceChildren();extra.replaceChildren();$('branches-meta').textContent='';return;}
 const branches=ownership.branches??[],summary=flagSummary(branches),repo=repoLabel(ownership.repo),state=runwayState(ownership);
 const meta=$('branches-meta');
 const cut=ownership.truncated&&ownership.totalBranches>summary.total;
 meta.textContent=state==='no-git'?'Not a git repository':`${repo.name?repo.name+' · ':''}${formatCount(summary.total)}${cut?' of '+formatCount(ownership.totalBranches):''} branch${(cut?ownership.totalBranches:summary.total)===1?'':'es'} · ${formatCount(summary.flagged)} flagged${ownership.generatedAt?' · mapped '+age(ownership.generatedAt):''}`;
 meta.title=repo.path;
 if(state==='no-git'){
  chips.replaceChildren();
  target.replaceChildren(h('div','unavailable',node('strong','No git repository here'),node('p','This room is not inside a git repository, so there are no branches to map. Branch claims need a git checkout; file and resource claims still work and appear under Claims.')));
  renderUnassigned(extra);return;
 }
 keepFocus(chips,()=>chips.replaceChildren(...[['','All',summary.total],...FLAG_ORDER.map(f=>[f,FLAG_META[f].label,summary[f]])].map(([flag,label,count])=>{
  const chipButton=button('',()=>{ui.flag=ui.flag===flag?'':flag;renderBranches();},`filter-chip${flag?' f-'+flag:''}${count?'':' zero'}`);chipButton.append(node('span',label),node('b',count));
  chipButton.setAttribute('aria-pressed',String(ui.flag===flag));chipButton.dataset.fk='flag:'+flag;return chipButton;
 })));
 const shown=filterBranches(branches,{flag:ui.flag,q:ui.branchQ});
 keepFocus(target,()=>{
  if(!branches.length)target.replaceChildren(h('div','unavailable',node('strong','No branches yet'),node('p','This repository has no branches, claims or branch-linked work to show. Branches appear once a branch exists or an agent claims one.')));
  else if(!shown.length)empty(target,'No branches match these filters.');
  else{const cards=shown.slice(0,120).map(runwayCard);stagger(cards);cards.forEach(c=>c.classList.add('rise'));
   if(shown.length>120)cards.push(node('p',`Showing 120 of ${formatCount(shown.length)} branches. Filter to narrow.`,'meta'));
   else if(ownership.truncated)cards.push(node('p',`The broker mapped ${formatCount(branches.length)} of ${formatCount(ownership.totalBranches)} branches, most urgent first.`,'meta'));
   target.replaceChildren(...cards);}
 });
 renderUnassigned(extra);
}
function renderUnassigned(extra){
 const groups=Object.entries(ownership?.unassigned??{}).filter(([,value])=>Array.isArray(value)&&value.length);
 if(!groups.length||ui.flag){extra.replaceChildren();return;}
 const panel=h('section','panel unassigned',h('div','panel-head',node('h2','Unassigned'),node('span','Not tied to any branch','note')));
 for(const [key,items] of groups)panel.append(cell(`${UNASSIGNED_TITLE[key]??key} (${items.length})`,list(items.map(item=>describeUnassigned(key,item)).map(t=>node('li',t)),6)));
 extra.replaceChildren(panel);
}

// ---- Claims ---------------------------------------------------------------------------------------
// Owner state uses the broker's holder word, except `stale` (idle past the window),
// which is shown as idle so the row reads left / retired / idle / missing.
function claimStateLabel(claim){
 if(!claim.stale)return 'held';
 const owner=claim.holder;
 if(!owner||owner==='active')return 'stale';
 if(owner==='stale')return 'stale · idle';
 return `stale · ${owner}`;
}
function renderClaims(){
 const claims=snapshot?.claims??[];
 $('claims-meta').textContent=snapshot?`${claims.length} held${claims.some(c=>c.stale)?` · ${claims.filter(c=>c.stale).length} stale`:''}`:'';
 const rows=claims.map(claim=>{
  const row=node('tr'),cells=[['Resource',`${claim.scope==='machine'?'Machine · ':''}${relative(claim.resource)}`],['Owner',`${claim.agentId}${claim.project?' · '+name(claim.project):''}`],['Claimed',age(claim.claimedAt)]];
  for(const [label,text] of cells){const td=node('td',text);td.dataset.label=label;row.append(td);}
  const state=node('td');state.dataset.label='State';
  const label=claimStateLabel(claim);
  state.append(chip(label,claim.stale?'warn':'ok'));
  if(claim.stale&&claim.holder)state.title=`Owner ${claim.holder==='stale'?'idle':claim.holder}; claimed ${age(claim.claimedAt)}`;
  row.append(state);return row;
 });
 $('claims').replaceChildren(...rows);$('no-claims').hidden=rows.length>0||!snapshot;
}

// ---- Radio log ------------------------------------------------------------------------------------
function allMessages(){return [...loaded.values()].sort((a,b)=>(b.cursor??0)-(a.cursor??0)||String(b.createdAt??'').localeCompare(String(a.createdAt??'')));}
function jumpTo(messageId){const entry=rendered.get(messageId);if(!entry)return;entry.details.open=true;entry.row.scrollIntoView?.({block:'nearest'});entry.row.classList.add('flash');setTimeout(()=>entry.row.classList.remove('flash'),1800);}
function olderControl(){
 if(!olderUI){
  const more=button('Load older messages',fetchOlder);
  olderUI=node('div',undefined,'footnote');olderUI.append(more);olderUI.button=more;
 }
 olderUI.hidden=!(snapshot&&(snapshot.totalMessages??0)>loaded.size&&historyPaging!==false&&!historyDone);
 return olderUI;
}
async function fetchOlder(){
 if(busy||!selected)return;
 const cursors=[...loaded.values()].map(m=>m.cursor).filter(c=>Number.isSafeInteger(c));
 const before=cursors.length?Math.min(...cursors):Number.MAX_SAFE_INTEGER;
 busy=true;
 try{
  const page=await read(`${API}/history?project=${encodeURIComponent(selected)}&before=${before}&limit=100`);
  if(!page)return;
  if(page.available===false){historyPaging=false;renderMessages();return;}
  historyPaging=true;
  const rows=Array.isArray(page.messages)?page.messages:[];
  for(const message of rows)if(idOf(message))loaded.set(idOf(message),message);
  if(page.done||!rows.length)historyDone=true;
  renderMessages();renderAgentFilter();
 }catch(error){fail(error.message);}
 finally{busy=false;}
}
function renderAgentFilter(){
 const known=new Map();
 for(const agent of snapshot?.agents??[])if(agentState(agent)!=='dormant')known.set(agent.agentId,true);
 for(const message of loaded.values()){known.set(message.from,true);for(const r of message.recipients??[])known.set(typeof r==='string'?r:r?.agentId,true);}
 const ids=[...known.keys()].filter(Boolean).sort(),current=$('agent-filter').value;
 if([...$('agent-filter').options].slice(1).map(o=>o.value).join('\n')===ids.join('\n'))return;
 $('agent-filter').replaceChildren(new Option('All agents',''),...ids.map(id=>new Option(id,id)));
 if(ids.includes(current))$('agent-filter').value=current;
}
function renderMessages(){
 dirty.log=false;
 const messages=allMessages(),query=$('search').value.toLowerCase(),agent=$('agent-filter').value,pendingOnly=$('pending-only').checked;
 const filtered=messages.filter(m=>{
  const summary=receiptSummary(m);
  return (!agent||m.from===agent||summary.rows.some(r=>r.agentId===agent))&&(!pendingOnly||summary.counts.acked<summary.counts.recipients)&&`${m.summary??''} ${m.body} ${m.from} ${m.to}`.toLowerCase().includes(query);
 });
 const total=snapshot?.totalMessages??0;
 $('message-range').textContent=windowLabel(filtered.length,total,messages.length,historyPaging===false?false:historyPaging&&!historyDone?true:undefined);
 const expanded=new Set([...$('messages').querySelectorAll('details[open]')].map(el=>el.dataset.message));
 const scroll=$('messages').scrollTop,fresh=seen.size>0;
 rendered.clear();
 if(!filtered.length){empty($('messages'),messages.length?'No messages match these filters.':'No messages yet. Agent questions and replies will appear here.');$('messages').append(olderControl());$('messages').scrollTop=scroll;return;}
 const fragment=document.createDocumentFragment();
 for(const message of filtered){
  const thread=threadView(message,messages),isNew=fresh&&!seen.has(idOf(message));
  const row=node('article',undefined,`message${thread.parentLoaded?' is-reply':''}${isNew?' fresh':''}`),identity=node('div',undefined,'message-identity'),content=node('div',undefined,'message-content'),state=node('div',undefined,'message-state');
  row.dataset.message=idOf(message);
  const date=node('time',time(message.createdAt));date.dateTime=message.createdAt;date.title=new Date(message.createdAt).toLocaleString();identity.append(date);
  identity.append(node('span',`${message.from} → ${message.to==='*'?'All peers':message.to}`,'route'));
   // A message that came through the gateway says so, and names the runner that carried it.
  const cloud=cloudMark(message);
  if(cloud.cloud){
   const badge=node('span',cloudRunner(message)||'cloud','cloud-badge');
   badge.title='This message was sent through the gateway, from a cloud agent.';
   identity.append(h('div','message-tags',badge,node('span','via gateway','via-gateway')));
  }
  const summary=receiptSummary(message),unacked=summary.counts.recipients-summary.counts.acked;
  state.append(node('span',unacked?`${unacked} unacked`:'Acknowledged',`tag${unacked?' pending':''}`));
  if(message.summary)content.append(node('strong',message.summary));
  content.append(node('p',message.body,'message-body'));
  if(thread.parent||thread.replies.length){
   const line=node('div',undefined,'receipt');
   if(thread.parent){
    if(thread.parentLoaded){const to=button(`Reply to ${thread.parent}`,()=>jumpTo(thread.parent));line.append(to);}
    else line.append(node('span',`Reply to ${thread.parent} (not in this window)`,'meta'));
   }
   if(thread.replies.length){
    line.append(node('span',`${thread.replies.length===1?'Reply':'Replies'}: `,'meta'));
    for(const reply of thread.replies)line.append(button(reply,()=>jumpTo(reply)));
   }
   content.append(line);
  }
  const details=node('details');details.dataset.message=idOf(message);details.open=expanded.has(idOf(message));
  details.append(node('summary',`Delivery · ${summary.counts.recipients} recipients · ${summary.counts.acked} acked · ${summary.counts.accepted} accepted · ${summary.counts.notified} notified · ${summary.counts.attempted} attempted · ${summary.counts.missing} missing · ${summary.counts.stored} stored`));
  for(const receipt of summary.rows){
   const line=node('div',undefined,'receipt');
   const pendingConcern=receipt.state==='stored'||receipt.state==='missing'||receipt.state==='attempted';
   const meta=[`${time(receipt.ts)}`];
   if(receipt.adapters?.length)meta.push(receipt.adapters.join(', '));
   if(receipt.reason)meta.push(receipt.reason);
   line.append(node('span',receipt.agentId),node('span',badgeLabel(receipt.state),`tag${pendingConcern?' pending':''} s-${receipt.state}`),node('span',meta.join(' · '),'meta'));
   details.append(line);
  }
  details.append(node('div',`Message ID: ${idOf(message)}`,'receipt'));
  content.append(details);
  row.append(identity,content,state);fragment.append(row);
  rendered.set(idOf(message),{row,details});
 }
 for(const message of messages)seen.add(idOf(message));
 $('messages').replaceChildren(fragment);$('messages').append(olderControl());$('messages').scrollTop=scroll;
}

// ---- Orchestration --------------------------------------------------------------------------------
const lastRendered={};
function renderActive(force){
 const stamp=Date.now();
 if(view==='overview')renderOverview();
 else if(view==='roadmap'){if(force||dirty.plan)renderPlan();}
 else if(view==='branches')renderBranches();
 else if(view==='agents')renderAgents();
 else if(view==='messages'){if(force||dirty.log)renderMessages();}
 else if(view==='claims')renderClaims();
 lastRendered[view]=stamp;
}
function renderAll(){
 $('project').textContent=selected||'Choose a project room';
 renderChrome();renderActive(true);
}
// Polls that answer 304 change nothing, so nothing is rebuilt: controls under the pointer are never swapped out mid-click.
let version=0,renderedStamp='';
const FEEDS={work:{views:['overview','roadmap'],apply:data=>{work=data;dirty.plan=true;version++;}},ownership:{views:['overview','branches'],apply:data=>{ownership=data;version++;}},usage:{views:[],apply:data=>{usage=data;version++;}},pairings:{views:['overview'],apply:data=>{pairings=data;version++;}}};
async function readFeed(key,target){
 const feed=FEEDS[key],current={work,ownership,usage,pairings}[key];
 if(skipUntil[key]>cycle)return;
 if(current&&!feed.views.includes(view)&&cycle%5!==0)return;
 try{
  const data=await read(`${API}/${key}?project=${encodeURIComponent(target)}`);
  if(selected!==target||!data)return;
  feed.apply(data);if(data.available===false)skipUntil[key]=cycle+10;
 }catch{
  if(selected===target&&!current){feed.apply({available:false});skipUntil[key]=cycle+10;}
 }
}
async function refresh(){
 if(busy||paused||document.hidden)return;
 busy=true;const startingSelection=selected;cycle++;
 try{
  if(!secret)throw new Error('Open the dashboard using the complete link printed by the CLI.');
  const listing=await read(`${API}/projects`);roomsKnown=true;
  if(listing){rooms=listing.rooms;version++;if(!selected||!rooms.some(r=>r.project===selected))selected=rooms.some(r=>r.project===listing.preferredProject)?listing.preferredProject:rooms[0]?.project??'';}
  const target=selected;
  if(target){
   const next=await read(`${API}/snapshot?project=${encodeURIComponent(target)}`);
   if(selected===target){
    if(next){snapshot=next;version++;for(const message of next.messages??[])if(idOf(message))loaded.set(idOf(message),message);dirty.log=true;renderAgentFilter();}
    await Promise.all(Object.keys(FEEDS).map(key=>readFeed(key,target)));
    if(selected===target){firstShow($('view-'+view));const stamp=`${version}:${view}:${selected}:${Math.floor(Date.now()/60000)}`;if(stamp!==renderedStamp){renderedStamp=stamp;renderProjects();renderAll();}}
   }
  }
  else{snapshot=null;loaded.clear();renderedStamp='';renderProjects();renderAll();}
  lastUpdated=new Date();$('updated').textContent=`Last checked ${time(lastUpdated)}`;$('error').hidden=true;connection(paused?'Updates paused':'Broker connected',paused);
 }catch(error){fail(error.message);connection('Connection unavailable',true);}
 finally{busy=false;if(selected!==startingSelection&&!paused)queueMicrotask(refresh);}
}
function togglePause(){paused=!paused;$('pause').textContent=paused?'Resume updates':'Pause updates';connection(paused?'Updates paused':'Connecting…',paused);if(!paused)refresh();}
$('pause').addEventListener('click',togglePause);
// The rail items are links, so they can be opened in a new tab or copied. A plain click routes in place.
for(const name of VIEWS)$('nav-'+name).addEventListener('click',event=>{
 const e=event||{};
 if(e.button>0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
 e.preventDefault?.();go(name);
});
for(const el of document.querySelectorAll?.('[data-go]')??[])el.addEventListener('click',()=>go(el.dataset.go));
for(const id of ['search','agent-filter','pending-only'])$(id).addEventListener(id==='search'?'input':'change',()=>{renderMessages();});
const planInputs={'roadmap-q':['q','input'],'roadmap-status':['status','change'],'roadmap-owner':['owner','change'],'roadmap-branch':['branch','change'],'roadmap-label':['label','change']};
for(const [id,[field,event]] of Object.entries(planInputs))$(id).addEventListener(event,()=>{ui.plan[field]=$(id).value;ui.planLimit=300;renderPlan();});
$('roadmap-mode-tree').addEventListener('click',()=>{ui.planMode='tree';renderPlan();});
$('roadmap-mode-lanes').addEventListener('click',()=>{ui.planMode='lanes';renderPlan();});
$('roadmap-expand').addEventListener('click',()=>collapseAll(false));$('roadmap-collapse').addEventListener('click',()=>collapseAll(true));
$('roadmap-reset').addEventListener('click',()=>{ui.plan={status:'',owner:'',branch:'',label:'',q:''};for(const id of Object.keys(planInputs))$(id).value='';renderPlan();});
$('branch-q').addEventListener('input',()=>{ui.branchQ=$('branch-q').value;renderBranches();});
$('live-only').addEventListener('change',()=>{ui.liveOnly=$('live-only').checked;renderAgents();});
$('agent-q').addEventListener('input',()=>{ui.stripQ=$('agent-q').value;renderAgents();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
document.addEventListener('keydown',event=>{
 if(event.metaKey||event.ctrlKey||event.altKey)return;
 const tag=event.target?.tagName;if(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA'||event.target?.isContentEditable)return;
 const index=event.key?.length===1?'123456'.indexOf(event.key):-1;
 if(index>=0){event.preventDefault();go(VIEWS[index]);}
 else if(event.key==='/'){event.preventDefault();go('messages');$('search').focus?.();}
 else if(event.key==='p'){togglePause();}
 else if(event.key==='Escape'){$('rooms-menu').open=false;}
});
globalThis.addEventListener?.('popstate',()=>go(readView(),{push:false,focus:false}));
const tick=()=>{$('zulu').textContent=new Date().toISOString().slice(11,19)+'Z';};
tick();setInterval(tick,1000);
view='';go(readView(),{push:false,focus:false});startEntrance($('view-'+view));
setInterval(refresh,3000);refresh();
