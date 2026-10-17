import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setupProject} from '../lib/setup.mjs';
import {parse} from 'jsonc-parser';

test('setup preserves instructions, JSONC, permissions and is idempotent',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-setup-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:200}));
 await fs.writeFile(path.join(dir,'AGENTS.md'),'# Our rules\nNever overwrite our policy.\n');
 await fs.writeFile(path.join(dir,'.mcp.json'),'{\n// existing provider\n"mcpServers":{"existing":{"command":"other"}},"policy":"ask"\n}\n');
 await fs.mkdir(path.join(dir,'.codex'));await fs.writeFile(path.join(dir,'.codex/config.toml'),'approval_policy = "on-request"\n[features]\nexample = true\n');
 const first=await setupProject(dir);assert.equal(first.changed.length,6);
 const mcp=await fs.readFile(path.join(dir,'.mcp.json'),'utf8');assert.ok(mcp.includes('// existing provider'));assert.equal(parse(mcp).mcpServers.existing.command,'other');assert.equal(parse(mcp).policy,'ask');
 const codex=await fs.readFile(path.join(dir,'.codex/config.toml'),'utf8');assert.ok(codex.startsWith('approval_policy = "on-request"'));
 const agents=await fs.readFile(path.join(dir,'AGENTS.md'),'utf8');assert.ok(agents.startsWith('# Our rules\nNever overwrite our policy.'));assert.equal(agents.split('agent-relay:begin').length,2);
 assert.deepEqual((await setupProject(dir)).changed,[]);
});
test('conflicting runner configuration is preserved',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-conflict-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:200}));
 const original='{"mcpServers":{"agent-relay":{"command":"my-other-server"}}}';await fs.writeFile(path.join(dir,'.mcp.json'),original);
 await assert.rejects(setupProject(dir,{runners:['claude']}),/Existing/);assert.equal(await fs.readFile(path.join(dir,'.mcp.json'),'utf8'),original);await assert.rejects(fs.stat(path.join(dir,'AGENTS.md')),{code:'ENOENT'});
});
test('equivalent quoted and inline Codex relay entries are preserved before any project writes',async t=>{
 for(const original of ['[mcp_servers."agent-relay"]\ncommand = "existing"\n',"[mcp_servers.'agent-relay']\ncommand = 'existing'\n",'[mcp_servers]\nagent-relay = {command = "existing"}\n']){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-toml-conflict-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:200}));await fs.mkdir(path.join(dir,'.codex'));await fs.writeFile(path.join(dir,'.codex/config.toml'),original);
  await assert.rejects(setupProject(dir,{runners:['codex']}),/preserved/);assert.equal(await fs.readFile(path.join(dir,'.codex/config.toml'),'utf8'),original);await assert.rejects(fs.stat(path.join(dir,'AGENTS.md')),{code:'ENOENT'});
 }
});
test('diagnose reports binding health and detects a moved installation',async t=>{
 const {diagnoseSetup,refreshSetup}=await import('../lib/setup.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-diagnose-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:200}));
 const empty=await diagnoseSetup(dir);
 assert.equal(empty.packageRoot.moved,false);
 assert.ok(empty.bindings.every(b=>b.ok===false));
 assert.equal(empty.ownerLoaded,'unknown');
 await setupProject(dir);
 const healthy=await diagnoseSetup(dir);
 assert.equal(healthy.packageRoot.moved,false);
 assert.ok(healthy.bindings.length>=3&&healthy.bindings.every(b=>b.ok===true));
 const relocated=await diagnoseSetup(dir,{packageRoot:'/elsewhere/pkg'});
 assert.equal(relocated.packageRoot.moved,true);
 assert.ok(relocated.bindings.every(b=>b.ok===true), 'a comparison-only override leaves files intact');
 const mcpPath=path.join(dir,'.mcp.json');
 await fs.writeFile(mcpPath,(await fs.readFile(mcpPath,'utf8')).replace(JSON.stringify(process.execPath).slice(1,-1),'/elsewhere/node'));
 const stale=await diagnoseSetup(dir);
 const claude=stale.bindings.find(b=>b.runner==='claude');
 assert.equal(claude.ok,false);assert.match(claude.detail,/not found/);
 const refreshed=await refreshSetup(dir);
 assert.deepEqual(refreshed.changed,['.mcp.json'], 'refresh repairs the stale binding');
 assert.equal(refreshed.diagnosis.packageRoot.moved,false);
 assert.ok(refreshed.diagnosis.bindings.every(b=>b.ok===true));
 assert.deepEqual((await refreshSetup(dir)).changed,[]);
});
test('diagnose selects exact relay table despite neighboring servers',async t=>{
 const {diagnoseSetup}=await import('../lib/setup.mjs');
 const valid=process.execPath;
 async function binding(toml){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-exact-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:200}));
  await fs.mkdir(path.join(dir,'.codex'),{recursive:true});
  await fs.writeFile(path.join(dir,'.codex/config.toml'),toml);
  return (await diagnoseSetup(dir)).bindings.find(b=>b.runner==='codex');
 }
 const relayOnly=`[mcp_servers.agent-relay]\ncommand = ${JSON.stringify(valid)}\nargs = [${JSON.stringify(valid)}]\n`;
 const otherInvalid=`[mcp_servers.other]\ncommand = "/definitely/missing/other"\nargs = ["/missing/other"]\n`;
 assert.equal((await binding(otherInvalid+relayOnly)).ok,true);
 assert.equal((await binding(relayOnly+otherInvalid)).ok,true);
 const relayInvalid=`[mcp_servers.agent-relay]\ncommand = "/definitely/missing/relay"\nargs = ["/missing/relay"]\n`;
 const otherValid=`[mcp_servers.other]\ncommand = ${JSON.stringify(valid)}\nargs = [${JSON.stringify(valid)}]\n`;
 const blamedFirst=await binding(otherValid+relayInvalid);
 assert.equal(blamedFirst.ok,false);
 assert.match(blamedFirst.detail,/missing\/relay/);
 const blamedLater=await binding(relayInvalid+otherValid);
 assert.equal(blamedLater.ok,false);
 assert.match(blamedLater.detail,/missing\/relay/);
});
test('diagnose handles quoted tables inline config and multiline args',async t=>{
 const {diagnoseSetup}=await import('../lib/setup.mjs');
 const valid=process.execPath;
 async function binding(toml){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-forms-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:200}));
  await fs.mkdir(path.join(dir,'.codex'),{recursive:true});
  await fs.writeFile(path.join(dir,'.codex/config.toml'),toml);
  return (await diagnoseSetup(dir)).bindings.find(b=>b.runner==='codex');
 }
 for(const header of ['[mcp_servers.agent-relay]','[mcp_servers."agent-relay"]',"[mcp_servers.'agent-relay']"]){
  const toml=`${header}\ncommand = ${JSON.stringify(valid)}\nargs = [${JSON.stringify(valid)}]\n`;
  assert.equal((await binding(toml)).ok,true,header);
 }
 const inline=`[mcp_servers]\nagent-relay = {command = ${JSON.stringify(valid)}, args = [${JSON.stringify(valid)}]}\n`;
 assert.equal((await binding(inline)).ok,true);
 const inlineOther=`[mcp_servers]\nother = {command = "/definitely/missing/other", args = ["/missing/other"]}\nagent-relay = {command = ${JSON.stringify(valid)}, args = [${JSON.stringify(valid)}]}\n`;
 assert.equal((await binding(inlineOther)).ok,true);
 const inlineBlamed=`[mcp_servers]\nother = {command = ${JSON.stringify(valid)}, args = [${JSON.stringify(valid)}]}\nagent-relay = {command = "/definitely/missing/relay", args = ["/missing/relay"]}\n`;
 const badInline=await binding(inlineBlamed);
 assert.equal(badInline.ok,false);
 assert.match(badInline.detail,/missing\/relay/);
 const multiline=`[mcp_servers.other]\ncommand = "/definitely/missing/other"\nargs = ["/missing/other"]\n[mcp_servers.agent-relay]\ncommand = ${JSON.stringify(valid)}\nargs = [\n ${JSON.stringify(valid)},\n "--extra"\n]\n`;
 assert.equal((await binding(multiline)).ok,true);
 const multilineLater=`[mcp_servers.agent-relay]\ncommand = ${JSON.stringify(valid)}\nargs = [\n ${JSON.stringify(valid)},\n "--extra"\n]\n[mcp_servers.other]\ncommand = "/definitely/missing/other"\nargs = ["/missing/other"]\n`;
 assert.equal((await binding(multilineLater)).ok,true);
});
test('diagnose decodes TOML escapes in relay table',async t=>{
 const {diagnoseSetup}=await import('../lib/setup.mjs');
 const valid=process.execPath;
 async function binding(toml){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-escapes-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:200}));
  await fs.mkdir(path.join(dir,'.codex'),{recursive:true});
  await fs.writeFile(path.join(dir,'.codex/config.toml'),toml);
  return (await diagnoseSetup(dir)).bindings.find(b=>b.runner==='codex');
 }
 const winPath='C:\\Tools\\cli';
 const escaped=`[mcp_servers.agent-relay]\ncommand = ${JSON.stringify(winPath)}\nargs = [${JSON.stringify(valid)}]\n`;
 const decoded=await binding(escaped);
 assert.equal(decoded.ok,false);
 assert.equal(decoded.detail,'command not found: '+winPath);
 const quotePath='a"b';
 const quoted=`[mcp_servers.agent-relay]\ncommand = ${JSON.stringify(quotePath)}\nargs = [${JSON.stringify(valid)}]\n`;
 const quoteResult=await binding(quoted);
 assert.equal(quoteResult.ok,false);
 assert.equal(quoteResult.detail,'command not found: '+quotePath);
 const uni=`[mcp_servers.agent-relay]\ncommand = "\\u0041"\nargs = [${JSON.stringify(valid)}]\n`;
 const uniResult=await binding(uni);
 assert.equal(uniResult.ok,false);
 assert.equal(uniResult.detail,'command not found: A');
 const tab=`[mcp_servers.agent-relay]\ncommand = "a\\tb"\nargs = [${JSON.stringify(valid)}]\n`;
 const tabResult=await binding(tab);
 assert.equal(tabResult.ok,false);
 assert.equal(tabResult.detail,'command not found: a\tb');
 const newline=`[mcp_servers.agent-relay]\ncommand = "a\\nb"\nargs = [${JSON.stringify(valid)}]\n`;
 const newlineResult=await binding(newline);
 assert.equal(newlineResult.ok,false);
 assert.equal(newlineResult.detail,'command not found: a\nb');
});
test('diagnose fails closed on inline key order with missing side',async t=>{
 const {diagnoseSetup}=await import('../lib/setup.mjs');
 const valid=process.execPath;
 async function binding(toml){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-inline-missing-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:200}));
  await fs.mkdir(path.join(dir,'.codex'),{recursive:true});
  await fs.writeFile(path.join(dir,'.codex/config.toml'),toml);
  return (await diagnoseSetup(dir)).bindings.find(b=>b.runner==='codex');
 }
 const firstMissingCli=`[mcp_servers]\nagent-relay = { command = ${JSON.stringify(valid)}, args = ["/missing/relay-cli"] }\n`;
 const r1=await binding(firstMissingCli);
 assert.equal(r1.ok,false);
 assert.match(r1.detail,/CLI path not found/);
 assert.match(r1.detail,/missing\/relay-cli/);
 const reversedMissingCmd=`[mcp_servers]\nagent-relay = { args = [${JSON.stringify(valid)}], command = "/missing/relay-node" }\n`;
 const r2=await binding(reversedMissingCmd);
 assert.equal(r2.ok,false);
 assert.match(r2.detail,/command not found/);
 assert.match(r2.detail,/missing\/relay-node/);
 const firstValid=`[mcp_servers]\nagent-relay = { command = ${JSON.stringify(valid)}, args = [${JSON.stringify(valid)}] }\n`;
 assert.equal((await binding(firstValid)).ok,true);
 const reversedValid=`[mcp_servers]\nagent-relay = { args = [${JSON.stringify(valid)}], command = ${JSON.stringify(valid)} }\n`;
 assert.equal((await binding(reversedValid)).ok,true);
 const missingArgs=`[mcp_servers]\nagent-relay = { command = ${JSON.stringify(valid)} }\n`;
 const r5=await binding(missingArgs);
 assert.equal(r5.ok,false);
 assert.match(r5.detail,/CLI path/);
 const missingCmd=`[mcp_servers]\nagent-relay = { args = [${JSON.stringify(valid)}] }\n`;
 const r6=await binding(missingCmd);
 assert.equal(r6.ok,false);
 assert.match(r6.detail,/command/);
 const emptyArgs=`[mcp_servers]\nagent-relay = { command = ${JSON.stringify(valid)}, args = [] }\n`;
 const r7=await binding(emptyArgs);
 assert.equal(r7.ok,false);
 assert.match(r7.detail,/CLI path/);
});
test('diagnose handles inline nesting comments quoting multiline escapes and neighbors',async t=>{
 const {diagnoseSetup}=await import('../lib/setup.mjs');
 const valid=process.execPath;
 async function binding(toml){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-inline-forms-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:15,retryDelay:200}));
  await fs.mkdir(path.join(dir,'.codex'),{recursive:true});
  await fs.writeFile(path.join(dir,'.codex/config.toml'),toml);
  return (await diagnoseSetup(dir)).bindings.find(b=>b.runner==='codex');
 }
 const nested=`[mcp_servers]\nagent-relay = { command = ${JSON.stringify(valid)}, options = { command = "/missing/inner", depth = 1 }, args = [${JSON.stringify(valid)}] }\n`;
 assert.equal((await binding(nested)).ok,true);
 const nestedOuterBad=`[mcp_servers]\nagent-relay = { command = "/missing/outer", options = { command = ${JSON.stringify(valid)} }, args = [${JSON.stringify(valid)}] }\n`;
 const nestedBad=await binding(nestedOuterBad);
 assert.equal(nestedBad.ok,false);
 assert.match(nestedBad.detail,/missing\/outer/);
 const nestedArgsInner=`[mcp_servers]\nagent-relay = { args = [${JSON.stringify(valid)}], options = { args = ["/missing/inner"] }, command = ${JSON.stringify(valid)} }\n`;
 assert.equal((await binding(nestedArgsInner)).ok,true);
 const commented=`[mcp_servers]\nagent-relay = { command = ${JSON.stringify(valid)}, # args = ["/missing/fake"]\n args = [${JSON.stringify(valid)}] } # command = "/missing/trailing"\n`;
 assert.equal((await binding(commented)).ok,true);
 const hashValue=`[mcp_servers]\nagent-relay = { command = "/missing/has#hash", args = [${JSON.stringify(valid)}] }\n`;
 const hashResult=await binding(hashValue);
 assert.equal(hashResult.ok,false);
 assert.equal(hashResult.detail,'command not found: /missing/has#hash');
 const braceComment=`[mcp_servers]\nagent-relay = { command = ${JSON.stringify(valid)}, # comment with } brace\n args = [${JSON.stringify(valid)}] }\n`;
 assert.equal((await binding(braceComment)).ok,true);
 const singleValid=`[mcp_servers]\nagent-relay = { command = '${valid}', args = ['${valid}'] }\n`;
 assert.equal((await binding(singleValid)).ok,true);
 const singleMissing=`[mcp_servers]\nagent-relay = { command = '${valid}', args = ['/missing/cli'] }\n`;
 const singleBad=await binding(singleMissing);
 assert.equal(singleBad.ok,false);
 assert.match(singleBad.detail,/CLI path not found/);
 const singleReversedBad=`[mcp_servers]\nagent-relay = { args = ['${valid}'], command = '/missing/node' }\n`;
 const singleRevBad=await binding(singleReversedBad);
 assert.equal(singleRevBad.ok,false);
 assert.match(singleRevBad.detail,/command not found/);
 const multiFirst=`[mcp_servers]\nagent-relay = { command = ${JSON.stringify(valid)}, args = [\n ${JSON.stringify(valid)},\n "--extra"\n ] }\n`;
 assert.equal((await binding(multiFirst)).ok,true);
 const multiReversed=`[mcp_servers]\nagent-relay = { args = [\n ${JSON.stringify(valid)},\n "--extra"\n ], command = ${JSON.stringify(valid)} }\n`;
 assert.equal((await binding(multiReversed)).ok,true);
 const multiMissing=`[mcp_servers]\nagent-relay = { command = ${JSON.stringify(valid)}, args = [\n "/missing/relay-cli",\n "--extra"\n ] }\n`;
 const multiBad=await binding(multiMissing);
 assert.equal(multiBad.ok,false);
 assert.match(multiBad.detail,/missing\/relay-cli/);
 const winPath='C:\\Tools\\cli';
 const winInline=`[mcp_servers]\nagent-relay = { command = ${JSON.stringify(winPath)}, args = [${JSON.stringify(valid)}] }\n`;
 const winResult=await binding(winInline);
 assert.equal(winResult.ok,false);
 assert.equal(winResult.detail,'command not found: '+winPath);
 const winArgsInline=`[mcp_servers]\nagent-relay = { args = [${JSON.stringify(winPath)}], command = ${JSON.stringify(valid)} }\n`;
 const winArgsResult=await binding(winArgsInline);
 assert.equal(winArgsResult.ok,false);
 assert.match(winArgsResult.detail,/CLI path not found/);
 assert.match(winArgsResult.detail,/C:\\Tools\\cli/);
 const otherValid=`other = { command = ${JSON.stringify(valid)}, args = [${JSON.stringify(valid)}] }\n`;
 const relayRevValid=`agent-relay = { args = [${JSON.stringify(valid)}], command = ${JSON.stringify(valid)} }\n`;
 assert.equal((await binding(`[mcp_servers]\n${otherValid}${relayRevValid}`)).ok,true);
 assert.equal((await binding(`[mcp_servers]\n${relayRevValid}${otherValid}`)).ok,true);
 const relayRevBad=`agent-relay = { args = ["/missing/relay"], command = "/definitely/missing/relay" }\n`;
 const blamedFirst=await binding(`[mcp_servers]\n${otherValid}${relayRevBad}`);
 assert.equal(blamedFirst.ok,false);
 assert.match(blamedFirst.detail,/missing\/relay/);
 const blamedLater=await binding(`[mcp_servers]\n${relayRevBad}${otherValid}`);
 assert.equal(blamedLater.ok,false);
 assert.match(blamedLater.detail,/missing\/relay/);
});
