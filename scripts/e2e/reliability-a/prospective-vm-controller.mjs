/** Finite owner lifecycle. Requires a fresh accepted task receipt and independently supplied CF grants.
 * Run ONLY through safe-controller supervise. No provisioning/sizing/pool/node mutation or task submission.
 */
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {retainPhase,retainCheckpoint,snapshotRoot} from './retain-phase.mjs';
import {AcceptanceSequence,terminalPhase,identity,snapshotProof,completionProof,completionMessages,project,repository} from './prospective-vm.mjs';
const api='https://api.sammy.party';
const hash=b=>createHash('sha256').update(b).digest('hex');
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.slice().sort().join();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const first='01M50VYZ60RQXXTGSVPXW6FRXD';
const failed=new Set(['01M51CCMB1S684RXVNBNDQRDAS','01M516EKT5593YRAAG5WE886CK']);
export async function run({requestSafe,logoutSafe,summary},resume=false){
 let root,c,browser,page,config,owner,sequence,stage='configuration',activeOwn=null,activeWorkspace=null,closed=false,auth=false;
 let completionSubmittedAt=null;
 const result={ok:false,stage,authCleanup:false,browserClosed:false,retained:false};
 const save=async(name,value)=>writeFile(root+'/'+name,JSON.stringify(value),{mode:0o600,flag:'wx'});
 const read=async name=>JSON.parse(await readFile(root+'/'+name,'utf8'));
 const action=()=>config.hard-540000; // 90s terminal action plus >=6min preservation, no reset.
 const live=()=>{if(Date.now()>=action())throw 0;};
 const producerFailed=async(mode,own)=>{
  let f;try{f=await read(mode+'-failure.json');}catch{return;}
  if(!exact(f,['mode','taskId','sessionId','started','hard','stage','observedAt','sourceEvidenceSha256'])||f.mode!==mode||f.taskId!==own.taskId||f.sessionId!==own.sessionId||f.started!==config.started||f.hard!==config.hard||!Number.isSafeInteger(f.observedAt)||f.observedAt<config.started||f.observedAt>Date.now()||!['configuration','settings','task','resource-guards','snapshot','mapping','restored-generation','completion-runtime','evidence'].includes(f.stage)||!(f.sourceEvidenceSha256===null||/^[0-9a-f]{64}$/.test(f.sourceEvidenceSha256)))return;
  result.producerFailure={mode,stage:f.stage,observedAt:f.observedAt,sourceEvidenceSha256:f.sourceEvidenceSha256};
  throw Error('producer-failed');
 };
 const get=async path=>{const r=await c.request.fetch(api+path,{headers:{Origin:api},timeout:10000,maxRedirects:0,failOnStatusCode:false});try{if(r.status()!==200)throw 0;const b=await r.body();if(b.length>250000)throw 0;return JSON.parse(b);}finally{await r.dispose();}};
 const canonical=async own=>{
  const t=await get(`/api/projects/${project}/tasks/${own.taskId}`),s=await get(`/api/projects/${project}/sessions/${own.sessionId}?limit=1`);
  const p=await get(`/api/projects/${project}/agent-profiles/${own.agentProfileId}`),profiles=await get(`/api/projects/${project}/agent-profiles`);if(p.id!==own.agentProfileId||p.agentType!==own.agentType||p.vmSizeOverride!=null||!(p.projectId===project||(p.projectId===null&&p.userId===owner))||!Array.isArray(profiles.items)||profiles.items.filter(x=>x.name===p.name).length!==1||t.agentProfileHint!==(p.userId===owner?p.name:p.id))throw 0;
  if(t.id!==own.taskId||t.taskMode!=='task'||t.userId!==owner||t.projectId!==project||t.outputBranch!==own.branch||s.session?.id!==own.sessionId||s.session.taskId!==own.taskId)throw 0;
  if(own.taskId===config.own.taskId&&t.status==='completed'&&completionSubmittedAt===null){
   await save('unexpected-completion.json',{taskId:t.id,status:'completed',completedAt:Number.isFinite(Date.parse(t.completedAt))?t.completedAt:null,completionEvidenceSha256:hash(JSON.stringify(t.completionEvidence??null)),observedAt:Date.now(),stage});throw 0;
  }
  return t;
 };
 const waitIdle=async(own,since,until=action())=>{
  while(Date.now()<until){
   const t=await canonical(own);if(t.workspaceId){const r=await c.request.fetch(api+'/api/workspaces/'+t.workspaceId,{headers:{Origin:api},timeout:10000,maxRedirects:0,failOnStatusCode:false});let w;try{if(r.status()===200)w=JSON.parse(await r.body());else if(r.status()!==404)throw 0;}finally{await r.dispose();}
    if(w){if(w.id!==t.workspaceId||w.projectId!==project||w.chatSessionId!==own.sessionId||w.branch!==own.branch||w.repository!==repository)throw 0;
     const a=await get(`/api/projects/${project}/sessions/${own.sessionId}/state`);
     if(w.status==='running'&&a.agentType===own.agentType&&a.agentSessionId&&a.state?.activity==='idle'&&a.state.runtimeWorkState==='inactive'&&a.state.runtimeWorkCount===0&&[a.state.activityAt,a.state.runtimeWorkUpdatedAt].every(v=>Number.isSafeInteger(v)&&v>=since&&v<=Date.now())){activeWorkspace=w.id;return {workspaceId:w.id,nodeId:w.nodeId,agentSessionId:a.agentSessionId,idleSince:since};}
    }
   }await pause(10000);
  }throw 0;
 };
 let protectedSnapshot=null,wakeSubmittedAt=null,lastSleep=null;
 const grant=async(name,own,mapping)=>{
  while(Date.now()<action()){await producerFailed(name.replace(/-grant$/,''),own);try{const g=await read(name+'.json');if(g.workspaceId!==mapping.workspaceId||g.nodeId!==mapping.nodeId||g.agentSessionId!==mapping.agentSessionId||g.ownerId!==owner||g.storedProfileId!==own.agentProfileId)throw Error('binding');if(name==='wake-check-grant'){
    if(!protectedSnapshot||g.recoveredSnapshotId!==protectedSnapshot.snapshotId||!Number.isSafeInteger(g.snapshotRestoreConfirmedAt)||g.snapshotRestoreConfirmedAt<wakeSubmittedAt||g.snapshotRestoreConfirmedAt>Date.now())throw Error('binding');
    const p=g.restoreProvenance;if(!exact(p,['protectedGenerationSha256','latestGenerationSha256','latestGenerationMatchesProtected','consumedGenerationObserved'])||p.protectedGenerationSha256!==hash(protectedSnapshot.snapshotGeneration)||!/^[0-9a-f]{64}$/.test(p.latestGenerationSha256)||typeof p.latestGenerationMatchesProtected!=='boolean'||p.latestGenerationMatchesProtected!==(p.protectedGenerationSha256===p.latestGenerationSha256)||p.consumedGenerationObserved!==false)throw Error('binding');
    await save('wake-restore-provenance.json',p);result.consumedGenerationObserved=false;
   }return g;}catch(e){if(e?.message==='binding')throw 0;}await pause(1000);}throw 0;
 };
 const phase=async(name,own,operation,originals,mapping)=>{
  live();const dir=root+'/'+name;await mkdir(dir,{mode:0o700});await save(name+'-mapping.json',{taskId:own.taskId,sessionId:own.sessionId,...mapping,at:Date.now()});
  const g=await grant(name+'-grant',own,mapping);live();let v;const transportWatchdog=setTimeout(()=>{void page.close().catch(()=>{});},90000);try{v=await terminalPhase({own,operation,originals,context:c,page,grant:g,evidenceDirectory:dir,idleSince:mapping.idleSince});}finally{clearTimeout(transportWatchdog);}await save(name+'-result.json',v);if(!v.ok)throw 0;if(!resume)await retainPhase({context:c,root,phase:name,own,target:config.own,started:config.started,hard:config.hard,sourceSha:process.env.SAM_VERIFICATION_SOURCE_SHA});return v;
 };
 const checkpoint=async(phase,proof={})=>{if(!resume)await retainCheckpoint({context:c,root,phase,target:config.own,started:config.started,hard:config.hard,sourceSha:process.env.SAM_VERIFICATION_SOURCE_SHA,proof});};
 const prompt=async(own,text)=>{live();const t=await canonical(own);if(resume&&own.taskId===config.own.taskId&&stage==='wake'&&(t.status!=='sleeping'||t.workspaceId!==protectedSnapshot.workspaceId))throw 0;activeOwn=own;const at=Date.now();const r=await requestSafe(c,api,{path:`/api/projects/${project}/sessions/${own.sessionId}/prompt`,method:'POST',data:{content:text},timeoutMs:30000});if(r.category!=='ok'||r.status!==202)throw 0;if(own.taskId===config.own.taskId&&text.startsWith('Call actual'))completionSubmittedAt=at;return at;};
 const preserve=async(own,label)=>{
  await waitIdle(own,config.started,config.hard-120000);
  const t=await canonical(own);if(t.workspaceId!==activeWorkspace)throw 0;
  const r=await requestSafe(c,api,{path:'/api/workspaces/'+activeWorkspace+'/sleep',method:'POST',data:{},timeoutMs:90000},v=>v?.status==='sleeping'&&v.workspaceId===activeWorkspace&&v.chatSessionId===own.sessionId&&Number.isFinite(Date.parse(v.snapshotExpiresAt)));
  if(r.category!=='ok'||r.status!==200)throw 0;
  lastSleep={taskId:own.taskId,sessionId:own.sessionId,workspaceId:activeWorkspace,sleepStatus:200,at:Date.now()};await save(label+'-sleep.json',lastSleep);
  activeWorkspace=null;activeOwn=null;result.retained=true;
 };
 try{
  root=process.env.SAM_PROSPECTIVE_ROOT;if(!isAbsolute(root)||root==='/')throw 0;const st=await lstat(root);if(!st.isDirectory()||st.isSymbolicLink())throw 0;
  config=await read('config.json');if(!exact(config,['started','hard','own','observer','evidencePrUrl',...(resume?['resume']:[])])||config.evidencePrUrl!=='https://github.com/raphaeltm/simple-agent-manager/pull/2355')throw 0;
  identity(config.own);identity(config.observer);
  if(!resume){await snapshotRoot(root,config.own.taskId);if(!/^[0-9a-f]{40}$/.test(process.env.SAM_VERIFICATION_SOURCE_SHA??''))throw 0;}
  if(failed.has(config.own.taskId)||config.own.taskId===first||config.observer.taskId!==first||config.observer.agentType!=='openai-codex'||config.own.agentProfileId!==(config.own.agentType==='claude-code'?'01KRS7Z2R88JFC73ARA7DV9WTK':'01KXG9MJRZ36FFJX0RVNW67SWB'))throw 0;
  let original;
  if(resume){
   const retained=await import('./prospective-resume.mjs');retained.resumeIdentity(config.own);
   if(!exact(config.resume,['kind','originalEvidenceSha256'])||!['second-prospective-restore','third-prospective-restore'].includes(config.resume.kind)||config.resume.originalEvidenceSha256!==retained.originalEvidenceSha256)throw 0;
   original=await retained.retainedOriginals(config.own);sequence=new retained.ContinuationSequence(config.own,config.started,config.hard);
   result.coverage=config.resume.kind;result.restoreAttemptOrdinal=config.resume.kind==='third-prospective-restore'?3:2;result.firstWakePass=false;
  }else sequence=new AcceptanceSequence(config.own,config.started,config.hard);
  live();if(config.started>Date.now())throw 0;
  await save('operation-start.json',{started:config.started,hard:config.hard,action:action(),taskId:config.own.taskId});
  const {chromium}=await import('/tmp/reliability-browser-deps/node_modules/playwright/index.mjs');browser=await chromium.launch({headless:true});c=await browser.newContext();
  stage='login';const login=await requestSafe(c,api,{path:'/api/auth/token-login',method:'POST',data:{token:process.env.SAM_PLAYWRIGHT_PRIMARY_USER}});delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;if(login.category!=='ok')throw 0;
  owner=(await get('/api/auth/get-session'))?.user?.id;if(!owner)throw 0;
  page=await c.newPage();await page.goto('https://app.sammy.party',{waitUntil:'domcontentloaded',timeout:20000});
  // Do not reopen FIRST until AFTER target completion. Preserve its immutable original proof first.
  const observerBefore=await canonical(config.observer);if(observerBefore.status!=='completed'||!observerBefore.completedAt||!observerBefore.completionEvidence)throw 0;
  await save('observer-original-completed.json',{taskId:config.observer.taskId,completedAt:observerBefore.completedAt,evidenceSha256:hash(JSON.stringify(observerBefore.completionEvidence))});
  const fixtureInitial=await canonical(config.own);if(!Number.isFinite(Date.parse(fixtureInitial.createdAt))||(!resume&&Date.parse(fixtureInitial.createdAt)<config.started)||(resume&&Date.parse(fixtureInitial.createdAt)>=config.started)||Date.parse(fixtureInitial.createdAt)>Date.now())throw 0;
  await checkpoint('start',{originalCompletedAt:observerBefore.completedAt,evidenceSha256:hash(JSON.stringify(observerBefore.completionEvidence))});
  let baseline,expectations,mapping;
  if(resume){
   if(fixtureInitial.status!=='sleeping')throw 0;
   baseline=original.baseline;expectations=original.expectations;
   await save('retained-originals.json',original.proof);
   sequence.append('retained-originals',{ok:true,hostBytesRetained:true,...original.proof},Date.now());
   stage='resume-snapshot';await save('resume-snapshot-request.json',{taskId:config.own.taskId,sessionId:config.own.sessionId,workspaceId:fixtureInitial.workspaceId,at:Date.now()});
   while(Date.now()<action()){
    await producerFailed('resume-snapshot',config.own);
    try{protectedSnapshot=snapshotProof(await read('resume-snapshot.json'),config.own,fixtureInitial.workspaceId,config.started,config.hard,Date.now());if(protectedSnapshot.observedAt<Date.now()-240000)throw 0;break;}catch{protectedSnapshot=null;}
    await pause(1000);
   }if(!protectedSnapshot)throw 0;
   await save('protected-snapshot.json',protectedSnapshot);
  }else{
  activeOwn=config.own;stage='setup';mapping=await waitIdle(config.own,config.started);
  await phase('setup',config.own,'setup',{},mapping);
  baseline=await readFile(root+'/setup/baseline.json');expectations=await readFile(root+'/setup/expectations.json');
  sequence.append('setup',{ok:true,baselineOriginal:true,expectationsOriginal:true,hostBytesRetained:true},Date.now());
  stage='actual-turn';const at=await prompt(config.own,'Authorized tested harness turn. Do not edit, run tools, publish, complete, or start background work. Return control with READY.');mapping=await waitIdle(config.own,at);
  sequence.append('turn',{ok:true,actualHarness:true,freshInactive:true,prompt202:true},Date.now());
  stage='turn-check';await phase('turn-check',config.own,'check',{baseline,expectations},mapping);sequence.append('turn-check',{ok:true},Date.now());
  stage='sleep';await preserve(config.own,'protected');
  // Independent snapshot AVAILABLE read is mandatory, never infer from Sleep HTTP200 alone.
  let snapshot;while(Date.now()<action()){await producerFailed('protected-snapshot',config.own);try{snapshot=snapshotProof(await read('protected-snapshot.json'),config.own,lastSleep.workspaceId,lastSleep.at,config.hard,Date.now());break;}catch{}await pause(1000);}if(!snapshot)throw 0;protectedSnapshot=snapshot;
  sequence.append('sleep',{ok:true,snapshotAvailable:true,sleep200:true,snapshotId:snapshot.snapshotId},Date.now());
  }
  await checkpoint('sleep',{snapshotId:protectedSnapshot.snapshotId,workspaceId:protectedSnapshot.workspaceId,generationSha256:hash(protectedSnapshot.snapshotGeneration)});
  stage='wake';const wakeAt=await prompt(config.own,'Authorized normal snapshot recovery only. Do not edit, run tools, publish, complete or start background work. Return control with READY.');wakeSubmittedAt=wakeAt;await save('wake-submitted.json',{taskId:config.own.taskId,sessionId:config.own.sessionId,at:wakeAt});
  if(resume)await save('resume-attempt-receipt.json',{kind:config.resume.kind,restoreAttemptOrdinal:result.restoreAttemptOrdinal,taskId:config.own.taskId,sessionId:config.own.sessionId,branch:config.own.branch,agentProfileId:config.own.agentProfileId,started:config.started,hard:config.hard,submittedAt:wakeAt,acceptedAt:Date.now(),promptStatus:202,snapshotId:protectedSnapshot.snapshotId,snapshotGenerationSha256:hash(protectedSnapshot.snapshotGeneration),originalEvidenceSha256:config.resume.originalEvidenceSha256});
  mapping=await waitIdle(config.own,wakeAt);
  sequence.append('wake',{ok:true,actualHarness:true,freshInactive:true,prompt202:true},Date.now());
  await checkpoint('wake',{workspaceId:mapping.workspaceId});
  stage='wake-check';await phase('wake-check',config.own,'check',{baseline,expectations},mapping);result.originalRestoredBytesVerified=true;sequence.append('wake-check',{ok:true,originalRestoredBytesVerified:true,consumedGenerationObserved:false},Date.now());
  stage='complete';const completeAt=await prompt(config.own,`Call actual mcp__sam_mcp__complete_task now. No Bash/Git/publication/other writes. Use evidence.prUrl=${config.evidencePrUrl}, and evidence.notes containing the measured fixture commit ${JSON.parse(baseline).head}. Report that host preservation checks passed, without claiming unobserved stages.`);
  let completed;
  while(Date.now()<action()){const t=await canonical(config.own);if(t.status==='completed'&&Number.isFinite(Date.parse(t.completedAt))&&Date.parse(t.completedAt)>=completeAt&&t.completionEvidence?.prUrl===config.evidencePrUrl&&typeof t.completionEvidence.notes==='string'&&t.completionEvidence.notes.includes(JSON.parse(baseline).head)){completed=t;break;}await pause(5000);}if(!completed)throw 0;
  await save('canonical-completed.json',{taskId:config.own.taskId,branch:config.own.branch,completedAt:completed.completedAt,completionEvidenceSha256:hash(JSON.stringify(completed.completionEvidence)),evidencePrUrl:config.evidencePrUrl});
  // An independent retained tool-result projection is required in addition to canonical completion.
  let tool;while(Date.now()<action()){
   await producerFailed('completion-runtime',config.own);
   try{
    const metadata=completionMessages(await get(`/api/projects/${project}/sessions/${config.own.sessionId}/messages?limit=100&order=desc&compact=true`),config.own,completeAt,Date.now());
    const runtime=await read('completion-runtime.json');
    if(runtime.taskId!==config.own.taskId||runtime.sessionId!==config.own.sessionId||runtime.runtimeWorkTerminal!==true||!Number.isSafeInteger(runtime.observedAt)||runtime.observedAt<Date.parse(completed.completedAt)||runtime.observedAt>Date.now()||!/^[0-9a-f]{64}$/.test(runtime.sourceEvidenceSha256))throw 0;
    const source=Buffer.from(JSON.stringify(metadata));
    const candidate={taskId:config.own.taskId,sessionId:config.own.sessionId,tool:'mcp__sam_mcp__complete_task',status:'completed',createdAt:metadata.createdAt,observedAt:Date.now(),originalEvidenceRetained:true,sourceEvidenceSha256:hash(source),runtimeWorkTerminal:true};
    tool=completionProof(candidate,config.own,completeAt,completed.completedAt,Date.now());
    await writeFile(root+'/completion-tool-original-metadata.json',source,{mode:0o600,flag:'wx'});await save('completion-tool.json',candidate);break;
   }catch{tool=null;}await pause(1000);
  }if(!tool)throw 0;
  sequence.append('complete',{ok:true,actualTool:true,canonicalCompletedAt:completed.completedAt,completionEvidence:true},Date.now());
  await checkpoint('complete',{completedAt:completed.completedAt,evidenceSha256:hash(JSON.stringify(completed.completionEvidence)),toolMetadataSha256:tool.sourceEvidenceSha256});
  activeOwn=null;activeWorkspace=null;stage='observe';
  const observerAt=await prompt(config.observer,'Authorized independent observer runtime only. Do not run tools, edit, publish, complete, or inspect your old fixture baseline. Return control immediately with READY.');mapping=await waitIdle(config.observer,observerAt);
  await phase('observe',config.observer,'observe',{baseline,expectations,completedAt:completed.completedAt,target:config.own},mapping);
  sequence.append('observe',{ok:true,independentRuntime:true,originalBaseline:true,originalExpectations:true,afterCanonical:true,allRefsAllPrStates:true},Date.now());
  await preserve(config.observer,'observer');
  let observerSnapshot;while(Date.now()<config.hard-120000){await producerFailed('observer-snapshot',config.observer);try{observerSnapshot=snapshotProof(await read('observer-snapshot.json'),config.observer,lastSleep.workspaceId,lastSleep.at,config.hard,Date.now(),'cf-container');break;}catch{}await pause(1000);}if(!observerSnapshot)throw 0;
  await save('observer-retained.json',{taskId:config.observer.taskId,snapshotId:observerSnapshot.snapshotId,originalCompletedAt:observerBefore.completedAt,reopenedStatus:'sleeping',observedAt:observerSnapshot.observedAt});
  await checkpoint('observer-sleep',{snapshotId:observerSnapshot.snapshotId,workspaceId:observerSnapshot.workspaceId,generationSha256:hash(observerSnapshot.snapshotGeneration),originalCompletedAt:observerBefore.completedAt});
  await checkpoint('closing');
  result.closureExportPending=!resume;result.ok=sequence.pass;stage='done';
 }catch{}finally{
  delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if(c&&activeOwn)try{await preserve(activeOwn,'abort');}catch{}
  if(c)try{const a=await logoutSafe(c,api),b=await requestSafe(c,api,{path:'/api/auth/get-session'},v=>v===null),d=await requestSafe(c,api,{path:'/api/nodes'});auth=a.category==='ok'&&b.category==='ok'&&[401,403].includes(d.status);}catch{}
  if(browser)try{await browser.close();closed=true;}catch{}
 }
 result.stage=stage;result.authCleanup=auth;result.browserClosed=closed;result.ok=result.ok&&auth&&closed;
 if(root)try{await save('final.json',{...result,events:sequence?.events??[],at:Date.now()});}catch{result.ok=false;}
 return summary(result.ok?'ok':'controller',result.ok?200:0,result.ok);
}
