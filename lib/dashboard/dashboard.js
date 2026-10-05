'use strict';
const $=id=>document.getElementById(id);
let secret=location.hash.slice(1);
try{if(secret)sessionStorage.setItem('relay-dashboard-token',secret);else secret=sessionStorage.getItem('relay-dashboard-token')||'';}catch{}
if(location.hash)history.replaceState(null,'',location.pathname);
let selected='',rooms=[],snapshot=null,paused=false,busy=false,lastUpdated=null;
const tags=new Map();
function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=String(text);if(className)el.className=className;return el;}
function empty(target,text){target.replaceChildren(node('p',text,'empty'));}
function time(value){const date=new Date(value);return Number.isNaN(date.getTime())?'Unknown':date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});}
function age(value){const minutes=Math.max(0,Math.floor((Date.now()-new Date(value))/60000));if(!Number.isFinite(minutes))return 'Unknown';if(minutes<1)return 'just now';if(minutes<60)return `${minutes}m ago`;if(minutes<1440)return `${Math.floor(minutes/60)}h ago`;return `${Math.floor(minutes/1440)}d ago`;}
function name(path){return path.split(/[\\/]/).filter(Boolean).at(-1)||path;}
function relative(resource){return resource.startsWith(selected+'/')||resource.startsWith(selected+'\\')?resource.slice(selected.length+1):resource;}
function connection(label,stale=false){$('connection').textContent=label;$('connection').classList.toggle('stale',stale);}
async function read(url){
 const headers={authorization:`Bearer ${secret}`};if(tags.has(url))headers['if-none-match']=tags.get(url);
 const response=await fetch(url,{headers,cache:'no-store',signal:AbortSignal.timeout(12000)});
 if(response.status===304)return null;
 if(!response.ok){let error;try{error=(await response.json()).error;}catch{}throw new Error(error||`Dashboard request failed (${response.status}).`);}
 const data=await response.json();if(response.headers.get('etag'))tags.set(url,response.headers.get('etag'));return data;
}
function renderProjects(){
 $('projects-count').textContent=`${rooms.length} project${rooms.length===1?'':'s'}`;
 if(!rooms.length){empty($('projects'),'No project rooms yet. Launch a coding runner and let it register with Agent Relay.');return;}
 const focused=document.activeElement?.dataset?.project;
 const fragment=document.createDocumentFragment();
 for(const room of rooms){
  const button=node('button');button.type='button';button.className='project-choice';button.dataset.project=room.project;button.setAttribute('aria-pressed',String(room.project===selected));
  button.append(node('strong',name(room.project)),node('span',room.project,'path'),node('span',`${room.agentCount} agents · ${room.messageCount} messages · ${room.pendingDeliveries} awaiting acknowledgement`,'project-stats'));
  const recent=room.lastActivityAt&&Date.now()-new Date(room.lastActivityAt)<300000;
  button.append(node('span',room.lastActivityAt?`${recent?'Recent activity':'Saved room'} · ${age(room.lastActivityAt)}`:'Saved room · no recorded activity',`activity-age${recent?'':' old'}`));
  button.addEventListener('click',()=>selectProject(room.project));fragment.append(button);
 }
 $('projects').replaceChildren(fragment);
 if(focused){for(const button of $('projects').children)if(button.dataset.project===focused)button.focus({preventScroll:true});}
}
function selectProject(project){
 if(selected===project)return;
 selected=project;snapshot=null;tags.delete('/api/snapshot?project='+encodeURIComponent(project));
 $('agent-filter').replaceChildren(new Option('All agents',''));$('search').value='';$('pending-only').checked=false;
 $('project').textContent=project;renderProjects();renderSnapshot();refresh();
}
function renderAgents(){
 const agents=snapshot?.agents??[];
 if(!agents.length){empty($('agents'),'No registered agents in this room.');return;}
 const fragment=document.createDocumentFragment();
 for(const agent of agents){
  const row=node('article',undefined,'agent'),identity=node('div',undefined,'agent-identity'),work=node('div',undefined,'agent-work');
  identity.append(node('span',agent.agentId,'agent-name'),node('p',agent.runner,'meta'));
  work.append(node('span',agent.frozen?'Frozen':agent.status,'tag'),node('p',agent.task===null?'No task reported':typeof agent.task==='string'?agent.task:JSON.stringify(agent.task,null,2),'task'));
  const pending=snapshot.pendingByAgent[agent.agentId]??0,activity=node('div',undefined,'agent-activity');
  const deliveries=node('p');deliveries.append(node('strong',pending),node('span',' awaiting acknowledgement','meta'));
  const claims=node('p');claims.append(node('strong',snapshot.claims.filter(c=>c.agentId===agent.agentId).length),node('span',' active claims','meta'));activity.append(deliveries,claims);
  const updated=node('div',undefined,'agent-updated');updated.append(node('span','Last update'),node('strong',age(agent.updatedAt)));updated.title=new Date(agent.updatedAt).toLocaleString();
  row.append(identity,work,activity,updated);fragment.append(row);
 }
 $('agents').replaceChildren(fragment);
 const current=$('agent-filter').value;
 if([...$('agent-filter').options].slice(1).map(o=>o.value).join('\n')!==agents.map(a=>a.agentId).join('\n')){
  $('agent-filter').replaceChildren(new Option('All agents',''),...agents.map(a=>new Option(a.agentId,a.agentId)));
  if(agents.some(a=>a.agentId===current))$('agent-filter').value=current;
 }
}
function renderMessages(){
 const messages=snapshot?.messages??[],query=$('search').value.toLowerCase(),agent=$('agent-filter').value,pendingOnly=$('pending-only').checked;
 const filtered=messages.filter(m=>(!agent||m.from===agent||m.recipients.includes(agent))&&(!pendingOnly||m.ackedBy.length<m.recipients.length)&&`${m.body} ${m.from} ${m.to}`.toLowerCase().includes(query));
 const expanded=new Set([...$('messages').querySelectorAll('details[open]')].map(el=>el.dataset.message));
 const scroll=$('messages').scrollTop;
 if(!filtered.length){empty($('messages'),messages.length?'No messages match these filters.':'No messages yet. Agent questions and replies will appear here.');return;}
 const fragment=document.createDocumentFragment();
 for(const message of filtered){
  const row=node('article',undefined,'message'),identity=node('div',undefined,'message-identity'),content=node('div',undefined,'message-content'),state=node('div',undefined,'message-state');
  identity.append(node('span',`${message.from} → ${message.to==='*'?'All peers':message.to}`,'route'));
  const pending=message.recipients.length-message.ackedBy.length;
  state.append(node('span',pending?`${pending} pending`:'Acknowledged',`tag${pending?' pending':''}`));
  const date=node('time',time(message.createdAt));date.dateTime=message.createdAt;date.title=new Date(message.createdAt).toLocaleString();identity.append(date);
  content.append(node('p',message.body,'message-body'));
  const details=node('details');details.dataset.message=message.messageId;details.open=expanded.has(message.messageId);details.append(node('summary','Delivery details'));
  details.append(node('div',`Acknowledged by: ${message.ackedBy.join(', ')||'No recipients yet'}`,'receipt'));
  details.append(node('div',`Transport notices: ${message.notified.map(n=>`${n.agentId} (${n.adapter})`).join(', ')||'None'}`,'receipt'));
  if(message.replyTo)details.append(node('div',`Reply to: ${message.replyTo}`,'receipt'));
  details.append(node('div',`Message ID: ${message.messageId}`,'receipt'));content.append(details);row.append(identity,content,state);fragment.append(row);
 }
 $('messages').replaceChildren(fragment);$('messages').scrollTop=scroll;
}
function renderSnapshot(){
 $('project').textContent=selected||'Choose a project room';
 for(const [id,value] of [['agents-count',snapshot?.agents.length],['messages-count',snapshot?.totalMessages],['pending-count',snapshot?.pendingDeliveries],['claims-count',snapshot?.claims.length]])$(id).textContent=value??'—';
 $('message-range').textContent=snapshot?`Latest ${snapshot.messages.length} of ${snapshot.totalMessages}`:'Latest 100 messages';
 renderAgents();renderMessages();
 const rows=(snapshot?.claims??[]).map(claim=>{const row=node('tr');row.append(node('td',relative(claim.resource)),node('td',claim.agentId),node('td',new Date(claim.claimedAt).toLocaleString()));return row;});
 $('claims').replaceChildren(...rows);$('no-claims').hidden=rows.length>0;
}
async function refresh(){
 if(busy||paused||document.hidden)return;
 busy=true;const startingSelection=selected;
 try{
  if(!secret)throw new Error('Open the dashboard using the complete link printed by the CLI.');
  const listing=await read('/api/projects');
  if(listing){rooms=listing.rooms;if(!selected||!rooms.some(r=>r.project===selected))selected=rooms.some(r=>r.project===listing.preferredProject)?listing.preferredProject:rooms[0]?.project??'';}
  renderProjects();
  const target=selected;
  if(target){const next=await read('/api/snapshot?project='+encodeURIComponent(target));if(selected===target){if(next){snapshot=next;renderSnapshot();}else if(snapshot)renderAgents();}}
  else{snapshot=null;renderSnapshot();}
  lastUpdated=new Date();$('updated').textContent=`Last checked ${time(lastUpdated)}`;$('error').hidden=true;connection(paused?'Updates paused':'Broker connected',paused);
 }catch(error){$('error').textContent=error.message+(snapshot?' Showing the last successful snapshot.':'');$('error').hidden=false;connection('Connection unavailable',true);}
 finally{busy=false;if(selected!==startingSelection&&!paused)queueMicrotask(refresh);}
}
$('pause').addEventListener('click',()=>{paused=!paused;$('pause').textContent=paused?'Resume updates':'Pause updates';connection(paused?'Updates paused':'Connecting…',paused);if(!paused)refresh();});
for(const id of ['search','agent-filter','pending-only'])$(id).addEventListener(id==='search'?'input':'change',renderMessages);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
setInterval(refresh,3000);refresh();
