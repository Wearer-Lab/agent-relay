'use strict';
// Pure view-model helpers for the dashboard. No DOM access, no network: everything
// here is deterministic given its inputs, so it can be unit tested in a bare vm.
const STATUS_ORDER=['todo','in-progress','blocked','review','done','cancelled'];
const STATUS_LABEL={todo:'To do','in-progress':'In progress',blocked:'Blocked',review:'In review',done:'Done',cancelled:'Cancelled'};
const STATUS_GLYPH={todo:'○','in-progress':'◐',blocked:'✕',review:'◉',done:'●',cancelled:'–'};
const KIND_ORDER=['roadmap','phase','epic','task','todo'];
const FLAG_ORDER=['contested','missing','orphaned','unclaimed'];
const FLAG_META={
 contested:{label:'Contested',tone:'alert',hint:'More than one owner is attached to this branch.'},
 missing:{label:'Missing',tone:'alert',hint:'Referenced by a claim or task, but not found in the repository.'},
 orphaned:{label:'Orphaned',tone:'warn',hint:'Work is attached, but no live owner holds it.'},
 unclaimed:{label:'Unclaimed',tone:'idle',hint:'The branch exists with no claim or agent attached.'}
};
const AGENT_STATES=['live','idle','dormant'];

function idOf(message){return message.messageId??message.id??'';}
function formatCount(value){return Number.isFinite(value)?Math.round(value).toLocaleString('en-US'):'—';}
function age(value,now=Date.now()){
 const minutes=Math.max(0,Math.floor((now-new Date(value))/60000));
 if(!Number.isFinite(minutes))return 'Unknown';
 if(minutes<1)return 'just now';if(minutes<60)return `${minutes}m ago`;if(minutes<1440)return `${Math.floor(minutes/60)}h ago`;return `${Math.floor(minutes/1440)}d ago`;
}
function ageMinutes(value,now=Date.now()){const ms=now-new Date(value);return Number.isFinite(ms)?Math.max(0,ms/60000):Infinity;}
function shortSha(value){return typeof value==='string'&&value?value.slice(0,7):'';}
function leafName(path){return String(path??'').split(/[\\/]/).filter(Boolean).at(-1)||String(path??'');}

