import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const site=path.join(root,'site');
const PAGES=['index.html','product/index.html','dashboard/index.html','architecture/index.html','security/index.html','start/index.html'];
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
// A reference resolves when it is a file, or a directory that carries an index.html.
const exists=async (base,ref)=>{
 const target=path.join(base,ref.split(/[?#]/)[0]);
 try{const info=await stat(target);if(info.isFile())return true;if(info.isDirectory())return (await stat(path.join(target,'index.html'))).isFile();}catch{}
 return false;
};
const pick=(source,re)=>source.match(re)?.[1]?.trim()??null;
const inside=(base,ref)=>{const target=path.resolve(base,ref.split(/[?#]/)[0]);return target===site||target.startsWith(site+path.sep);};

test('every page: relative asset references resolve inside site/ and stay portable under a subpath',async()=>{
 const css=await readFile(path.join(site,'styles.css'),'utf8');
 const cssRefs=[...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map(match=>match[1]).filter(ref=>!external(ref)&&!ref.startsWith('data:'));
 assert.ok(cssRefs.length>=2,'the stylesheet should reference its self-hosted fonts');
 for(const ref of cssRefs){assert.ok(!ref.startsWith('/'),`root-relative path breaks under /agent-relay/: ${ref}`);assert.ok(inside(site,ref),`path escapes site/: ${ref}`);assert.ok(await exists(site,ref),`missing file for reference: ${ref}`);}
 let screens=0;
 for(const page of PAGES){
  const source=await readFile(path.join(site,page),'utf8');
  const base=path.dirname(path.join(site,page));
  for(const ref of localRefs(source,['href','src','srcset','poster'])){
   assert.ok(!ref.startsWith('/'),`root-relative path breaks under /agent-relay/: ${page} → ${ref}`);
   assert.ok(inside(base,ref),`path escapes site/: ${page} → ${ref}`);
   assert.ok(await exists(base,ref),`missing file for reference: ${page} → ${ref}`);
   if(ref.includes('assets/dash-'))screens++;
  }
 }
 assert.ok(screens>=6,'the pages should show the dashboard screenshots');
 assert.ok(await exists(site,'styles.css')&&await exists(site,'app.js')&&await exists(site,'favicon.svg')&&await exists(site,'assets/og.png'));
 assert.ok(await exists(site,'assets/logo.svg'),'the site needs the Agent Relay mark');
 for(const font of ['assets/fonts/BubbledotICG-FinePos.woff2','assets/fonts/GeistPixel-Circle.woff2','assets/fonts/Inter-latin.woff2'])assert.ok(await exists(site,font),`missing self-hosted font: ${font}`);
});

test('every page: ids are unique and in-page anchors and aria-controls resolve',async()=>{
 for(const page of PAGES){
  const source=await readFile(path.join(site,page),'utf8');
  const ids=[...source.matchAll(/\sid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length,`${page} has duplicate ids: ${ids.filter((id,index)=>ids.indexOf(id)!==index)}`);
  for(const match of source.matchAll(/\shref="#([^"]+)"/g))assert.ok(ids.includes(match[1]),`${page}: anchor #${match[1]} has no target`);
  for(const match of source.matchAll(/\s(?:aria-controls|aria-labelledby)="([^"]+)"/g))for(const id of match[1].split(/\s+/))assert.ok(ids.includes(id),`${page}: ${id} referenced by ARIA but missing`);
 }
});

test('every page: no third-party scripts, no tracking, required metadata and one heading',async()=>{
 for(const page of PAGES){
  const source=await readFile(path.join(site,page),'utf8');
  for(const match of source.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/gi))assert.ok(!external(match[1]),`${page}: external script: ${match[1]}`);
  for(const match of source.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/gi))if(external(match[1]))assert.match(match[1],/^https:\/\/fonts\.googleapis\.com\//);
  assert.doesNotMatch(source,/google-analytics|googletagmanager|gtag\(|plausible|posthog|segment\.com|hotjar/i,`${page}: tracker found`);
  assert.match(source,/<html lang="en"/);assert.match(source,/<meta name="viewport"/);assert.match(source,/<title>[^<]+<\/title>/);
  assert.equal((source.match(/<h1[\s>]/g)||[]).length,1,`${page} needs exactly one h1`);
  for(const property of ['og:title','og:description','og:image','og:url'])assert.match(source,new RegExp(`property="${property}"`));
  for(const name of ['twitter:card','description'])assert.match(source,new RegExp(`name="${name}"`));
 }
 const start=await readFile(path.join(site,'start/index.html'),'utf8');
 assert.match(start,/npx --yes @wearer-haitch\/agent-relay launch codex/);
 assert.equal((await readFile(path.join(site,'styles.css'),'utf8')).includes('prefers-reduced-motion'),true);
});

const VARIANTS=['variants/index.html','variants/a/index.html','variants/b/index.html','variants/c/index.html'];
// The site's origin lives in package.json; scripts/set-site-origin.mjs moves it.
const origin=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).homepage.replace(/\/+$/,'');
test('the landing page variants are self-contained drafts with valid references',async()=>{
 for(const page of VARIANTS){
  const source=await readFile(path.join(site,page),'utf8');
  const base=path.dirname(path.join(site,page));
  const ids=[...source.matchAll(/\sid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length,`${page} has duplicate ids`);
  for(const match of source.matchAll(/\shref="#([^"]+)"/g))assert.ok(ids.includes(match[1]),`${page}: anchor #${match[1]} has no target`);
  for(const match of source.matchAll(/\s(?:aria-controls|aria-labelledby)="([^"]+)"/g))for(const id of match[1].split(/\s+/))assert.ok(ids.includes(id),`${page}: ${id} referenced by ARIA but missing`);
  for(const ref of localRefs(source,['href','src','srcset','poster'])){
   assert.ok(!ref.startsWith('/'),`${page}: root-relative path: ${ref}`);
   assert.ok(inside(base,ref),`${page}: path escapes site/: ${ref}`);
   assert.ok(await exists(base,ref),`${page}: missing file for reference: ${ref}`);
  }
  assert.equal((source.match(/<h1[\s>]/g)||[]).length,1,`${page} needs exactly one h1`);
  assert.match(source,/<meta name="robots" content="noindex, follow">/,`${page} should stay out of search results`);
  for(const match of source.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/gi))assert.ok(!external(match[1]),`${page}: external script: ${match[1]}`);
 }
});

test('the navigation is the same on every page and marks the current page',async()=>{
 const links=['product/','dashboard/','architecture/','security/','start/'];
 for(const page of PAGES){
  const source=await readFile(path.join(site,page),'utf8');
  for(const link of links)assert.ok(source.includes(`href="${link}"`)||source.includes(`href="../${link}"`),`${page} is missing the ${link} link`);
  assert.ok(source.includes('assets/logo.svg'),`${page} is missing the mark`);
  assert.ok(source.includes('app.js'),`${page} is missing the script`);
 }
 const home=await readFile(path.join(site,'index.html'),'utf8');
 assert.ok(!home.includes('aria-current="page"'),'the home page marks no section as current');
 assert.match(await readFile(path.join(site,'product/index.html'),'utf8'),/aria-current="page"/);
});

test('every page carries the metadata a crawler and a link preview need',async()=>{
 const pages=[...PAGES,...VARIANTS];
 for(const page of pages){
  const source=await readFile(path.join(site,page),'utf8');
  const title=pick(source,/<title>([^<]*)<\/title>/i);
  const description=pick(source,/<meta name="description" content="([^"]*)"/i);
  assert.ok(title,`${page}: no title`);
  assert.ok(title.length<=60,`${page}: title is ${title.length} characters, over 60`);
  assert.ok(description,`${page}: no description`);
  assert.ok(description.length<=160,`${page}: description is ${description.length} characters, over 160`);
  const canonical=pick(source,/<link rel="canonical" href="([^"]*)"/i);
  assert.ok(canonical,`${page}: no canonical`);
  assert.ok(canonical.startsWith(`${origin}/`),`${page}: canonical is not absolute or on the wrong origin: ${canonical}`);
  assert.ok(canonical.endsWith('/'),`${page}: canonical should end with a slash`);
  for(const [label,re] of [['og:title',/<meta property="og:title" content="([^"]*)"/i],['og:description',/<meta property="og:description" content="([^"]*)"/i],['og:url',/<meta property="og:url" content="([^"]*)"/i],['og:image',/<meta property="og:image" content="([^"]*)"/i],['og:site_name',/<meta property="og:site_name" content="([^"]*)"/i],['twitter:card',/<meta name="twitter:card" content="([^"]*)"/i],['twitter:title',/<meta name="twitter:title" content="([^"]*)"/i],['twitter:description',/<meta name="twitter:description" content="([^"]*)"/i],['twitter:image',/<meta name="twitter:image" content="([^"]*)"/i]]){
   assert.ok(pick(source,re),`${page}: no ${label}`);
  }
  assert.match(source,/<link rel="icon" href="[^"]*favicon\.svg" type="image\/svg\+xml">/,`${page}: no SVG icon`);
  assert.match(source,/<link rel="apple-touch-icon"/,`${page}: no apple-touch-icon`);
  assert.match(source,/<link rel="manifest"/,`${page}: no web manifest`);
  assert.match(source,/<script type="application\/ld\+json">\{/,`${page}: no structured data`);
  const ld=source.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1]??'';
  assert.doesNotThrow(()=>JSON.parse(ld),`${page}: structured data is not valid JSON`);
  assert.match(source,/<html lang="en"/,`${page}: no lang`);
  assert.match(source,/<meta name="viewport" content="width=device-width, initial-scale=1">/,`${page}: no viewport`);
  assert.equal((source.match(/<h1[\s>]/g)||[]).length,1,`${page} needs exactly one h1`);
 }
 const home=await readFile(path.join(site,'index.html'),'utf8');
 const ld=JSON.parse(home.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
 assert.ok(ld['@graph'].some(x=>x['@type']==='SoftwareApplication'),'the home page should describe the software');
 assert.ok(ld['@graph'].some(x=>x['@type']==='WebSite'),'the home page should describe the site');
 for(const page of VARIANTS)assert.match(await readFile(path.join(site,page),'utf8'),/<meta name="robots" content="noindex, follow">/,`${page} should stay out of the index`);
});

test('the site tells crawlers where to go, and ships a way home for a bad URL',async()=>{
 const robots=await readFile(path.join(site,'robots.txt'),'utf8');
 assert.match(robots,/User-agent: \*/);
 assert.match(robots,/Allow: \//);
 assert.ok(robots.includes(`Sitemap: ${origin}/sitemap.xml`),'robots.txt must point at the sitemap on the site origin');
 const sitemap=await readFile(path.join(site,'sitemap.xml'),'utf8');
 for(const page of PAGES){
  const path=page==='index.html'?'':page.replace('index.html','');
  assert.ok(sitemap.includes(`<loc>${origin}/${path}</loc>`),`the sitemap is missing ${path}`);
 }
 assert.ok(!sitemap.includes('/variants/'),'the copy drafts should not be in the sitemap');
 const notFound=await readFile(path.join(site,'404.html'),'utf8');
 assert.match(notFound,/<title>[^<]*not found[^<]*<\/title>/i);
 assert.match(notFound,/Agent Relay/);
 assert.ok(notFound.includes(origin),'the 404 page needs absolute links');
 const manifest=JSON.parse(await readFile(path.join(site,'site.webmanifest'),'utf8'));
 assert.equal(manifest.name,'Agent Relay');
 assert.ok(manifest.icons.length>=2,'the manifest needs icons');
 for(const file of ['assets/favicon-32.png','assets/apple-touch-icon.png','assets/icon-512.png'])assert.ok(await exists(site,file),`missing icon: ${file}`);
});

// Third parties the site is allowed to point at.
// `example` is the reserved documentation domain (RFC 2606): the site's own
// README uses it as the placeholder for a future move.
const ALLOWED_HOSTS=/(github\.com|npmjs\.com|opensource\.org|onlinewebfonts\.com|json-schema\.org|schema\.org|sitemaps\.org|w3\.org|\.example)$/;
test('every absolute URL on the site points at the same origin',async()=>{
 const files=['robots.txt','sitemap.xml','404.html','site.webmanifest','README.md',...PAGES,...VARIANTS];
 for(const file of files){
  const source=await readFile(path.join(site,file),'utf8');
  // Markdown emphasis and punctuation trail a URL in a README, so they are stripped.
  const found=[...source.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map(m=>m[0].replace(/[.,;:!*_]+$/,''));
  for(const url of found){
   let host='';
   try{host=new URL(url).host;}catch{continue;}
   if(ALLOWED_HOSTS.test(host))continue;
   // The bare origin is as good as a path on it.
   assert.ok(url===origin||url.startsWith(`${origin}/`),`${file} points at ${url}, not ${origin}`);
  }
 }
 const robots=await readFile(path.join(site,'robots.txt'),'utf8');
 assert.ok(robots.includes(`Sitemap: ${origin}/sitemap.xml`),'robots.txt must point at the sitemap on the same origin');
 const sitemap=await readFile(path.join(site,'sitemap.xml'),'utf8');
 assert.ok(sitemap.includes(`<loc>${origin}/</loc>`),'the sitemap must use the same origin');
});

test('the pages agree with each other about their own address and version',async()=>{
 const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
 for(const page of PAGES){
  const source=await readFile(path.join(site,page),'utf8');
  const canonical=pick(source,/<link rel="canonical" href="([^"]*)"/i);
  assert.ok(canonical.startsWith(`${origin}/`),`${page}: canonical is not on the site origin`);
  for(const [label,re] of [['og:url',/<meta property="og:url" content="([^"]*)"/i],['twitter:image',/<meta name="twitter:image" content="([^"]*)"/i],['og:image',/<meta property="og:image" content="([^"]*)"/i]]){
   const value=pick(source,re);
   assert.ok(value&&value.startsWith(`${origin}/`),`${page}: ${label} does not point at the site origin`);
  }
  const ld=JSON.parse(source.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const graph=ld['@graph']??[ld];
  for(const node of graph){
   if(node['@type']==='SoftwareApplication')assert.equal(node.softwareVersion,pkg.version,`${page}: the structured data states a stale version`);
   if(node.url)assert.ok(String(node.url).startsWith(`${origin}/`),`${page}: the structured data points at ${node.url}`);
  }
 }
});

test('the origin can be changed with one command',async()=>{
 const script=await readFile(path.join(root,'scripts','set-site-origin.mjs'),'utf8');
 assert.match(script,/process\.argv\[2\]/);
 assert.match(script,/site\/robots\.txt/);
 assert.match(script,/package\.json/);
});

// The command really moves the site: a copy of the tree is moved to another
// origin and every file has to follow. The list of files is checked against
// the pages that exist, so a new page cannot be forgotten.
test('moving the origin moves every file, and no page is left behind',async()=>{
 const {mkdtemp,cp,mkdir,readdir}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {execFile}=await import('node:child_process');
 const {promisify}=await import('node:util');
 const execFileAsync=promisify(execFile);
 const copy=await mkdtemp(path.join(tmpdir(),'relay-site-'));
 await cp(site,path.join(copy,'site'),{recursive:true});
 await cp(path.join(root,'package.json'),path.join(copy,'package.json'));
 await cp(path.join(root,'README.md'),path.join(copy,'README.md'));
 await cp(path.join(root,'scripts'),path.join(copy,'scripts'),{recursive:true});
 const target='https://relay.example';
 await execFileAsync(process.execPath,[path.join(copy,'scripts','set-site-origin.mjs'),target],{cwd:copy});

 const moved=await readFile(path.join(copy,'site','index.html'),'utf8');
 assert.ok(moved.includes(`${target}/`),'the canonical moved');
 assert.ok(!moved.includes('relay.next-notes.com'),'nothing points at the old origin');
 const pkg=JSON.parse(await readFile(path.join(copy,'package.json'),'utf8'));
 assert.equal(pkg.homepage,`${target}/`,'the homepage moved');
 const robots=await readFile(path.join(copy,'site','robots.txt'),'utf8');
 assert.ok(robots.includes(`Sitemap: ${target}/sitemap.xml`),'the sitemap line moved');

 // Every page in the site has to be in the script's list.
 const script=await readFile(path.join(copy,'scripts','set-site-origin.mjs'),'utf8');
 const listed=new Set([...script.matchAll(/'(site\/[^']+)'/g)].map(match=>match[1]));
 const walk=async dir=>{
  const out=[];
  for(const entry of await readdir(dir,{withFileTypes:true})){
   const full=path.join(dir,entry.name);
   if(entry.isDirectory())out.push(...await walk(full));
   else if(entry.name.endsWith('.html'))out.push(path.relative(copy,full).split(path.sep).join('/'));
  }
  return out;
 };
 for(const page of await walk(path.join(copy,'site')))assert.ok(listed.has(page),`${page} is not in the move list`);
});

test('site assets stay small (under 3 MB) and screenshots exist for both themes',async()=>{
 const dir=path.join(site,'assets');let total=0;
 for(const name of await readdir(dir)){const info=await stat(path.join(dir,name));if(info.isFile())total+=info.size;}
 assert.ok(total<3*1024*1024,`assets are ${total} bytes`);
 for(const view of ['overview','roadmap','branches','agents','messages','claims'])for(const theme of ['dark','light'])assert.ok(await exists(site,`assets/dash-${view}-${theme}.webp`),`missing ${view} ${theme} screenshot`);
});
