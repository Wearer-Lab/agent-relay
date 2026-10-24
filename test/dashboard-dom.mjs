// Shared fake-DOM harness for dashboard view tests (not a test file itself: it only exports helpers).
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
export const dashboardSource=await readFile(new URL('../lib/dashboard/assets/dashboard.js',import.meta.url),'utf8');
export const modelSource=await readFile(new URL('../lib/dashboard/assets/model.js',import.meta.url),'utf8');
export const textOf=el=>(el.textContent??'')+(el.children??[]).map(textOf).join('');
export const findAll=(root,pred)=>{const out=[];const walk=n=>{for(const child of n.children??[]){if(pred(child))out.push(child);walk(child);}};walk(root);return out;};
export const byClass=(root,cls)=>findAll(root,el=>String(el.className).split(' ').includes(cls));
export const findButton=(root,label)=>findAll(root,el=>el.tag==='button'&&(el.textContent===label||textOf(el)===label))[0];
export const plain=value=>JSON.parse(JSON.stringify(value));
export function modelContext(){const sandbox={};createContext(sandbox);runInContext(modelSource,sandbox);return sandbox;}
const emptySnapshot={project:'',agents:[],claims:[],messages:[],totalMessages:0,pendingDeliveries:0,pendingByAgent:{},cursor:0};
export function boot({projects,snapshot,work,ownership,usage,path='/'}={}){
 const elements=new Map();
 const make=tag=>{
  const el={tag,children:[],parent:null,dataset:{},listeners:{},textContent:'',className:'',type:'',value:'',checked:false,hidden:false,disabled:false,title:'',dateTime:'',open:false,scrollTop:0,scrolled:false,attributes:{},
   classList:{toggle(){},add(){},remove(){},contains:()=>false},style:{setProperty(){}},focus(){},
   addEventListener(event,callback){el.listeners[event]=callback;},
   setAttribute(name,value){el.attributes[name]=value;},
   append(...nodes){for(const n of nodes){const items=n&&n.isFragment?n.children.splice(0):[n];for(const item of items){item.parent=el;el.children.push(item);}}},
   replaceChildren(...nodes){el.children=[];el.append(...nodes);},
   querySelectorAll(selector){const found=[];const walk=n=>{for(const child of n.children){if(selector==='details[open]'&&child.tag==='details'&&child.open)found.push(child);walk(child);}};walk(el);return found;},
   scrollIntoView(){el.scrolled=true;}};
  Object.defineProperty(el,'options',{get(){return el.children.filter(c=>c.tag==='option');}});
  return el;
 };
 class Option{constructor(text,value=''){this.tag='option';this.text=text;this.value=value;this.children=[];this.dataset={};}}
 const document={hidden:false,activeElement:null,cookie:'',title:'',
  getElementById(id){if(!elements.has(id))elements.set(id,make('div'));return elements.get(id);},
  createElement:make,
  createDocumentFragment(){return {isFragment:true,children:[],append(...nodes){this.children.push(...nodes);}};},
  addEventListener(event,callback){(document.listeners??={})[event]=callback;}};
 const fetchLog=[];
 const response=(body,status=200)=>({status,ok:status<400,headers:{get:()=>null},json:async()=>body});
 const feed=(value,url)=>value===undefined?response({error:'Not found.'},404):response(typeof value==='function'?value(url):value);
 const fetch=async url=>{
  fetchLog.push(url);
  if(url.startsWith('/api/v1/projects'))return response(projects??{rooms:[],preferredProject:''});
  if(url.startsWith('/api/v1/snapshot'))return response(typeof snapshot==='function'?snapshot(url):snapshot??emptySnapshot);
  if(url.startsWith('/api/v1/work'))return feed(work,url);
  if(url.startsWith('/api/v1/ownership'))return feed(ownership,url);
  if(url.startsWith('/api/v1/usage'))return feed(usage,url);
  if(url.startsWith('/api/v1/history'))return response({available:false,messages:[],nextCursor:null,done:true});
  return response({error:'Not found.'},404);
 };
 const pushed=[];
 const sandbox={document,location:{hash:'#dashboard-test-secret',pathname:path,search:''},URLSearchParams,history:{replaceState(){},pushState(_s,_t,url){pushed.push(url);}},sessionStorage:{getItem:()=>null,setItem(){}},fetch,AbortSignal:{timeout:()=>({})},Option,setInterval:()=>0,queueMicrotask,setTimeout,clearTimeout};
 createContext(sandbox);runInContext(modelSource,sandbox);runInContext(dashboardSource,sandbox);
 const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
 return {elements,sandbox,fetchLog,pushed,flush,$:id=>elements.get(id)??document.getElementById(id),document};
}
