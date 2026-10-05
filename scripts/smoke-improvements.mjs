// Runs only this checkout's CLI, a temporary store, and ephemeral loopback ports.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {execFile,spawn} from 'node:child_process';import {promisify} from 'node:util';import assert from 'node:assert/strict';import {createBroker} from '../lib/broker.mjs';
const exec=promisify(execFile),cli=fileURLToPath(new URL('../bin/agent-relay.mjs',import.meta.url));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-smoke-')),dataDir=path.join(root,'data'),project=path.join(root,'one'),other=path.join(root,'two');let broker,watch;
try{
 await Promise.all([dataDir,project,other].map(p=>fs.mkdir(p)));
 const open=async()=>{broker=await createBroker({dataDir,port:0});await fs.writeFile(path.join(dataDir,'broker.json'),JSON.stringify({pid:process.pid,url:broker.url,token:broker.token}));};await open();
 const run=async(args,room=project)=>JSON.parse((await exec(process.execPath,[cli,...args,'--project',room,'--data-dir',dataDir],{timeout:20000,env:{...process.env,AGENT_RELAY_HOME:dataDir}})).stdout);
 await run(['join','--as','a']);await run(['join','--as','b']);await run(['join','--as','c'],other);
 const packet=path.join(root,'packet.txt');await fs.writeFile(packet,'durable smoke packet');
 await run(['send','--as','a','--to','b','--id','smoke','--message','long body','--summary','packet ready','--attach',packet]);await fs.unlink(packet);
 watch=spawn(process.execPath,[cli,'watch','--as','b','--json-lines','--unread','--max-chars','4','--project',project,'--data-dir',dataDir],{env:{...process.env,AGENT_RELAY_HOME:dataDir},stdio:['ignore','pipe','pipe']});
 let buffer='';const first=new Promise((resolve,reject)=>{watch.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n'))resolve(JSON.parse(buffer.split('\n')[0]));});watch.once('error',reject);});
 const row=await Promise.race([first,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('watch timed out')),10000);timer.unref();})]);assert.equal(row.id,'smoke');assert.equal(row.summary,'packet ready');assert.equal(row.truncated,true);
 await broker.close();await open();await run(['send','--as','a','--to','b','--id','after-restart','--message','restart body']);
 for(let i=0;i<100&&!buffer.includes('after-restart');i++)await new Promise(r=>setTimeout(r,50));assert.ok(buffer.includes('after-restart'));
 const stopped=new Promise(resolve=>watch.once('exit',(code,signal)=>resolve({code,signal})));watch.kill('SIGTERM');assert.deepEqual(await stopped,{code:0,signal:null});watch=null;
 const fetched=await run(['fetch','--as','b','--id','smoke','--out',path.join(root,'out')]);assert.equal(await fs.readFile(fetched.files[0].path,'utf8'),'durable smoke packet');
 await run(['ack','--as','b','--all']);assert.equal((await run(['inbox','--as','b','--unread'])).messages.length,0);
 await run(['claim','--as','a','--scope','machine','native']);const claims=(await run(['agents'],other)).claims;assert.equal(claims[0].agentId,'a');assert.equal(claims[0].project,await fs.realpath(project));
 console.log('Isolated two-identity CLI smoke passed, including watch restart and SIGTERM.');
 const gate=await exec(process.execPath,[cli,'gate','--data-dir',dataDir],{env:{...process.env,AGENT_RELAY_HOME:dataDir}}).catch(e=>{if(e.code===1&&e.stdout)return {stdout:e.stdout};throw e;});console.log(gate.stdout.trim());
}finally{watch?.kill('SIGTERM');await broker?.close();await fs.rm(root,{recursive:true,force:true});}
