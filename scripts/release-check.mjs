import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
const PUBLIC_DOCS=['docs/branches.md','docs/broker-notes.md','docs/ci-workflow.md','docs/claude-channel.md','docs/dashboard.md','docs/opencode.md','docs/process-ownership.md','docs/publishing.md','docs/registry.md','docs/validation.md','docs/work-items.md'];
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'relay-release-'));
const npm=process.platform==='win32'?'npm.cmd':'npm',npmCli=process.env.npm_execpath;
const run=async(args,cwd=root)=>exec(npmCli?process.execPath:npm,npmCli?[npmCli,...args]:args,{cwd,env:{...process.env,npm_config_cache:path.join(tmp,'cache')},timeout:120000,maxBuffer:4*1024*1024});
try{
 const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
 const shrinkwrap=JSON.parse(await fs.readFile(path.join(root,'npm-shrinkwrap.json'),'utf8'));
 const lock=JSON.parse(await fs.readFile(path.join(root,'package-lock.json'),'utf8'));
 assert.deepEqual(lock,shrinkwrap,'Development and published dependency locks must agree');
 assert.equal(shrinkwrap.version,pkg.version);
 assert.equal(shrinkwrap.packages[''].version,pkg.version,'Lockfile root package version must match package.json');
 assert.equal(pkg.publishConfig?.provenance,true,'publishConfig.provenance must be true');
 assert.equal(pkg.homepage,'https://wearer-lab.github.io/agent-relay/');
 assert.equal(pkg.repository?.url,'git+https://github.com/Wearer-Lab/agent-relay.git');
 const changelog=await fs.readFile(path.join(root,'CHANGELOG.md'),'utf8');
 assert.ok(changelog.split(/\r?\n/).some(l=>l.startsWith(`## [${pkg.version}] - `)),`CHANGELOG.md needs a dated "## [${pkg.version}] - YYYY-MM-DD" section`);
 const lf=async f=>(await fs.readFile(path.join(root,f),'utf8')).replace(/\r\n/g,'\n'),ci=await lf('.github/workflows/ci.yml');
 assert.equal(await lf('docs/ci-workflow.yml'),ci,'docs/ci-workflow.yml must match .github/workflows/ci.yml');
 assert.ok((await lf('docs/ci-workflow.md')).includes(ci.trimEnd()),'docs/ci-workflow.md must embed .github/workflows/ci.yml');
 // The release workflow runs on tags; a tag build must match the package version.
 if(process.env.GITHUB_REF_TYPE==='tag')assert.equal(process.env.GITHUB_REF_NAME,`v${pkg.version}`,'Tag must match package.json version');
 assert.deepEqual(shrinkwrap.packages[''].dependencies,pkg.dependencies);
 const [packed]=JSON.parse((await run(['pack','--json','--ignore-scripts','--pack-destination',tmp])).stdout);
  for(const file of packed.files){
   assert.ok(/^(bin\/|lib\/|docs\/[^/]+\.md$|README\.md$|CHANGELOG\.md$|LICENSE$|package\.json$|npm-shrinkwrap\.json$)/.test(file.path),`Unexpected published file: ${file.path}`);
  }
  for(const file of packed.files.filter(f=>/^docs\/[^/]+\.md$/.test(f.path)))assert.ok(PUBLIC_DOCS.includes(file.path),`Unexpected published doc: ${file.path}`);
  for(const doc of PUBLIC_DOCS)assert.ok(packed.files.some(f=>f.path===doc),`Missing public doc ${doc}`);
 for(const required of ['bin/agent-relay.mjs','lib/setup.mjs','lib/tool-pages.mjs','lib/dashboard.mjs','lib/observability.mjs','lib/dashboard/index.html','lib/dashboard/dashboard.css','lib/dashboard/dashboard.js','lib/dashboard/theme.js','lib/dashboard/model.js','lib/registry.mjs','lib/ownership.mjs','lib/workitems.mjs','CHANGELOG.md','npm-shrinkwrap.json'])assert.ok(packed.files.some(f=>f.path===required),`Missing ${required}`);
 // Validate the extracted artifact, rather than loading the source checkout.
 await exec('tar',['-xzf',path.join(tmp,packed.filename),'-C',tmp]);
 const cli=path.join(tmp,'package','bin','agent-relay.mjs');
 // Offline source dependencies suffice for CLI validation; installation via npx
 // is a separate registry/dependency-resolution check in the publishing guide.
 await fs.symlink(path.join(root,'node_modules'),path.join(tmp,'package','node_modules'),process.platform==='win32'?'junction':'dir');
 const version=await exec(process.execPath,[cli,'--version']);assert.equal(version.stdout.trim(),pkg.version);
 for(const script of ['dashboard.js','theme.js','model.js'])await exec(process.execPath,['--check',path.join(tmp,'package','lib','dashboard',script)]);
 const help=await exec(process.execPath,[cli,'--help']);assert.ok(help.stdout.includes('npx --yes @wearer-haitch/agent-relay launch'));
 console.log(`Verified ${packed.filename}: ${packed.files.length} files, ${(packed.size/1024).toFixed(1)} KiB, CLI help/version pass.`);
}finally{await fs.rm(tmp,{recursive:true,force:true});}
