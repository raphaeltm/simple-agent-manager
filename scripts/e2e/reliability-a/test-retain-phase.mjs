/** Real filesystem and owner upload/download verification; no external services. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {retainPhase,retainCheckpoint,phaseBundle,verifyBundle,snapshotRoot} from './retain-phase.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const home=await mkdtemp(join(tmpdir(),'sam-retention-')),cwd=process.cwd();let cases=0;
try{
 process.chdir(home);const own={taskId:'01M51ZZZZZZZZZZZZZZZZZZZZZ',sessionId:'11111111-2222-4333-8444-555555555555',branch:'sam/retention-case',agentProfileId:'01KRS7Z2R88JFC73ARA7DV9WTK',agentType:'claude-code'};own.receipt={taskId:own.taskId,sessionId:own.sessionId,branchName:own.branch,status:'queued'};
 const base=join(home,'.agent-evidence');await mkdir(base);const root=join(base,own.taskId);await mkdir(root,{mode:0o700});await mkdir(root+'/setup');
 const files=['.reliability-a/tracked.txt','.reliability-a/staged-new.txt','.reliability-a/untracked.txt','.do-state.md','.workflow-state.md'];
 const baseline={head:'a'.repeat(40),branch:own.branch,index:'b'.repeat(40),status:' M .reliability-a/tracked.txt',files:Object.fromEntries(files.map(n=>[n,'c'.repeat(64)])),stagedTracked:'staged tracked content',stagedNew:'staged new content',remoteRefs:'a'.repeat(40)+'\trefs/heads/main'};
 const objects={'asset-hashes.json':{checks:{assetHashesMatch:true},statuses:{hash:0}},'prepare.json':{checks:{prepared:true,localCommitUnpublished:true},statuses:{probe:0}},'baseline.json':baseline,'check.json':{checks:Object.fromEntries(['headUnchanged','branchUnchanged','indexUnchanged','statusUnchanged','filesUnchanged','stagedTrackedUnchanged','stagedNewUnchanged','remoteRefsUnchanged'].map(k=>[k,true])),statuses:{probe:0}},'record.json':{checks:{remoteRefsUnchanged:true,expectationsRecorded:true},statuses:{remoteRefs:0,prInventory:0}},'expectations.json':{repository:'serverspresentation2025/crewai',branch:own.branch,remoteRefs:{'refs/heads/main':'a'.repeat(40)},prs:[],recordedAt:'2026-10-16T00:00:00.000Z',prLimit:100}};
 const bytes=Object.fromEntries(Object.entries(objects).map(([n,v])=>[n,Buffer.from(JSON.stringify(v,null,2)+'\n')]));
 const done={taskId:own.taskId,sessionId:own.sessionId,runId:'11111111-2222-4333-8444-555555555555',operation:'setup',status:0,files:Object.fromEntries(Object.entries(bytes).map(([n,b])=>[n,sha(b)]))};
 for(const [n,b]of Object.entries(bytes))await writeFile(root+'/setup/'+n,b);await writeFile(root+'/setup/done.json',JSON.stringify(done));
 let clock=1000000;const args={root,phase:'setup',own,target:own,started:clock,hard:clock+2700000,sourceSha:'d'.repeat(40),now:()=>clock};
 let uploaded,events=[],mode='ok';
 const response=(status,b)=>({status:()=>status,body:async()=>b,headers:async()=>({'content-length':String(b.length)}),dispose:async()=>{events.push('dispose');}});
 const context={request:{fetch:async(url,o)=>{events.push(o.method==='POST'?'upload':'download');if(o.method==='POST'){uploaded=o.multipart.file.buffer;assert.equal(o.headers.Origin,'https://api.sammy.party');assert(!JSON.stringify(o.multipart).includes('SAM_PLAYWRIGHT'));if(mode==='upload-fail')return response(500,Buffer.from('{}'));return response(201,Buffer.from(JSON.stringify({id:'01M523ZZZZZZZZZZZZZZZZZZZZ',filename:o.multipart.file.name,projectId:'01KJNR9R3TEN3KX1ETE33852R8',directory:o.multipart.directory,uploadTaskId:o.multipart.uploadTaskId,uploadSessionId:mode==='foreign-metadata'?'foreign':o.multipart.uploadSessionId,uploadSource:'agent',sizeBytes:uploaded.length,status:'ready',replacedAt:null})));}if(mode==='late')clock+=90001;return response(200,mode==='mismatch'?Buffer.from('changed'):uploaded);}}};
 await snapshotRoot(root,own.taskId);const bundle=await phaseBundle(args);assert.equal(verifyBundle(bundle,bundle),sha(bundle));const decoded=JSON.parse(bundle);assert(Buffer.from(decoded.originals['baseline.json'],'base64').equals(bytes['baseline.json']));cases++;
 const receipt=await retainPhase({...args,context});assert.equal(receipt.sha256,sha(uploaded));assert.deepEqual(events,['upload','dispose','download','dispose']);assert((await readFile(root+'/exports/setup-retrieved.json')).equals(uploaded));cases++;
 // Retention must finish before caller can perform the next action.
 let advanced=false;mode='upload-fail';await assert.rejects(async()=>{await retainCheckpoint({...args,context,phase:'sleep',proof:{}});advanced=true;});assert.equal(advanced,false);cases++;
 mode='foreign-metadata';await assert.rejects(retainCheckpoint({...args,context,phase:'observer-sleep',proof:{}}),/upload/);cases++;
 mode='mismatch';await assert.rejects(retainCheckpoint({...args,context,phase:'wake',proof:{}}),/retrieval/);cases++;
 mode='late';await assert.rejects(retainCheckpoint({...args,context,phase:'complete',proof:{}}),/deadline/);cases++;
 clock=args.started;mode='ok';const calls=events.length;await assert.rejects(retainCheckpoint({...args,context,phase:'closing',hard:clock+540001,proof:{}}));assert.equal(events.length,calls);cases++;
 await assert.rejects(retainCheckpoint({...args,context,phase:'closing',proof:{error:'PRIVATE_CANARY'}}),/schema/);assert.equal(events.length,calls);cases++;
 await assert.rejects(retainCheckpoint({...args,context,phase:'closing',proof:{evidenceSha256:'PRIVATE_CANARY'}}),/schema/);cases++;
 await writeFile(root+'/setup/check.json',JSON.stringify({checks:{...objects['check.json'].checks,secret:'PRIVATE_CANARY'},statuses:{probe:0}}));await assert.rejects(phaseBundle(args),/hash/);cases++;
 await writeFile(root+'/setup/check.json',bytes['check.json']);const foreign={...done,taskId:'01M52ZZZZZZZZZZZZZZZZZZZZZ'};await writeFile(root+'/setup/done.json',JSON.stringify(foreign));await assert.rejects(phaseBundle(args),/manifest/);cases++;
 await writeFile(root+'/setup/done.json',JSON.stringify(done));await rm(root+'/setup/check.json');await symlink(root+'/setup/prepare.json',root+'/setup/check.json');await assert.rejects(phaseBundle(args),/path/);cases++;
 const alias=join(home,'alias');await symlink(base,alias);await assert.rejects(snapshotRoot(join(alias,own.taskId),own.taskId,alias),/path/);cases++;
 await assert.rejects(snapshotRoot(join(home,'tmp'),own.taskId),/path/);cases++;
 assert.equal(advanced,false);console.log(`PASS ${cases} retention cases; external calls simulated; real filesystem/original bytes/hash verification`);
}finally{process.chdir(cwd);await rm(home,{recursive:true,force:true});}