function windowLabel(shown,total,win,older){
 if(!total)return 'Showing 0 of 0 messages (window: empty)';
 const base=`Showing ${shown} of ${total} message${total===1?'':'s'} (window: latest ${win})`;
 if(win>=total)return `${base} · search covers the full retained history`;
 return `${base} · search covers this window only${older===true?', older history can be loaded':older===false?', older history is unreachable here':''}`;
}
function badgeLabel(state){
 if(state==='missing')return 'missing — confirmed not delivered';
 return state;
}
function receiptSummary(message){
 const source=message?.receipt?.recipients??message?.recipients??[];
 const pendingByAgent=new Map();
 for(const entry of (message?.receipt?.pending??message?.pending??[])){
  if(entry?.agentId&&entry?.reason)pendingByAgent.set(entry.agentId,entry.reason);
 }
 const rows=source.map(entry=>{
  if(typeof entry==='string'){
   const markers=(message?.notified??[]).filter(n=>n?.agentId===entry);
   const acked=(message?.ackedBy??[]).includes(entry);
   const ackTs=message?.acks?.find(a=>a?.agentId===entry)?.at;
   const accepted=markers.filter(n=>String(n?.adapter??'').endsWith('-accepted'));
   const missingMarkers=markers.filter(n=>{const name=String(n?.adapter??'');return name.endsWith('-missing')||name.endsWith('-failed');});
   const attempted=markers.filter(n=>String(n?.adapter??'').endsWith('-attempted'));
   const notifiedOnly=markers.filter(n=>{const name=String(n?.adapter??'');return !name.endsWith('-accepted')&&!name.endsWith('-attempted')&&!name.endsWith('-missing')&&!name.endsWith('-failed');});
   const state=acked?'acked':accepted.length?'accepted':missingMarkers.length?'missing':notifiedOnly.length?'notified':attempted.length?'attempted':'stored';
   const ts=ackTs??accepted.at(-1)?.at??missingMarkers.at(-1)?.at??notifiedOnly.at(-1)?.at??attempted.at(-1)?.at??message?.createdAt??message?.ts??null;
   const adapters=[...new Set(markers.map(n=>n?.adapter).filter(Boolean))];
   const row={agentId:entry,state,ts,adapters};
   const explicit=pendingByAgent.get(entry);
   if(state==='missing')row.reason=explicit??(adapters.includes('codex-reconciled-missing')?'operator-confirmed-missing':'negative-reconciliation');
   else if(state==='stored')row.reason=explicit??'no-transport-markers';
   else if(explicit)row.reason=explicit;
   return row;
  }
  const agentId=entry?.agentId;
  const acceptedArr=entry?.accepted??[];
  const notifiedArr=entry?.notified??[];
  const missingArr=entry?.missing??[];
  const adapters=[...new Set([...(acceptedArr??[]),...(notifiedArr??[]),...(missingArr??[])].map(n=>n?.adapter).filter(Boolean))];
  let state=entry?.state;
  const valid=['acked','accepted','notified','attempted','missing','stored'];
  if(!valid.includes(state)){
   const acked=entry?.acked??(message?.ackedBy??[]).includes(agentId)??false;
   const hasAccepted=(acceptedArr?.length??0)>0;
   const hasMissing=(missingArr?.length??0)>0;
   const notifiedOnly=(notifiedArr??[]).filter(n=>{const name=String(n?.adapter??'');return !name.endsWith('-attempted')&&!name.endsWith('-missing')&&!name.endsWith('-failed')&&!name.endsWith('-accepted');});
   const attemptedOnly=(notifiedArr??[]).filter(n=>String(n?.adapter??'').endsWith('-attempted'));
   if(acked)state='acked';
   else if(hasAccepted)state='accepted';
   else if(hasMissing)state='missing';
   else if(notifiedOnly.length)state='notified';
   else if(attemptedOnly.length)state='attempted';
   else state='stored';
  }
  const ts=entry?.ackTs??entry?.ackAt??acceptedArr?.at(-1)?.ts??acceptedArr?.at(-1)?.at??missingArr?.at(-1)?.ts??missingArr?.at(-1)?.at??notifiedArr?.at(-1)?.ts??notifiedArr?.at(-1)?.at??entry?.ts??message?.ts??message?.createdAt??null;
  const row={agentId,state,ts,adapters};
  const explicit=pendingByAgent.get(agentId)??entry?.reason;
  if(state==='missing')row.reason=explicit??(adapters.includes('codex-reconciled-missing')?'operator-confirmed-missing':'negative-reconciliation');
  else if(state==='stored')row.reason=explicit??'no-transport-markers';
  else if(explicit)row.reason=explicit;
  return row;
 });
 const counts={recipients:rows.length,acked:0,accepted:0,notified:0,attempted:0,missing:0,stored:0,pending:0};
 for(const row of rows){
  if(row.state==='acked')counts.acked++;
  else if(row.state==='accepted')counts.accepted++;
  else if(row.state==='notified')counts.notified++;
  else if(row.state==='attempted')counts.attempted++;
  else if(row.state==='missing')counts.missing++;
  else counts.stored++;
 }
 counts.pending=counts.stored+counts.missing;
 return {rows,counts};
}
function threadView(message,all){
 const id=idOf(message),ids=new Set(all.map(idOf));
 return {parent:message.replyTo??null,parentLoaded:message.replyTo?ids.has(message.replyTo):false,replies:all.filter(m=>m.replyTo===id&&idOf(m)!==id).map(idOf)};
}

