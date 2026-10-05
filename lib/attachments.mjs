import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const FILE_LIMIT=25*1024*1024,TOTAL_LIMIT=100*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validAttachment(a){return a&&typeof a.name==='string'&&a.name.length>0&&a.name===path.basename(a.name)&&!/[\x00-\x1f]/u.test(a.name)&&/^[a-f0-9]{64}$/u.test(a.sha256)&&Number.isSafeInteger(a.size)&&a.size>=0&&a.size<=FILE_LIMIT;}
async function boundedRead(file){
 const handle=await fs.open(file,'r');
 try{
  const stat=await handle.stat();if(!stat.isFile())throw Error('Attachment must be a regular file');
  if(stat.size>FILE_LIMIT)throw Error('Attachment exceeds 25 MB capacity');
  const bytes=Buffer.alloc(stat.size+1);let length=0;
  while(length<bytes.length){const {bytesRead}=await handle.read(bytes,length,bytes.length-length,null);if(!bytesRead)break;length+=bytesRead;}
  if(length!==stat.size)throw Error('Attachment changed while reading');return bytes.subarray(0,length);
 }finally{await handle.close();}
}
export async function storeAttachments(dataDir,files=[]){
 if(!Array.isArray(files)||files.length>64||files.some(f=>typeof f!=='string'||!path.isAbsolute(f)))throw Error('Attachments require up to 64 absolute file paths');
 if(!files.length)return [];
 let incoming=0;
 for(const file of files){const stat=await fs.stat(file);if(!stat.isFile())throw Error('Attachment must be a regular file');if(stat.size>FILE_LIMIT)throw Error('Attachment exceeds 25 MB capacity');incoming+=stat.size;}
 if(incoming>TOTAL_LIMIT)throw Error('Attachment batch exceeds 100 MB capacity');
 const prepared=[];
 for(const file of files){const bytes=await boundedRead(file);const item={name:path.basename(file),size:bytes.length,sha256:hash(bytes)};if(!validAttachment(item))throw Error('Invalid attachment filename');prepared.push({item,bytes});}
 const directory=path.join(dataDir,'attachments');await fs.mkdir(directory,{recursive:true,mode:0o700});
 let total=0;const existing=new Set();
 for(const name of await fs.readdir(directory)){const stat=await fs.stat(path.join(directory,name));total+=stat.size;existing.add(name);}
 const unique=new Map(prepared.map(p=>[p.item.sha256,p]));
 for(const [sha,p] of unique)if(!existing.has(sha))total+=p.bytes.length;
 if(total>TOTAL_LIMIT)throw Error('Attachment storage reached 100 MB capacity; nothing is deleted');
 for(const [sha,p] of unique){
  const destination=path.join(directory,sha);
  if(existing.has(sha)){const bytes=await boundedRead(destination);if(hash(bytes)!==sha)throw Error('Stored attachment hash mismatch');continue;}
  const temporary=path.join(directory,`.${randomUUID()}.tmp`);const handle=await fs.open(temporary,'wx',0o600);
  try{await handle.writeFile(p.bytes);await handle.sync();}finally{await handle.close();}
  await fs.rename(temporary,destination);
 }
 let handle;try{handle=await fs.open(directory,'r');await handle.sync();}catch(e){if(!['EINVAL','ENOTSUP','EISDIR'].includes(e.code)&&!(process.platform==='win32'&&['EPERM','EACCES'].includes(e.code)))throw e;}finally{await handle?.close();}
 return prepared.map(p=>p.item);
}
export async function fetchAttachments(dataDir,attachments,out){
 out=path.resolve(out);await fs.mkdir(out,{recursive:true,mode:0o700});
 const verified=[];
 for(const item of attachments){if(!validAttachment(item))throw Error('Invalid attachment metadata');const bytes=await boundedRead(path.join(dataDir,'attachments',item.sha256));if(bytes.length!==item.size||hash(bytes)!==item.sha256)throw Error('Attachment hash or size mismatch');verified.push({item,bytes});}
 const files=[];
 for(const [index,{item,bytes}] of verified.entries()){
  const file=path.join(out,`${index+1}-${item.sha256.slice(0,12)}-${item.name}`);await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});files.push({...item,path:file});
 }
 return files;
}
