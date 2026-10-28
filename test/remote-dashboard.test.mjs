import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {boot, modelContext, textOf, findAll, byClass, plain} from './dashboard-dom.mjs';
import {createDashboardHandler} from '../lib/dashboard.mjs';
import {startGateway, PAIRINGS_PATH} from '../lib/gateway.mjs';

const ago=minutes=>new Date(Date.now()-minutes*60000).toISOString();
const rooms={rooms:[{project:'/w',agentCount:2,messageCount:1,pendingDeliveries:3,lastActivityAt:null}],preferredProject:'/w'};
const agent=(agentId,extra={})=>({agentId,runner:'codex',status:'working',frozen:false,task:'Ship it',updatedAt:ago(1),live:true,...extra});
// A cloud agent carries the marker the gateway put on the request; a local agent has none.
const fleet=(extra={})=>({project:'/w',agents:[
  agent('atlas'),
  agent('cloud-1',{runner:'remote',cloud:{runner:'claude',prefix:'cloud-'}})],
  claims:[],messages:[],totalMessages:0,pendingDeliveries:3,pendingByAgent:{atlas:3},cursor:0,...extra});

// The shared harness has no route for the gateway's pairing feed, so the fetch stub
// learns one here: the dashboard asks for it exactly like the other feeds.
function withPairings(page,payload){
  const original=page.sandbox.fetch;
  page.sandbox.fetch=async url=>{
    if(url.startsWith(PAIRINGS_PATH))return {status:200,ok:true,headers:{get:()=>null},json:async()=>typeof payload==='function'?payload():payload};
    return original(url);
  };
  return page;
}
const message=(extra={})=>({messageId:'m1',cursor:1,from:'atlas',to:'cloud-1',body:'hello',createdAt:ago(1),recipients:['cloud-1'],ackedBy:[],notified:[],...extra});

// ---- Pure view-model helpers ----------------------------------------------------------
const M=modelContext();
test('the cloud marker is read from the broker row, and a row without one stays local',()=>{
  assert.deepEqual(plain(M.cloudMark({cloud:{runner:'claude',prefix:'cloud-'}})),{cloud:true,runner:'claude',prefix:'cloud-'});
  assert.deepEqual(plain(M.cloudMark({cloud:true})),{cloud:true,runner:null,prefix:null});
  assert.deepEqual(plain(M.cloudMark({runner:'codex'})),{cloud:false,runner:null,prefix:null});
  assert.deepEqual(plain(M.cloudMark({})),{cloud:false,runner:null,prefix:null});
  assert.equal(M.cloudRunner({cloud:{runner:'claude'},runner:'codex'}),'claude');
  assert.equal(M.cloudRunner({cloud:{},runner:'codex'}),'codex','the row runner is the fallback');
  assert.equal(M.cloudRunner({runner:'codex'}),null,'a local agent has no badge');
});
test('the pending split is read when the broker reports it, and the old number is the fallback',()=>{
  assert.deepEqual(plain(M.pendingSplit({pendingCounts:{live:3,dormant:2,retired:1,expired:4}})),{live:3,dormant:2,retired:1,expired:4});
  assert.deepEqual(plain(M.pendingSplit({pending:{counts:{live:1,dormant:0,retired:0,expired:0}}})),{live:1,dormant:0,retired:0,expired:0});
  assert.equal(M.pendingSplit({pendingDeliveries:3}),null,'a broker without the split reports nothing');
  assert.equal(M.pendingSplit({pendingCounts:{live:3}}),null,'a half-filled split is not a split');
  assert.deepEqual(plain(M.pendingSplit({},{pending:{live:2,dormant:0,retired:0,expired:0}})),{live:2,dormant:0,retired:0,expired:0},'the usage report carries the same numbers');
  assert.deepEqual(plain(M.pendingHeadline({pendingCounts:{live:3,dormant:2,retired:1,expired:4}})),{split:{live:3,dormant:2,retired:1,expired:4},live:3,held:7,total:10});
  assert.deepEqual(plain(M.pendingHeadline({pendingDeliveries:3})),{split:null,live:3,held:0,total:3});
  assert.deepEqual(plain(M.pendingHeadline({})),{split:null,live:0,held:0,total:0});
  assert.deepEqual(plain(M.pendingForAgent({pendingByAgent:{a:{live:1,dormant:2,retired:0,expired:0}}},'a')),{split:true,live:1,dormant:2,retired:0,expired:0,total:3});
  assert.deepEqual(plain(M.pendingForAgent({pendingByAgent:{a:3}},'a')),{split:false,live:3,dormant:0,retired:0,expired:0,total:3});
  assert.deepEqual(plain(M.pendingForAgent({},'a')),{split:false,live:0,dormant:0,retired:0,expired:0,total:0});
  assert.match(M.pendingTooltip({live:1,dormant:2,retired:0,expired:0}),/durable inbox is deliberate/);
  assert.deepEqual(plain(M.pendingGroupList({live:1,dormant:2,retired:0,expired:0})),[{key:'dormant',label:'held for dormant identities',count:2}]);
});
test('the pairing rows are the gateway list, and no gateway means no rows at all',()=>{
  const rows=M.pairingRows({available:true,pairings:[{code:'K7Q2PX',runner:'claude',repo:'github.com/org/repo',branch:'main',createdAt:ago(2),expiresAt:ago(-8)}]});
  assert.equal(rows.length,1);
  assert.equal(rows[0].code,'K7Q2PX');assert.equal(rows[0].runner,'claude');assert.equal(rows[0].repo,'github.com/org/repo');
  assert.equal(M.pairingRows({available:false}),null,'a local dashboard has no gateway and shows no panel');
  assert.deepEqual(M.pairingRows({available:true,pairings:[]}),[]);
  assert.equal(M.pairingRows(null),null);
});