// ---- Agents ---------------------------------------------------------------
// live: the broker says so (or, on brokers that do not report it, a connected transport / very recent update).
// idle: not live, but heard from within the hour. dormant: everything older.
function agentState(agent,now=Date.now()){
 if(agent?.live===true)return 'live';
 const seen=ageMinutes(agent?.updatedAt,now);
 if(agent?.live===undefined&&((agent?.readiness?.transport?.state??agent?.transport?.state)==='connected'||seen<5))return 'live';
 return seen<60?'idle':'dormant';
}
function groupAgents(agents,now=Date.now()){
 const groups={live:[],idle:[],dormant:[]};
 for(const agent of agents??[])groups[agentState(agent,now)].push(agent);
 for(const list of Object.values(groups))list.sort((a,b)=>String(b.updatedAt??'').localeCompare(String(a.updatedAt??''))||String(a.agentId).localeCompare(String(b.agentId)));
 return groups;
}
function transportInfo(agent){
 const t=agent?.readiness?.transport??agent?.transport??null;
 const state=t?.state??'unknown';
 const push=agent?.readiness?.push?.ready??t?.push;
 return {state,adapter:t?.adapter??null,push:typeof push==='boolean'?push:null,label:`${state}${t?.adapter?' · '+t.adapter:''}${push===true?' · push':push===false?' · no push':''}`};
}
// Registry hygiene: how many identities exist versus how many are actually on the air.
function registrySummary(snapshot,usage,now=Date.now()){
 const groups=groupAgents(snapshot?.agents,now),reg=snapshot?.registry;
 const num=value=>Number.isFinite(value)?value:null;
 if(reg&&typeof reg==='object'){
  const stored=num(reg.stored)??snapshot.agents.length,live=num(reg.live)??groups.live.length;
  return {source:'registry',stored,live,dormant:num(reg.dormant)??Math.max(0,stored-live),retired:num(reg.retired)??0,ephemeral:num(reg.ephemeral)??0,prunable:num(reg.prunable)??0};
 }
 const ua=usage?.agents;
 if(ua&&Number.isFinite(ua.stored)){
  const live=groups.live.length;
  return {source:'usage',stored:ua.stored,live,dormant:Math.max(0,ua.active-live),retired:num(ua.left)??0,ephemeral:0,prunable:0};
 }
 const total=(snapshot?.agents??[]).length;
 return {source:'room',stored:total,live:groups.live.length,dormant:groups.dormant.length+groups.idle.length,retired:0,ephemeral:0,prunable:0};
}
// Width of each registry segment in percent; the segments always add up to 100 when stored > 0.
function registrySegments(summary){
 const stored=summary?.stored??0;if(!stored)return [];
 const live=Math.min(summary.live,stored),retired=Math.min(summary.retired,stored-live),ephemeral=Math.min(summary.ephemeral,stored-live-retired);
 const dormant=Math.max(0,stored-live-retired-ephemeral);
 return [['live',live],['dormant',dormant],['ephemeral',ephemeral],['retired',retired]].filter(([,n])=>n>0).map(([key,n])=>({key,count:n,percent:Math.max(1.5,n/stored*100)}));
}

