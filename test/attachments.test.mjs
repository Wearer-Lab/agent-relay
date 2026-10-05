import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {storeAttachments,fetchAttachments} from '../lib/attachments.mjs';
test('durable copies survive source removal and fetch refuses corrupt content',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-files-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'packet');await fs.writeFile(source,'packet bytes');const items=await storeAttachments(dir,[source]);await fs.unlink(source);
 const files=await fetchAttachments(dir,items,path.join(dir,'out'));assert.equal(await fs.readFile(files[0].path,'utf8'),'packet bytes');
 await fs.writeFile(path.join(dir,'attachments',items[0].sha256),'corrupt');await assert.rejects(fetchAttachments(dir,items,path.join(dir,'bad')),/mismatch/);
});
test('attachment capacity rejects oversized files and full storage without deleting data',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-capacity-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'large');await fs.writeFile(file,'');await fs.truncate(file,25*1024*1024+1);
 await assert.rejects(storeAttachments(dir,[file]),/25 MB/);await fs.writeFile(file,'x');await fs.mkdir(path.join(dir,'attachments'));const retained=path.join(dir,'attachments','retained');await fs.writeFile(retained,'');await fs.truncate(retained,100*1024*1024);
 await assert.rejects(storeAttachments(dir,[file]),/100 MB/);assert.equal((await fs.stat(retained)).size,100*1024*1024);
});
