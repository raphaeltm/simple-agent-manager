/** Verification-only immutable originals export using the existing authenticated Library API. */
import {readFile,writeFile,lstat,realpath,mkdir} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {identity,project,repository} from './prospective-vm.mjs';
import {baselineArtifact,expectationsArtifact,probeArtifact} from './queue-controller.mjs';
const api='https://api.sammy.party';
const digest=b=>createHash('sha256').update(b).digest('hex');
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.slice().sort().join();
const phases={'setup':'setup','turn-check':'check','wake-check':'check','observe':'observe'};
const names={setup:['asset-hashes.json','prepare.json','baseline.json','check.json','record.json','expectations.json'],check:['asset-hashes.json','check.json','publication.json'],observe:['asset-hashes.json','observer.json']};
export async function snapshotRoot(root,taskId,base=resolve(process.cwd(),'.agent-evidence')){
 const expected=resolve(base,taskId);if(root!==expected)throw Error('retention-path');
 // Every component must be a real directory: no symlink parent can redirect originals to /tmp.
 for(let p=expected;;p=dirname(p)){const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink())throw Error('retention-path');if(p===dirname(p))break;}
 if(await realpath(expected)!==expected||!expected.startsWith(resolve(base)+sep))throw Error('retention-path');
}
export async function phaseBundle({root,phase,own,target,started,hard,sourceSha}){
 identity(own);identity(target);const operation=phases[phase];if(!operation||!/^[0-9a-f]{40}$/.test(sourceSha)||!Number.isSafeInteger(started)||!Number.isSafeInteger(hard)||hard-started!==2700000)throw Error('retention-binding');
 const dir=root+'/'+phase;const ds=await lstat(dir);if(!ds.isDirectory()||ds.isSymbolicLink())throw Error('retention-path');
 const load=async n=>{const p=dir+'/'+n,s=await lstat(p);if(!s.isFile()||s.isSymbolicLink()||s.size>131072)throw Error('retention-path');const b=await readFile(p);if(b.length>131072)throw Error('retention-size');return b;};
 const original=await load('done.json'),done=JSON.parse(original);const files=names[operation];
 if(!exact(done,['taskId','sessionId','runId','operation','status','files'])||done.taskId!==own.taskId||done.sessionId!==own.sessionId||!/^[-0-9a-f]{36}$/.test(done.runId)||done.operation!==operation||done.status!==0||!exact(done.files,files))throw Error('retention-manifest');
 const bytes={'done.json':original};for(const n of files){const b=await load(n);if(digest(b)!==done.files[n])throw Error('retention-hash');bytes[n]=b;}
 const probe=(n,p)=>{const v=probeArtifact(JSON.parse(bytes[n]),p);if(!Object.values(v.checks).every(x=>x===true)||!Object.values(v.statuses).every(x=>x===0))throw Error('retention-schema');};
 probe('asset-hashes.json','asset-hashes');
 if(operation==='setup'){const b=baselineArtifact(JSON.parse(bytes['baseline.json']),target.branch);expectationsArtifact(JSON.parse(bytes['expectations.json']),b,repository);probe('prepare.json','a-prepare');probe('record.json','observer-record');}
 if(operation==='observe')probe('observer.json','observer-check');else probe('check.json','a-check');
 if(operation==='check'){const p=JSON.parse(bytes['publication.json']);if(!exact(p,['checks','statuses'])||!exact(p.checks,['remoteRefsUnchanged','taskBranchPrInventoryUnchanged'])||!exact(p.statuses,['remoteRefs','prInventory'])||!Object.values(p.checks).every(v=>v===true)||!Object.values(p.statuses).every(v=>v===0))throw Error('retention-schema');}
 const manifest={taskId:target.taskId,sessionId:target.sessionId,observerTaskId:own.taskId,phase,sourceSha,started,hard,files:Object.fromEntries(Object.entries(bytes).sort().map(([n,b])=>[n,{size:b.length,sha256:digest(b)}]))};
 return Buffer.from(JSON.stringify({manifest,originals:Object.fromEntries(Object.entries(bytes).sort().map(([n,b])=>[n,b.toString('base64')]))}));
}
export function verifyBundle(actual,expected){
 if(actual.length>1500000||!actual.equals(expected))throw Error('retention-retrieval');
 const v=JSON.parse(actual);if(!exact(v,['manifest','originals'])||!exact(v.originals,Object.keys(v.manifest.files)))throw Error('retention-retrieval');
 for(const [n,m]of Object.entries(v.manifest.files)){if(!/^[a-z-]+\.json$/.test(n)||!exact(m,['size','sha256']))throw Error('retention-retrieval');const b=Buffer.from(v.originals[n],'base64');if(b.length!==m.size||digest(b)!==m.sha256)throw Error('retention-retrieval');}
 return digest(actual);
}
async function retainBytes({context,root,phase,target,started,hard,sourceSha,bytes,now=Date.now}){
 // No durable-message roundtrip. Same finite owner browser context, separate upload and retrieval.
 const until=Math.min(now()+90000,hard-540000);if(until-now()<90000)throw Error('retention-deadline');
 const left=()=>{const n=until-now();if(n<=0)throw Error('retention-deadline');return n;};
 await snapshotRoot(root,target.taskId);
 const filename=phase+'-'+digest(bytes)+'.json',directory='/engineering/reliability/'+target.taskId+'/'+sourceSha+'/';
 const exportDir=root+'/exports';await mkdir(exportDir,{mode:0o700,recursive:true});if((await lstat(exportDir)).isSymbolicLink())throw Error('retention-path');
 await writeFile(exportDir+'/'+filename,bytes,{mode:0o600,flag:'wx'});left();
 let r;try{
  r=await context.request.fetch(api+'/api/projects/'+project+'/library/upload',{method:'POST',headers:{Origin:api},multipart:{file:{name:filename,mimeType:'application/json',buffer:bytes},directory,uploadSource:'agent',uploadTaskId:target.taskId,uploadSessionId:target.sessionId},timeout:left(),maxRedirects:0,failOnStatusCode:false});
  if(r.status()!==201)throw Error('retention-upload');const body=await r.body();if(body.length>32768)throw Error('retention-upload');const v=JSON.parse(body);if(!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(v.id)||v.filename!==filename||v.projectId!==project||v.directory!==directory||v.uploadTaskId!==target.taskId||v.uploadSessionId!==target.sessionId||v.uploadSource!=='agent'||v.sizeBytes!==bytes.length||v.status!=='ready'||v.replacedAt!==null)throw Error('retention-upload');
  await r.dispose();r=null;left();
  r=await context.request.fetch(api+'/api/projects/'+project+'/library/'+v.id+'/download',{headers:{Origin:api},timeout:left(),maxRedirects:0,failOnStatusCode:false});
  if(r.status()!==200)throw Error('retention-download');const cl=(await r.headers())['content-length'];if(cl!==undefined&&(!/^\d+$/.test(cl)||Number(cl)>1500000))throw Error('retention-size');const downloaded=await r.body();left();const sha256=verifyBundle(downloaded,bytes);
  await writeFile(exportDir+'/'+phase+'-retrieved.json',downloaded,{mode:0o600,flag:'wx'});
  const receipt={taskId:target.taskId,sessionId:target.sessionId,phase,sourceSha,started,hard,fileId:v.id,sha256,verifiedAt:now()};
  await writeFile(exportDir+'/'+phase+'-receipt.json',JSON.stringify(receipt),{mode:0o600,flag:'wx'});left();return receipt;
 }finally{if(r)await r.dispose();}
}