// ---- Flight plan (roadmap tree) ----------------------------------------------
function progressOf(node){
 const p=node?.progress;
 if(p&&Number.isFinite(p.total)&&Number.isFinite(p.done))return {done:p.done,total:p.total,percent:Number.isFinite(p.percent)?p.percent:p.total?Math.round(p.done/p.total*100):0};
 const leaves=[];const walk=n=>{if(n.children?.length)n.children.forEach(walk);else if(n.status!=='cancelled')leaves.push(n);};
 if(node)walk(node);
 const done=leaves.filter(n=>n.status==='done').length;
 return {done,total:leaves.length,percent:leaves.length?Math.round(done/leaves.length*100):0};
}
function formatProgress(p){return p&&p.total?`${p.done}/${p.total} · ${p.percent}%`:'no items';}
// A container's own status is whatever was set on it (the broker defaults it to 'todo'), which says nothing once its children move.
// derivedStatus is the broker's roll-up; without it the status is derived here from the children and progress, so older brokers read right too.
function deriveStatus(node){
 const kids=node?.children??[];
 if(!kids.length)return STATUS_ORDER.includes(node?.status)?node.status:'todo';
 const p=progressOf(node);
 if(!p.total)return kids.every(k=>deriveStatus(k)==='cancelled')?'cancelled':'todo';
 if(p.done>=p.total)return 'done';
 let active=p.done>0;
 const walk=n=>{if(n.children?.length)n.children.forEach(walk);else if(['in-progress','review','blocked'].includes(n.status))active=true;};
 kids.forEach(walk);
 return active?'in-progress':'todo';
}
// What the status chip shows: {status, derived}. Leaves, and containers with a meaningful status of their own, show it as set.
function displayStatus(node){
 const own=STATUS_ORDER.includes(node?.status)?node.status:null;
 if(!node?.children?.length)return {status:own??'todo',derived:false};
 if(own&&own!=='todo')return {status:own,derived:false};
 const given=STATUS_ORDER.includes(node?.derivedStatus)?node.derivedStatus:null,status=given??deriveStatus(node);
 return {status,derived:status!==(own??'todo')||!own};
}
function rollup(roots){
 const total={done:0,total:0,percent:0};
 for(const root of roots??[]){const p=progressOf(root);total.done+=p.done;total.total+=p.total;}
 total.percent=total.total?Math.round(total.done/total.total*100):0;return total;
}
function walkTree(roots,visit,path=[],depth=0){
 for(const node of roots??[]){visit(node,path,depth);if(node.children?.length)walkTree(node.children,visit,[...path,node.title],depth+1);}
}
// Counts leaves (the actual work), so containers never inflate the totals. Falls back to the broker's counts for an empty tree.
function statusCounts(roots,counts){
 const out=Object.fromEntries(STATUS_ORDER.map(s=>[s,0]));
 let any=false;
 walkTree(roots,n=>{if(!n.children?.length&&n.status in out){out[n.status]++;any=true;}});
 if(!any&&counts?.byStatus&&typeof counts.byStatus==='object')for(const s of STATUS_ORDER)out[s]=counts.byStatus[s]??0;
 return out;
}
function treeFacets(roots){
 const owners=new Set(),branches=new Set(),labels=new Set();
 walkTree(roots,n=>{if(n.owner)owners.add(n.owner);if(n.branch)branches.add(n.branch);for(const l of n.labels??[])labels.add(l);});
 const sorted=set=>[...set].sort((a,b)=>String(a).localeCompare(String(b)));
 return {owners:sorted(owners),branches:sorted(branches),labels:sorted(labels)};
}
function planFilterActive(f){return !!(f&&(f.status||f.owner||f.branch||f.label||(f.q&&f.q.trim())));}
function nodeMatches(node,f){
 if(f.status&&displayStatus(node).status!==f.status)return false;
 if(f.owner&&node.owner!==f.owner)return false;
 if(f.branch&&node.branch!==f.branch)return false;
 if(f.label&&!(node.labels??[]).includes(f.label))return false;
 const q=(f.q??'').trim().toLowerCase();
 if(q&&!`${node.title??''} ${node.id??''} ${node.owner??''} ${node.branch??''} ${(node.labels??[]).join(' ')}`.toLowerCase().includes(q))return false;
 return true;
}
// Keeps every matching node plus the ancestors needed to reach it (marked context:true).
function filterTree(roots,f){
 if(!planFilterActive(f))return roots??[];
 const prune=node=>{
  const children=(node.children??[]).map(prune).filter(Boolean),self=nodeMatches(node,f);
  if(!self&&!children.length)return null;
  return {...node,children,context:!self};
 };
 return (roots??[]).map(prune).filter(Boolean);
}
function flattenTree(roots,collapsed=new Set()){
 const rows=[];
 const visit=(nodes,depth)=>{for(const node of nodes){const kids=node.children??[];rows.push({node,depth,hasChildren:kids.length>0,collapsed:collapsed.has(node.id)});if(kids.length&&!collapsed.has(node.id))visit(kids,depth+1);}};
 visit(roots??[],0);return rows;
}
function laneGroups(roots){
 const lanes=new Map(STATUS_ORDER.map(s=>[s,[]]));
 walkTree(roots,(node,path)=>{if(node.children?.length)return;(lanes.get(node.status)??lanes.get('todo')).push({node,path});});
 return STATUS_ORDER.filter(s=>s!=='cancelled'||lanes.get(s).length).map(status=>({status,label:STATUS_LABEL[status],cards:lanes.get(status)}));
}

