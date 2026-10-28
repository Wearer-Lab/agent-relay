import {isLive,isTransportStale,registryCounts,pendingByAgent,transportAgeMs,hasRead,liveness} from './registry.mjs';
// The deliveries nobody has read: an explicit ack, or a broadcast cursor that covers the message.
const unreadCount=(room)=>{
 const agents=new Map((room?.agents??[]).map(agent=>[agent.agentId,agent]));
 return (room?.messages??[]).reduce((n,message)=>{
  const read=message.recipients.filter(id=>hasRead(id,message,agents.get(id))).length;
  return n+message.recipients.length-read;
 },0);
};
export function presence(agents,withinMinutes){
 return agents.filter(a=>!a.left).map(a=>{
  const transport=a.transport??null;
  const ageMs=transport?.ts?Date.now()-Date.parse(transport.ts):null;
  return {...a,lastSeenAgeMs:Math.max(0,Date.now()-Date.parse(a.updatedAt)),
   transportAgeMs:transportAgeMs(a),transportStale:isTransportStale(a),
   readiness:{declared:{status:a.status,task:a.task??null,frozen:a.frozen,statusAt:a.statusAt??null,source:'agent'},
    lastSeenAt:a.updatedAt,
    transport:transport?{...transport,ageMs:Number.isFinite(ageMs)?Math.max(0,ageMs):null}:{state:'unknown',adapter:null,ts:null,source:null,ageMs:null},
    push:transport?.push===undefined?{ready:null,source:null,ts:null}
     :{ready:transport.push,source:transport.source??'adapter-report',ts:transport.ts}}};
 }).filter(a=>withinMinutes===undefined||a.lastSeenAgeMs<=withinMinutes*60000);
}
export function transportState(agent){return agent?.transport?.state??'unknown';}
// The same liveness classification staleClaimList uses, so agents, blocked and the
// dashboard agree on whether a claim is stale and on the owner's state.
function claimView(claim,agent,scope,staleMinutes){
 const view=liveness(agent,{withinMinutes:staleMinutes});
 return {...claim,scope,ageMs:Math.max(0,Date.now()-Date.parse(claim.claimedAt)),
  lastSeenAgeMs:view.lastSeenAgeMs,holder:view.holder,stale:view.stale};
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
  return {project:room.project,agentCount:presence(room.agents).length,messageCount:room.messages.length,
   claimCount:room.claims.length,pendingDeliveries:unreadCount(room),
   lastActivityAt:times.at(-1)??null};
 }).sort((a,b)=>(b.lastActivityAt??'').localeCompare(a.lastActivityAt??'')||a.project.localeCompare(b.project));
}
export function roomSnapshot(project,room,limit=100,state={rooms:[]},staleMinutes=30,registry={}){
 const now=Date.now();
 // Dashboard computes ages from timestamps so conditional snapshots stay stable.
 const snapshotRow=({ageMs,lastSeenAgeMs,...row})=>{
  if(row.readiness?.transport){
   const {ageMs:transportAge,...transport}=row.readiness.transport;
   row.readiness={...row.readiness,transport};
  }
  return row;
 };
 const messages=room?.messages??[];
 return structuredClone({project,agents:presence(room?.agents??[]).map(snapshotRow).map(row=>({...row,live:isLive(row,{now}),
   stale:!isLive(row,{now})})),claims:[...projectClaims(room,staleMinutes),...machineClaims(state,staleMinutes)].map(snapshotRow),messages:messages.slice(-limit).reverse(),
  totalMessages:messages.length,pendingDeliveries:unreadCount(room),
  pendingByAgent:pendingByAgent(room),registry:registryCounts(state,room,{now,...registry}),cursor:room?.cursor??0});
}