export async function retainPhase(args){
 const bytes=await phaseBundle(args);return retainBytes({...args,bytes});
}
export async function retainCheckpoint(args){
 const {phase,target,started,hard,sourceSha,proof}=args;identity(target);
 if(!['start','sleep','wake','complete','observer-sleep','closing'].includes(phase)||!/^[0-9a-f]{40}$/.test(sourceSha)||hard-started!==2700000)throw Error('retention-binding');
 // Fixed identifiers/times/digests only. No arbitrary state/config/errors/transcripts.
 const keys=['snapshotId','workspaceId','generationSha256','completedAt','evidenceSha256','toolMetadataSha256','originalCompletedAt'];
 if(!proof||typeof proof!=='object'||Array.isArray(proof)||Object.keys(proof).some(k=>!keys.includes(k)))throw Error('retention-schema');
 for(const [k,v]of Object.entries(proof)){
  if(k.endsWith('Sha256')){if(!/^[0-9a-f]{64}$/.test(v))throw Error('retention-schema');}
  else if(k.endsWith('Id')){if(!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(v))throw Error('retention-schema');}
  else if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v)||!Number.isFinite(Date.parse(v)))throw Error('retention-schema');
 }
 const original=Buffer.from(JSON.stringify({taskId:target.taskId,sessionId:target.sessionId,phase,started,hard,sourceSha,proof}));
 const bytes=Buffer.from(JSON.stringify({manifest:{taskId:target.taskId,sessionId:target.sessionId,phase,sourceSha,started,hard,files:{'checkpoint.json':{size:original.length,sha256:digest(original)}}},originals:{'checkpoint.json':original.toString('base64')}}));
 return retainBytes({...args,bytes});
}