// ---- Rendering against the fake DOM ------------------------------------------------------
test('a cloud agent shows a runner badge and the via-gateway marker, a local agent does not',async()=>{
  const page=boot({projects:rooms,snapshot:fleet(),path:'/agents/'});
  await page.flush();
  const strips=findAll(page.$('agents'),el=>el.tag==='article');
  const local=strips.find(el=>el.dataset.agent==='atlas');
  const cloud=strips.find(el=>el.dataset.agent==='cloud-1');
  assert.ok(local&&cloud);
  assert.equal(byClass(local,'cloud-badge').length,0,'a local agent shows no badge');
  assert.equal(byClass(local,'via-gateway').length,0,'a local agent shows no marker');
  assert.match(textOf(local),/codex/);
  const badge=byClass(cloud,'cloud-badge');
  assert.equal(badge.length,1);
  assert.equal(textOf(badge[0]),'claude','the badge names the runner the gateway knows');
  assert.equal(textOf(byClass(cloud,'via-gateway')[0]),'via gateway');
  // A row that predates the feature renders exactly as before.
  const old=boot({projects:rooms,snapshot:fleet({agents:[agent('atlas')]}),path:'/agents/'});
  await old.flush();
  const row=findAll(old.$('agents'),el=>el.tag==='article')[0];
  assert.equal(byClass(row,'cloud-badge').length,0);
  assert.equal(byClass(row,'via-gateway').length,0);
});
test('the radio log marks a message that came through the gateway',async()=>{
  const page=boot({projects:rooms,snapshot:fleet({messages:[
    message({messageId:'cloud-1',cursor:2,from:'cloud-1',to:'atlas',cloud:{runner:'claude',prefix:'cloud-'}}),
    message({messageId:'local-1',cursor:1,from:'atlas',to:'cloud-1'})],totalMessages:2}),path:'/messages/'});
  await page.flush();
  const rows=findAll(page.$('messages'),el=>el.tag==='article');
  const cloud=rows.find(el=>el.dataset.message==='cloud-1');
  const local=rows.find(el=>el.dataset.message==='local-1');
  assert.ok(cloud&&local);
  assert.equal(byClass(cloud,'cloud-badge').length,1);
  assert.equal(textOf(byClass(cloud,'cloud-badge')[0]),'claude');
  assert.equal(textOf(byClass(cloud,'via-gateway')[0]),'via gateway');
  assert.equal(byClass(local,'cloud-badge').length,0);
  assert.equal(byClass(local,'via-gateway').length,0);
});
test('the tower lists the pending pairing requests, read-only',async()=>{
  const page=boot({projects:rooms,snapshot:fleet()});
  withPairings(page,{available:true,pairings:[{code:'K7Q2PX',runner:'claude',repo:'github.com/org/repo',branch:'main',createdAt:ago(2),expiresAt:ago(-8)}]});
  await page.flush();
  assert.equal(page.$('pairings').hidden,false,'the tower shows the panel when a gateway is behind it');
  const list=textOf(page.$('pairing-list'));
  assert.match(list,/K7Q2PX/);assert.match(list,/claude/);assert.match(list,/github\.com\/org\/repo/);
  assert.equal(findAll(page.$('pairing-list'),el=>el.tag==='button').length,0,'the dashboard never approves or denies');
  assert.equal(findAll(page.$('pairing-list'),el=>el.tag==='input'||el.tag==='form').length,0);
  // The panel itself carries no control either.
  const html=await fs.readFile(new URL('../lib/dashboard/index.html',import.meta.url),'utf8');
  const panel=html.slice(html.indexOf('id="pairings"'),html.indexOf('</section>',html.indexOf('id="pairings"')));
  assert.doesNotMatch(panel,/<button|<form|<input/i,'the pairing panel is read-only');
  assert.match(panel,/agent-relay remote approve/,'the panel says where the decision is made');
});
test('the pairing panel refreshes with the tower, so an expired request does not linger',async()=>{
  const page=boot({projects:rooms,snapshot:fleet()});
  let payload={available:true,pairings:[{code:'K7Q2PX',runner:'claude',repo:'github.com/org/repo',createdAt:ago(2),expiresAt:ago(-8)}]};
  withPairings(page,()=>payload);
  await page.flush();
  assert.match(textOf(page.$('pairing-list')),/K7Q2PX/);
  payload={available:true,pairings:[]};
  await page.sandbox.refresh();
  await page.flush();
  assert.doesNotMatch(textOf(page.$('pairing-list')),/K7Q2PX/,'the tower does not keep a request that is gone');
});
test('a local dashboard without a gateway shows no pairing panel and does not fail',async()=>{
  const page=boot({projects:rooms,snapshot:fleet()});
  await page.flush();
  assert.equal(page.$('pairings').hidden,true,'no gateway, no panel');
  assert.equal(findAll(page.$('pairings'),el=>el.tag==='article'||el.tag==='button').length,0);
  assert.equal(textOf(page.$('agents-count')),'2','the rest of the tower still renders');
  assert.equal(textOf(page.$('pending-count')),'3');
});
test('the tower shows the four pending groups when the broker reports them',async()=>{
  const snapshot=fleet({pendingDeliveries:10,pendingCounts:{live:3,dormant:2,retired:1,expired:4},
    pendingByAgent:{atlas:{live:3,dormant:2,retired:1,expired:4}}});
  const tower=boot({projects:rooms,snapshot});
  await tower.flush();
  assert.equal(textOf(tower.$('pending-count')),'3','the headline is the deliveries awaiting live agents');
  assert.equal(textOf(tower.$('pending-label')),'Awaiting live agents');
  assert.match(textOf(tower.$('pending-sub')),/2 dormant/);
  assert.match(textOf(tower.$('pending-sub')),/1 retired/);
  assert.match(textOf(tower.$('pending-sub')),/4 expired/);
  assert.match(tower.$('pending-sub').title,/durable inbox is deliberate/,'the tooltip explains why a durable inbox is not a bug');
  const strips=boot({projects:rooms,snapshot,path:'/agents/'});
  await strips.flush();
  const strip=findAll(strips.$('agents'),el=>el.tag==='article').find(el=>el.dataset.agent==='atlas');
  assert.match(textOf(strip),/3 awaiting live/);
  assert.match(textOf(strip),/2 dormant · 1 retired · 4 expired/);
});
test('the tower falls back to the old single number when the broker reports no split',async()=>{
  const snapshot=fleet({pendingDeliveries:3});
  const tower=boot({projects:rooms,snapshot});
  await tower.flush();
  assert.equal(textOf(tower.$('pending-count')),'3');
  assert.equal(textOf(tower.$('pending-label')),'Awaiting ack');
  assert.equal(textOf(tower.$('pending-sub')),'pending deliveries');
  const strips=boot({projects:rooms,snapshot,path:'/agents/'});
  await strips.flush();
  const strip=findAll(strips.$('agents'),el=>el.tag==='article').find(el=>el.dataset.agent==='atlas');
  assert.match(textOf(strip),/3 awaiting ack/);
});

