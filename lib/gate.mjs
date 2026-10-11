import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile as fsReadFile} from 'node:fs/promises';
import os from 'node:os';
const exec=promisify(execFile);
const REQUIRE_KEYS=['swap','load','disk'];
const LABELS={swap:'swap',load:'load',disk:'free disk'};
const errorText=error=>String(error&&error.message?error.message:error).split('\n')[0];
export function parseDfAvailableKb(stdout){
 const lines=String(stdout).trim().split('\n').map(line=>line.trim()).filter(Boolean);
 if(lines.length<2)return null;
 const row=lines.at(-1).split(/\s+/);
 const available=Number(row[3]);
 return Number.isFinite(available)?available:null;
}
export function parseSysctlSwapGb(stdout){
 const match=String(stdout).match(/used\s*=\s*([\d.]+)([KMGT])/);
 return match?Number(match[1])*({K:1/1024**2,M:1/1024,G:1,T:1024}[match[2]]):null;
}
export function parseSysctlLoad(stdout){
 const match=String(stdout).match(/[\d.]+/);
 return match?Number(match[0]):null;
}
export function parseProcMeminfoSwapGb(text){
 const total=String(text).match(/^SwapTotal:\s*(\d+)/m);
 const free=String(text).match(/^SwapFree:\s*(\d+)/m);
 if(!total||!free)return null;
 return (Number(total[1])-Number(free[1]))/1024**2;
}
export function windowsDriveOf(path){
 const match=String(path).match(/^([A-Za-z]:)/);
 return match?match[1].toUpperCase():'C:';
}
export function parseWindowsNumber(stdout){
 const text=String(stdout).trim();
 if(!text)return null;
 const value=Number(text);
 return Number.isFinite(value)?value:null;
}
export async function machineGate({maxSwapGb=8,maxLoad=40,minFreeGb=10,path='/',platform=process.platform,run=exec,load=os.loadavg,mode='permissive',require=['swap','load','disk'],now=Date.now,readFile=fsReadFile}={}){
 for(const value of [maxSwapGb,maxLoad,minFreeGb])if(!Number.isFinite(value)||value<0)throw new Error('Gate limits must be nonnegative numbers');
 if(mode!=='permissive'&&mode!=='strict')throw new Error('Gate mode must be permissive or strict');
 if(!Array.isArray(require)||require.some(key=>!REQUIRE_KEYS.includes(key)))throw new Error('Gate require must name swap, load, or disk');
 const stamp=()=>new Date(now()).toISOString();
 const swapInfo={value:null,source:null,timestamp:null,error:null},loadInfo={value:null,source:null,timestamp:null,error:null},diskInfo={value:null,source:null,timestamp:null,error:null};
 const hit=(info,value,source)=>{info.value=value;info.source=source;info.timestamp=stamp();return value;};
 const miss=(info,message)=>{info.error=message;info.timestamp=stamp();return null;};
 let swapGb=null,loadValue=null,freeGb=null;
 if(platform!=='win32')try{loadValue=load()[0];if(Number.isFinite(loadValue))hit(loadInfo,loadValue,'os.loadavg');else{loadValue=null;miss(loadInfo,'os.loadavg returned no usable value');}}catch(error){miss(loadInfo,`os.loadavg failed: ${errorText(error)}`);}
 if(platform==='darwin'){
  try{const {stdout}=await run('/usr/sbin/sysctl',['-n','vm.swapusage'],{timeout:5000});const value=parseSysctlSwapGb(stdout);swapGb=value===null?miss(swapInfo,'sysctl vm.swapusage returned no usable value'):hit(swapInfo,value,'sysctl vm.swapusage');}catch(error){miss(swapInfo,`sysctl vm.swapusage failed: ${errorText(error)}`);}
  try{const {stdout}=await run('/usr/sbin/sysctl',['-n','vm.loadavg'],{timeout:5000});const value=parseSysctlLoad(stdout);if(value!==null)loadValue=hit(loadInfo,value,'sysctl vm.loadavg');else if(loadInfo.value===null)miss(loadInfo,'sysctl vm.loadavg returned no usable value');}catch(error){if(loadInfo.value===null)miss(loadInfo,`sysctl vm.loadavg failed: ${errorText(error)}`);}
 }
 if(platform==='linux'){
  try{const text=await readFile('/proc/meminfo','utf8');const value=parseProcMeminfoSwapGb(text);swapGb=value===null?miss(swapInfo,'/proc/meminfo returned no usable value'):hit(swapInfo,value,'/proc/meminfo');}catch(error){miss(swapInfo,`/proc/meminfo failed: ${errorText(error)}`);}
 }
 if(platform==='win32'){
  const drive=windowsDriveOf(path);
  try{const {stdout}=await run('powershell',['-NoProfile','-Command','$os=Get-CimInstance Win32_OperatingSystem; ($os.TotalVirtualMemorySize-$os.FreeVirtualMemory)-($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)'],{timeout:5000});const kb=parseWindowsNumber(stdout);swapGb=kb===null?miss(swapInfo,'powershell Win32_OperatingSystem returned no usable value'):hit(swapInfo,kb/1024**2,'powershell Win32_OperatingSystem');}catch(error){miss(swapInfo,`powershell Win32_OperatingSystem failed: ${errorText(error)}`);}
  try{const {stdout}=await run('powershell',['-NoProfile','-Command','(Get-CimInstance Win32_PerfFormattedData_PerfOS_System).ProcessorQueueLength'],{timeout:5000});const value=parseWindowsNumber(stdout);if(value!==null)loadValue=hit(loadInfo,value,'powershell Win32_PerfFormattedData_PerfOS_System.ProcessorQueueLength');else miss(loadInfo,'powershell ProcessorQueueLength returned no usable value');}catch(error){miss(loadInfo,`powershell ProcessorQueueLength failed: ${errorText(error)}`);}
  try{const {stdout}=await run('powershell',['-NoProfile','-Command',`(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'").FreeSpace`],{timeout:5000});const bytes=parseWindowsNumber(stdout);freeGb=bytes===null?miss(diskInfo,`powershell Win32_LogicalDisk ${drive} returned no usable value`):hit(diskInfo,bytes/1024**3,`powershell Win32_LogicalDisk ${drive}`);}catch(error){miss(diskInfo,`powershell Win32_LogicalDisk ${drive} failed: ${errorText(error)}`);}
 }else{
  try{const {stdout}=await run('df',['-Pk',path],{timeout:5000});const availableKb=parseDfAvailableKb(stdout);freeGb=availableKb===null?miss(diskInfo,'df returned no usable value'):hit(diskInfo,availableKb/1024**2,`df -Pk ${path}`);}catch(error){miss(diskInfo,`df failed: ${errorText(error)}`);}
 }
 const reasons=[];
 if(swapGb!==null&&swapGb>maxSwapGb)reasons.push(`Swap ${swapGb.toFixed(2)} GB exceeds ${maxSwapGb} GB`);
 if(loadValue!==null&&loadValue>maxLoad)reasons.push(`Load ${loadValue.toFixed(2)} exceeds ${maxLoad}`);
 if(freeGb!==null&&freeGb<minFreeGb)reasons.push(`Free disk ${freeGb.toFixed(2)} GB is below ${minFreeGb} GB`);
 const coverage={swap:swapGb===null?'unknown':'measured',load:loadValue===null?'unknown':'measured',disk:freeGb===null?'unknown':'measured'};
 const unknown=[...(swapGb===null?[swapInfo.error?`${LABELS.swap}: ${swapInfo.error}`:LABELS.swap]:[]),...(loadValue===null?[loadInfo.error?`${LABELS.load}: ${loadInfo.error}`:LABELS.load]:[]),...(freeGb===null?[diskInfo.error?`${LABELS.disk}: ${diskInfo.error}`:LABELS.disk]:[])];
 const missing=require.filter(key=>coverage[key]==='unknown');
 const measuredRefusal=reasons.length>0;
 if(mode==='strict')for(const key of missing)reasons.push(`required measurement unavailable: ${key}`);
 return {kind:'preflight',mode,assessed:measuredRefusal?'refusal':(missing.length?'insufficient-evidence':'pass'),ok:!measuredRefusal&&(mode!=='strict'||missing.length===0),swapGb,load:loadValue,freeGb,path,require:[...require],reasons,unknown,coverage,measurements:{swapGb:swapInfo,load:loadInfo,freeGb:diskInfo}};
}
