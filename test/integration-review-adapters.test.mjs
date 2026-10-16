import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpAdapter} from '../lib/mcp.mjs';
import {AgentRelayPlugin} from '../lib/opencode-plugin.mjs';

// The registry sweep marks idle, disconnected identities dormant. Adapters register once at start, so the first
// call after that used to fail with UNKNOWN_AGENT until the host restarted. They now register again, once.
const unknownAgent=()=>Object.assign(new Error('Agent is not registered in this project.'),{code:'UNKNOWN_AGENT'});
const neverWait=(project,agentId,cursor,options)=>new Promise((resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new Error('aborted'))));

test('MCP adapter registers again when the sweep made its identity dormant, but not after an explicit leave',async t=>{
 const calls=[];let dormant=false;
 const rpcImpl=async(project,fields)=>{
  calls.push(fields.op);
  if(fields.op==='register'){dormant=false;return {ok:true,agent:{},capacity:{}};}
  if(dormant)throw unknownAgent();
  return {ok:true,agent:{},claims:[],left:fields.agentId};
 };
 const adapter=await createMcpAdapter({project:'/tmp',runner:'claude',sessionId:'dormant',rpcImpl,waitImpl:neverWait,gitContextImpl:async()=>null});
 const [serverSide,clientSide]=InMemoryTransport.createLinkedPair();
 const client=new Client({name:'dormant',version:'1'});
 await adapter.start(serverSide);await client.connect(clientSide);
 t.after(async()=>{try{await client.close();}catch{}try{await adapter.close();}catch{}});
 const call=async(name,args={})=>{const result=await client.callTool({name,arguments:args});return {isError:result.isError===true,body:JSON.parse(result.content[0].text)};};
 const registrations=()=>calls.filter(op=>op==='register').length;
 assert.equal(registrations(),1);
 dormant=true;
 const revived=await call('relay_status',{status:'busy'});
 assert.equal(revived.isError,false,JSON.stringify(revived));
 assert.equal(registrations(),2,'exactly one re-registration');
 assert.deepEqual(calls.slice(-3),['status','register','status']);
 // An explicit leave is respected: no resurrection afterwards.
 assert.equal((await call('relay_leave')).isError,false);
 dormant=true;
 const before=registrations();
 const after=await call('relay_status',{status:'busy'});
 assert.equal(after.isError,true);
 assert.equal(registrations(),before);
});

test('MCP adapter surfaces an unknown recipient after at most one extra registration',async t=>{
 const calls=[];
 const rpcImpl=async(project,fields)=>{
  calls.push(fields.op);
  if(fields.op==='send')throw unknownAgent();
  return {ok:true,agent:{},capacity:{}};
 };
 const adapter=await createMcpAdapter({project:'/tmp',runner:'claude',sessionId:'recipient',rpcImpl,waitImpl:neverWait,gitContextImpl:async()=>null});
 const [serverSide,clientSide]=InMemoryTransport.createLinkedPair();
 const client=new Client({name:'recipient',version:'1'});
 await adapter.start(serverSide);await client.connect(clientSide);
 t.after(async()=>{try{await client.close();}catch{}try{await adapter.close();}catch{}});
 const result=await client.callTool({name:'relay_send',arguments:{to:'nobody',body:'hi'}});
 assert.equal(result.isError,true);
 assert.match(JSON.parse(result.content[0].text).error,/not registered/u);
 assert.equal(calls.filter(op=>op==='register').length,2);
 assert.equal(calls.filter(op=>op==='send').length,2);
});

test('OpenCode plugin registers a session again when its identity went dormant, but not after relay_leave',async()=>{
 const calls=[];let dormant=false;
 const plugin=await AgentRelayPlugin({client:{tui:{showToast:async()=>true},session:{status:async()=>({}),promptAsync:async()=>({})}},directory:'/tmp'},
  {transport:{rpc:async(project,fields)=>{
    calls.push(fields.op);
    if(fields.op==='register'){dormant=false;return {ok:true};}
    if(dormant)throw unknownAgent();
    return {ok:true,messages:[],cursor:0,agent:{},claims:[]};
   },wait:neverWait}});
 const ctx={sessionID:'ses_dormant',directory:'/tmp',abort:new AbortController().signal};
 const registrations=()=>calls.filter(op=>op==='register').length;
 await plugin.tool.relay_status.execute({status:'busy'},ctx);
 assert.equal(registrations(),1);
 dormant=true;
 await plugin.tool.relay_status.execute({status:'idle'},ctx);
 assert.equal(registrations(),2);
 await plugin.tool.relay_leave.execute({},ctx);
 dormant=true;
 const before=registrations();
 await assert.rejects(plugin.tool.relay_status.execute({status:'busy'},ctx),/not registered/u);
 assert.equal(registrations(),before);
 await plugin.dispose();
});
