/** Offline real capsule+real terminal phase, simulated owner HTTP/socket only. No service calls. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=await mkdtemp(join(tmpdir(),'sam-prospective-contract-')),source=new URL('.',import.meta.url);
const canary='PRIVATE_HELPER_CANARY_NEVER_EMIT',sha=x=>createHash('sha256').update(x).digest('hex');
const exec=(cmd,args,cwd,env)=>execFileSync(cmd,args,{cwd,env,stdio:['ignore','pipe','pipe'],maxBuffer:2000000});
let cases=0;
try{
 const modules=join(root,'modules');await mkdir(modules);
 for(const name of ['prospective-vm.mjs','owner-terminal-inspect.mjs','queue-controller.mjs','git-probe.py','b-probe.py','terminal-observer.py'])await copyFile(new URL(name,source),join(modules,name));
 await copyFile(new URL('prospective-capsule.py',source),join(modules,'prospective-capsule.py'));
 const {terminalPhase,AcceptanceSequence,capsule,releaseProvenance}=await import(pathToFileURL(join(modules,'prospective-vm.mjs')));
 const realGit=exec('which',['git']).toString().trim(),remote=join(root,'remote.git'),repo=join(root,'repo'),bin=join(root,'bin');await mkdir(bin);
 exec(realGit,['init','--bare','--initial-branch=main',remote]);exec(realGit,['init','--initial-branch=main',repo]);
 await writeFile(join(repo,'seed'),'seed');exec(realGit,['add','seed'],repo);exec(realGit,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','seed'],repo);
 exec(realGit,['remote','add','origin',remote],repo);exec(realGit,['push','origin','main'],repo);
 const own={taskId:'01M51ZZZZZZZZZZZZZZZZZZZZZ',sessionId:'11111111-2222-4333-8444-555555555555',branch:'sam/prospective-claude',agentProfileId:'01KRS7Z2R88JFC73ARA7DV9WTK',agentType:'claude-code'};
 own.receipt={taskId:own.taskId,sessionId:own.sessionId,branchName:own.branch,status:'queued'};exec(realGit,['checkout','-b',own.branch],repo);
 await writeFile(join(bin,'git'),'#!/usr/bin/env python3\nimport os,sys\na=sys.argv[1:]\nif a[:2]==["ls-remote","--heads"] and a[2].startswith("https://github.com/"):a[2]='+JSON.stringify(remote)+'\nprint('+JSON.stringify(canary)+',file=sys.stderr)\nos.execv('+JSON.stringify(realGit)+',['+JSON.stringify(realGit)+',*a])\n');
 await writeFile(join(bin,'gh'),'#!/bin/sh\nprintf "%s\\n" "'+canary+'" >&2\nprintf "[]\\n"\n');exec('chmod',['700',join(bin,'git'),join(bin,'gh')]);
 const env={...process.env,PATH:bin+':'+process.env.PATH};
 const ptyRunner=join(root,'pty-runner.py');
 await writeFile(ptyRunner,`import os,pty,subprocess,select,sys,time,pathlib
master,slave=pty.openpty()
child=subprocess.Popen(['bash','--noprofile','--norc','-i'],stdin=slave,stdout=slave,stderr=slave,cwd=sys.argv[2],start_new_session=True)
os.close(slave)
command=pathlib.Path(sys.argv[1]).read_bytes()+b"\\nprintf '\\\\nSAM_TEST_TERMINAL_DONE\\\\n'\\nexit\\n"
position=0;data=b'';deadline=time.monotonic()+90
try:
 while time.monotonic()<deadline:
  readable,writable,_=select.select([master],[master] if position<len(command) else [],[],0.02)
  if readable:
   try:part=os.read(master,65536)
   except OSError:break
   if not part:break
   data=(data+part)[-1000000:]
  if writable:
   position+=os.write(master,command[position:position+512])
  if child.poll() is not None:break
 child.wait(timeout=2)
 assert b'SAM_TEST_TERMINAL_DONE' in data
finally:
 if child.poll() is None:child.kill();child.wait()
 os.close(master)
`);

 let invalidProvenance=false,grantPatch={},clockOverride=null,expireAfterInput=false;
 let identity=own,operation='setup',originals={},downloadCorrupt=false,closed=false,disposed=false,targetReads=0;const payloads=[];
 const workspace='01M51YYYYYYYYYYYYYYYYYYYYY',node='01M51XXXXXXXXXXXXXXXXXXXXX',acp='01M51WWWWWWWWWWWWWWWWWWWWW';
 const grant=()=>({releaseProvenance:invalidProvenance?{...releaseProvenance,rawHostShaObserved:true}:releaseProvenance,globalVmCount:1,otherWorkspaceCount:0,activeForeignClaimCount:0,workspaceId:workspace,nodeId:node,agentSessionId:acp,ownerId:'owner',expectedProfileOwnerId:'owner',runtime:identity===own?'vm':'cf-container',agentVersion:'b467f389811eadeaf973960bb30f9fa7b9cb4678',expiresAt:Date.now()+200000,storedProfileId:identity.agentProfileId,storedProfileObservedAt:Date.now(),receipt:Object.fromEntries(Object.entries(identity.receipt).sort(([a],[b])=>a.localeCompare(b))),...grantPatch});
 const response=(v,status=200)=>{const b=Buffer.isBuffer(v)?v:Buffer.from(JSON.stringify(v));return {status:()=>status,body:async()=>b,headers:async()=>({'content-length':String(b.length)}),dispose:async()=>{}};};
 const context={request:{fetch:async(url,options)=>{
  assert.equal(options.maxRedirects,0);
  if(url.endsWith('/api/auth/get-session'))return response({user:{id:'owner'}});
  const profile={id:identity.agentProfileId,userId:'owner',projectId:'01KJNR9R3TEN3KX1ETE33852R8',name:canary,agentType:identity.agentType,runtime:identity===own?'vm':'cf-container',vmSizeOverride:null};
  if(url.includes('/agent-profiles/'))return response(profile);
  if(url.endsWith('/agent-profiles'))return response({items:[profile]});
  if(url.includes('/tasks/')){
   if(identity!==own&&url.endsWith(own.taskId)){targetReads++;return response({id:own.taskId,projectId:'01KJNR9R3TEN3KX1ETE33852R8',userId:'owner',outputBranch:own.branch,status:'completed',completedAt:originals.completedAt,completionEvidence:{prUrl:'https://github.com/raphaeltm/simple-agent-manager/pull/2355'}});}
   return response({id:identity.taskId,projectId:'01KJNR9R3TEN3KX1ETE33852R8',userId:'owner',outputBranch:identity.branch,status:'in_progress',workspaceId:workspace,agentProfileHint:canary});
  }
  if(url.endsWith('/state'))return response({agentSessionId:acp,agentType:identity.agentType,state:{activity:'idle',runtimeWorkState:'inactive',runtimeWorkCount:0,activityAt:Date.now(),runtimeWorkUpdatedAt:Date.now()}});
  if(url.includes('/sessions/'))return response({session:{id:identity.sessionId,taskId:identity.taskId,workspaceId:workspace,agentSessionId:acp,agentType:identity.agentType}});
  if(url.endsWith('/api/workspaces/'+workspace))return response({id:workspace,nodeId:node,projectId:'01KJNR9R3TEN3KX1ETE33852R8',chatSessionId:identity.sessionId,branch:identity.branch,repository:'serverspresentation2025/crewai',status:'running',hardware:{cloudProvider:identity===own?'hetzner':'cloudflare'}});
  if(url.endsWith('/api/terminal/token'))return response({workspaceUrl:'https://ws-'+workspace+'.sammy.party',token:canary.repeat(3),expiresAt:new Date(Date.now()+200000).toISOString()});
  if(url.includes('/files/download?')){const path=new URL(url).searchParams.get('path').replace('/workspaces/reliability-prospective',root+'/remote-phase');try{const b=await readFile(path);return response(downloadCorrupt&&path.endsWith('/done.json')?Buffer.from('{}'):b);}catch{return response({},404);}}
  throw Error('unexpected');
 }}};
 const open=async()=>({send:async f=>{
  if(f.type==='input'){
   const command=f.data.data;assert(command.split('\n').every(x=>Buffer.byteLength(x)<3800));payloads.push(command);
   const commandFile=join(root,'command-'+payloads.length);await writeFile(commandFile,command.replaceAll('/workspaces/reliability-prospective',root+'/remote-phase'));
   const output=exec('python3',[ptyRunner,commandFile,repo],repo,env);assert.equal(output.length,0);if(expireAfterInput)clockOverride=Date.now()+85001;
  }if(f.type==='close_session')closed=true;
 },state:async()=>({created:true,closed,failed:false}),dispose:async()=>{disposed=true;}});
 const invoke=async(name)=>{cases++;const dir=join(root,name);await mkdir(dir);closed=false;disposed=false;const result=await terminalPhase({own:identity,operation,originals,context,page:{},grant:grant(),evidenceDirectory:dir,open,now:()=>clockOverride??Date.now()});assert(!JSON.stringify(result).includes(canary));return {result,dir};};
 const setup=await invoke('setup');assert(setup.result.ok&&setup.result.hostBytesRetained&&closed&&disposed);assert((await readFile(join(setup.dir,'done.json'))).length>100);
 originals={baseline:await readFile(join(setup.dir,'baseline.json')),expectations:await readFile(join(setup.dir,'expectations.json'))};
 const originalBaseline=Buffer.from(originals.baseline);operation='check';invalidProvenance=true;assert(!(await invoke('invented-host-proof')).result.ok);invalidProvenance=false;
 for(const [n,patch]of [['foreign-receipt',{receipt:{...identity.receipt,taskId:'01M51VVVVVVVVVVVVVVVVVVVVV'}}],['undefined-expiry',{expiresAt:undefined}],['string-expiry',{expiresAt:'future'}],['infinite-expiry',{expiresAt:Infinity}],['undefined-observed',{storedProfileObservedAt:undefined}],['string-observed',{storedProfileObservedAt:'now'}],['zero-observed',{storedProfileObservedAt:0}]]){grantPatch=patch;assert(!(await invoke(n)).result.ok);}grantPatch={};
 expireAfterInput=true;const expired=await invoke('action-expired-close');assert(!expired.result.ok&&expired.result.terminalClosed&&expired.result.socketClosed);expireAfterInput=false;clockOverride=null;
 assert((await invoke('turn-check')).result.ok);assert((await invoke('wake-check')).result.ok);
 // Damaged original is rejected, never replaced from the copied host baseline.
 await writeFile(join(repo,'.reliability-a/untracked.txt'),'changed');assert(!(await invoke('damaged')).result.ok);assert.deepEqual(await readFile(join(repo,'.reliability-a/baseline.json')),originalBaseline);
 await writeFile(join(repo,'.reliability-a/untracked.txt'),'untracked preservation fixture\n');
 downloadCorrupt=true;assert(!(await invoke('bad-manifest')).result.ok);downloadCorrupt=false;
 const observer={taskId:'01M50VYZ60RQXXTGSVPXW6FRXD',sessionId:'4e5282b9-0cd5-454f-a8f0-db160b9823fe',branch:'sam/bootstrap-only-authorized-reliability-w6frxd',agentProfileId:'01KYQ5YDHC1VS0BZ9F3NY97FNH',agentType:'openai-codex'};observer.receipt={taskId:observer.taskId,sessionId:observer.sessionId,branchName:observer.branch,status:'queued'};
 identity=observer;operation='observe';originals={...originals,target:own,completedAt:new Date().toISOString()};assert((await invoke('independent-observe')).result.ok);assert(targetReads>0);
 const started=Date.now()-20000,seq=new AcceptanceSequence(own,started,started+2700000);assert.throws(()=>seq.append('complete',{ok:true},Date.now()));
 for(const [kind,proof]of [['setup',{baselineOriginal:true,expectationsOriginal:true,hostBytesRetained:true}],['turn',{actualHarness:true,freshInactive:true,prompt202:true}],['turn-check',{}],['sleep',{snapshotAvailable:true,sleep200:true,snapshotId:'snapshot'}],['wake',{actualHarness:true,freshInactive:true,prompt202:true}],['wake-check',{}],['complete',{actualTool:true,canonicalCompletedAt:new Date().toISOString(),completionEvidence:true}],['observe',{independentRuntime:true,originalBaseline:true,originalExpectations:true,afterCanonical:true,allRefsAllPrStates:true}]])seq.append(kind,{ok:true,...proof},started+1000+seq.events.length);
 assert(seq.pass);assert.throws(()=>seq.append('setup',{ok:true},Date.now()));
 assert.throws(()=>new AcceptanceSequence(own,started,started+2700001));
 const producerSource=await readFile(new URL('prospective-proof.py',source),'utf8');assert(producerSource.includes("sort_keys=True"));
 const capsuleSource=await readFile(new URL('prospective-capsule.py',source),'utf8');assert(!capsuleSource.includes('/etc/sam/')&&!capsuleSource.includes('/usr/local/bin/vm-agent'));
 const packed=await capsule(own,'setup');assert(packed.command.split('\n').every(x=>Buffer.byteLength(x)<3800));assert(!packed.command.includes(canary));
 console.log(JSON.stringify({ok:true,cases,actualPtyExecutions:payloads.length,sequenceAndDeadlineNegatives:true,originalBytesRetained:true,canarySuppressed:true,liveCalls:0,limits:'simulated HTTP/socket/node-release provenance; actual local PTY/Bash/Python/Git'}));
}finally{await rm(root,{recursive:true,force:true});}
