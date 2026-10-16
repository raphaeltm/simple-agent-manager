/** Real lifecycle controller and sequence; external browser/terminal/CF producers simulated. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=await mkdtemp(join(tmpdir(),'sam-prospective-sequence-')),source=new URL('.',import.meta.url);
try{
 const modules=join(root,'modules');await mkdir(modules);
 for(const n of ['owner-terminal-inspect.mjs','queue-controller.mjs'])await copyFile(new URL(n,source),join(modules,n));
 const library=await readFile(new URL('prospective-vm.mjs',source),'utf8');
 await writeFile(join(modules,'prospective-vm.mjs'),library.replace('export async function terminalPhase(', 'async function originalTerminalPhase(')+'\nexport const terminalPhase=(v)=>globalThis.__prospectiveTest.phase(v);\n');
 const playwright=join(root,'playwright.mjs');await writeFile(playwright,'export const chromium={launch:()=>globalThis.__prospectiveTest.browser};');
 const caller=await readFile(new URL('prospective-vm-controller.mjs',source),'utf8');
 await writeFile(join(modules,'caller.mjs'),caller.replace('/tmp/reliability-browser-deps/node_modules/playwright/index.mjs',playwright).replaceAll('Date.now()', 'globalThis.__prospectiveTest.now()').replace('const pause=ms=>new Promise(r=>setTimeout(r,ms));','const pause=async()=>{await new Promise(r=>setTimeout(r,10));};'));
 const {run}=await import(pathToFileURL(join(modules,'caller.mjs')));
 const {snapshotProof,completionProof}=await import(pathToFileURL(join(modules,'prospective-vm.mjs')));
 const own={taskId:'01M51ZZZZZZZZZZZZZZZZZZZZZ',sessionId:'11111111-2222-4333-8444-555555555555',branch:'sam/prospective-claude',agentProfileId:'01KRS7Z2R88JFC73ARA7DV9WTK',agentType:'claude-code'};
 const observer={taskId:'01M50VYZ60RQXXTGSVPXW6FRXD',sessionId:'4e5282b9-0cd5-454f-a8f0-db160b9823fe',branch:'sam/bootstrap-only-authorized-reliability-w6frxd',agentProfileId:'01KYQ5YDHC1VS0BZ9F3NY97FNH',agentType:'openai-codex'};
 for(const x of [own,observer])x.receipt={taskId:x.taskId,sessionId:x.sessionId,branchName:x.branch,status:'queued'};
 let count=0;
 for(const mode of ['success','setup-failure','wake-check-failure','complete-missing-notes']){
  count++;const dir=join(root,mode);await mkdir(dir);process.env.SAM_PROSPECTIVE_ROOT=dir;process.env.SAM_PLAYWRIGHT_PRIMARY_USER='SYNTHETIC_PRIVATE_CANARY';
  const started=Date.now()-1000,hard=started+2700000,config={started,hard,own,observer,evidencePrUrl:'https://github.com/raphaeltm/simple-agent-manager/pull/2355'};
  await writeFile(join(dir,'config.json'),JSON.stringify(config));
  let virtualNow=null;
  let woken=false,ownStatus='in_progress',observerStatus='completed',completedAt,active=own,loggedOut=false,browserClosed=false;
  const stages=[],prompts=[],slept=[];
  const mapping=(x)=>({workspaceId:x===observer?'01M51OOOOOOOOOOOOOOOOOOOOO':woken?'01M51YYYYYYYYYYYYYYYYYYYYY':'01M51XXXXXXXXXXXXXXXXXXXXX',nodeId:'01M51NNNNNNNNNNNNNNNNNNNNN',agentSessionId:'01M51AAAAAAAAAAAAAAAAAAAAA'});
  const snapId='01M51SSSSSSSSSSSSSSSSSSSSS';
  for(const name of ['setup','turn-check','wake-check','observe']){const x=name==='observe'?observer:own;woken=name==='wake-check';await writeFile(join(dir,name+'-grant.json'),JSON.stringify({...mapping(x),ownerId:'owner',storedProfileId:x.agentProfileId,recoveredSnapshotId:snapId,snapshotRestoreConfirmedAt:Date.now()+5000}));}woken=false;
  // Grant timestamp is refreshed by the independently simulated producer at wake prompt.
  const response=v=>({status:()=>200,body:async()=>Buffer.from(JSON.stringify(v)),dispose:async()=>{}});
  const task=x=>({id:x.taskId,userId:'owner',projectId:'01KJNR9R3TEN3KX1ETE33852R8',outputBranch:x.branch,taskMode:'task',agentProfileHint:'safe-profile-'+x.agentProfileId,workspaceId:mapping(x).workspaceId,status:x===own?ownStatus:observerStatus,createdAt:new Date(started+100).toISOString(),completedAt:x===own?completedAt:new Date(started-10000).toISOString(),completionEvidence:x===own?(completedAt?{prUrl:config.evidencePrUrl,notes:mode==='complete-missing-notes'?'no commit':'measured '+ 'a'.repeat(40)}:null):{prUrl:config.evidencePrUrl}});
  const context={request:{fetch:async url=>{
   if(url.includes('/agent-profiles/')){const x=url.endsWith(own.agentProfileId)?own:observer;return response({id:x.agentProfileId,name:'safe-profile-'+x.agentProfileId,userId:'owner',projectId:'01KJNR9R3TEN3KX1ETE33852R8',agentType:x.agentType,vmSizeOverride:null});}
   if(url.endsWith('/agent-profiles'))return response({items:[own,observer].map(x=>({id:x.agentProfileId,name:'safe-profile-'+x.agentProfileId}))});
   if(url.includes('/messages?'))return response({messages:[{id:'fixed-tool-message',sessionId:own.sessionId,createdAt:Date.parse(completedAt),role:'tool',content:'SYNTHETIC_PRIVATE_CANARY',toolMetadata:{toolName:'mcp__sam_mcp__complete_task',status:'completed'}}],hasMore:false});
   if(url.endsWith('/api/auth/get-session'))return response({user:{id:'owner'}});
   if(url.includes('/tasks/')){const x=url.endsWith(own.taskId)?own:observer;const v=task(x);if(mode==='complete-missing-notes'&&x===own&&ownStatus==='completed')virtualNow=hard-540000;return response(v);}
   const x=url.includes(observer.sessionId)?observer:url.includes(own.sessionId)?own:active;
   if(url.includes('/sessions/')&&!url.endsWith('/state')){active=x;return response({session:{id:x.sessionId,taskId:x.taskId}});}
   if(url.includes('/api/workspaces/'))return response({id:mapping(active).workspaceId,nodeId:mapping(active).nodeId,projectId:'01KJNR9R3TEN3KX1ETE33852R8',chatSessionId:active.sessionId,branch:active.branch,repository:'serverspresentation2025/crewai',status:'running'});
   if(url.endsWith('/state'))return response({...mapping(x),agentType:x.agentType,state:{activity:'idle',runtimeWorkState:'inactive',runtimeWorkCount:0,activityAt:Date.now(),runtimeWorkUpdatedAt:Date.now()}});
   throw Error('route');
  }},newPage:async()=>({goto:async()=>{}})};
  globalThis.__prospectiveTest={now:()=>virtualNow??Date.now(),browser:{newContext:async()=>context,close:async()=>{browserClosed=true;}},phase:async p=>{
   stages.push(p.operation+':'+(p.own===observer?'observer':'own'));
   if(mode==='setup-failure'&&p.operation==='setup'||mode==='wake-check-failure'&&p.evidenceDirectory.endsWith('wake-check'))return {ok:false};
   if(p.operation==='setup'){await writeFile(p.evidenceDirectory+'/baseline.json',JSON.stringify({head:'a'.repeat(40)}));await writeFile(p.evidenceDirectory+'/expectations.json','{}');}
   return {ok:true};
  }};
  const requestSafe=async(c,api,o,validate)=>{
   if(o.path==='/api/auth/token-login')return {category:'ok',status:200};
   if(o.path==='/api/auth/get-session')return {category:loggedOut&&validate(null)?'ok':'controller',status:200};
   if(o.path==='/api/nodes')return {category:'http',status:loggedOut?401:200};
   if(o.path.endsWith('/prompt')){
    prompts.push(o.data.content);const isObserver=o.path.includes(observer.sessionId);active=isObserver?observer:own;
    if(isObserver)observerStatus='in_progress';
    if(o.data.content.includes('snapshot recovery')){woken=true;const f=join(dir,'wake-check-grant.json');const v=JSON.parse(await readFile(f));v.snapshotRestoreConfirmedAt=Date.now();await writeFile(f,JSON.stringify(v));}
    if(o.data.content.startsWith('Call actual')){ownStatus='completed';completedAt=new Date().toISOString();await writeFile(join(dir,'completion-runtime.json'),JSON.stringify({taskId:own.taskId,sessionId:own.sessionId,tool:'mcp__sam_mcp__complete_task',status:'completed',createdAt:Date.now(),observedAt:Date.now(),originalEvidenceRetained:true,runtimeWorkTerminal:true,sourceEvidenceSha256:'b'.repeat(64)}));
     // Force this failure to terminate promptly through the original fixed action clock.
    }
    return {category:'ok',status:202};
   }
   if(o.path.endsWith('/sleep')){
    slept.push(active.taskId);const body={status:'sleeping',workspaceId:mapping(active).workspaceId,chatSessionId:active.sessionId,snapshotExpiresAt:new Date(hard+86400000).toISOString()};assert(validate(body));
    const sleeping=active;setTimeout(()=>writeFile(join(dir,sleeping===own?'protected-snapshot.json':'observer-snapshot.json'),JSON.stringify({taskId:sleeping.taskId,sessionId:sleeping.sessionId,workspaceId:body.workspaceId,snapshotId:snapId,status:'available',runtime:sleeping===own?'vm':'cf-container',degradation:'none',expiresAt:body.snapshotExpiresAt,snapshotGeneration:'synthetic-generation',observedAt:Date.now(),sourceEvidenceSha256:'b'.repeat(64)})),5);
    return {category:'ok',status:200};
   }throw Error('request');
  };
  const result=await run({requestSafe,logoutSafe:async()=>{loggedOut=true;return {category:'ok'};},summary:(category,status,ok)=>({category,status,ok})});
  assert(loggedOut&&browserClosed);assert(!JSON.stringify(result).includes('CANARY'));
  const final=JSON.parse(await readFile(join(dir,'final.json')));assert.equal(result.ok,mode==='success',JSON.stringify({mode,stage:final.stage,events:final.events.map(x=>x.kind)}));
  if(mode==='success'){assert.equal(final.events.length,8);assert.equal(prompts.length,4);assert.equal(stages.length,4);assert.equal(slept.length,2);assert.equal(final.stage,'done');}
  else{assert(!final.ok);assert(slept.includes(own.taskId));if(mode!=='complete-missing-notes')assert(!prompts.some(p=>p.startsWith('Call actual')));else assert(!prompts.some(p=>p.startsWith('Authorized independent observer')));}
 }
 const now=Date.now(),s={taskId:own.taskId,sessionId:own.sessionId,workspaceId:'ws',snapshotId:'01M51SSSSSSSSSSSSSSSSSSSSS',status:'available',runtime:'vm',degradation:'none',expiresAt:new Date(now+10000).toISOString(),snapshotGeneration:'synthetic-generation',observedAt:now,sourceEvidenceSha256:'a'.repeat(64)};
 snapshotProof(s,own,'ws',now-1,now+1000,now);for(const patch of [{observedAt:undefined},{degradation:'partial'},{sessionId:observer.sessionId},{expiresAt:new Date(now-1).toISOString()}])assert.throws(()=>snapshotProof({...s,...patch},own,'ws',now-1,now+1000,now));
 assert.throws(()=>completionProof({taskId:own.taskId},own,now-1,new Date(now).toISOString(),now));
 console.log(JSON.stringify({ok:true,lifecycleCases:4,typedProofNegatives:5,missingCompletionNotesRejected:true,liveCalls:0,limits:'browser/terminal/CF producers simulated; real caller+ledger'}));
}finally{delete globalThis.__prospectiveTest;delete process.env.SAM_PROSPECTIVE_ROOT;delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;await rm(root,{recursive:true,force:true});}