// ---- Runways (branch ownership) ----------------------------------------------
function branchSeverity(branch){
 const flags=branch?.flags??[];
 for(let i=0;i<FLAG_ORDER.length;i++)if(flags.includes(FLAG_ORDER[i]))return FLAG_ORDER.length-i;
 return 0;
}
function sortBranches(branches){
 return [...(branches??[])].sort((a,b)=>branchSeverity(b)-branchSeverity(a)||String(a.name).localeCompare(String(b.name)));
}
function flagSummary(branches){
 const out={total:0,flagged:0,contested:0,missing:0,orphaned:0,unclaimed:0};
 for(const b of branches??[]){
  out.total++;const flags=(b.flags??[]).filter(f=>FLAG_ORDER.includes(f));
  if(flags.length)out.flagged++;
  for(const f of new Set(flags))out[f]++;
 }
 return out;
}
// Tower caption: every flag kind that occurs, with counts, most serious first. The headline number is the branches carrying any flag.
function conflictSummary(branches){
 const s=flagSummary(branches);
 const parts=FLAG_ORDER.filter(f=>s[f]>0).map(f=>`${formatCount(s[f])} ${f}`);
 const tone=s.contested||s.missing?'alert':s.orphaned?'warn':s.flagged?'':'live';
 return {count:s.flagged,total:s.total,caption:parts.length?parts.join(' · '):s.total?'all branches clear':'no branches yet',tone};
}
// A repo is identified by its git common dir: '<repo>/.git' for a normal clone, '<name>.git' for a bare one. Show the repository and keep the path for a tooltip.
function repoLabel(repo){
 const path=typeof repo==='string'?repo:repo&&typeof repo==='object'?String(repo.root??repo.path??repo.name??''):'';
 const parts=path.split(/[\\/]/).filter(Boolean),last=parts.at(-1)??'';
 return {name:last==='.git'?(parts.at(-2)??last):last,path};
}
// One row per checkout. `project` is the registered room mapped to that checkout (null when no agent room covers it).
function worktreeRows(worktrees,{project='',rooms=[]}={}){
 const known=new Set(rooms),seen=new Set(),rows=[];
 for(const w of worktrees??[]){
  const path=String(w?.path??w?.project??'');if(!path||seen.has(path))continue;seen.add(path);
  const room=w.project||(known.has(path)?path:null);
  rows.push({path,name:leafName(path)||path,project:room,current:!!room&&room===project,registered:!!room,roomName:room&&leafName(room)!==leafName(path)?leafName(room):''});
 }
 return rows.sort((a,b)=>b.current-a.current||a.name.localeCompare(b.name));
}
// Which empty-or-ready state the Runways view is in, so each gets its own explanation.
function runwayState(ownership){
 if(!ownership)return 'loading';
 if(!ownership.available)return 'unavailable';
 if(ownership.git===false)return 'no-git';
 return (ownership.branches??[]).length?'ready':'empty';
}
function describeUnassigned(key,entry){
 if(entry===null||entry===undefined)return '';
 if(typeof entry!=='object')return String(entry);
 if(key==='claims')return [entry.branch,entry.agentId,entry.reason==='no-git'?'no git repository':entry.reason==='missing'?'branch not found':entry.reason,entry.stale?'stale':''].filter(Boolean).join(' · ');
 if(key==='worktrees')return [leafName(entry.path),entry.head?'@ '+shortSha(entry.head):'detached',(entry.agents??[]).length?`${entry.agents.length} agent${entry.agents.length===1?'':'s'}`:''].filter(Boolean).join(' · ');
 const lead=entry.title??entry.name??entry.agentId??entry.path??entry.id??entry.resource;
 const tail=[entry.state,entry.owner,entry.source,entry.project&&leafName(entry.project)].filter(v=>v&&v!==lead);
 return lead===undefined?JSON.stringify(entry):[lead,...tail].join(' · ');
}
const UNASSIGNED_TITLE={claims:'Claims without a runway',worktrees:'Detached worktrees',agents:'Agents not on a branch',tasks:'Work not tied to a branch'};
function filterBranches(branches,{flag='',q=''}={}){
 const needle=q.trim().toLowerCase();
 return sortBranches(branches).filter(b=>(!flag||(b.flags??[]).includes(flag))&&(!needle||`${b.name} ${b.claim?.agentId??''} ${(b.agents??[]).map(a=>a.agentId).join(' ')} ${(b.tasks??[]).map(t=>t.title).join(' ')}`.toLowerCase().includes(needle)));
}

