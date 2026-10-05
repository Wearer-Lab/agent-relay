import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
const exec=promisify(execFile);
export async function machineGate({maxSwapGb=8,maxLoad=40,minFreeGb=10,path='/',platform=process.platform,run=exec,load=os.loadavg}={}){
 for(const value of [maxSwapGb,maxLoad,minFreeGb])if(!Number.isFinite(value)||value<0)throw new Error('Gate limits must be nonnegative numbers');
 let swapGb=null,freeGb=null,loadValue=null;
 try{loadValue=platform==='win32'?null:load()[0];if(!Number.isFinite(loadValue))loadValue=null;}catch{}
 if(platform==='darwin'){
  try{const {stdout}=await run('/usr/sbin/sysctl',['-n','vm.swapusage'],{timeout:5000});const match=stdout.match(/used\s*=\s*([\d.]+)([KMGT])/);if(match)swapGb=Number(match[1])*({K:1/1024**2,M:1/1024,G:1,T:1024}[match[2]]);}catch{}
  try{const {stdout}=await run('/usr/sbin/sysctl',['-n','vm.loadavg'],{timeout:5000});const match=stdout.match(/[\d.]+/);if(match)loadValue=Number(match[0]);}catch{}
 }
 try{const {stdout}=await run('df',['-Pk',path],{timeout:5000});const row=stdout.trim().split('\n').at(-1).trim().split(/\s+/);const available=Number(row[3]);if(Number.isFinite(available))freeGb=available/1024**2;}catch{}
 const reasons=[];
 if(swapGb!==null&&swapGb>maxSwapGb)reasons.push(`Swap ${swapGb.toFixed(2)} GB exceeds ${maxSwapGb} GB`);
 if(loadValue!==null&&loadValue>maxLoad)reasons.push(`Load ${loadValue.toFixed(2)} exceeds ${maxLoad}`);
 if(freeGb!==null&&freeGb<minFreeGb)reasons.push(`Free disk ${freeGb.toFixed(2)} GB is below ${minFreeGb} GB`);
 return {ok:reasons.length===0,swapGb,load:loadValue,freeGb,path,reasons,unknown:[...(swapGb===null?['swap']:[]),...(loadValue===null?['load']:[]),...(freeGb===null?['free disk']:[])]};
}
