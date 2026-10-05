import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFile,spawn} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),cli=fileURLToPath(new URL('../bin/agent-relay.mjs',import.meta.url));
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-cli-options-')),journal=path.join(root,'requests.jsonl'),preload=path.join(root,'transport.mjs');t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'broker.json'),JSON.stringify({pid:process.pid,url:'http://127.0.0.1:12345',token:'test-only'}));
 await fs.writeFile(preload,`import fs from 'node:fs/promises';
 globalThis.fetch=async(url,options)=>{
  if(url.endsWith('/health'))return {ok:true};const input=JSON.parse(options.body);
  await fs.appendFile(process.env.RELAY_TEST_JOURNAL,JSON.stringify(input)+'\\n');
  const result=input.op==='capabilities'?{ok:true,features:['test']}:input.op==='inbox'?{ok:true,messages:[{messageId:'watch-id',from:'a',createdAt:'today',body:'😀body',summary:'preview',cursor:1}]}:{ok:true};
  if(input.op==='wait')await new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true});});
  return {ok:true,json:async()=>result};
 };
 `);
 const args=['--import',preload,cli],env={...process.env,AGENT_RELAY_HOME:root,RELAY_TEST_JOURNAL:journal};
 return {root,journal,args,env,run:(...command)=>exec(process.execPath,[...args,...command,'--data-dir',root],{env,timeout:10000}),requests:async()=>{try{return (await fs.readFile(journal,'utf8')).trim().split('\n').map(line=>JSON.parse(line));}catch(e){if(e.code==='ENOENT')return [];throw e;}}};
}
test('CLI forwards feature command options',async t=>{
 const f=await fixture(t);
 await f.run('inbox','--as','b','--unread','--since','7','--from','a','--limit','2');
 await f.run('ack','--as','b','--through','8');await f.run('claim','--as','a','--scope','machine','native');await f.run('release','--as','human','--force','--scope','machine','native');
 const calls=(await f.requests()).filter(r=>r.op!=='capabilities');const inbox=calls.find(r=>r.op==='inbox');assert.equal(inbox.since,7);assert.equal(inbox.limit,2);assert.equal(inbox.unacked,true);assert.equal(calls.find(r=>r.op==='ack').through,8);
 assert.equal(calls.find(r=>r.op==='claim').scope,'machine');assert.equal(calls.find(r=>r.op==='release').force,true);assert.equal(calls.find(r=>r.op==='release').agentId,'human');
});

test('gated claim refuses before broker requests when measured disk limit fails',async t=>{
 const f=await fixture(t);await assert.rejects(f.run('claim','--as','a','--gate','--min-free-gb','1000000','native'),/Free disk/);assert.deepEqual(await f.requests(),[]);
});
test('CLI JSON watch flushes preview and exits zero on SIGINT and SIGTERM',async t=>{
 const f=await fixture(t);
 for(const signal of ['SIGINT','SIGTERM']){
  const child=spawn(process.execPath,[...f.args,'watch','--as','b','--json-lines','--unread','--max-chars','1','--data-dir',f.root],{env:f.env,stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
  let stdout='';const line=new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('\n'))resolve(JSON.parse(stdout.split('\n')[0]));});});
  const timer=AbortSignal.timeout(5000);const timed=new Promise((_,reject)=>timer.addEventListener('abort',()=>reject(Error('watch timeout')),{once:true}));
  const row=await Promise.race([line,timed]);assert.equal(row.id,'watch-id');assert.equal(row.body,'😀');assert.equal(row.truncated,true);
  const stopped=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));child.kill(signal);assert.deepEqual(await stopped,{code:0,signal:null});
 }
});
