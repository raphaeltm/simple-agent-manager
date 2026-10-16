/** Real lifecycle controller and sequence; external browser/terminal/CF producers simulated. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const pendingWrites=[];
const deferJSON=(file,make)=>{const promise=new Promise((resolve,reject)=>setTimeout(()=>writeFile(file,JSON.stringify(make())).then(resolve,reject),5));pendingWrites.push(promise);return promise;};
const root=await mkdtemp(join(tmpdir(),'sam-prospective-sequence-')),source=new URL('.',import.meta.url);
try{
 const modules=join(root,'modules');await mkdir(modules);
 for(const n of ['owner-terminal-inspect.mjs','queue-controller.mjs','git-probe.py','b-probe.py','terminal-observer.py','prospective-capsule.py'])await copyFile(new URL(n,source),join(modules,n));
 const library=await readFile(new URL('prospective-vm.mjs',source),'utf8');
 await writeFile(join(modules,'prospective-vm.mjs'),library.replace('export async function terminalPhase(', 'async function originalTerminalPhase(')+'\nexport const terminalPhase=(v)=>globalThis.__prospectiveTest.phase(v);\nexport {originalTerminalPhase};\n');
 const playwright=join(root,'playwright.mjs');await writeFile(playwright,'export const chromium={launch:()=>globalThis.__prospectiveTest.browser};');
 await writeFile(join(modules,'retain-phase.mjs'),"export const snapshotRoot=async()=>{};export const retainPhase=async p=>globalThis.__prospectiveTest.retain(p);export const retainCheckpoint=async p=>globalThis.__prospectiveTest.retain(p);\n");
 const caller=await readFile(new URL('prospective-vm-controller.mjs',source),'utf8');
 await writeFile(join(modules,'caller.mjs'),caller.replace('/tmp/reliability-browser-deps/node_modules/playwright/index.mjs',playwright).replaceAll('Date.now()', 'globalThis.__prospectiveTest.now()').replace('const pause=ms=>new Promise(r=>setTimeout(r,ms));','const pause=async()=>{await new Promise(r=>setTimeout(r,10));};'));
 const sha=b=>createHash('sha256').update(b).digest('hex');
 const retained=join(root,'retained');await mkdir(retained);await mkdir(join(retained,'setup'));await mkdir(join(retained,'turn-check'));
 const resumeOwn={taskId:'01M51Q2J7AQEKAKZAKZ39NFXWP',sessionId:'f5f56c5b-e9fb-4218-b327-bd9d4b7e25e9',branch:'sam/authorized-one-clean-prospective-9nfxwp',agentProfileId:'01KRS7Z2R88JFC73ARA7DV9WTK',agentType:'claude-code'};
 resumeOwn.receipt={taskId:resumeOwn.taskId,sessionId:resumeOwn.sessionId,branchName:resumeOwn.branch,status:'queued'};
 const fixtureFiles={};
 const fixtureSave=(name,value)=>{fixtureFiles[name]=Buffer.from(JSON.stringify(value));};
 const originalBaseline={head:'a'.repeat(40),branch:resumeOwn.branch,index:'a'.repeat(40),status:'',files:Object.fromEntries(['.reliability-a/tracked.txt','.reliability-a/staged-new.txt','.reliability-a/untracked.txt','.do-state.md','.workflow-state.md'].map(n=>[n,'b'.repeat(64)])),stagedTracked:'staged tracked content',stagedNew:'staged new content',remoteRefs:'a'.repeat(40)+'\trefs/heads/main'};
 fixtureSave('config.json',{own:resumeOwn});fixtureSave('clock.json',{started:1,hard:2});fixtureSave('final.json',{ok:false,stage:'wake-check',authCleanup:true,browserClosed:true,retained:true});
 fixtureSave('setup/baseline.json',originalBaseline);fixtureSave('setup/expectations.json',{repository:'serverspresentation2025/crewai',branch:resumeOwn.branch,remoteRefs:{'refs/heads/main':'a'.repeat(40)},prs:[],recordedAt:new Date(Date.now()-100000).toISOString(),prLimit:100});
 for(const n of ['asset-hashes','prepare','check','record'])fixtureSave('setup/'+n+'.json',{checks:{prepared:true},statuses:{probe:0}});
 for(const n of ['asset-hashes','check','publication'])fixtureSave('turn-check/'+n+'.json',{checks:{remoteRefsUnchanged:true},statuses:{probe:0}});
 for(const phase of ['setup','turn-check']){const files=Object.fromEntries(Object.entries(fixtureFiles).filter(([n])=>n.startsWith(phase+'/')).map(([n,b])=>[n.slice(phase.length+1),sha(b)]));fixtureSave(phase+'/done.json',{taskId:resumeOwn.taskId,sessionId:resumeOwn.sessionId,runId:'11111111-2222-4333-8444-555555555555',operation:phase==='setup'?'setup':'check',status:0,files});fixtureSave(phase+'-result.json',{ok:true,sourceManifestSha256:sha(fixtureFiles[phase+'/done.json'])});}
 const evidenceSha=sha(JSON.stringify(Object.fromEntries(Object.keys(fixtureFiles).sort().map(n=>[n,sha(fixtureFiles[n])]))));
 for(const [n,b]of Object.entries(fixtureFiles))await writeFile(join(retained,n),b);
 const resumeSource=await readFile(new URL('prospective-resume.mjs',source),'utf8');
 await writeFile(join(modules,'prospective-resume.mjs'),resumeSource.replace('./prospective-vm-controller.mjs','./caller.mjs').replace('/tmp/reliability-prospective-vm-claude-001',retained).replace('9715d238b6fcf5cc1e45e065ea041e87e8b72b38b6776664827467a6e74c14d2',evidenceSha));
 const {run}=await import(pathToFileURL(join(modules,'caller.mjs')));
 const {run:resumeRun,retainedOriginals:checkRetained}=await import(pathToFileURL(join(modules,'prospective-resume.mjs')));
 await checkRetained(resumeOwn);
 const {snapshotProof,completionProof,originalTerminalPhase,releaseProvenance}=await import(pathToFileURL(join(modules,'prospective-vm.mjs')));
 const producerHarness=join(root,'actual-producer.py');
 await writeFile(producerHarness,`import sys,os,json,time,importlib.util,urllib.request
from pathlib import Path
from datetime import datetime,timezone
scenario=sys.argv[3]; folder=Path(sys.argv[1]); config=json.loads((folder/'config.json').read_text()); own=config['own']; mapping=json.loads((folder/'wake-check-mapping.json').read_text())
spec=importlib.util.spec_from_file_location('actual_reader',sys.argv[2]); reader=importlib.util.module_from_spec(spec);spec.loader.exec_module(reader)
class Response:
 def __init__(self,v):self.v=v
 def __enter__(self):return self
 def __exit__(self,*a):pass
 def read(self):return json.dumps(self.v).encode()
def request(req,timeout):
 if req.full_url.endswith('/settings'):return Response({'result':{'bindings':[{'name':'DATABASE','id':'synthetic'},{'name':'VM_AGENT_REQUIRED_VERSION','text':reader.VERSION}]}})
 sql=json.loads(req.data)['sql']; assert sql.startswith('SELECT ')
 if 'FROM tasks WHERE id=' in sql:rows=[{'id':own['taskId'],'user_id':'owner','project_id':reader.PROJECT,'chat_session_id':own['sessionId'],'workspace_id':mapping['workspaceId'],'output_branch':own['branch'],'agent_profile_hint':own['agentProfileId'],'status':'in_progress','claimed_warm_node_id':None,'completed_at':None}]
 elif 'FROM nodes WHERE user_id=' in sql:rows=[{'id':mapping['nodeId']}]
 elif 'FROM tasks WHERE user_id=' in sql or 'FROM workspaces WHERE node_id=' in sql:rows=[]
 elif 'FROM workspaces WHERE id=' in sql:rows=[{'id':mapping['workspaceId'],'user_id':'owner','project_id':reader.PROJECT,'chat_session_id':own['sessionId'],'node_id':mapping['nodeId'],'branch':own['branch'],'status':'running'}]
 elif 'FROM nodes WHERE id=' in sql:rows=[{'id':mapping['nodeId'],'user_id':'owner','runtime':'vm','agent_version':reader.VERSION,'capacity_pool_revision':40,'status':'running'}]
 elif 'FROM agent_profiles' in sql:rows=[{'id':own['agentProfileId'],'user_id':'owner','project_id':reader.PROJECT,'agent_type':own['agentType'],'runtime':'vm','vm_size_override':None}]
 elif 'FROM session_snapshots' in sql:rows=[{'id':json.loads((folder/'protected-snapshot.json').read_text())['snapshotId'],'snapshot_generation':'different-generation','recovery_status':'restored','recovery_task_id':'01M51FFFFFFFFFFFFFFFFFFFFF' if scenario=='failure' else own['taskId'],'recovery_workspace_id':mapping['workspaceId'],'restored_at':datetime.now(timezone.utc).isoformat(),'ignoredPrivate':os.environ['CF_TOKEN']}]
 else:raise AssertionError('fixed-query')
 return Response({'result':[{'results':rows}]})
reader.urllib.request.urlopen=request;reader.sys.argv=['actual','wake-check'];reader.main()
`);
 const baseOwn={taskId:'01M51ZZZZZZZZZZZZZZZZZZZZZ',sessionId:'11111111-2222-4333-8444-555555555555',branch:'sam/prospective-claude',agentProfileId:'01KRS7Z2R88JFC73ARA7DV9WTK',agentType:'claude-code'};
 const observer={taskId:'01M50VYZ60RQXXTGSVPXW6FRXD',sessionId:'4e5282b9-0cd5-454f-a8f0-db160b9823fe',branch:'sam/bootstrap-only-authorized-reliability-w6frxd',agentProfileId:'01KYQ5YDHC1VS0BZ9F3NY97FNH',agentType:'openai-codex'};
 for(const x of [baseOwn,observer])x.receipt={taskId:x.taskId,sessionId:x.sessionId,branchName:x.branch,status:'queued'};
 let count=0;
 for(const mode of ['success','real-binding-failure','real-binding-old-idle','retention-setup-failure','retention-turn-failure','setup-failure','wake-check-failure','complete-missing-notes','early-complete','producer-failure','foreign-producer-failure','stale-producer-failure','resume-success','resume-invalid-originals','resume-producer-failure','resume-invalid-fixture','resume-early-complete','resume-foreign-identity','resume-real-producer-failure','resume-checkpoint-rotation','resume-real-producer-rotation','resume-false-consumed-claim','resume-third-success','resume-unsupported-kind']){
  const resumed=mode.startsWith('resume-'),own=resumed?structuredClone(resumeOwn):baseOwn;
  if(mode==='resume-foreign-identity'){own.taskId=baseOwn.taskId;own.receipt.taskId=own.taskId;}
  count++;const dir=join(root,mode);await mkdir(dir);process.env.SAM_PROSPECTIVE_ROOT=dir;process.env.SAM_VERIFICATION_SOURCE_SHA='d'.repeat(40);process.env.SAM_PLAYWRIGHT_PRIMARY_USER='SYNTHETIC_PRIVATE_CANARY';
  const started=Date.now()-1000,hard=started+2700000,config={started,hard,own,observer,evidencePrUrl:'https://github.com/raphaeltm/simple-agent-manager/pull/2355'};
  if(resumed)config.resume={kind:mode==='resume-third-success'?'third-prospective-restore':mode==='resume-unsupported-kind'?'fourth-prospective-restore':'second-prospective-restore',originalEvidenceSha256:evidenceSha};
  await writeFile(join(dir,'config.json'),JSON.stringify(config));
  let virtualNow=null,inAdapter=false;
  let woken=false,ownStatus=resumed?'sleeping':'in_progress',observerStatus='completed',completedAt,active=own,loggedOut=false,browserClosed=false;
  if(['early-complete','resume-early-complete'].includes(mode)){ownStatus='completed';completedAt=new Date().toISOString();}
  const stages=[],prompts=[],slept=[],retainedPhases=[];
  const mapping=(x)=>({workspaceId:x===observer?'01M51OOOOOOOOOOOOOOOOOOOOO':woken?'01M51YYYYYYYYYYYYYYYYYYYYY':'01M51XXXXXXXXXXXXXXXXXXXXX',nodeId:'01M51NNNNNNNNNNNNNNNNNNNNN',agentSessionId:'01M51AAAAAAAAAAAAAAAAAAAAA'});
  const snapId='01M51SSSSSSSSSSSSSSSSSSSSS';
  for(const name of ['setup','turn-check','wake-check','observe']){const x=name==='observe'?observer:own;woken=name==='wake-check';if(!(['producer-failure','resume-producer-failure','resume-real-producer-failure','resume-real-producer-rotation'].includes(mode)&&name==='wake-check'))await writeFile(join(dir,name+'-grant.json'),JSON.stringify({...mapping(x),ownerId:'owner',storedProfileId:x.agentProfileId,recoveredSnapshotId:snapId,snapshotRestoreConfirmedAt:Date.now()+5000,restoreProvenance:{protectedGenerationSha256:sha('synthetic-generation'),latestGenerationSha256:sha(mode==='resume-checkpoint-rotation'?'later-generation':'synthetic-generation'),latestGenerationMatchesProtected:mode!=='resume-checkpoint-rotation',consumedGenerationObserved:mode==='resume-false-consumed-claim'}}));}woken=false;
  if(resumed)await writeFile(join(dir,'resume-snapshot.json'),JSON.stringify({taskId:own.taskId,sessionId:own.sessionId,workspaceId:mapping(own).workspaceId,snapshotId:snapId,status:'available',runtime:'vm',degradation:'none',expiresAt:new Date(hard+86400000).toISOString(),snapshotGeneration:'synthetic-generation',observedAt:Date.now(),sourceEvidenceSha256:'b'.repeat(64)}));
  // Grant timestamp is refreshed by the independently simulated producer at wake prompt.
  const response=v=>({status:()=>200,body:async()=>Buffer.from(JSON.stringify(v)),dispose:async()=>{}});
  const task=x=>({id:x.taskId,userId:'owner',projectId:'01KJNR9R3TEN3KX1ETE33852R8',outputBranch:x.branch,taskMode:'task',agentProfileHint:'safe-profile-'+x.agentProfileId,workspaceId:mapping(x).workspaceId,status:x===own?ownStatus:observerStatus,createdAt:new Date(resumed?started-100000:started+100).toISOString(),completedAt:x===own?completedAt:new Date(started-10000).toISOString(),completionEvidence:x===own?(completedAt?{prUrl:config.evidencePrUrl,notes:mode==='complete-missing-notes'?'no commit':'measured '+ 'a'.repeat(40)}:null):{prUrl:config.evidencePrUrl}});
  const context={request:{fetch:async url=>{
   if(url.includes('/agent-profiles/')){const x=url.endsWith(own.agentProfileId)?own:observer;return response({id:x.agentProfileId,name:'safe-profile-'+x.agentProfileId,userId:'owner',projectId:'01KJNR9R3TEN3KX1ETE33852R8',agentType:x.agentType,vmSizeOverride:null,runtime:null});}
   if(url.endsWith('/agent-profiles'))return response({items:[own,observer].map(x=>({id:x.agentProfileId,name:'safe-profile-'+x.agentProfileId}))});
   if(url.includes('/messages?'))return response({messages:[{id:'fixed-tool-message',sessionId:own.sessionId,createdAt:Date.parse(completedAt),role:'tool',content:'SYNTHETIC_PRIVATE_CANARY',toolMetadata:{toolName:'mcp__sam_mcp__complete_task',status:'completed'}}],hasMore:false});
   if(url.endsWith('/api/terminal/token'))return response({workspaceUrl:'https://ws-'+mapping(active).workspaceId+'.sammy.party',token:'SYNTHETIC_PRIVATE_CANARY'.repeat(3),expiresAt:new Date((virtualNow??Date.now())+200000).toISOString()});
   if(url.endsWith('/api/auth/get-session'))return response({user:{id:'owner'}});
   if(url.includes('/tasks/')){const x=url.endsWith(own.taskId)?own:observer;const v=task(x);if(mode==='complete-missing-notes'&&x===own&&ownStatus==='completed')virtualNow=hard-540000;return response(v);}
   const x=url.includes(observer.sessionId)?observer:url.includes(own.sessionId)?own:active;
   if(url.includes('/sessions/')&&!url.endsWith('/state')){active=x;return response({session:{id:x.sessionId,taskId:x.taskId,workspaceId:mapping(x).workspaceId,agentSessionId:mapping(x).agentSessionId,agentType:x.agentType}});}
   if(url.includes('/api/workspaces/'))return response({id:mapping(active).workspaceId,nodeId:mapping(active).nodeId,projectId:'01KJNR9R3TEN3KX1ETE33852R8',chatSessionId:active.sessionId,branch:active.branch,repository:'serverspresentation2025/crewai',status:'running',hardware:{cloudProvider:'hetzner'}});
   if(url.endsWith('/state'))return response({...mapping(x),agentType:x.agentType,state:{activity:'idle',runtimeWorkState:'inactive',runtimeWorkCount:inAdapter?1:0,activityAt:Date.now(),runtimeWorkUpdatedAt:Date.now()}});
   throw Error('route');
  }},newPage:async()=>({goto:async()=>{}})};
  globalThis.__prospectiveTest={retain:async p=>{retainedPhases.push(p.phase);if(mode==='retention-setup-failure'&&p.phase==='setup'||mode==='retention-turn-failure'&&p.phase==='turn-check')throw Error('retention');},now:()=>virtualNow??Date.now(),browser:{newContext:async()=>context,close:async()=>{browserClosed=true;}},phase:async p=>{
   stages.push(p.operation+':'+(p.own===observer?'observer':'own'));
   assert(Number.isSafeInteger(p.idleSince)&&p.idleSince>=started);
   if(['real-binding-failure','real-binding-old-idle'].includes(mode)){
    inAdapter=mode==='real-binding-failure';if(mode==='real-binding-old-idle')virtualNow=Date.now()+90000;
    const g={...p.grant,globalVmCount:1,otherWorkspaceCount:0,activeForeignClaimCount:0,expectedProfileOwnerId:'owner',runtime:'vm',agentVersion:releaseProvenance.agentSource,releaseProvenance,expiresAt:(virtualNow??Date.now())+200000,storedProfileObservedAt:virtualNow??Date.now(),receipt:own.receipt};
    try{return await originalTerminalPhase({...p,grant:g,now:()=>virtualNow??Date.now(),open:async()=>{assert.equal(mode,'real-binding-old-idle');throw Error('SYNTHETIC_PRIVATE_CANARY');}});}finally{inAdapter=false;}
   }
   if(mode==='setup-failure'&&p.operation==='setup'||['wake-check-failure','resume-invalid-fixture'].includes(mode)&&p.evidenceDirectory.endsWith('wake-check'))return {ok:false};
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
    if(o.data.content.includes('snapshot recovery')){
    woken=true;if(resumed)ownStatus='in_progress';if(!['producer-failure','resume-producer-failure','resume-real-producer-failure','resume-real-producer-rotation'].includes(mode)){const f=join(dir,'wake-check-grant.json');const v=JSON.parse(await readFile(f));v.snapshotRestoreConfirmedAt=Date.now();await writeFile(f,JSON.stringify(v));}
     if((mode.includes('producer-failure')&&mode!=='resume-real-producer-failure')||mode==='resume-producer-failure')await writeFile(join(dir,'wake-check-failure.json'),JSON.stringify({mode:'wake-check',taskId:mode==='foreign-producer-failure'?observer.taskId:own.taskId,sessionId:own.sessionId,started:mode==='stale-producer-failure'?started-1:started,hard,stage:'restored-generation',observedAt:Date.now(),sourceEvidenceSha256:'c'.repeat(64)}));
     if(['resume-real-producer-failure','resume-real-producer-rotation'].includes(mode)){
      const pending=(async()=>{for(let n=0;n<100;n++){try{await readFile(join(dir,'wake-check-mapping.json'));break;}catch{await new Promise(r=>setTimeout(r,10));}}
       const child=await promisify(execFile)('python3',[producerHarness,dir,new URL('prospective-proof.py',source).pathname,mode==='resume-real-producer-failure'?'failure':'rotation'],{env:{...process.env,SAM_PROSPECTIVE_ROOT:dir,CF_TOKEN:'SYNTHETIC_PRIVATE_CANARY',CF_ACCOUNT_ID:'synthetic'},timeout:3000,maxBuffer:100000});
       assert(!child.stdout.includes('CANARY')&&!child.stderr.includes('CANARY'));const output=JSON.parse(child.stdout);assert.equal(output.ok,mode==='resume-real-producer-rotation');if(!output.ok)assert(output.diagnostic.predicates.taskMatches===false);
      })();pendingWrites.push(pending);
     }
    }
    if(o.data.content.startsWith('Call actual')){ownStatus='completed';completedAt=new Date().toISOString();await writeFile(join(dir,'completion-runtime.json'),JSON.stringify({taskId:own.taskId,sessionId:own.sessionId,tool:'mcp__sam_mcp__complete_task',status:'completed',createdAt:Date.now(),observedAt:Date.now(),originalEvidenceRetained:true,runtimeWorkTerminal:true,sourceEvidenceSha256:'b'.repeat(64)}));
     // Force this failure to terminate promptly through the original fixed action clock.
    }
    return {category:'ok',status:202};
   }
   if(o.path.endsWith('/sleep')){
    slept.push(active.taskId);const body={status:'sleeping',workspaceId:mapping(active).workspaceId,chatSessionId:active.sessionId,snapshotExpiresAt:new Date(hard+86400000).toISOString()};assert(validate(body));
    const sleeping=active;deferJSON(join(dir,sleeping===own?'protected-snapshot.json':'observer-snapshot.json'),()=>({taskId:sleeping.taskId,sessionId:sleeping.sessionId,workspaceId:body.workspaceId,snapshotId:snapId,status:'available',runtime:sleeping===own?'vm':'cf-container',degradation:'none',expiresAt:body.snapshotExpiresAt,snapshotGeneration:'synthetic-generation',observedAt:Date.now(),sourceEvidenceSha256:'b'.repeat(64)}));
    return {category:'ok',status:200};
   }throw Error('request');
  };
  if(mode==='resume-invalid-originals')await writeFile(join(retained,'setup/baseline.json'),'SYNTHETIC_PRIVATE_CANARY');
  const result=await (resumed?resumeRun:run)({requestSafe,logoutSafe:async()=>{loggedOut=true;return {category:'ok'};},summary:(category,status,ok)=>({category,status,ok})});
  if(mode==='resume-invalid-originals')await writeFile(join(retained,'setup/baseline.json'),fixtureFiles['setup/baseline.json']);
  const beforeBrowser=['resume-invalid-originals','resume-foreign-identity','resume-unsupported-kind'].includes(mode);
  assert(beforeBrowser?!loggedOut&&!browserClosed:loggedOut&&browserClosed,JSON.stringify({mode,loggedOut,browserClosed,final:JSON.parse(await readFile(join(dir,'final.json')))}));assert(!JSON.stringify(result).includes('CANARY'));
  const success=['success','foreign-producer-failure','stale-producer-failure','resume-success','resume-checkpoint-rotation','resume-real-producer-rotation','resume-third-success'].includes(mode);
  const final=JSON.parse(await readFile(join(dir,'final.json')));assert.equal(result.ok,success,JSON.stringify({mode,stage:final.stage,events:final.events.map(x=>x.kind)}));
  if(['real-binding-failure','real-binding-old-idle'].includes(mode)){
   const diagnostic=JSON.parse(await readFile(join(dir,'setup/binding-diagnostics.json'))),phaseResult=JSON.parse(await readFile(join(dir,'setup-result.json')));
   if(mode==='real-binding-failure')assert(diagnostic.some(x=>x.predicateId==='before.state.work-count'&&!x.ok));
   else{assert(phaseResult.before&&phaseResult.stage==='terminal');assert(diagnostic.every(x=>x.ok));assert(virtualNow-Date.now()>60000);}
   assert.deepEqual((await readFile(join(dir,'setup/binding-diagnostics.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),diagnostic);assert.deepEqual(phaseResult.bindingDiagnostics,diagnostic);
   assert(final.retained&&final.authCleanup&&final.browserClosed);assert.equal(prompts.length,0);assert.equal(slept.length,1);assert(!JSON.stringify(diagnostic).includes('CANARY'));
  }
  if(mode==='retention-setup-failure'){assert.deepEqual(retainedPhases,['start','setup']);assert(!prompts.some(p=>p.startsWith('Authorized tested')));assert(final.authCleanup&&final.browserClosed);}
  if(mode==='retention-turn-failure'){assert.deepEqual(retainedPhases,['start','setup','turn-check']);assert(!prompts.some(p=>p.startsWith('Authorized normal snapshot')));assert(final.authCleanup&&final.browserClosed);}
  if(mode==='success')assert.deepEqual(retainedPhases,['start','setup','turn-check','sleep','wake','wake-check','complete','observe','observer-sleep','closing']);
  if(success){assert.equal(final.events.length,resumed?5:8);assert.equal(prompts.length,resumed?3:4);assert.equal(stages.length,resumed?2:4);assert.equal(slept.length,resumed?1:2);assert.equal(final.stage,'done');assert.equal(final.producerFailure,undefined);assert.equal(final.consumedGenerationObserved,false);assert.equal(final.originalRestoredBytesVerified,true);}
  else{assert(!final.ok);if(mode==='early-complete'||mode==='resume-early-complete'){assert.equal(prompts.length,0);assert.equal(stages.length,0);assert(JSON.parse(await readFile(join(dir,'unexpected-completion.json'))).status==='completed');}else if(!beforeBrowser)assert(slept.includes(own.taskId));if(mode!=='complete-missing-notes')assert(!prompts.some(p=>p.startsWith('Call actual')));else assert(!prompts.some(p=>p.startsWith('Authorized independent observer')));}
  if(mode==='producer-failure'){assert.equal(final.stage,'wake-check');assert.equal(final.producerFailure.stage,'restored-generation');assert.equal(stages.length,2);assert.equal(prompts.length,2);assert.equal(slept.length,2);assert(final.at<hard-540000);assert(final.authCleanup&&final.browserClosed&&final.retained);assert.equal(virtualNow,null);assert(!stages.some(s=>s.includes('observer')));}
  if(mode==='resume-false-consumed-claim'){assert.equal(final.stage,'wake-check');assert.equal(stages.length,0);assert.equal(prompts.length,1);assert(final.authCleanup&&final.browserClosed);}
  if(resumed){assert(!stages.some(s=>s.startsWith('setup')));assert(!prompts.some(p=>p.startsWith('Authorized tested')));if(!beforeBrowser){assert.equal(final.coverage,config.resume.kind);assert.equal(final.restoreAttemptOrdinal,mode==='resume-third-success'?3:2);assert.equal(final.firstWakePass,false);}if(['resume-success','resume-third-success'].includes(mode)){const receipt=JSON.parse(await readFile(join(dir,'resume-attempt-receipt.json')));assert.equal(receipt.started,started);assert.equal(receipt.hard,hard);assert.equal(receipt.promptStatus,202);assert.equal(receipt.kind,config.resume.kind);assert.equal(receipt.restoreAttemptOrdinal,mode==='resume-third-success'?3:2);assert.equal(receipt.originalEvidenceSha256,evidenceSha);assert.equal(JSON.parse(await readFile(join(dir,'retained-originals.json'))).firstWakePass,false);}if(['resume-producer-failure','resume-invalid-fixture','resume-real-producer-failure'].includes(mode)){assert.equal(final.stage,'wake-check');assert(!stages.some(s=>s.includes('observer')));assert(final.at<hard-540000);}assert.equal(sha(await readFile(join(retained,'setup/baseline.json'))),sha(fixtureFiles['setup/baseline.json']));}
 }
 const own=baseOwn,now=Date.now(),s={taskId:own.taskId,sessionId:own.sessionId,workspaceId:'ws',snapshotId:'01M51SSSSSSSSSSSSSSSSSSSSS',status:'available',runtime:'vm',degradation:'none',expiresAt:new Date(now+10000).toISOString(),snapshotGeneration:'synthetic-generation',observedAt:now,sourceEvidenceSha256:'a'.repeat(64)};
 snapshotProof(s,own,'ws',now-1,now+1000,now);for(const patch of [{observedAt:undefined},{degradation:'partial'},{sessionId:observer.sessionId},{expiresAt:new Date(now-1).toISOString()}])assert.throws(()=>snapshotProof({...s,...patch},own,'ws',now-1,now+1000,now));
 assert.throws(()=>completionProof({taskId:own.taskId},own,now-1,new Date(now).toISOString(),now));
 await Promise.all(pendingWrites);
 console.log(JSON.stringify({ok:true,lifecycleCases:count,typedProofNegatives:5,producerFailurePreservedPromptly:true,foreignOrStaleSentinelIgnored:true,missingCompletionNotesRejected:true,earlyCompletionRetained:true,liveCalls:0,limits:'browser/terminal/CF producers simulated; real caller+ledger'}));
}finally{await Promise.all(pendingWrites);delete globalThis.__prospectiveTest;delete process.env.SAM_PROSPECTIVE_ROOT;delete process.env.SAM_VERIFICATION_SOURCE_SHA;delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;await rm(root,{recursive:true,force:true});}
