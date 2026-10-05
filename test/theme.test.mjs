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