// ---- The gateway --------------------------------------------------------------------------
const temp=async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-remote-dashboard-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:200}));
  return dir;
};
const gatewayWith=async(t,{call,...options}={})=>{
  const dataDir=await temp(t),calls=[];
  const gateway=await startGateway({dataDir,port:0,call:call??(async(room,fields)=>{calls.push([room,fields]);return {ok:true,echoed:fields};}),...options});
  t.after(()=>gateway.close());
  return {gateway,dataDir,calls};
};
test('the gateway marks what came through it, and a client cannot claim otherwise',async t=>{
  const {gateway,calls}=await gatewayWith(t);
  const token=gateway.store.issue({room:'/work/alpha',agentPrefix:'cloud-',runner:'claude'});
  await gateway.store.save();
  const headers={authorization:`Bearer ${token.value}`};
  const register=await fetch(`${gateway.url}/rpc`,{method:'POST',headers,body:JSON.stringify({op:'register',agentId:'cloud-1',runner:'claude'})});
  assert.equal(register.status,200);
  assert.deepEqual(calls.at(-1)[1].cloud,{runner:'claude',prefix:'cloud-'});
  const send=await fetch(`${gateway.url}/rpc`,{method:'POST',headers,body:JSON.stringify({op:'send',from:'cloud-1',to:'atlas',body:'hi'})});
  assert.equal(send.status,200);
  assert.deepEqual(calls.at(-1)[1].cloud,{runner:'claude',prefix:'cloud-'});
  // A client cannot claim to be local, and cannot pretend to be somebody else's runner.
  // The token is already bound to cloud-1, so a second identity is refused and does not rebind.
  const rebound=await fetch(`${gateway.url}/rpc`,{method:'POST',headers,body:JSON.stringify({op:'register',agentId:'cloud-2',runner:'claude',cloud:false})});
  assert.equal(rebound.status,403);
  assert.equal(gateway.store.find(token.value).agentId,'cloud-1');
  // Every operation carries the marker, including one that is not a register or a send.
  const status=await fetch(`${gateway.url}/rpc`,{method:'POST',headers,body:JSON.stringify({op:'status',agentId:'cloud-1',cloud:{runner:'local',prefix:''}})});
  assert.equal(status.status,200);
  assert.deepEqual(calls.at(-1)[1].cloud,{runner:'claude',prefix:'cloud-'});
  // A token may not post in the name of an identity outside its prefix.
  const forged=await fetch(`${gateway.url}/rpc`,{method:'POST',headers,body:JSON.stringify({op:'send',from:'atlas',to:'cloud-1',body:'hi'})});
  assert.equal(forged.status,403);
});
test('the gateway serves the pending pairing requests read-only',async t=>{
  const dataDir=await temp(t);
  let origin='http://127.0.0.1:1';
  const secret='dashboard-secret';
  const dashboard={handler:createDashboardHandler({project:'/w',secret,origin:()=>origin,assets:new Map(),
    getRooms:async()=>({rooms:[{project:'/w'}]}),getSnapshot:async()=>({})}),secret,pages:new Set(['/'])};
  const gateway=await startGateway({dataDir,port:0,dashboard,call:async()=>({ok:true})});
  t.after(()=>gateway.close());
  origin=gateway.url;
  const paired=await fetch(`${gateway.url}/pair`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repo:'github.com/org/repo',runner:'claude'})});
  assert.equal(paired.status,200);
  const request=await paired.json();
  const before=JSON.stringify(gateway.store.pendingPairings());
  const listed=await fetch(`${gateway.url}${PAIRINGS_PATH}`,{headers:{authorization:`Bearer ${secret}`}});
  assert.equal(listed.status,200);
  const body=await listed.json();
  assert.equal(body.available,true);
  assert.equal(body.pairings.length,1);
  assert.equal(body.pairings[0].code,request.code);
  assert.equal(body.pairings[0].runner,'claude');
  assert.equal(body.pairings[0].repo,'github.com/org/repo');
  // The dashboard secret is the only way in.
  assert.equal((await fetch(`${gateway.url}${PAIRINGS_PATH}`)).status,401);
  assert.equal((await fetch(`${gateway.url}${PAIRINGS_PATH}`,{headers:{authorization:'Bearer nope'}})).status,401);
  // Nothing can be approved or denied from here.
  const write=await fetch(`${gateway.url}${PAIRINGS_PATH}`,{method:'POST',headers:{authorization:`Bearer ${secret}`}});
  assert.equal(write.status,405);
  const after=JSON.stringify(gateway.store.pendingPairings());
  assert.equal(after,before,'the token store is not touched by reading');
  assert.equal(gateway.store.pendingPairings()[0].approvedAt,null);
  assert.equal(gateway.store.pendingPairings()[0].deniedAt,null);
});
test('the local dashboard answers the pairing route without a gateway and never fails',async()=>{
  let origin='http://127.0.0.1:1';
  const secret='dashboard-secret';
  const handler=createDashboardHandler({project:'/w',secret,origin:()=>origin,assets:new Map(),
    getRooms:async()=>({rooms:[{project:'/w'}]}),getSnapshot:async()=>({}),getPairings:async()=>({available:false})});
  const request=async(url,headers={})=>{
    const response={headers:{},status:0,body:'',setHeader(k,v){this.headers[k.toLowerCase()]=v;},writeHead(status,h={}){this.status=status;for(const [k,v] of Object.entries(h))this.setHeader(k,v);},end(body=''){this.body=body;}};
    await handler({url,method:'GET',headers:{host:'127.0.0.1:1',authorization:`Bearer ${secret}`,...headers}},response);
    return response;
  };
  const answer=await request(PAIRINGS_PATH);
  assert.equal(answer.status,200);
  assert.deepEqual(JSON.parse(answer.body),{available:false});
  assert.equal((await request(PAIRINGS_PATH,{authorization:''})).status,401);
});

test('the strips show the per-identity split the broker reports', async () => {
  // The broker reports the split under `pending.byAgent`; the dashboard has to read
  // that map, not only the older plain total.
  const snapshot = { pending: { counts: { live: 3, dormant: 2, retired: 1, expired: 4 },
      byAgent: { atlas: { live: 3, dormant: 2, retired: 1, expired: 4, total: 10 } } },
    pendingByAgent: { atlas: 10 } };
  const pending = M.pendingForAgent(snapshot, 'atlas');
  assert.equal(pending.split, true);
  assert.deepEqual({ live: pending.live, dormant: pending.dormant, retired: pending.retired, expired: pending.expired },
    { live: 3, dormant: 2, retired: 1, expired: 4 });
  // An identity the broker says nothing about still shows a number.
  const unknown = M.pendingForAgent(snapshot, 'nobody');
  assert.equal(unknown.split, false);
  assert.equal(unknown.total, 0);
});
