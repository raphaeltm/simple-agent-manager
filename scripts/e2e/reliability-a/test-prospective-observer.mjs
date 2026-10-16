/** Offline actual Node observer + real local Git; gh/remote publication boundaries stubbed. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {capsule} from './prospective-vm.mjs';
import {validateInputs,inventory,refs,run} from './prospective-observer.mjs';
const root=await mkdtemp(join(tmpdir(),'sam-node-observer-')),exec=promisify(execFile),canary='PRIVATE_OBSERVER_CANARY';
const own={taskId:'01M51ZZZZZZZZZZZZZZZZZZZZZ',sessionId:'11111111-2222-4333-8444-555555555555',branch:'sam/prospective-codex',agentProfileId:'01KXG9MJRZ36FFJX0RVNW67SWB',agentType:'openai-codex'};
own.receipt={taskId:own.taskId,sessionId:own.sessionId,branchName:own.branch,status:'queued'};
const files=['.reliability-a/tracked.txt','.reliability-a/staged-new.txt','.reliability-a/untracked.txt','.do-state.md','.workflow-state.md'];
let cases=0;
try{
 const repo=join(root,'repo'),bin=join(root,'bin');await mkdir(bin);execFileSync('git',['init','--initial-branch=main',repo],{stdio:'ignore'});
 const realGit=execFileSync('which',['git']).toString().trim(),refText='a'.repeat(40)+'\trefs/heads/main\n'+'b'.repeat(40)+'\trefs/heads/sam/other\n';
 const baseline={head:'c'.repeat(40),branch:own.branch,index:'d'.repeat(40),status:' M .reliability-a/tracked.txt',files:Object.fromEntries(files.map(n=>[n,'e'.repeat(64)])),stagedTracked:'staged tracked content',stagedNew:'staged new content',remoteRefs:refText.trim()};
 const prs=['MERGED','CLOSED','OPEN'].map((state,i)=>({number:i+1,url:`https://github.com/serverspresentation2025/crewai/pull/${i+1}`,state,headRefName:own.branch}));
 const expected={repository:'serverspresentation2025/crewai',branch:own.branch,remoteRefs:refs(refText),prs,recordedAt:new Date(Date.now()-10000).toISOString(),prLimit:100},completedAt=new Date(Date.now()-1000).toISOString();
 const originals={baseline:JSON.stringify(baseline),expectations:JSON.stringify(expected),completedAt};
 await writeFile(join(bin,'git'),`#!/bin/sh\nif [ "$1" = ls-remote ]; then printf '%s' '${canary}' >&2; cat "$REF_FILE"; else exec '${realGit}' "$@"; fi\n`);
 await writeFile(join(bin,'gh'),`#!/bin/sh\n[ "$1 $2 $3" = 'pr list --repo' ] || exit 2\n[ "$6" = '${own.branch}' ] || exit 2\n[ "$7 $8 $9" = '--state all --limit' ] || exit 2\nprintf '%s' '${canary}' >&2\ncat "$PR_FILE"\n`);
 for(const n of ['git','gh'])await chmod(join(bin,n),0o700);
 const env={...process.env,PATH:bin+':'+process.env.PATH,REF_FILE:join(root,'refs'),PR_FILE:join(root,'prs')};
 await writeFile(env.REF_FILE,refText);await writeFile(env.PR_FILE,JSON.stringify(prs));
 async function attempt(name,originalPatch={},transform=x=>x){
  cases++;const v=await capsule(own,'observe',{...originals,...originalPatch});const command=transform(v.command.replaceAll('/workspaces/reliability-prospective',root+'/remote'));
  assert(command.split('\n').every(l=>Buffer.byteLength(l)<3800));assert(!command.includes('python'));
  const result=await exec('bash',['--noprofile','--norc','-c',command],{cwd:repo,env,timeout:20000,maxBuffer:200000}).catch(e=>{assert.equal(e.code,1);return {stdout:e.stdout,stderr:e.stderr};});assert(!result.stdout.includes(canary)&&!result.stderr.includes(canary));
  const dir=v.directory.replace('/workspaces/reliability-prospective',root+'/remote'),done=JSON.parse(await readFile(dir+'/done.json'));
  assert.equal(done.operation,'observe');assert.equal(done.taskId,own.taskId);assert.equal(done.runId,v.runId);
  return {done,dir};
 }
 const success=await attempt('success');assert.equal(success.done.status,0);assert.deepEqual(Object.keys(success.done.files).sort(),['asset-hashes.json','observer.json']);
 const observer=JSON.parse(await readFile(success.dir+'/observer.json'));assert(Object.values(observer.checks).every(v=>v===true));assert.deepEqual(observer.statuses,{remoteRefs:0,prInventory:0});
 await writeFile(env.REF_FILE,refText.replace('a'.repeat(40),'f'.repeat(40)));assert.equal((await attempt('tampered-refs')).done.status,1);await writeFile(env.REF_FILE,refText);
 await writeFile(env.PR_FILE,JSON.stringify(prs.map((p,i)=>i? p:{...p,state:'OPEN'})));assert.equal((await attempt('tampered-closed-pr')).done.status,1);await writeFile(env.PR_FILE,JSON.stringify(prs));
 assert.equal((await attempt('tampered-package',{},s=>s.replace(/(printf '%s' ')[A-Za-z0-9+/]/,'$1!'))).done.status,1);
 const ghOriginal=await readFile(join(bin,'gh'));await writeFile(join(bin,'gh'),'#!/bin/sh\nexit 127\n');assert.equal((await attempt('missing-gh')).done.status,1);await writeFile(join(bin,'gh'),ghOriginal);
 assert.equal((await attempt('missing-runtime',{},s=>s.replaceAll('/usr/local/bin/node','/no-observer-node-a').replaceAll('/usr/bin/node','/no-observer-node-b').replaceAll('/opt/node/bin/node','/no-observer-node-c').replace('$(command -v node 2>/dev/null)',''))).done.status,1);
 assert.throws(()=>validateInputs(baseline,{...expected,extra:true},{branch:own.branch,completedAt}));
 assert.throws(()=>validateInputs(baseline,expected,{branch:own.branch,completedAt:expected.recordedAt}));
 assert.throws(()=>inventory(Array(100).fill(prs[0]),expected.repository,own.branch,100));
 assert.throws(()=>inventory([{...prs[0],headRefName:'sam/foreign'}],expected.repository,own.branch,100));
 assert.throws(()=>refs(refText+refText));
 // A child and its descendant retain pipes; native deadline must kill the group.
 const pidFile=join(root,'child-pid');const start=Date.now();
 await assert.rejects(run([process.execPath,'-e',`const {spawn}=require('child_process');const f=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});f.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`],Date.now()+200));
 assert(Date.now()-start<1500);const pid=Number(await readFile(pidFile,'utf8'));
 let alive=true;for(let i=0;i<30;i++){try{const stat=await readFile(`/proc/${pid}/stat`,'utf8');if(stat.split(' ')[2]==='Z'){alive=false;break;}}catch{alive=false;break;}await new Promise(r=>setTimeout(r,20));}assert(!alive,'descendant still running');
 console.log(JSON.stringify({ok:true,actualNodeCapsules:cases,liveCalls:0,missingRuntimeFailure:true,fullRefsAndAllPrStates:true,deadlineAndChildGroupCleanup:true,limits:'Node/Git/shell real; remote refs and gh responses stubbed; missing Node simulated by hiding fixed discovery candidates'}));
}finally{await rm(root,{recursive:true,force:true});}
