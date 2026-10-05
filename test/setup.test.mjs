import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setupProject} from '../lib/setup.mjs';
import {parse} from 'jsonc-parser';

test('setup preserves instructions, JSONC, permissions and is idempotent',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-setup-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
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
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-conflict-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const original='{"mcpServers":{"agent-relay":{"command":"my-other-server"}}}';await fs.writeFile(path.join(dir,'.mcp.json'),original);
 await assert.rejects(setupProject(dir,{runners:['claude']}),/Existing/);assert.equal(await fs.readFile(path.join(dir,'.mcp.json'),'utf8'),original);await assert.rejects(fs.stat(path.join(dir,'AGENTS.md')),{code:'ENOENT'});
});
test('equivalent quoted and inline Codex relay entries are preserved before any project writes',async t=>{
 for(const original of ['[mcp_servers."agent-relay"]\ncommand = "existing"\n',"[mcp_servers.'agent-relay']\ncommand = 'existing'\n",'[mcp_servers]\nagent-relay = {command = "existing"}\n']){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-toml-conflict-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(path.join(dir,'.codex'));await fs.writeFile(path.join(dir,'.codex/config.toml'),original);
  await assert.rejects(setupProject(dir,{runners:['codex']}),/preserved/);assert.equal(await fs.readFile(path.join(dir,'.codex/config.toml'),'utf8'),original);await assert.rejects(fs.stat(path.join(dir,'AGENTS.md')),{code:'ENOENT'});
 }
});
