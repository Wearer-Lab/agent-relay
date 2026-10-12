import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const exec=promisify(execFile),source=fileURLToPath(new URL('../../',import.meta.url));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-relay-packed-review-'));
let cli,dataDir,project,started=false;
const env={...process.env,npm_config_cache:path.join(root,'cache')};
const npm=async(args,cwd=source)=>exec('npm',args,{cwd,env,timeout:120000,maxBuffer:1024*1024});
const run=async args=>JSON.parse((await exec(process.execPath,[cli,...args,'--project',project,'--data-dir',dataDir],{env,timeout:20000})).stdout);
try{
 const [packed]=JSON.parse((await npm(['pack','--json','--ignore-scripts','--pack-destination',root])).stdout);
 await npm(['install','--prefix',path.join(root,'installed'),path.join(root,packed.filename),'--ignore-scripts','--no-audit','--no-fund']);
 const pkgRoot=path.join(root,'installed','node_modules','@wearer-haitch','agent-relay');
 cli=path.join(pkgRoot,'bin','agent-relay.mjs');dataDir=path.join(root,'data');project=path.join(root,'project');
 await fs.mkdir(project);await run(['setup']);started=true;
 assert.ok((await run(['setup','--check'])).bindings.every(binding=>binding.ok));
 await run(['join','--as','one']);await run(['join','--as','two']);
 const sent=await run(['send','--as','one','--to','two','--message','packed-runtime-notice']);
 assert.equal((await run(['inbox','--as','two'])).messages[0].messageId,sent.messageId);
 await run(['ack','--as','two','--id',sent.messageId]);
 assert.equal((await run(['receipt','--id',sent.messageId])).recipients[0].state,'acked');
 await run(['claim','--as','one','source.mjs']);await run(['release','--as','one']);
 const exportFile=path.join(root,'export.json');await run(['export','--out',exportFile]);
 assert.equal((await run(['restore','--in',exportFile,'--dry-run'])).valid,true);
 // Load MCP and its SDK from the fresh install, never from this checkout.
 const {createMcpAdapter}=await import(pathToFileURL(path.join(pkgRoot,'lib/mcp.mjs')).href);
 const sdkRoot=path.join(root,'installed','node_modules','@modelcontextprotocol','sdk','dist','esm');
 const {Client}=await import(pathToFileURL(path.join(sdkRoot,'client/index.js')).href);
 const {InMemoryTransport}=await import(pathToFileURL(path.join(sdkRoot,'inMemory.js')).href);
 const [a,b]=InMemoryTransport.createLinkedPair();
 const adapter=await createMcpAdapter({project,dataDir,runner:'generic',sessionId:'packed-sdk'});
 const client=new Client({name:'packed-smoke',version:'1'});
 try{
  await adapter.start(a);await client.connect(b);
  assert.ok((await client.listTools()).tools.some(tool=>tool.name==='relay_read_page'));
  const notice=await run(['send','--as','one','--to',adapter.agentId,'--message','fresh-SDK-read']);
  const received=JSON.parse((await client.callTool({name:'relay_inbox',arguments:{}})).content[0].text);
  assert.equal(received.messages[0].messageId,notice.messageId);
  await client.callTool({name:'relay_ack',arguments:{messageId:notice.messageId}});
 }finally{await adapter.close();await client.close();}
 await run(['stop']);started=false;
 const ledger=await fs.readFile(path.join(dataDir,'state.json'),'utf8');
 const filesBefore=await fs.readdir(dataDir);
 const dry=await run(['restore','--offline','--dry-run','--in',exportFile]);
 assert.equal(dry.dryRun,true);assert.equal(dry.valid,true);
 assert.equal(await fs.readFile(path.join(dataDir,'state.json'),'utf8'),ledger);
 assert.deepEqual(await fs.readdir(dataDir),filesBefore);
 const badFile=path.join(root,'unsupported.json');
 await fs.writeFile(badFile,JSON.stringify({schemaVersion:999,state:JSON.parse(ledger)}));
 await assert.rejects(run(['restore','--offline','--in',badFile]),/schema 999/);
 const fresh=path.join(root,'new','data');
 const restored=JSON.parse((await exec(process.execPath,[cli,'restore','--offline','--in',exportFile,'--project',project,'--data-dir',fresh],{env,timeout:20000})).stdout);
 assert.equal(restored.restored,true);

 const broken=[];
 for(const file of packed.files.filter(f=>f.path.endsWith('.md'))){
  const markdown=await fs.readFile(path.join(pkgRoot,file.path),'utf8');
  for(const match of markdown.matchAll(/\]\(([^)]+)\)/g)){
   const link=match[1].split('#')[0];if(!link||link.includes('://'))continue;
   try{await fs.access(path.resolve(path.dirname(path.join(pkgRoot,file.path)),link));}catch{broken.push({file:file.path,link});}
  }
 }
 console.log(JSON.stringify({artifact:packed.filename,files:packed.files.length,installedVersion:JSON.parse(await fs.readFile(path.join(pkgRoot,'package.json'),'utf8')).version,
  freshDependencyInstall:true,setupSendInboxAckReceiptClaimsExportDryRun:'pass',freshMcpSdk:'pass',offlineDryRunSchemaAndNewDirectory:'pass',brokenRelativeMarkdownLinks:broken}));
}finally{
 if(started)await run(['stop']);
 await fs.rm(root,{recursive:true,force:true});
}
