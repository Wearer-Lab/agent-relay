import test from 'node:test';import assert from 'node:assert/strict';import {machineGate} from '../lib/gate.mjs';
test('macOS gate parses read-only measurements and refuses each exceeded limit',async()=>{
 const run=async(command,args)=>({stdout:command==='df'?'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 20000000 15000000 5000000 75% /\n':args[1]==='vm.swapusage'?'total = 12.00G used = 9216.00M free = 3.00G':'{ 41.00 20.00 10.00 }'});
 const result=await machineGate({platform:'darwin',run});assert.equal(result.swapGb,9);assert.equal(result.load,41);assert.equal(result.reasons.length,3);assert.equal(result.ok,false);
});
test('gate reports unknown values and permits exact boundary values',async()=>{
 const result=await machineGate({platform:'linux',run:async()=>{throw Error('unknown');},load:()=>[40]});assert.equal(result.ok,true);assert.deepEqual(result.unknown,['swap','free disk']);
 await assert.rejects(machineGate({maxSwapGb:-1}),/nonnegative/);
});
