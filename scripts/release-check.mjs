import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'relay-release-'));
const npm=process.platform==='win32'?'npm.cmd':'npm',npmCli=process.env.npm_execpath;
const run=async(args,cwd=root)=>exec(npmCli?process.execPath:npm,npmCli?[npmCli,...args]:args,{cwd,env:{...process.env,npm_config_cache:path.join(tmp,'cache')},timeout:120000,maxBuffer:4*1024*1024});
try{
 const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
 const [packed]=JSON.parse((await run(['pack','--json','--ignore-scripts','--pack-destination',tmp])).stdout);
 for(const file of packed.files){
  assert.ok(/^(bin\/|lib\/|docs\/[^/]+\.md$|README\.md$|LICENSE$|package\.json$|npm-shrinkwrap\.json$)/.test(file.path),`Unexpected published file: ${file.path}`);
 }
 for(const required of ['bin/agent-relay.mjs','lib/setup.mjs','lib/dashboard.mjs','lib/observability.mjs','lib/dashboard/index.html','lib/dashboard/dashboard.css','lib/dashboard/dashboard.js','lib/dashboard/theme.js','npm-shrinkwrap.json'])assert.ok(packed.files.some(f=>f.path===required),`Missing ${required}`);
 // Validate the extracted artifact, rather than loading the source checkout.
 await exec('tar',['-xzf',path.join(tmp,packed.filename),'-C',tmp]);
 const cli=path.join(tmp,'package','bin','agent-relay.mjs');
 // Offline source dependencies suffice for CLI validation; installation via npx
 // is a separate registry/dependency-resolution check in the publishing guide.
 await fs.symlink(path.join(root,'node_modules'),path.join(tmp,'package','node_modules'),process.platform==='win32'?'junction':'dir');
 const version=await exec(process.execPath,[cli,'--version']);assert.equal(version.stdout.trim(),pkg.version);
 for(const script of ['dashboard.js','theme.js'])await exec(process.execPath,['--check',path.join(tmp,'package','lib','dashboard',script)]);
 const help=await exec(process.execPath,[cli,'--help']);assert.ok(help.stdout.includes('npx --yes @wearer-haitch/agent-relay launch'));
 console.log(`Verified ${packed.filename}: ${packed.files.length} files, ${(packed.size/1024).toFixed(1)} KiB, CLI help/version pass.`);
}finally{await fs.rm(tmp,{recursive:true,force:true});}
