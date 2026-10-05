// Read-only views of durable state. Never register an observer or acknowledge a message.
export function projectSummaries(state){
 return state.rooms.map(room=>{
  const times=[...room.agents.map(a=>a.updatedAt),...room.messages.map(m=>m.createdAt),...room.claims.map(c=>c.claimedAt)].sort();
  return {project:room.project,agentCount:room.agents.length,messageCount:room.messages.length,
   claimCount:room.claims.length,pendingDeliveries:room.messages.reduce((n,m)=>n+m.recipients.length-m.ackedBy.length,0),
   lastActivityAt:times.at(-1)??null};
 }).sort((a,b)=>(b.lastActivityAt??'').localeCompare(a.lastActivityAt??'')||a.project.localeCompare(b.project));
}
export function roomSnapshot(project,room,limit=100){
 const messages=room?.messages??[];
 return structuredClone({project,agents:room?.agents??[],claims:room?.claims??[],messages:messages.slice(-limit).reverse(),
  totalMessages:messages.length,pendingDeliveries:messages.reduce((n,m)=>n+m.recipients.length-m.ackedBy.length,0),
  pendingByAgent:Object.fromEntries((room?.agents??[]).map(a=>[a.agentId,messages.filter(m=>m.recipients.includes(a.agentId)&&!m.ackedBy.includes(a.agentId)).length])),cursor:room?.cursor??0});
}
