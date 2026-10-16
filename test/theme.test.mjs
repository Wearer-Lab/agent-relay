import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const source=await readFile(new URL('../lib/dashboard/theme.js',import.meta.url),'utf8');
function boot({cookie='',saved=null,systemDark=false,blocked=false}={}){
 const events={},control={value:'',addEventListener:(event,callback)=>{events[event]=callback;}},documentEvents={};
 const document={documentElement:{dataset:{}},cookie,getElementById:()=>control,addEventListener:(event,callback)=>{documentEvents[event]=callback;}};
 const values=new Map(saved?[['agent-relay-theme',saved]]:[]),storage={getItem:key=>{if(blocked)throw new Error('blocked');return values.get(key);},setItem:(key,value)=>{if(blocked)throw new Error('blocked');values.set(key,value);}};
 const media={matches:systemDark,addEventListener:(_,callback)=>{media.changed=callback;}};
 runInNewContext(source,{document,localStorage:storage,window:{matchMedia:()=>media}});documentEvents.DOMContentLoaded();
 return {document,control,values,select(value){control.value=value;events.change();},system(value){media.matches=value;media.changed();}};
}
test('theme switches immediately, persists user preference and restores it after reload',()=>{
 const page=boot();assert.equal(page.document.documentElement.dataset.theme,'dark');
 page.select('light');assert.equal(page.document.documentElement.dataset.theme,'light');assert.equal(page.values.get('agent-relay-theme'),'light');
 const restored=boot({cookie:page.document.cookie});assert.equal(restored.control.value,'light');assert.equal(restored.document.documentElement.dataset.theme,'light');
 page.select('dark');assert.equal(page.document.documentElement.dataset.theme,'dark');
});
test('system theme follows OS changes while explicit themes remain fixed, and blocked storage is harmless',()=>{
 const page=boot({saved:'system'});assert.equal(page.control.value,'system');assert.equal(page.document.documentElement.dataset.theme,'light');
 page.system(true);assert.equal(page.document.documentElement.dataset.theme,'dark');page.select('light');page.system(true);assert.equal(page.document.documentElement.dataset.theme,'light');
 const restricted=boot({blocked:true});assert.doesNotThrow(()=>restricted.select('light'));assert.equal(restricted.document.documentElement.dataset.theme,'light');
});

// ---- Contrast: every text/background pairing the dashboard uses must reach WCAG AA (4.5:1) in both themes ----
const css=await readFile(new URL('../lib/dashboard/dashboard.css',import.meta.url),'utf8');
const tokens=selector=>{const body=css.match(new RegExp(selector.replace(/[[\]"]/g,'\\$&')+'\\s*\\{([^}]*)\\}'))?.[1]??'';return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([,key,value])=>[key,value.trim()]));};
const themes={light:tokens(':root'),dark:{...tokens(':root'),...tokens(':root[data-theme="dark"]')}};
const channels=hex=>{const h=hex.replace('#','');return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16));};
const luminance=hex=>{const [r,g,b]=channels(hex).map(v=>{const c=v/255;return c<=.03928?c/12.92:((c+.055)/1.055)**2.4;});return .2126*r+.7152*g+.0722*b;};
const contrast=(a,b)=>{const [x,y]=[luminance(a),luminance(b)];return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
// [foreground token, background token, where it is used]
const PAIRS=[
 ['ink','bg','body text'],['ink','panel','panel text'],['ink','panel-2','hovered rows'],['muted','bg','secondary text'],['muted','panel','panel notes'],['muted','panel-2','hovered notes'],['muted','strip','strip meta'],
 ['callsign','bg','callsigns'],['callsign','panel','callsigns in panels'],['callsign','strip','callsigns on strips'],['callsign','panel-2','callsigns on hover'],
 ['amber-ink','bg','kicker'],['amber-ink','panel','priority chip'],['cyan-ink','panel','link buttons'],['live-ink','panel','live text'],['live-ink','bg','live text'],['alert-ink','panel','alert text'],
 ['cyan-ink','cyan-bg','branch chip, in-progress status, attention note'],['alert-ink','alert-bg','blocked chip and status, missing flag, missing receipt'],['amber-ink','amber-bg','warn chip, review status, pending tag'],['live-ink','live-bg','ok chip, done status, acknowledged tag'],
 ['ink','alert-bg','error banner'],['ink','amber-bg','callout'],['muted','amber-bg','muted on amber'],['muted','live-bg','muted on green'],
 ['on-solid','alert','alert attention tag, contested flag, alert count'],['on-solid','alert-2','contested flag stripes, frozen stub'],['on-solid','amber','caution tag, pressed button, orphaned flag, active rail number'],
 ['on-solid','live','live stub'],['on-solid','cyan','idle stub'],['on-solid','stub','dormant stub']
];
for (const [name,theme] of Object.entries(themes)) {
 test(`status chips, tags and text keep WCAG AA contrast in the ${name} theme`,()=>{
  for (const [fg,bg] of PAIRS) for (const token of [fg,bg]) assert.match(theme[token]??'',/^#[0-9a-f]{6}$/i,`${token} must be a 6-digit hex token`);
  const failures=PAIRS.map(([fg,bg,where])=>({fg,bg,where,ratio:contrast(theme[fg],theme[bg])})).filter(row=>!(row.ratio>=4.5));
  assert.deepEqual(failures.map(row=>`${row.fg} on ${row.bg} (${row.where}): ${row.ratio.toFixed(2)}`),[]);
 });
}
test('the contrast helper agrees with known WCAG values',()=>{
 assert.equal(contrast('#000000','#ffffff').toFixed(1),'21.0');assert.equal(contrast('#777777','#ffffff').toFixed(2),'4.48');
});

// ---- Keyboard and motion -------------------------------------------------------------------
test('focus is always visible, and reduced motion removes animation, hover lift and the only motion-borne signal',()=>{
 assert.match(css,/:focus-visible\s*\{\s*outline:\s*2px solid var\(--cyan\)/);
 assert.doesNotMatch(css,/(^|\})\s*(button|select|input|a|summary)[^{]*\{[^}]*outline:\s*none/,'no control hides its focus ring');
 const reduced=css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/)?.[1]??'';
 assert.match(reduced,/animation:\s*none\s*!important/);assert.match(reduced,/transition:\s*none\s*!important/);
 assert.match(reduced,/\.gauge:hover[^{]*\{\s*transform:\s*none/,'hover lift is dropped');
 assert.match(reduced,/\.message\.fresh[^{]*\{[^}]*box-shadow/,'a new message stays marked without the flash');
});
