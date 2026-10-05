import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import os from 'node:os';import {promises as fs} from 'node:fs';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),cli=fileURLToPath(new URL('../bin/agent-relay.mjs',import.meta.url));
test('real CLI starts one daemon under concurrent clients and configures/reuses an isolated project',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-cli-')),project=path.join(root,'project'),dataDir=path.join(root,'data');await fs.mkdir(project);
 t.after(async()=>{try{const {pid}=JSON.parse(await fs.readFile(path.join(dataDir,'broker.json'),'utf8'));process.kill(pid,'SIGTERM');for(let i=0;i<50;i++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,20));}catch{break;}}}catch{}await fs.rm(root,{recursive:true,force:true});});
 const run=async(...args)=>JSON.parse((await exec(process.execPath,[cli,...args,'--project',project,'--data-dir',dataDir],{timeout:20000})).stdout);
 const joined=await Promise.all([run('join','--as','a','--runner','codex'),run('join','--as','b','--runner','claude')]);assert.equal(joined.length,2);
 const discovery=JSON.parse(await fs.readFile(path.join(dataDir,'broker.json'),'utf8'));assert.ok(discovery.pid);
 const setup=await run('setup');assert.equal(setup.changed.length,6);assert.deepEqual((await run('setup')).changed,[]);
 const sent=await run('send','--as','a','--to','b','--id','cli-message','--message','Ping from one existing peer');assert.equal(sent.duplicate,false);
 assert.equal((await run('send','--as','a','--to','b','--id','cli-message','--message','Ping from one existing peer')).duplicate,true);
 assert.equal((await run('inbox','--as','b')).messages.length,1);await run('ack','--as','b','--id','cli-message');assert.equal((await run('inbox','--as','b')).messages.length,0);
 await run('claim','--as','a','build');await assert.rejects(run('claim','--as','b','build'),/already claimed|conflict|owned/i);await run('release','--as','a','build');await run('claim','--as','b','build');
 assert.equal(JSON.parse(await fs.readFile(path.join(dataDir,'broker.json'),'utf8')).pid,discovery.pid);
});