// ---- Attention board --------------------------------------------------------
function attentionItems({snapshot,work,ownership,usage}={}){
 const items=[],add=(level,text,view,extra)=>items.push({level,text,view,...extra});
 const plural=(n,word)=>`${formatCount(n)} ${n===1?word:/[^aeiou]y$/.test(word)?word.slice(0,-1)+'ies':/(ch|s|x)$/.test(word)?word+'es':word+'s'}`;
 const flags=ownership?.available?flagSummary(ownership.branches):null;
 if(flags?.contested)add('alert',`${plural(flags.contested,'contested branch')}: more than one owner attached`,'runways',{flag:'contested'});
 if(flags?.missing)add('alert',`${plural(flags.missing,'missing branch')} referenced but not in the repository`,'runways',{flag:'missing'});
 const missingDeliveries=(snapshot?.messages??[]).reduce((n,m)=>n+receiptSummary(m).counts.missing,0);
 if(missingDeliveries)add('alert',`${plural(missingDeliveries,'delivery')} confirmed not delivered`,'log',{unacked:true});
 if(flags?.orphaned)add('warn',`${plural(flags.orphaned,'orphaned branch')} with no live owner`,'runways',{flag:'orphaned'});
 const stale=(snapshot?.claims??[]).filter(c=>c.stale).length;
 if(stale)add('warn',`${plural(stale,'stale claim')} held by agents that went quiet`,'claims');
 const blocked=work?.available?statusCounts(work.roots,work.counts).blocked:0;
 if(blocked)add('warn',`${plural(blocked,'blocked work item')}`,'plan',{status:'blocked'});
 if(snapshot?.pendingDeliveries>0)add('warn',`${plural(snapshot.pendingDeliveries,'delivery')} awaiting acknowledgement`,'log',{unacked:true});
 if(Array.isArray(usage?.nearLimit)&&usage.nearLimit.length)add('warn',`Storage headroom is low: ${usage.nearLimit.join(', ')}`,'tower');
 const reg=registrySummary(snapshot,usage);
 if(reg.prunable>0)add('info',`${plural(reg.prunable,'identity')} could be pruned from the registry`,'strips');
 if(flags?.unclaimed)add('info',`${plural(flags.unclaimed,'unclaimed branch')}`,'runways',{flag:'unclaimed'});
 if(!items.length)add('ok','All quiet. Nothing needs attention.','tower');
 const rank={alert:0,warn:1,info:2,ok:3};
 return items.sort((a,b)=>rank[a.level]-rank[b.level]);
}
