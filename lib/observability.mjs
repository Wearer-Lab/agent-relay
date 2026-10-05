function claimView(claim,holder,scope,staleMinutes){
 const lastSeenAgeMs=holder?Math.max(0,Date.now()-Date.parse(holder.updatedAt)):null;
 return {...claim,scope,ageMs:Math.max(0,Date.now()-Date.parse(claim.claimedAt)),lastSeenAgeMs,
  stale:!holder||holder.left===true||lastSeenAgeMs>=staleMinutes*60000};
}
export function projectClaims(room,staleMinutes=30){
 return (room?.claims??[]).map(c=>claimView(c,room.agents.find(a=>a.agentId===c.agentId),'project',staleMinutes));
}
export function machineClaims(state,staleMinutes=30){
 return (state.machineClaims??[]).map(c=>claimView(c,
  state.rooms.find(r=>r.project===c.project)?.agents.find(a=>a.agentId===c.agentId),'machine',staleMinutes));
}
// Read-only views of durable state. Never register an observer or acknowledge a message.
export function projectSummaries(state){
 return state.rooms.map(room=>{
  const times=[...room.agents.map(a=>a.updatedAt),...room.messages.map(m=>m.createdAt),...room.claims.map(c=>c.claimedAt)].sort();
  return {project:room.project,agentCount:room.agents.length,messageCount:room.messages.length,
   claimCount:room.claims.length,pendingDeliveries:room.messages.reduce((n,m)=>n+m.recipients.length-m.ackedBy.length,0),
   lastActivityAt:times.at(-1)??null};
 }).sort((a,b)=>(b.lastActivityAt??'').localeCompare(a.lastActivityAt??'')||a.project.localeCompare(b.project));
}
export function roomSnapshot(project,room,limit=100,state={rooms:[]},staleMinutes=30){
 // Dashboard computes ages from timestamps so conditional snapshots stay stable.
 const snapshotRow=({ageMs,lastSeenAgeMs,...row})=>row;
 const messages=room?.messages??[];
 return structuredClone({project,agents:room?.agents??[],claims:[...projectClaims(room,staleMinutes),...machineClaims(state,staleMinutes)].map(snapshotRow),messages:messages.slice(-limit).reverse(),
  totalMessages:messages.length,pendingDeliveries:messages.reduce((n,m)=>n+m.recipients.length-m.ackedBy.length,0),
  pendingByAgent:Object.fromEntries((room?.agents??[]).map(a=>[a.agentId,messages.filter(m=>m.recipients.includes(a.agentId)&&!m.ackedBy.includes(a.agentId)).length])),cursor:room?.cursor??0});
}
