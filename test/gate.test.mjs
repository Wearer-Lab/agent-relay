import test from 'node:test';import assert from 'node:assert/strict';import {machineGate,parseDfAvailableKb,parseSysctlSwapGb,parseSysctlLoad,parseProcMeminfoSwapGb,windowsDriveOf,parseWindowsNumber,parseWindowsPageFileUsageGb} from '../lib/gate.mjs';
const at=()=>Date.parse('2026-10-11T00:00:00.000Z');
const dfRow=(available)=>`Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 20000000 15000000 ${available} 75% /\n`;
const darwinRun=(swapusage,loadavg,available)=>async(command,args)=>({stdout:command==='df'?dfRow(available):args[1]==='vm.swapusage'?swapusage:loadavg});
test('macOS gate parses read-only measurements and refuses each exceeded limit',async()=>{
 const run=async(command,args)=>({stdout:command==='df'?'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 20000000 15000000 5000000 75% /\n':args[1]==='vm.swapusage'?'total = 12.00G used = 9216.00M free = 3.00G':'{ 41.00 20.00 10.00 }'});
 const result=await machineGate({platform:'darwin',run,now:at});assert.equal(result.swapGb,9);assert.equal(result.load,41);assert.equal(result.reasons.length,3);assert.equal(result.ok,false);
 assert.equal(result.kind,'preflight');assert.equal(result.mode,'permissive');assert.equal(result.assessed,'refusal');assert.deepEqual(result.unknown,[]);
 assert.deepEqual(result.coverage,{swap:'measured',load:'measured',disk:'measured'});
 assert.deepEqual(result.measurements.swapGb,{value:9,source:'sysctl vm.swapusage',timestamp:'2026-10-11T00:00:00.000Z',error:null});
 assert.deepEqual(result.measurements.load,{value:41,source:'sysctl vm.loadavg',timestamp:'2026-10-11T00:00:00.000Z',error:null});
 assert.match(result.measurements.freeGb.source,/^df -Pk/);
});
test('gate reports unknown values and permits exact boundary values',async()=>{
 const result=await machineGate({platform:'linux',run:async()=>{throw Error('df exploded');},load:()=>[40],readFile:async()=>{throw Error('no meminfo');}});
 assert.equal(result.ok,true);assert.equal(result.assessed,'insufficient-evidence');assert.deepEqual(result.unknown,['swap: /proc/meminfo failed: no meminfo','free disk: df failed: df exploded']);
 await assert.rejects(machineGate({maxSwapGb:-1}),/nonnegative/);
 const boundary=await machineGate({platform:'darwin',run:darwinRun('total = 8.00G used = 8.00G free = 0.00G','{ 40.00 20.00 10.00 }',String(10*1024*1024)),load:()=>[40],now:at});
 assert.equal(boundary.ok,true);assert.equal(boundary.assessed,'pass');assert.equal(boundary.swapGb,8);assert.equal(boundary.load,40);assert.equal(boundary.freeGb,10);assert.deepEqual(boundary.reasons,[]);
});
test('measured pass labels permissive coverage and exposes sources',async()=>{
 const result=await machineGate({platform:'darwin',run:darwinRun('total = 4.00G used = 1024.00M free = 3.00G','{ 1.00 1.00 1.00 }',String(19*1024*1024)),now:at});
 assert.equal(result.ok,true);assert.equal(result.assessed,'pass');assert.deepEqual(result.unknown,[]);
 assert.deepEqual(result.coverage,{swap:'measured',load:'measured',disk:'measured'});
 assert.equal(result.measurements.swapGb.value,1);assert.equal(result.measurements.freeGb.value,19);assert.equal(result.measurements.freeGb.timestamp,'2026-10-11T00:00:00.000Z');
});
test('permissive insufficient evidence is never a measured pass',async()=>{
 const result=await machineGate({platform:'win32',run:async()=>{throw Error('powershell missing');},now:at});
 assert.equal(result.ok,true);assert.notEqual(result.assessed,'pass');assert.equal(result.assessed,'insufficient-evidence');
 assert.deepEqual(result.coverage,{swap:'unknown',load:'unknown',disk:'unknown'});
 assert.deepEqual(result.unknown,['swap: powershell Win32_PageFileUsage failed: powershell missing','load: powershell ProcessorQueueLength failed: powershell missing','free disk: powershell Win32_LogicalDisk C: failed: powershell missing']);
 assert.equal(result.measurements.freeGb.error,'powershell Win32_LogicalDisk C: failed: powershell missing');
});
test('strict mode refuses with structured reason when a required measurement is unknown',async()=>{
 const run=async(command,args)=>{if(args[1]==='vm.swapusage')return {stdout:'total = 4.00G used = 1024.00M free = 3.00G'};if(args[1]==='vm.loadavg')throw Error('sysctl down');return {stdout:dfRow(String(19*1024*1024))};};
 const result=await machineGate({platform:'darwin',run,load:()=>{throw Error('no loadavg');},mode:'strict',require:['disk','load','swap'],now:at});
 assert.equal(result.ok,false);assert.deepEqual(result.reasons,['required measurement unavailable: load']);assert.equal(result.assessed,'insufficient-evidence');
 assert.deepEqual(result.coverage,{swap:'measured',load:'unknown',disk:'measured'});assert.deepEqual(result.unknown,['load: sysctl vm.loadavg failed: sysctl down']);
 const strict=await machineGate({platform:'darwin',run:darwinRun('total = 4.00G used = 1024.00M free = 3.00G','{ 1.00 1.00 1.00 }',String(19*1024*1024)),mode:'strict',require:['disk','load','swap'],now:at});
 assert.equal(strict.ok,true);assert.equal(strict.assessed,'pass');
 const subset=await machineGate({platform:'darwin',run,load:()=>{throw Error('no loadavg');},mode:'strict',require:['disk'],now:at});
 assert.equal(subset.ok,true);assert.equal(subset.assessed,'pass');
});
test('windows gate measures the selected drive and never fabricates values',async()=>{
 const calls=[];
 const run=async(command,args)=>{calls.push([command,...args]);const script=args.at(-1);if(script.includes('Win32_PageFileUsage'))return {stdout:'2048\r\n'};if(script.includes('ProcessorQueueLength'))return {stdout:'2\n'};if(script.includes('Win32_LogicalDisk'))return {stdout:' 5368709120000 \r\n'};throw Error('unexpected probe');};
 const result=await machineGate({platform:'win32',path:'D:\\work\\project',run,now:at});
 assert.equal(result.swapGb,2);assert.equal(result.load,2);assert.equal(result.freeGb,5000);assert.equal(result.ok,true);assert.equal(result.assessed,'pass');
 assert.deepEqual(result.unknown,[]);assert.deepEqual(result.coverage,{swap:'measured',load:'measured',disk:'measured'});
 assert.match(result.measurements.freeGb.source,/Win32_LogicalDisk D:/);
 const diskCall=calls.find(call=>call.at(-1).includes('Win32_LogicalDisk'));
 assert.match(diskCall.at(-1),/DeviceID='D:'/);assert.ok(!calls.some(([command])=>command==='df'||command.includes('sysctl')));
 assert.equal(windowsDriveOf('D:\\work\\project'),'D:');assert.equal(windowsDriveOf('c:/temp/x'),'C:');assert.equal(windowsDriveOf('/somewhere'),'C:');
 const refused=await machineGate({platform:'win32',path:'D:\\work',run:async(command,args)=>{const script=args.at(-1);if(script.includes('Win32_LogicalDisk'))return {stdout:'1073741824'};return script.includes('ProcessorQueueLength')?{stdout:'1'}:{stdout:'0'};},now:at});
 assert.equal(refused.ok,false);assert.equal(refused.assessed,'refusal');assert.deepEqual(refused.reasons,['Free disk 1.00 GB is below 10 GB']);
});
test('pure parsers read fixture output without running probes',()=>{
 assert.equal(parseDfAvailableKb(dfRow('5000000')),5000000);assert.equal(parseDfAvailableKb('Filesystem 1024-blocks Used Available Capacity Mounted on\n'),null);
 assert.equal(parseSysctlSwapGb('total = 12.00G used = 9216.00M free = 3.00G'),9);assert.equal(parseSysctlSwapGb('total = 12.00G free = 3.00G'),null);
 assert.equal(parseSysctlLoad('{ 41.00 20.00 10.00 }'),41);
 assert.equal(parseProcMeminfoSwapGb('SwapTotal: 2097152 kB\nSwapFree: 1048576 kB\nMemTotal: 8000000 kB\n'),1);assert.equal(parseProcMeminfoSwapGb('MemTotal: 8000000 kB\n'),null);
 assert.equal(parseWindowsNumber(' 5368709120000 \r\n'),5368709120000);assert.equal(parseWindowsNumber(''),null);assert.equal(parseWindowsNumber('nope'),null);
 assert.equal(windowsDriveOf('E:/x'),'E:');
});
test('windows page file parser sums CurrentUsage MB across page files',()=>{
 assert.equal(parseWindowsPageFileUsageGb('5311\r\n'),5311/1024);
 assert.equal(parseWindowsPageFileUsageGb('1024\r\n2048\r\n'),3);
 assert.equal(parseWindowsPageFileUsageGb(' 512 \n\n 512 \n'),1);
 assert.equal(parseWindowsPageFileUsageGb('0\r\n'),0);
 assert.equal(parseWindowsPageFileUsageGb(''),null);assert.equal(parseWindowsPageFileUsageGb('  \r\n'),null);
 assert.equal(parseWindowsPageFileUsageGb('1024\r\nnope\r\n'),null);assert.equal(parseWindowsPageFileUsageGb('-5'),null);
});
const pageFileRun=pageFile=>async(command,args)=>{const script=args.at(-1);if(script.includes('Win32_PageFileUsage'))return {stdout:pageFile};if(script.includes('ProcessorQueueLength'))return {stdout:'0'};return {stdout:'5368709120000'};};
test('windows swap is page file use, not commit charge beyond physical memory',async()=>{
 const run=async(command,args)=>{const script=args.at(-1);if(script.includes('Win32_PageFileUsage'))return {stdout:'5311\r\n'};if(script.includes('Win32_OperatingSystem'))throw Error('commit charge probe must not run');if(script.includes('ProcessorQueueLength'))return {stdout:'0\n'};return {stdout:'5368709120000'};};
 const result=await machineGate({platform:'win32',run,now:at});
 assert.equal(result.swapGb,5311/1024);assert.equal(result.measurements.swapGb.source,'powershell Win32_PageFileUsage');assert.equal(result.ok,true);assert.equal(result.assessed,'pass');
 const empty=await machineGate({platform:'win32',run:pageFileRun(''),now:at});
 assert.equal(empty.swapGb,null);assert.equal(empty.coverage.swap,'unknown');assert.equal(empty.measurements.swapGb.error,'powershell Win32_PageFileUsage returned no usable value');
 const heavy=await machineGate({platform:'win32',run:pageFileRun('4096\r\n6144\r\n'),now:at,maxSwapGb:8});
 assert.equal(heavy.swapGb,10);assert.equal(heavy.ok,false);assert.deepEqual(heavy.reasons,['Swap 10.00 GB exceeds 8 GB']);
});
test('legacy callers keep ok, unknown, reasons and raw measurements',async()=>{
 const refusal=await machineGate({platform:'darwin',run:darwinRun('total = 4.00G used = 1024.00M free = 3.00G','{ 1.00 1.00 1.00 }',String(1024*1024)),now:at});
 assert.equal(refusal.ok,false);assert.match(refusal.reasons.join('; '),/Free disk/);assert.equal(typeof refusal.swapGb,'number');assert.equal(typeof refusal.load,'number');assert.equal(typeof refusal.freeGb,'number');assert.equal(refusal.path,'/');
 const quiet=await machineGate({platform:'linux',run:async()=>{throw Error('df exploded');},load:()=>[40],readFile:async()=>{throw Error('no meminfo');}});
 assert.equal(quiet.ok,true);assert.ok(quiet.unknown.length>0);assert.deepEqual(quiet.reasons,[]);
 await assert.rejects(machineGate({mode:'stealth'}),/mode/);
 await assert.rejects(machineGate({require:['cpu']}),/require/);
});
