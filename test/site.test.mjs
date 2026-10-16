import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const site=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','site');
const html=await readFile(path.join(site,'index.html'),'utf8');
const external=ref=>/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref);
// Local references from attributes and srcset lists; ignores absolute URLs, mailto and in-page anchors.
function localRefs(source,attrs){
 const refs=[];
 for(const match of source.matchAll(/\s(href|src|srcset|poster|data-src)\s*=\s*"([^"]*)"/gi)){
  if(!attrs.includes(match[1].toLowerCase()))continue;
  const values=match[1].toLowerCase()==='srcset'?match[2].split(',').map(part=>part.trim().split(/\s+/)[0]):[match[2]];
  for(const value of values)if(value&&!external(value)&&!value.startsWith('#'))refs.push(value);
 }
 return refs;
}
const exists=async ref=>{try{return (await stat(path.join(site,ref.split(/[?#]/)[0]))).isFile();}catch{return false;}};

test('landing page: every relative asset reference resolves inside site/ and stays portable under a subpath',async()=>{
 const refs=[...localRefs(html,['href','src','srcset','poster'])];
 const css=await readFile(path.join(site,'styles.css'),'utf8');
 for(const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi))if(!external(match[1])&&!match[1].startsWith('data:'))refs.push(match[1]);
 assert.ok(refs.filter(ref=>ref.startsWith('assets/dash-')).length>=12,'expected the page to reference its stylesheet, script, favicon and screenshots');
 for(const ref of refs){
  assert.ok(!ref.startsWith('/'),`root-relative path breaks under /agent-relay/: ${ref}`);
  assert.ok(!ref.includes('..'),`path escapes site/: ${ref}`);
  assert.ok(await exists(ref),`missing file for reference: ${ref}`);
 }
 for(const required of ['styles.css','app.js','favicon.svg','assets/og.png'])assert.ok(refs.includes(required)||html.includes(`/${required}`),`page should use ${required}`);
});

test('landing page: ids are unique and in-page anchors and aria-controls resolve',()=>{
 const ids=[...html.matchAll(/\sid="([^"]+)"/g)].map(match=>match[1]);
 assert.equal(new Set(ids).size,ids.length,`duplicate ids: ${ids.filter((id,index)=>ids.indexOf(id)!==index)}`);
 for(const match of html.matchAll(/\shref="#([^"]+)"/g))assert.ok(ids.includes(match[1]),`anchor #${match[1]} has no target`);
 for(const match of html.matchAll(/\s(?:aria-controls|aria-labelledby)="([^"]+)"/g))for(const id of match[1].split(/\s+/))assert.ok(ids.includes(id),`${id} referenced by ARIA but missing`);
});

test('landing page: no third-party scripts, no tracking, only Google Fonts as an external stylesheet, and required metadata',async()=>{
 for(const match of html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/gi))assert.ok(!external(match[1]),`external script: ${match[1]}`);
 for(const match of html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/gi))if(external(match[1]))assert.match(match[1],/^https:\/\/fonts\.googleapis\.com\//);
 assert.doesNotMatch(html,/google-analytics|googletagmanager|gtag\(|plausible|posthog|segment\.com|hotjar/i);
 assert.match(html,/<html lang="en"/);assert.match(html,/<meta name="viewport"/);assert.match(html,/<title>[^<]+<\/title>/);
 for(const property of ['og:title','og:description','og:image','og:url'])assert.match(html,new RegExp(`property="${property}"`));
 for(const name of ['twitter:card','description'])assert.match(html,new RegExp(`name="${name}"`));
 assert.match(html,/npx --yes @wearer-haitch\/agent-relay launch codex/);
 assert.equal(html.match(/<h1[\s>]/g).length,1);
 assert.equal((await readFile(path.join(site,'styles.css'),'utf8')).includes('prefers-reduced-motion'),true);
});

test('landing page: assets stay small (under 3 MB) and screenshots exist for both themes',async()=>{
 const dir=path.join(site,'assets');let total=0;
 for(const name of await readdir(dir))total+=(await stat(path.join(dir,name))).size;
 assert.ok(total<3*1024*1024,`assets are ${total} bytes`);
 for(const view of ['tower','plan','runways','strips','radio','claims'])for(const theme of ['dark','light'])assert.ok(await exists(`assets/dash-${view}-${theme}.webp`),`missing ${view} ${theme} screenshot`);
});
